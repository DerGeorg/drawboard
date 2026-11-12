package at.dergeorg.drawboard.files.domain

import at.dergeorg.drawboard.files.common.FilesModule
import at.dergeorg.drawboard.files.domain.detect.AllowedType
import at.dergeorg.drawboard.files.domain.files.ConversionQueue
import at.dergeorg.drawboard.files.domain.files.FilesErrors
import at.dergeorg.drawboard.files.domain.files.InfectedUploadException
import at.dergeorg.drawboard.files.domain.files.FilesLimits
import at.dergeorg.drawboard.files.domain.files.UploadInspector
import at.dergeorg.drawboard.files.domain.files.chunks
import at.dergeorg.drawboard.files.domain.files.readRange
import at.dergeorg.drawboard.files.domain.detect.FileTypes
import at.dergeorg.drawboard.files.domain.detect.ZipSniffer
import at.dergeorg.drawboard.files.domain.files.model.ByteRange
import at.dergeorg.drawboard.files.domain.files.model.Conversion
import at.dergeorg.drawboard.files.domain.files.model.FileDeleted
import at.dergeorg.drawboard.files.domain.files.model.FileDownload
import at.dergeorg.drawboard.files.domain.files.model.FileKind
import at.dergeorg.drawboard.files.domain.files.model.FileRejected
import at.dergeorg.drawboard.files.domain.files.model.FileUploaded
import at.dergeorg.drawboard.files.domain.files.model.FileVariant
import at.dergeorg.drawboard.files.domain.files.model.IssuedUrls
import at.dergeorg.drawboard.files.domain.files.model.RangeNotSatisfiableException
import at.dergeorg.drawboard.files.domain.files.model.SignedFileUrls
import at.dergeorg.drawboard.files.domain.files.model.StoredFile
import at.dergeorg.drawboard.files.domain.files.provides.FilesUseCase
import at.dergeorg.drawboard.files.domain.files.provides.OpenFileCommand
import at.dergeorg.drawboard.files.domain.files.provides.UploadCommand
import at.dergeorg.drawboard.files.domain.files.requires.BlobKey
import at.dergeorg.drawboard.files.domain.files.requires.BlobKind
import at.dergeorg.drawboard.files.domain.files.requires.FileRepository
import at.dergeorg.drawboard.files.domain.files.requires.FileScanner
import at.dergeorg.drawboard.files.domain.files.requires.FileStorage
import at.dergeorg.drawboard.files.domain.files.requires.FilesMetrics
import at.dergeorg.drawboard.files.domain.files.model.ScanUnavailableException
import at.dergeorg.drawboard.files.domain.files.requires.ScanVerdict
import at.dergeorg.drawboard.files.domain.files.requires.Transactions
import at.dergeorg.drawboard.files.domain.images.Dimensions
import at.dergeorg.drawboard.files.domain.images.ImageHeaders
import at.dergeorg.drawboard.files.domain.images.ImageWorker
import at.dergeorg.drawboard.files.domain.images.JpegMetadata
import at.dergeorg.drawboard.files.domain.ranges.RangeParser
import at.dergeorg.drawboard.files.domain.ranges.RangeRequest
import at.dergeorg.drawboard.files.domain.upload.ByteBudget
import at.dergeorg.drawboard.files.domain.upload.FileNames
import at.dergeorg.drawboard.files.domain.urls.FileUrlSigner
import at.dergeorg.drawboard.shared.auditing.AuditAction
import at.dergeorg.drawboard.shared.auditing.AuditTrail
import at.dergeorg.drawboard.shared.auditing.DomainEvents
import at.dergeorg.drawboard.shared.logging.AppLogger
import at.dergeorg.drawboard.shared.security.RateRule
import at.dergeorg.drawboard.shared.security.WindowRateLimiter
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.PayloadTooLargeException
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.onCompletion
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.springframework.stereotype.Service
import kotlin.time.Clock
import kotlin.time.Duration.Companion.minutes
import kotlin.uuid.Uuid

