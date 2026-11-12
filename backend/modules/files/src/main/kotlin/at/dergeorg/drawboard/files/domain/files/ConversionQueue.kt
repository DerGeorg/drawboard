package at.dergeorg.drawboard.files.domain.files

import at.dergeorg.drawboard.files.common.FilesModule
import at.dergeorg.drawboard.files.domain.files.model.Conversion
import at.dergeorg.drawboard.files.domain.files.model.FileConverted
import at.dergeorg.drawboard.files.domain.files.model.StoredFile
import at.dergeorg.drawboard.files.domain.files.requires.BlobKey
import at.dergeorg.drawboard.files.domain.files.requires.BlobKind
import at.dergeorg.drawboard.files.domain.files.requires.ConversionFailedException
import at.dergeorg.drawboard.files.domain.files.requires.Converter
import at.dergeorg.drawboard.files.domain.files.requires.FileRepository
import at.dergeorg.drawboard.files.domain.files.requires.FilesMetrics
import at.dergeorg.drawboard.files.domain.files.requires.FileStorage
import at.dergeorg.drawboard.files.domain.files.requires.Transactions
import at.dergeorg.drawboard.shared.auditing.AuditAction
import at.dergeorg.drawboard.shared.auditing.AuditTrail
import at.dergeorg.drawboard.shared.auditing.DomainEvents
import at.dergeorg.drawboard.shared.logging.AppLogger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.TimeoutCancellationException
import kotlin.uuid.Uuid

/**
 * The conversion of Office documents to PDF (S4.10): ONE at a time per instance, in the order of the uploads. The queue
 * holds ids only; the worker loads the file when its turn comes, so a file deleted while it waits is simply skipped.
 * What was PENDING when the process stopped is queued again on [resume]. The converter is a sidecar that never has a
 * way out of its network; this class additionally bounds the time ([FilesLimits.conversionTimeout]), checks that the
 * answer IS a PDF (`%PDF-`) and caps its size - whatever the sidecar says, nothing else is stored.
 */
