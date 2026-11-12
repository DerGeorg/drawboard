package at.dergeorg.drawboard.files.domain.files

import at.dergeorg.drawboard.files.domain.files.model.Conversion
import at.dergeorg.drawboard.files.domain.files.model.FileConverted
import at.dergeorg.drawboard.files.domain.files.model.FileKind
import at.dergeorg.drawboard.files.domain.files.model.StoredFile
import at.dergeorg.drawboard.files.domain.files.requires.BlobKey
import at.dergeorg.drawboard.files.domain.files.requires.BlobKind
import at.dergeorg.drawboard.files.domain.files.requires.ConversionFailedException
import at.dergeorg.drawboard.shared.testing.FIXED_NOW
import at.dergeorg.drawboard.shared.testing.RecordingAppLogger
import at.dergeorg.drawboard.shared.testing.RecordingAuditTrail
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds
import kotlin.uuid.Uuid

class ConversionQueueTest {

    private val repository = InMemoryFileRepository()
    private val storage = InMemoryFileStorage()
    private val audit = RecordingAuditTrail()
    private val converter = FakeConverter()
    private val limits = FilesLimits(maxFileBytes = 1000, conversionTimeout = 200.milliseconds)
    private val queue = ConversionQueue(
        repository,
        storage,
        converter,
        DirectTransactions,
        audit,
        limits,
        CoroutineScope(Dispatchers.Unconfined),
        RecordingAppLogger(),
    )

    private suspend fun pendingDocument(): StoredFile {
        val id = Uuid.generateV7()
        storage.blobs[BlobKey(id, BlobKind.ORIGINAL)] = Samples.ooxml("word/document.xml")
        return repository.insert(
            StoredFile(
                id = id,
                boardId = Uuid.generateV7(),
                name = "report.docx",
                mediaType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                kind = FileKind.DOCUMENT,
                size = 100,
                createdAt = FIXED_NOW,
                createdBy = Uuid.generateV7(),
                conversion = Conversion.PENDING,
            ),
        )
    }

    @Nested
    inner class Converting {

        @Test
        fun `when the converter answers a pdf then the file is DONE, the pdf is stored and the result is audited`() = runBlocking {
            val file = pendingDocument()

            queue.convert(file.id)

            val done = assertNotNull(repository.rows[file.id], "row")
            assertEquals(Conversion.DONE to FakeConverter.PDF_BYTES.size.toLong(), done.conversion to done.pdfSize, "state and size")
            assertTrue(FakeConverter.PDF_BYTES.contentEquals(storage.blobs.getValue(BlobKey(file.id, BlobKind.PDF))), "the pdf is stored")
            assertEquals("docx", converter.calls.single().first, "the converter is told the type from the DETECTED type, not the name")
            val details = audit.events.single().details as FileConverted
            assertEquals("DONE", details.result, "audit result")
        }

        @Test
        fun `when the answer is not a pdf then it is rejected whatever the sidecar says`() = runBlocking {
            converter.result = { flow { emit("<html>not a pdf</html>".toByteArray()) } }
            val file = pendingDocument()

            queue.convert(file.id)

            assertEquals(Conversion.FAILED, repository.rows.getValue(file.id).conversion, "failed")
            assertTrue(BlobKey(file.id, BlobKind.PDF) !in storage.blobs, "nothing of the answer is kept")
            assertEquals("NOT_A_PDF", (audit.events.single().details as FileConverted).reason, "reason code")
        }

        @Test
        fun `when the pdf is larger than the cap then the conversion fails and nothing is stored`() = runBlocking {
            converter.result = { flow { emit("%PDF-".toByteArray()); repeat(20) { emit(ByteArray(100)) } } }
            val file = pendingDocument()

            queue.convert(file.id)

            assertEquals("RESULT_TOO_LARGE", (audit.events.single().details as FileConverted).reason, "size cap")
            assertTrue(BlobKey(file.id, BlobKind.PDF) !in storage.blobs, "partial result removed")
        }

        @Test
        fun `when the converter takes longer than the timeout then the conversion fails`() = runBlocking {
            converter.result = { flow { awaitCancellation() } }
            val file = pendingDocument()

            queue.convert(file.id)

            assertEquals("TIMEOUT", (audit.events.single().details as FileConverted).reason, "timeout")
            assertEquals(Conversion.FAILED, repository.rows.getValue(file.id).conversion, "state")
        }

        @Test
        fun `when the converter fails then the file is FAILED with a code, never the message of the converter`() = runBlocking {
            converter.result = { flow { throw ConversionFailedException("CONVERTER_HTTP_500") } }
            val file = pendingDocument()

            queue.convert(file.id)

            assertEquals("CONVERTER_HTTP_500", (audit.events.single().details as FileConverted).reason, "code")
        }

        @Test
        fun `when the file was deleted while it waited then nothing happens`() = runBlocking {
            val file = pendingDocument()
            repository.deleteByIds(listOf(file.id))

            queue.convert(file.id)

            assertTrue(converter.calls.isEmpty() && audit.events.isEmpty(), "skipped")
        }

        @Test
        fun `when the file is deleted while it is converted then the pdf is removed again`() = runBlocking {
            val file = pendingDocument()
            converter.result = {
                flow {
                    repository.deleteByIds(listOf(file.id))
                    emit(FakeConverter.PDF_BYTES)
                }
            }

            queue.convert(file.id)

            assertTrue(BlobKey(file.id, BlobKind.PDF) !in storage.blobs, "nobody can reach it any more")
        }

        @Test
        fun `when a file is submitted and the queue is full then it is FAILED with QUEUE_FULL, as on resume`() = runBlocking {
            val small = ConversionQueue(
                repository, storage, converter, DirectTransactions, audit, FilesLimits(conversionQueue = 1),
                CoroutineScope(Dispatchers.Unconfined), RecordingAppLogger(),
            )
            val first = pendingDocument()
            val second = pendingDocument()

            assertTrue(small.submit(first.id), "room for one")
            assertEquals(false, small.submit(second.id), "no room for the second")

            assertEquals(Conversion.PENDING, repository.rows.getValue(first.id).conversion, "the queued one waits")
            assertEquals(Conversion.FAILED, repository.rows.getValue(second.id).conversion, "the other one will never be looked at")
            val details = assertNotNull(audit.events.single().details as? FileConverted, "audited once")
            assertEquals("QUEUE_FULL", details.reason, "reason")
        }

        @Test
        fun `when the process restarted then pending files are queued again`() = runBlocking {
            val file = pendingDocument()

            queue.resume()
            queue.start()

            repeat(100) { if (repository.rows.getValue(file.id).conversion == Conversion.PENDING) kotlinx.coroutines.delay(20) }
            assertEquals(Conversion.DONE, repository.rows.getValue(file.id).conversion, "converted after the restart")
            queue.stop()
        }
    }
}