/**
 * Implements the file use cases (S4). The order of an upload is what makes the limits hold: cheap checks first (rate
 * limit, number of files, quotas), then the bytes stream into storage past the [UploadInspector], then the checks that
 * need the whole file (ZIP type, image size from the header, EXIF removal, thumbnail), and only then the metadata row
 * and the audit event are written in ONE short transaction. Anything that fails on the way removes what was written.
 */
@Service
@Suppress("TooManyFunctions")
internal class FilesService(
    private val files: FileRepository,
    private val storage: FileStorage,
    private val transactions: Transactions,
    private val signer: FileUrlSigner,
    private val images: ImageWorker,
    private val conversions: ConversionQueue,
    private val limits: FilesLimits,
    private val audit: AuditTrail,
    private val clock: Clock,
    private val log: AppLogger,
    private val scanner: FileScanner,
    private val metrics: FilesMetrics = FilesMetrics.None,
) : FilesUseCase {

    private val events = DomainEvents(FilesModule.NAME)

    private val uploads = WindowRateLimiter(clock, RateRule(limits.uploadsPerMinute, 1.minutes))
    private val conversionRate = WindowRateLimiter(clock, RateRule(limits.conversionsPerMinute, 1.minutes))
    private val budget = ByteBudget(clock, limits.uploadBytesPerMinute)

    /** The quota checks and the insert of one upload run one at a time, so two uploads cannot both pass the same check. */
    private val commit = Mutex()

    @WithSpan
    override suspend fun upload(command: UploadCommand): StoredFile = try {
        store(command).also { metrics.upload("accepted") }
    } catch (e: InfectedUploadException) {
        metrics.upload("infected")
        throw e
    } catch (e: DomainException) {
        metrics.upload(uploadResult(e.errorCode))
        throw e
    } catch (e: ScanUnavailableException) {
        metrics.upload("scan_failed")
        throw e
    }

    /** The label of a refused upload: a fixed set, so Grafana can count the reasons. */
    private fun uploadResult(code: ErrorCode): String = when (code) {
        ErrorCode.FILES_TYPE_NOT_ALLOWED -> "type_not_allowed"
        ErrorCode.FILES_QUOTA_EXCEEDED -> "quota_exceeded"
        ErrorCode.PAYLOAD_TOO_LARGE -> "too_large"
        ErrorCode.TOO_MANY_REQUESTS -> "rate_limited"
        else -> "error"
    }

    private suspend fun store(command: UploadCommand): StoredFile {
        val userKey = command.uploaderId.toString()
        uploads.take(userKey)
        budget.check(userKey)
        val boardId = command.boardId
        val name = FileNames.sanitise(command.fileName)
        val (userRemaining, boardRemaining) = requireQuotaLeft(command)

        val fileId = Uuid.generateV7()
        val inspector = UploadInspector(name, limits, userRemaining, boardRemaining)
        val stored = try {
            storage.write(BlobKey(fileId, BlobKind.ORIGINAL), command.content.onEach(inspector::accept).onCompletion { cause ->
                if (cause == null) inspector.finish()
            })
            val finished = finishUpload(fileId, command, name, inspector)
            budget.record(userKey, finished.size)
            finished
        } catch (@Suppress("TooGenericExceptionCaught") e: Throwable) {
            removeBlobs(fileId)
            throw e
        }
        return startConversion(stored)
    }

    /** The cheap quota checks first: a full board or user is told before one byte is stored. Returns the bytes left for user and board. */
    private suspend fun requireQuotaLeft(command: UploadCommand): Pair<Long, Long> {
        if (files.countByBoard(command.boardId) >= limits.maxFilesPerBoard) throw FilesErrors.quota("BOARD", limits.maxBytesPerBoard)
        val userRemaining = limits.maxBytesPerUser - files.usedBytesOfUser(command.uploaderId)
        val boardRemaining = limits.maxBytesPerBoard - files.usedBytesOfBoard(command.boardId)
        if (userRemaining <= 0) throw FilesErrors.quota("USER", limits.maxBytesPerUser)
        if (boardRemaining <= 0) throw FilesErrors.quota("BOARD", limits.maxBytesPerBoard)
        return userRemaining to boardRemaining
    }

    /**
     * Queues a stored document for conversion. A full queue marks the file FAILED (`QUEUE_FULL`), as the start-up resume does,
     * and the answer shows it. This runs after the row is committed, so it never takes the blobs away: if marking fails, the
     * file stays PENDING and the next start queues it again.
     */
    private suspend fun startConversion(stored: StoredFile): StoredFile {
        if (stored.conversion != Conversion.PENDING) return stored
        return try {
            if (conversions.submit(stored.id)) {
                stored
            } else {
                log.warn("file conversion queue is full", "files.file.id" to stored.id.toString())
                files.findById(stored.id) ?: stored
            }
        } catch (e: CancellationException) {
            throw e
        } catch (@Suppress("TooGenericExceptionCaught") e: Exception) {
            log.error("file could not be marked after a full conversion queue", e, "files.file.id" to stored.id.toString())
            stored
        }
    }

    /** What needs the complete file; returns the stored file. */
    private suspend fun finishUpload(fileId: Uuid, command: UploadCommand, name: String, inspector: UploadInspector): StoredFile {
        val original = BlobKey(fileId, BlobKind.ORIGINAL)
        requireClean(fileId, command, name, inspector) // before anything parses the bytes, and long before the file is visible
        val type = inspector.type ?: zipType(original, inspector.size, name)
        var size = inspector.size
        var width: Int? = null
        var height: Int? = null
        var thumbnail: ByteArray? = null
        var thumbnailType: String? = null
        if (type.kind == FileKind.IMAGE) {
            val prefix = storage.readRange(original, 0, ImageHeaders.PREFIX_BYTES)
            val dimensions = ImageHeaders.dimensions(type.mediaType, prefix) ?: throw FilesErrors.typeNotAllowed(type.mediaType)
            if (dimensions.pixels > limits.maxPixels) throw FilesErrors.tooManyPixels(limits.maxPixels)
            width = dimensions.width
            height = dimensions.height
            if (type.mediaType == "image/jpeg") size = stripJpeg(fileId, prefix, size)
            if (thumbnailable(type.mediaType, dimensions)) {
                // read through the stored file by the decoder itself: the original never sits in the heap whole (S4.8)
                val made = images.thumbnail(type.mediaType) { storage.open(original) }
                thumbnail = made?.data
                thumbnailType = made?.mediaType
            }
        }
        val conversion = if (type.kind == FileKind.DOCUMENT) pendingOrFailed(command.uploaderId) else Conversion.NONE
        thumbnail?.let { storage.write(BlobKey(fileId, BlobKind.THUMBNAIL), flow { emit(it) }) }
        val file = StoredFile(
            id = fileId,
            boardId = command.boardId,
            name = name,
            mediaType = type.mediaType,
            kind = type.kind,
            size = size,
            createdAt = clock.now(),
            createdBy = command.uploaderId,
            conversion = conversion,
            width = width,
            height = height,
            thumbnailMediaType = thumbnailType.takeIf { thumbnail != null },
        )
        return register(file, inspector.sha256())
    }

    /**
     * The malware scan (S4.12) of the stored original, if a scanner is configured. A finding refuses the upload (415, audited with the
     * signature, the bytes are removed by the caller). A scan that did not work follows the policy: fail closed refuses the upload (503; 413 when the file
     * is just larger than the scanner takes), fail open (the default) accepts it - and both are counted, so a scanner that is down does not
     * go unnoticed. A blob that cannot be opened counts as unavailable.
     */
    private suspend fun requireClean(fileId: Uuid, command: UploadCommand, name: String, inspector: UploadInspector) {
        if (!scanner.enabled) return
        // a blob that cannot be opened is a scan that did not happen: it follows the same policy as an unreachable scanner
        val verdict = storage.open(BlobKey(fileId, BlobKind.ORIGINAL))?.use { scanner.scan(it, inspector.size) }
            ?: ScanVerdict.Unavailable("OPEN")
        when (verdict) {
            ScanVerdict.Clean -> metrics.scan("clean")
            is ScanVerdict.Infected -> {
                metrics.scan("infected")
                audit.record(
                    events.of(
                        FILE, fileId, AuditAction.FAILED, "rejected",
                        FileRejected(command.boardId.toString(), name, inspector.size, inspector.sha256(), "INFECTED", verdict.signature),
                    ),
                )
                throw FilesErrors.infected()
            }
            is ScanVerdict.TooLarge -> {
                // the scanner works, the file is larger than it takes: its own count, so "unavailable" stays the alarm for a scanner that is down
                metrics.scan("too_large")
                log.warn(
                    "an upload is larger than the scanner takes", "files.scan.limit" to verdict.limitBytes,
                    "files.scan.fail_closed" to limits.scanFailClosed,
                )
                if (limits.scanFailClosed) throw PayloadTooLargeException(verdict.limitBytes)
            }
            is ScanVerdict.Unavailable -> {
                metrics.scan("unavailable")
                log.warn(
                    "an upload could not be scanned", "files.scan.reason" to verdict.reason,
                    "files.scan.fail_closed" to limits.scanFailClosed,
                )
                if (limits.scanFailClosed) throw ScanUnavailableException(verdict.reason)
            }
        }
    }

    /** Quotas again, now with the real size, then the row and the audit event together - one upload at a time. */
    private suspend fun register(file: StoredFile, sha256: String): StoredFile = commit.withLock {
        val userBytes = files.usedBytesOfUser(file.createdBy) + file.size
        val boardBytes = files.usedBytesOfBoard(file.boardId) + file.size
        if (files.countByBoard(file.boardId) >= limits.maxFilesPerBoard) throw FilesErrors.quota("BOARD", limits.maxBytesPerBoard)
        if (userBytes > limits.maxBytesPerUser) throw FilesErrors.quota("USER", limits.maxBytesPerUser)
        if (boardBytes > limits.maxBytesPerBoard) throw FilesErrors.quota("BOARD", limits.maxBytesPerBoard)
        transactions.required {
            val inserted = files.insert(file)
            audit.record(
                events.created(
                    FILE, inserted.id, after = inserted.auditView(),
                    details = FileUploaded(
                        boardId = inserted.boardId.toString(),
                        name = inserted.name,
                        mediaType = inserted.mediaType,
                        kind = inserted.kind.name,
                        size = inserted.size,
                        sha256 = sha256,
                    ),
                ),
            )
            inserted
        }
    }

    /**
     * WebP has no decoder in the JDK; a progressive JPEG above the cap would cost the native decoder ~6 bytes a pixel whatever
     * the subsampling. Both are stored without a thumbnail (never refused: the original is fine to show).
     */
    private fun thumbnailable(mediaType: String, dimensions: Dimensions): Boolean = when {
        mediaType == "image/webp" -> false
        dimensions.progressive && dimensions.pixels > limits.maxProgressivePixels -> {
            log.info("progressive jpeg above the thumbnail cap stored without a thumbnail", "files.image.pixels" to dimensions.pixels)
            false
        }
        else -> true
    }

    /** The ZIP is an Office document if the entry names say so - read from the central directory, nothing is inflated (S4.11). */
    private suspend fun zipType(original: BlobKey, size: Long, name: String): AllowedType {
        val mediaType = withContext(Dispatchers.IO) {
            val channel = storage.open(original) ?: return@withContext null
            channel.use { ch ->
                ZipSniffer(size) { from, length ->
                    ch.position(from)
                    val buffer = java.nio.ByteBuffer.allocate(length)
                    while (buffer.hasRemaining() && ch.read(buffer) >= 0) Unit
                    buffer.array().copyOf(buffer.position())
                }.documentType()
            }
        }
        val type = mediaType?.let { FileTypes.ALLOWED[it] } ?: throw FilesErrors.typeNotAllowed("application/zip")
        if (!FileTypes.extensionMatches(name, type)) throw FilesErrors.typeNotAllowed(type.mediaType)
        return type
    }

    /**
     * Removes EXIF/XMP/IPTC/comments (and foreign APP2 blocks) from the header of a JPEG original (S4.8, SHOULD); returns the
     * new size. "Nothing to strip" is only the answer of a walk that reached the start of the scan; a walk that failed
     * refuses the file (400, field `file`) - a byte scan for `FF DA` would let metadata past that the walk could not see.
     */
    private suspend fun stripJpeg(fileId: Uuid, prefix: ByteArray, size: Long): Long {
        val stripped = when (val outcome = JpegMetadata.strip(prefix)) {
            JpegMetadata.NothingToStrip -> return size
            JpegMetadata.WalkFailed -> throw FilesErrors.jpegUnreadable()
            is JpegMetadata.Stripped -> outcome
        }
        val original = BlobKey(fileId, BlobKind.ORIGINAL)
        val staging = BlobKey(fileId, BlobKind.STAGING)
        val rewritten = storage.write(
            staging,
            flow {
                emit(stripped.head)
                emitAll(storage.chunks(original, from = stripped.replacedBytes.toLong()))
            },
        )
        storage.move(staging, original)
        return rewritten
    }

    /** PENDING if the converter is configured and the user may convert one more now (429 otherwise); FAILED without a converter. */
    private fun pendingOrFailed(userId: Uuid): Conversion {
        if (!limits.conversionEnabled) return Conversion.FAILED
        conversionRate.take(userId.toString())
        return Conversion.PENDING
    }

    @WithSpan
    override suspend fun listFiles(@SpanAttribute("board.id") boardId: Uuid): List<StoredFile> = files.findByBoard(boardId)

    @WithSpan
    override suspend fun getFile(@SpanAttribute("board.id") boardId: Uuid, @SpanAttribute("file.id") fileId: Uuid): StoredFile =
        files.findById(fileId)?.takeIf { it.boardId == boardId } ?: throw FilesErrors.notFound(fileId)

    @WithSpan
    override suspend fun deleteFile(@SpanAttribute("board.id") boardId: Uuid, @SpanAttribute("file.id") fileId: Uuid) {
        val file = getFile(boardId, fileId)
        transactions.required {
            files.deleteByIds(listOf(file.id))
            audit.record(
                events.deleted(
                    FILE, file.id, before = file.auditView(),
                    details = FileDeleted(file.boardId.toString(), file.name, file.kind.name, file.size),
                ),
            )
        }
        removeBlobs(file.id)
    }

    @WithSpan
    override suspend fun issueUrls(@SpanAttribute("board.id") boardId: Uuid, ids: List<Uuid>): IssuedUrls {
        val expiresAt = signer.expiry()
        val byId = files.findByBoard(boardId).associateBy { it.id }
        val items = ids.distinct().mapNotNull { byId[it] }.map { file ->
            val original = signer.url(file.id, FileVariant.ORIGINAL, expiresAt)
            val pdf = signer.url(file.id, FileVariant.PDF, expiresAt).takeIf { file.pdfSize != null }
            SignedFileUrls(
                fileId = file.id,
                url = pdf ?: original,
                thumbnailUrl = signer.url(file.id, FileVariant.THUMBNAIL, expiresAt).takeIf { file.thumbnailMediaType != null },
                pdfUrl = pdf,
                originalUrl = original,
            )
        }
        return IssuedUrls(expiresAt, items)
    }

    @WithSpan
    override suspend fun open(command: OpenFileCommand): FileDownload {
        // 1. the signature - ONE answer for every way it can be wrong, before the database is touched
        val variant = FileVariant.ofWire(command.variant)
        if (variant == null || !signer.verify(command.fileId, command.variant, command.exp, command.signature)) {
            throw FilesErrors.urlInvalid()
        }
        // 2. only a valid signature may learn whether the file exists
        val file = files.findById(command.fileId) ?: throw FilesErrors.notFound(command.fileId)
        val served = servedVariant(file, variant) ?: throw FilesErrors.notFound(file.id)
        val key = BlobKey(file.id, served.blob)
        val size = storage.size(key) ?: run {
            log.error("file metadata without stored bytes", null, "files.file.id" to file.id.toString())
            throw FilesErrors.notFound(file.id)
        }
        val range = when (val parsed = RangeParser.parse(command.range, size)) {
            RangeRequest.Whole -> null
            is RangeRequest.Partial -> ByteRange(parsed.first, parsed.last)
            RangeRequest.NotSatisfiable -> throw RangeNotSatisfiableException(size)
        }
        return FileDownload(
            fileName = served.fileName,
            mediaType = served.mediaType,
            inline = served.mediaType.startsWith("image/") || served.mediaType.startsWith("video/"),
            size = size,
            range = range,
            open = { checkNotNull(storage.open(key)) { "stored bytes disappeared" } },
        )
    }

    private class Served(val blob: BlobKind, val mediaType: String, val fileName: String)

    /** The stored blob behind a variant, or null when the file has no such variant. */
    private fun servedVariant(file: StoredFile, variant: FileVariant): Served? = when (variant) {
        FileVariant.ORIGINAL -> Served(BlobKind.ORIGINAL, file.mediaType, file.name)
        FileVariant.THUMBNAIL -> file.thumbnailMediaType?.let {
            Served(BlobKind.THUMBNAIL, it, file.name.substringBeforeLast('.') + if (it == "image/png") ".png" else ".jpg")
        }
        FileVariant.PDF -> file.pdfSize?.let { Served(BlobKind.PDF, "application/pdf", file.name.substringBeforeLast('.') + ".pdf") }
    }

    @WithSpan
    override suspend fun deleteBoardData(boardIds: Collection<Uuid>): Int {
        if (boardIds.isEmpty()) return 0
        val doomed = files.findByBoards(boardIds)
        if (doomed.isEmpty()) return 0
        transactions.required {
            files.deleteByIds(doomed.map { it.id })
            doomed.forEach { file ->
                audit.record(
                    events.deleted(
                        FILE, file.id, before = file.auditView(),
                        details = FileDeleted(file.boardId.toString(), file.name, file.kind.name, file.size, withBoard = true),
                    ),
                )
            }
        }
        doomed.forEach { removeBlobs(it.id) }
        return doomed.size
    }

    /**
     * The sweep (S4.13): stored blobs that no metadata row belongs to are deleted - leftovers of a failed delete, of a crash
     * between the bytes and the row, of a purge. Blobs younger than the grace period are left alone: they may belong to an
     * upload that is still running. Returns how many blobs were removed.
     */
    @WithSpan
    suspend fun sweepOrphans(): Int {
        val before = clock.now() - limits.orphanGrace
        storage.purgeUnfinished(before)
        val candidates = storage.list().filter { it.modifiedAt < before }.toList()
        if (candidates.isEmpty()) return 0
        var removed = 0
        candidates.groupBy { it.key.fileId }.entries.chunked(SWEEP_BATCH).forEach { batch ->
            val existing = files.existing(batch.map { it.key })
            batch.filter { it.key !in existing }.forEach { (_, blobs) ->
                blobs.forEach {
                    storage.delete(it.key)
                    removed++
                }
            }
        }
        if (removed > 0) log.info("orphaned file blobs removed", "files.blobs.removed" to removed)
        return removed
    }

    private suspend fun removeBlobs(fileId: Uuid) = withContext(NonCancellable) {
        BlobKind.entries.forEach { storage.delete(BlobKey(fileId, it)) }
    }

    /** What the audit event keeps of a file: no bytes, no URL - the metadata. */
    private fun StoredFile.auditView() = mapOf(
        "name" to name, "mediaType" to mediaType, "kind" to kind.name, "size" to size, "boardId" to boardId.toString(),
    )

    private companion object {
        const val FILE = "file"
        const val SWEEP_BATCH = 200
    }
}