internal class ConversionQueue(
    private val files: FileRepository,
    private val storage: FileStorage,
    private val converter: Converter,
    private val transactions: Transactions,
    private val audit: AuditTrail,
    private val limits: FilesLimits,
    private val scope: CoroutineScope,
    private val log: AppLogger,
    private val metrics: FilesMetrics = FilesMetrics.None,
) {
    private val events = DomainEvents(FilesModule.NAME)
    private val queue = Channel<Uuid>(limits.conversionQueue)

    /** Starts the worker. */
    fun start() {
        scope.launch {
            for (id in queue) {
                try {
                    convert(id)
                } catch (e: CancellationException) {
                    throw e
                } catch (@Suppress("TooGenericExceptionCaught") e: Exception) {
                    log.error("file conversion failed unexpectedly", e, "files.file.id" to id.toString())
                }
            }
        }
    }

    /** Queues the files that were waiting when the process last stopped. */
    suspend fun resume() {
        files.findByConversion(Conversion.PENDING).forEach { submit(it.id) }
    }

    /**
     * Queues a file that was just stored as PENDING. When the queue is full the file is marked FAILED with the reason
     * `QUEUE_FULL` (and audited) - it would stay PENDING forever otherwise, the worker never learns of it (M3 backend review,
     * SHOULD 4). Returns whether the file was queued.
     */
    suspend fun submit(fileId: Uuid): Boolean {
        if (enqueue(fileId)) return true
        fail(fileId, "QUEUE_FULL")
        return false
    }

    /** False when the queue is full. */
    private fun enqueue(fileId: Uuid): Boolean = queue.trySend(fileId).isSuccess

    fun stop() {
        queue.close()
    }

    /** Converts one file now. Public to the module for the tests; the worker calls it in order. */
    suspend fun convert(fileId: Uuid) {
        val file = files.findById(fileId)?.takeIf { it.conversion == Conversion.PENDING } ?: return
        val result = try {
            Result.success(makePdf(file))
        } catch (e: TimeoutCancellationException) {
            Result.failure(ConversionFailedException("TIMEOUT", e))
        } catch (e: ConversionFailedException) {
            Result.failure(e)
        } catch (e: CancellationException) {
            throw e
        } catch (@Suppress("TooGenericExceptionCaught") e: Exception) {
            Result.failure(ConversionFailedException("CONVERTER_ERROR", e))
        }
        result.onSuccess { size -> finish(file, size) }.onFailure { e ->
            withContext(NonCancellable) { storage.delete(BlobKey(file.id, BlobKind.PDF)) }
            val reason = (e as? ConversionFailedException)?.reason ?: "CONVERTER_ERROR"
            log.warn("file conversion failed", "files.file.id" to file.id.toString(), "files.conversion.reason" to reason)
            fail(file.id, reason)
        }
    }

    private suspend fun makePdf(file: StoredFile): Long {
        val extension = ConversionExtensions.of(file.mediaType) ?: throw ConversionFailedException("TYPE_NOT_CONVERTIBLE")
        val source = storage.chunks(BlobKey(file.id, BlobKind.ORIGINAL))
        return withTimeout(limits.conversionTimeout) {
            storage.write(BlobKey(file.id, BlobKind.PDF), checkedPdf(converter.toPdf(extension, source)))
        }
    }

    /** Only a PDF within the size cap passes: the first bytes are `%PDF-`, and no more than [FilesLimits.maxFileBytes] arrive. */
    private fun checkedPdf(pdf: Flow<ByteArray>): Flow<ByteArray> = flow {
        var total = 0L
        var first = true
        pdf.onEach { chunk ->
            if (first && chunk.isNotEmpty()) {
                first = false
                if (!chunk.startsWithPdfMagic()) throw ConversionFailedException("NOT_A_PDF")
            }
            total += chunk.size
            if (total > limits.maxFileBytes) throw ConversionFailedException("RESULT_TOO_LARGE")
        }.collect { emit(it) }
        if (total == 0L) throw ConversionFailedException("EMPTY_RESULT")
    }

    private suspend fun finish(file: StoredFile, pdfSize: Long) {
        val done = transactions.required {
            val current = files.findById(file.id)?.takeIf { it.conversion == Conversion.PENDING }
            val updated = current?.let { files.update(it.copy(conversion = Conversion.DONE, pdfSize = pdfSize)) }
            if (updated != null) {
                audit.record(
                    events.of(
                        FILE, file.id, AuditAction.EXECUTED, "converted",
                        FileConverted(boardId = file.boardId.toString(), result = "DONE", pdfSize = pdfSize),
                    ),
                )
            }
            updated
        }
        if (done != null) metrics.conversion("done")
        // deleted while it was converted: nobody can reach the PDF any more
        if (done == null) withContext(NonCancellable) { storage.delete(BlobKey(file.id, BlobKind.PDF)) }
    }

    private suspend fun fail(fileId: Uuid, reason: String) {
        transactions.required {
            val current = files.findById(fileId)?.takeIf { it.conversion == Conversion.PENDING } ?: return@required
            if (files.update(current.copy(conversion = Conversion.FAILED, pdfSize = null)) != null) {
                metrics.conversion("failed")
                audit.record(
                    events.of(
                        FILE, fileId, AuditAction.FAILED, "converted",
                        FileConverted(boardId = current.boardId.toString(), result = "FAILED", reason = reason),
                    ),
                )
            }
        }
    }

    private fun ByteArray.startsWithPdfMagic() =
        size >= PDF_MAGIC.size && PDF_MAGIC.indices.all { this[it] == PDF_MAGIC[it] }

    private companion object {
        const val FILE = "file"
        val PDF_MAGIC = "%PDF-".toByteArray(Charsets.US_ASCII)
    }
}

/** The extension the converter needs to pick its import filter - from the DETECTED type, never from the client's name. */
internal object ConversionExtensions {
    private val EXTENSIONS = mapOf(
        at.dergeorg.drawboard.files.domain.detect.FileTypes.DOCX to "docx",
        at.dergeorg.drawboard.files.domain.detect.FileTypes.XLSX to "xlsx",
        at.dergeorg.drawboard.files.domain.detect.FileTypes.PPTX to "pptx",
        at.dergeorg.drawboard.files.domain.detect.FileTypes.ODT to "odt",
        at.dergeorg.drawboard.files.domain.detect.FileTypes.ODS to "ods",
        at.dergeorg.drawboard.files.domain.detect.FileTypes.ODP to "odp",
    )

    fun of(mediaType: String): String? = EXTENSIONS[mediaType]
}
