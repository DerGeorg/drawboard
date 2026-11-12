package at.dergeorg.drawboard.files.domain

import at.dergeorg.drawboard.files.domain.detect.FileTypes
import at.dergeorg.drawboard.files.domain.files.ConversionQueue
import at.dergeorg.drawboard.files.domain.files.DirectTransactions
import at.dergeorg.drawboard.files.domain.files.FakeConverter
import at.dergeorg.drawboard.files.domain.files.FakeFileScanner
import at.dergeorg.drawboard.files.domain.files.FilesLimits
import at.dergeorg.drawboard.files.domain.files.InMemoryFileRepository
import at.dergeorg.drawboard.files.domain.files.RecordingFilesMetrics
import at.dergeorg.drawboard.files.domain.files.InMemoryFileStorage
import at.dergeorg.drawboard.files.domain.files.Samples
import at.dergeorg.drawboard.files.domain.files.asUpload
import at.dergeorg.drawboard.files.domain.files.model.Conversion
import at.dergeorg.drawboard.files.domain.files.model.FileKind
import at.dergeorg.drawboard.files.domain.files.model.FileConverted
import at.dergeorg.drawboard.files.domain.files.model.FileRejected
import at.dergeorg.drawboard.files.domain.files.model.FileUploaded
import at.dergeorg.drawboard.files.domain.files.model.FileVariant
import at.dergeorg.drawboard.files.domain.files.model.RangeNotSatisfiableException
import at.dergeorg.drawboard.files.domain.files.provides.OpenFileCommand
import at.dergeorg.drawboard.files.domain.files.provides.UploadCommand
import at.dergeorg.drawboard.files.domain.files.requires.BlobKey
import at.dergeorg.drawboard.files.domain.files.model.ScanUnavailableException
import at.dergeorg.drawboard.files.domain.files.requires.ScanVerdict
import at.dergeorg.drawboard.files.domain.files.requires.BlobKind
import at.dergeorg.drawboard.files.domain.images.ImageWorker
import at.dergeorg.drawboard.files.domain.urls.FileUrlSigner
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.PayloadTooLargeException
import at.dergeorg.drawboard.shared.error.RateLimitedException
import at.dergeorg.drawboard.shared.error.ValidationFailedException
import at.dergeorg.drawboard.shared.testing.MutableClock
import at.dergeorg.drawboard.shared.testing.RecordingAppLogger
import at.dergeorg.drawboard.shared.testing.RecordingAuditTrail
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.seconds
import kotlin.uuid.Uuid

class FilesServiceTest {

    private val clock = MutableClock()
    private val repository = InMemoryFileRepository()
    private val storage = InMemoryFileStorage()
    private val audit = RecordingAuditTrail()
    private val logger = RecordingAppLogger()
    private val converter = FakeConverter()
    private val metrics = RecordingFilesMetrics()
    private val scanner = FakeFileScanner()
    private val images = ImageWorker(threads = 1, timeout = 10.seconds)
    private val signer = FileUrlSigner(listOf(ByteArray(32) { 3 }), clock)
    private val board = Uuid.generateV7()
    private val alice = Uuid.generateV7()

    private fun service(limits: FilesLimits = FilesLimits(conversionEnabled = false)): FilesService {
        val queue = ConversionQueue(
            repository,
            storage,
            converter,
            DirectTransactions,
            audit,
            limits,
            CoroutineScope(Dispatchers.Unconfined),
            logger,
            metrics,
        )
        return FilesService(repository, storage, DirectTransactions, signer, images, queue, limits, audit, clock, logger, scanner, metrics)
    }

    @AfterEach
    fun closeImages() = images.close()

    private fun upload(name: String?, bytes: ByteArray, boardId: Uuid = board, user: Uuid = alice, chunk: Int = 1000) =
        UploadCommand(boardId, user, name, bytes.asUpload(chunk))

    private suspend inline fun failure(
        block: () -> Unit,
    ): DomainException = assertFailsWith<DomainException>("must be rejected") { block() }

    @Nested
    inner class Scanning {

        @Test
        fun `when no scanner is configured then the file is not even opened for a scan and is accepted`() = runTest {
            val none = FakeFileScanner(enabled = false)
            val limits = FilesLimits(conversionEnabled = false)
            val scope = CoroutineScope(Dispatchers.Unconfined)

            val stored = FilesService(
                repository, storage, DirectTransactions, signer, images,
                ConversionQueue(repository, storage, converter, DirectTransactions, audit, limits, scope, logger),
                limits, audit, clock, logger, none, metrics,
            ).upload(upload("a.png", Samples.png()))

            assertEquals(emptyList(), none.scanned, "nothing was handed to the scanner")
            assertEquals(emptyList(), metrics.scans, "and nothing was counted")
            assertNotNull(repository.rows[stored.id], "stored")
        }

        @Test
        fun `when the scan is clean then the file is stored and the scan was of the stored bytes`() = runTest {
            val png = Samples.png(40, 30)

            val stored = service().upload(upload("a.png", png))

            assertTrue(png.contentEquals(scanner.scanned.single()), "the scanner saw exactly the uploaded bytes")
            assertEquals(listOf("clean"), metrics.scans, "counted")
            assertNotNull(repository.rows[stored.id], "visible after the scan")
        }

        @Test
        fun `when the scan finds something then 415 without a signature, nothing is stored, and the audit event names it`() = runTest {
            scanner.verdict = ScanVerdict.Infected("Win.Test.EICAR_HDB-1")

            val error = failure { service().upload(upload("report.png", Samples.png())) }

            assertEquals(ErrorCode.FILES_TYPE_NOT_ALLOWED, error.errorCode, "the fitting code of the contract")
            assertTrue(error.params.isEmpty() && !error.message.orEmpty().contains("EICAR"), "the client is not told which signature")
            assertTrue(storage.blobs.isEmpty() && repository.rows.isEmpty(), "no bytes and no row stay")
            val event = audit.events.single()
            assertEquals("files.file.rejected", event.eventType, "audit event")
            val details = assertNotNull(event.details as? FileRejected, "details")
            assertEquals("Win.Test.EICAR_HDB-1" to "INFECTED", details.signature to details.reason, "signature and reason")
            assertEquals(64, details.sha256.length, "hash of the bytes")
            assertEquals(listOf("infected"), metrics.scans, "scan counter")
            assertEquals(listOf("infected"), metrics.uploads, "upload counter")
        }

        @Test
        fun `when the scanner cannot decide and the policy is open then the upload is accepted and the failure is counted`() = runTest {
            scanner.verdict = ScanVerdict.Unavailable("IO")

            val stored = service().upload(upload("a.png", Samples.png()))

            assertNotNull(repository.rows[stored.id], "accepted although it was not scanned")
            assertEquals(listOf("unavailable"), metrics.scans, "counted, so a scanner that is down does not go unnoticed")
            assertEquals(listOf("accepted"), metrics.uploads, "upload counter")
            assertTrue(logger.entries.any { it.message.contains("could not be scanned") }, "and logged")
        }

        @Test
        fun `when the scanner cannot decide and the policy is closed then the upload is refused and nothing stays`() = runTest {
            scanner.verdict = ScanVerdict.Unavailable("IO")

            val error = assertFailsWith<ScanUnavailableException>("fail closed") {
                service(FilesLimits(conversionEnabled = false, scanFailClosed = true)).upload(upload("a.png", Samples.png()))
            }

            assertEquals("IO", error.reason, "reason")
            assertTrue(storage.blobs.isEmpty() && repository.rows.isEmpty(), "rolled back")
            assertEquals(listOf("scan_failed"), metrics.uploads, "upload counter")
        }

        @Test
        fun `when the file is too large for the scanner and the policy is closed then 413 with the scanner's limit`() = runTest {
            scanner.verdict = ScanVerdict.TooLarge(26_214_400)

            val closed = service(FilesLimits(conversionEnabled = false, scanFailClosed = true))
            val error = failure { closed.upload(upload("a.png", Samples.png())) }

            assertEquals(ErrorCode.PAYLOAD_TOO_LARGE, error.errorCode, "the fitting code of the contract")
            assertEquals(mapOf("limit" to "26214400"), error.params, "the limit is the scanner's, not the upload cap")
            assertTrue(storage.blobs.isEmpty() && repository.rows.isEmpty(), "rolled back")
            assertEquals(listOf("too_large"), metrics.scans, "its own count: the scanner is not down")
            assertEquals(listOf("too_large"), metrics.uploads, "upload counter")
        }

        @Test
        fun `when the file is too large for the scanner and the policy is open then it is accepted and counted apart`() = runTest {
            scanner.verdict = ScanVerdict.TooLarge(10)

            val stored = service().upload(upload("a.png", Samples.png()))

            assertNotNull(repository.rows[stored.id], "accepted")
            assertEquals(listOf("too_large"), metrics.scans, "not counted as unavailable")
            assertEquals(listOf("accepted"), metrics.uploads, "upload counter")
            assertTrue(logger.entries.any { it.message.contains("larger than the scanner takes") }, "and logged")
        }

        @Test
        fun `when the stored blob cannot be opened and the policy is closed then the upload is refused with reason OPEN`() = runTest {
            storage.nextOpenFindsNothing = true

            val error = assertFailsWith<ScanUnavailableException>("fail closed") {
                service(FilesLimits(conversionEnabled = false, scanFailClosed = true)).upload(upload("a.png", Samples.png()))
            }

            assertEquals("OPEN", error.reason, "reason")
            assertEquals(emptyList(), scanner.scanned, "the scanner was not asked")
            assertEquals(listOf("unavailable"), metrics.scans, "counted")
            assertEquals(listOf("scan_failed"), metrics.uploads, "upload counter")
            assertTrue(storage.blobs.isEmpty() && repository.rows.isEmpty(), "rolled back")
        }

        @Test
        fun `when the stored blob cannot be opened and the policy is open then it is accepted and counted as unavailable`() = runTest {
            storage.nextOpenFindsNothing = true

            val stored = service().upload(upload("a.png", Samples.png()))

            assertNotNull(repository.rows[stored.id], "accepted")
            assertEquals(listOf("unavailable"), metrics.scans, "no longer skipped silently")
            assertTrue(logger.entries.any { it.message.contains("could not be scanned") }, "and logged")
        }

        @Test
        fun `when the scanner is clean for a file that is not on the allowlist then the type check still refuses it`() = runTest {
            val error = failure { service().upload(upload("holiday.png", Samples.exe())) }

            assertEquals(ErrorCode.FILES_TYPE_NOT_ALLOWED, error.errorCode, "the scan is no substitute for the allowlist")
        }
    }

    @Nested
    inner class Uploading {

        @Test
        fun `when a png is uploaded then it is stored under its id with metadata, size from the header and an audit event`() = runTest {
            val png = Samples.png(40, 30)

            val stored = service().upload(upload("photo.png", png))

            assertEquals("image/png", stored.mediaType, "detected from the content")
            assertEquals(FileKind.IMAGE, stored.kind, "kind")
            assertEquals(png.size.toLong(), stored.size, "size")
            assertEquals(40 to 30, stored.width to stored.height, "dimensions from the header")
            assertEquals(alice, stored.createdBy, "uploader")
            assertTrue(
                png.contentEquals(storage.blobs.getValue(BlobKey(stored.id, BlobKind.ORIGINAL))),
                "the bytes are stored under the id",
            )
            val event = audit.events.single()
            assertEquals("files.file.created", event.eventType, "audit event")
            assertEquals(stored.id.toString(), event.entityId, "audit entity")
            val details = assertNotNull(event.details as? FileUploaded, "details")
            assertEquals(64, details.sha256.length, "sha-256 of the bytes in the audit event")
        }

        @Test
        fun `when uploads succeed or are refused then the metric counts each with a fixed result word`() = runTest {
            val service = service()
            service.upload(upload("a.png", Samples.png()))
            failure { service.upload(upload("holiday.png", Samples.exe())) }

            assertEquals(listOf("accepted", "type_not_allowed"), metrics.uploads, "one accepted, one refused for its type")
        }

        @Test
        fun `when the client lies about the type then the content decides - an exe named png is a 415`() = runTest {
            val error = failure { service().upload(upload("holiday.png", Samples.exe())) }

            assertEquals(ErrorCode.FILES_TYPE_NOT_ALLOWED, error.errorCode, "renamed exe")
            assertTrue(storage.blobs.isEmpty() && repository.rows.isEmpty(), "nothing is stored")
        }

        @Test
        fun `when the upload is an SVG then it is a 415 even with an image name`() = runTest {
            val error = failure { service().upload(upload("logo.svg", Samples.svg())) }

            assertEquals(ErrorCode.FILES_TYPE_NOT_ALLOWED, error.errorCode, "svg")
            assertTrue(storage.blobs.isEmpty(), "nothing is stored")
        }

        @Test
        fun `when the extension does not match the content then it is a 415 and nothing stays`() = runTest {
            val error = failure { service().upload(upload("photo.jpg", Samples.png())) }

            assertEquals(ErrorCode.FILES_TYPE_NOT_ALLOWED, error.errorCode, "png named jpg")
            assertEquals("image/png", error.params["mediaType"], "the detected type is named")
            assertTrue(storage.blobs.isEmpty() && repository.rows.isEmpty(), "rolled back")
        }

        @Test
        fun `when the name has no extension then the file is refused`() = runTest {
            assertEquals(
                ErrorCode.FILES_TYPE_NOT_ALLOWED,
                failure { service().upload(upload("photo", Samples.png())) }.errorCode,
                "no extension",
            )
            assertEquals(ErrorCode.FILES_TYPE_NOT_ALLOWED, failure { service().upload(upload(null, Samples.png())) }.errorCode, "no name")
        }

        @Test
        fun `when an empty file is uploaded then it is refused`() = runTest {
            assertEquals(ErrorCode.FILES_TYPE_NOT_ALLOWED, failure { service().upload(upload("a.png", ByteArray(0))) }.errorCode, "empty")
        }

        @Test
        fun `when the name is a path then only the sanitised last part is kept in the metadata, never used for the storage`() = runTest {
            val stored = service().upload(upload("../../etc/Report Q3.PNG", Samples.png()))

            assertEquals("Report Q3.PNG", stored.name, "sanitised name")
            assertTrue(storage.blobs.keys.all { it.fileId == stored.id }, "blobs are keyed by the id")
        }

        @Test
        fun `when a pdf is uploaded then it is a PDF without conversion`() = runTest {
            val stored = service().upload(upload("plan.pdf", Samples.pdf()))

            assertEquals(FileKind.PDF to Conversion.NONE, stored.kind to stored.conversion, "pdf")
        }

        @Test
        fun `when a webp is uploaded then its size is read from the header and there is no thumbnail`() = runTest {
            val stored = service().upload(upload("a.webp", Samples.webp(8, 6)))

            assertEquals(8 to 6, stored.width to stored.height, "dimensions")
            assertNull(stored.thumbnailMediaType, "the JDK cannot decode WebP")
        }

        @Test
        fun `when a JPEG header cannot be walked to its scan then 400 on field file, even though FF DA appears later`() = runTest {
            val plain = Samples.jpeg(16, 8)
            val sof = plain.indices.first { plain[it] == 0xFF.toByte() && plain[it + 1] == 0xC0.toByte() }
            val dht = (sof + 2 until plain.size).first { plain[it] == 0xFF.toByte() && plain[it + 1] == 0xC4.toByte() }
            // the frame header (and so the size) is intact, the segment after it claims 64 KiB: the walk fails, the scan marker is there
            val broken = plain.copyOf().also {
                it[dht + 2] = 0xFF.toByte()
                it[dht + 3] = 0xFF.toByte()
            }
            assertTrue(broken.indices.any { broken[it] == 0xFF.toByte() && broken.getOrNull(it + 1) == 0xDA.toByte() }, "it has a FF DA")

            val error = assertFailsWith<ValidationFailedException>("refused") { service().upload(upload("broken.jpg", broken)) }

            assertEquals(listOf("file"), error.invalidFields.map { it.field }, "on the field file")
            assertEquals(ErrorCode.VALIDATION_FAILED, error.errorCode, "the existing code")
            assertTrue(storage.blobs.isEmpty() && repository.rows.isEmpty(), "nothing is stored")
        }

        @Test
        fun `when a JPEG carries a multi-picture APP2 and an ICC profile then the first is gone and the second stays`() = runTest {
            fun segment(marker: Int, payload: ByteArray) =
                byteArrayOf(0xFF.toByte(), marker.toByte(), ((payload.size + 2) shr 8).toByte(), (payload.size + 2).toByte()) + payload
            val plain = Samples.jpeg(16, 8)
            val withBlocks = plain.copyOf(2) +
                segment(0xE2, "ICC_PROFILE\u0000".toByteArray() + ByteArray(20)) +
                segment(0xE2, "MPF\u0000".toByteArray() + "GPS 48.2N".toByteArray()) + plain.copyOfRange(2, plain.size)

            val stored = service().upload(upload("cam.jpg", withBlocks))

            val bytes = String(storage.blobs.getValue(BlobKey(stored.id, BlobKind.ORIGINAL)), Charsets.ISO_8859_1)
            assertTrue("MPF" !in bytes && "GPS" !in bytes, "the multi-picture block is not stored")
            assertTrue("ICC_PROFILE" in bytes, "the colour profile is")
            assertEquals(bytes.length.toLong(), stored.size, "the size is the stripped size")
        }

        @Test
        fun `when a progressive JPEG is above the progressive cap then it is stored without a thumbnail, not refused`() = runTest {
            val limits = FilesLimits(maxProgressivePixels = 1_000, conversionEnabled = false)

            val stored = service(limits).upload(upload("big.jpg", Samples.progressiveJpeg(64, 48))) // 3072 pixels

            assertEquals(64 to 48, stored.width to stored.height, "dimensions from the header")
            assertNull(stored.thumbnailMediaType, "no thumbnail for a progressive JPEG above the cap")
            assertTrue(BlobKey(stored.id, BlobKind.ORIGINAL) in storage.blobs, "the original is stored")
            assertTrue(BlobKey(stored.id, BlobKind.THUMBNAIL) !in storage.blobs, "no thumbnail blob")
            assertTrue(logger.entries.any { "progressive" in it.message }, "the decision is logged")
        }

        @Test
        fun `when a progressive JPEG is within the cap or a baseline one is above it then both get a thumbnail`() = runTest {
            val limits = FilesLimits(maxProgressivePixels = 1_000, conversionEnabled = false)

            val smallProgressive = service(limits).upload(upload("a.jpg", Samples.progressiveJpeg(20, 20))) // 400 pixels
            val bigBaseline = service(limits).upload(upload("b.jpg", Samples.jpeg(64, 48)))

            assertEquals("image/jpeg", smallProgressive.thumbnailMediaType, "progressive below the cap")
            assertEquals("image/jpeg", bigBaseline.thumbnailMediaType, "the cap is for progressive JPEGs only")
        }

        @Test
        fun `when a video is uploaded then it is accepted up to the video cap`() = runTest {
            val limits = FilesLimits(maxFileBytes = 70_000, maxVideoBytes = 200_000, conversionEnabled = false)
            val video = Samples.mp4(120_000)

            val stored = service(limits).upload(upload("clip.mp4", video, chunk = 10_000))

            assertEquals(FileKind.VIDEO, stored.kind, "video")
            assertEquals(120_000L, stored.size, "size")
        }
    }

    @Nested
    inner class Caps {

        @Test
        fun `when the body is larger than the cap then it is cut off while streaming - Content-Length is never consulted`() = runTest {
            val limits = FilesLimits(maxFileBytes = 5_000, conversionEnabled = false)
            var delivered = 0
            val endless = flow {
                emit(Samples.png(50, 50))
                while (true) {
                    emit(ByteArray(1000))
                    delivered += 1000
                    if (delivered > 1_000_000) error("the stream was not stopped")
                }
            }

            val error = assertFailsWith<PayloadTooLargeException>("above the cap") {
                service(limits).upload(UploadCommand(board, alice, "a.png", endless))
            }

            assertEquals("5000", error.params["limit"], "limit")
            assertTrue(delivered < 20_000, "the producer was stopped right after the cap: $delivered")
            assertTrue(storage.blobs.isEmpty() && repository.rows.isEmpty(), "nothing is stored")
        }

        @Test
        fun `when a video is above the file cap but below the video cap then it passes, other kinds are cut at the file cap`() = runTest {
            val limits = FilesLimits(maxFileBytes = 70_000, maxVideoBytes = 200_000, conversionEnabled = false)
            val bigPdf = Samples.pdf() + ByteArray(100_000)

            assertFailsWith<PayloadTooLargeException>("a pdf of 100 kB with a cap of 70 kB") {
                service(limits).upload(upload("big.pdf", bigPdf, chunk = 10_000))
            }
        }

        @Test
        fun `when an image has more than 50 megapixels in its header then it is refused before it is decoded`() = runTest {
            val png = Samples.withPngSize(Samples.png(), 9000, 9000)

            val error = assertFailsWith<ValidationFailedException>("81 megapixels") { service().upload(upload("big.png", png)) }

            assertEquals("file", error.invalidFields.single().field, "violation on the file")
            assertTrue(storage.blobs.isEmpty(), "nothing stays")
        }
    }

    @Nested
    inner class Quotas {

        @Test
        fun `when the board holds the maximum number of files then the next upload is a 413 with scope BOARD`() = runTest {
            val limits = FilesLimits(maxFilesPerBoard = 2, conversionEnabled = false)
            val service = service(limits)
            service.upload(upload("a.png", Samples.png()))
            service.upload(upload("b.png", Samples.png()))

            val error = failure { service.upload(upload("c.png", Samples.png())) }

            assertEquals(ErrorCode.FILES_QUOTA_EXCEEDED, error.errorCode, "501st file")
            assertEquals("BOARD", error.params["scope"], "scope")
            assertEquals(2, repository.rows.size, "nothing was added")
        }

        @Test
        fun `when the upload would exceed the quota of the user then it is a 413 with scope USER and nothing is stored`() = runTest {
            val png = Samples.png(40, 30)
            val limits = FilesLimits(maxBytesPerUser = png.size * 2L - 1, conversionEnabled = false)
            val service = service(limits)
            service.upload(upload("a.png", png))

            val error = failure { service.upload(upload("b.png", png)) }

            assertEquals(ErrorCode.FILES_QUOTA_EXCEEDED, error.errorCode, "quota")
            assertEquals("USER" to limits.maxBytesPerUser.toString(), error.params["scope"] to error.params["limit"], "scope and limit")
            assertEquals(1, storage.blobs.keys.map { it.fileId }.toSet().size, "only the first file is stored")
        }

        @Test
        fun `when the upload would exceed the quota of the board then it is a 413 with scope BOARD even for another user`() = runTest {
            val png = Samples.png(40, 30)
            val limits = FilesLimits(maxBytesPerBoard = png.size * 2L - 1, conversionEnabled = false)
            val service = service(limits)
            service.upload(upload("a.png", png))

            val error = failure { service.upload(upload("b.png", png, user = Uuid.generateV7())) }

            assertEquals("BOARD", error.params["scope"], "board quota")
        }

        @Test
        fun `when a document was converted then its PDF counts against the quotas of the user and the board`() = runBlocking {
            // runBlocking: the conversion has a real time limit, runTest's virtual time would let it expire at once
            val docx = Samples.ooxml("word/document.xml")
            val png = Samples.png(40, 30)
            val limits = FilesLimits(maxBytesPerUser = docx.size + png.size + 100L, maxBytesPerBoard = 1_000_000, conversionEnabled = true)
            val service = service(limits)
            val stored = service.upload(upload("a.docx", docx))
            converter.result = { flow { emit(FakeConverter.PDF_BYTES + ByteArray(200)) } }
            val scope = CoroutineScope(Dispatchers.Unconfined)
            ConversionQueue(repository, storage, converter, DirectTransactions, audit, limits, scope, logger, metrics).convert(stored.id)
            assertEquals(listOf("done"), metrics.conversions, "a finished conversion is counted")
            val pdfSize = checkNotNull(repository.rows.getValue(stored.id).pdfSize) { "the conversion did not finish" }

            val error = failure { service.upload(upload("b.png", png)) }

            assertEquals(docx.size + pdfSize, repository.usedBytesOfUser(alice), "originals plus PDFs")
            assertEquals(docx.size + pdfSize, repository.usedBytesOfBoard(board), "the board counts them as well")
            assertEquals(ErrorCode.FILES_QUOTA_EXCEEDED to "USER", error.errorCode to error.params["scope"], "only the original fits")
        }

        @Test
        fun `when a user uploads too often then it is a 429 and the byte budget counts too`() = runTest {
            val service = service(FilesLimits(uploadsPerMinute = 2, conversionEnabled = false))
            service.upload(upload("a.png", Samples.png()))
            service.upload(upload("b.png", Samples.png()))

            assertFailsWith<RateLimitedException>("third upload within a minute") { service.upload(upload("c.png", Samples.png())) }
            val other = service(FilesLimits(uploadBytesPerMinute = 100, conversionEnabled = false))
            other.upload(upload("a.png", Samples.png(100, 100)))
            assertFailsWith<RateLimitedException>("bytes of the minute used up") { other.upload(upload("b.png", Samples.png())) }
            clock.advanceBy(61.seconds)
            service.upload(upload("c.png", Samples.png()))
        }
    }

    @Nested
    inner class Documents {

        @Test
        fun `when a docx is uploaded with a converter then it is PENDING and queued`() = runTest {
            val stored = service(FilesLimits(conversionEnabled = true)).upload(upload("report.docx", Samples.ooxml("word/document.xml")))

            assertEquals(FileKind.DOCUMENT to Conversion.PENDING, stored.kind to stored.conversion, "document")
            assertEquals(FileTypes.DOCX, stored.mediaType, "ooxml told apart from the entry names")
        }

        @Test
        fun `when a docx is uploaded without a converter then it is stored and the conversion FAILED`() = runTest {
            val stored = service(FilesLimits(conversionEnabled = false)).upload(upload("report.docx", Samples.ooxml("word/document.xml")))

            assertEquals(Conversion.FAILED, stored.conversion, "the original stays downloadable")
        }

        @Test
        fun `when a zip is not an office document then it is a 415`() = runTest {
            val error = failure { service().upload(upload("archive.docx", Samples.zip("readme.txt" to "hi"))) }

            assertEquals(ErrorCode.FILES_TYPE_NOT_ALLOWED, error.errorCode, "a zip is no document")
            assertTrue(storage.blobs.isEmpty(), "nothing stays")
        }

        @Test
        fun `when a spreadsheet is named like a text document then the extension check refuses it`() = runTest {
            val error = failure { service().upload(upload("sheet.docx", Samples.ooxml("xl/workbook.xml"))) }

            assertEquals(FileTypes.XLSX, error.params["mediaType"], "the detected type")
        }

        @Test
        fun `when the conversion queue is full then the file is FAILED with QUEUE_FULL, audited, and the original stays`() = runTest {
            val service = service(FilesLimits(conversionQueue = 1, conversionEnabled = true))
            val queued = service.upload(upload("a.docx", Samples.ooxml("word/document.xml")))

            val overflow = service.upload(upload("b.docx", Samples.ooxml("word/document.xml")))

            assertEquals(Conversion.PENDING, queued.conversion, "the first one waits for the worker")
            assertEquals(Conversion.FAILED, overflow.conversion, "the answer already says FAILED")
            assertEquals(Conversion.FAILED, repository.rows.getValue(overflow.id).conversion, "and so does the row")
            assertEquals(Conversion.PENDING, repository.rows.getValue(queued.id).conversion, "the queued one is untouched")
            assertTrue(BlobKey(overflow.id, BlobKind.ORIGINAL) in storage.blobs, "the original is kept and downloadable")
            val failure = audit.events.last { it.eventType == "files.file.converted" }
            assertEquals(overflow.id.toString(), failure.entityId, "audit entity")
            assertEquals("QUEUE_FULL", (failure.details as FileConverted).reason, "the reason is a code")
            assertTrue(logger.entries.any { it.message == "file conversion queue is full" }, "logged")
        }

        @Test
        fun `when more conversions are started than a user may per minute then it is a 429`() = runTest {
            val service = service(FilesLimits(conversionsPerMinute = 1, conversionEnabled = true))
            service.upload(upload("a.docx", Samples.ooxml("word/document.xml")))

            assertFailsWith<RateLimitedException>(
                "second conversion",
            ) { service.upload(upload("b.docx", Samples.ooxml("word/document.xml"))) }
            assertEquals(1, repository.rows.size, "the rejected upload left nothing")
        }
    }

    @Nested
    inner class Reading {

        @Test
        fun `when listing then the files of the board come newest first and files of other boards stay out`() = runTest {
            val service = service()
            val first = service.upload(upload("a.png", Samples.png()))
            clock.advanceBy(1.seconds)
            val second = service.upload(upload("b.png", Samples.png()))
            service.upload(upload("c.png", Samples.png(), boardId = Uuid.generateV7()))

            assertEquals(listOf(second.id, first.id), service.listFiles(board).map { it.id }, "newest first")
        }

        @Test
        fun `when a file belongs to another board then getting it is FILES_FILE_NOT_FOUND`() = runTest {
            val service = service()
            val stored = service.upload(upload("a.png", Samples.png()))

            assertEquals(ErrorCode.FILES_FILE_NOT_FOUND, failure { service.getFile(Uuid.generateV7(), stored.id) }.errorCode, "other board")
            assertEquals(ErrorCode.FILES_FILE_NOT_FOUND, failure { service.getFile(board, Uuid.generateV7()) }.errorCode, "unknown id")
        }

        @Test
        fun `when deleting a file then metadata and every blob are gone and the event is audited`() = runTest {
            val service = service()
            val stored = service.upload(upload("a.png", Samples.png()))

            service.deleteFile(board, stored.id)

            assertTrue(repository.rows.isEmpty() && storage.blobs.isEmpty(), "gone")
            assertEquals("files.file.deleted", audit.events.last().eventType, "audit")
            assertEquals(ErrorCode.FILES_FILE_NOT_FOUND, failure { service.deleteFile(board, stored.id) }.errorCode, "twice")
        }

        @Test
        fun `when deleting through another board then nothing happens`() = runTest {
            val service = service()
            val stored = service.upload(upload("a.png", Samples.png()))

            assertEquals(
                ErrorCode.FILES_FILE_NOT_FOUND,
                failure { service.deleteFile(Uuid.generateV7(), stored.id) }.errorCode,
                "wrong board",
            )
            assertEquals(1, repository.rows.size, "still there")
        }
    }

    @Nested
    inner class Urls {

        @Test
        fun `when issuing urls then only files of the board are answered, in the order asked, each at most once`() = runTest {
            val service = service()
            val a = service.upload(upload("a.png", Samples.png()))
            val b = service.upload(upload("b.pdf", Samples.pdf()))
            val foreign = service.upload(upload("c.png", Samples.png(), boardId = Uuid.generateV7()))

            val issued = service.issueUrls(board, listOf(b.id, foreign.id, a.id, b.id, Uuid.generateV7()))

            assertEquals(listOf(b.id, a.id), issued.items.map { it.fileId }, "order of the ids, unknown and foreign ids left out")
            assertEquals(clock.now() + 3600.seconds, issued.expiresAt, "one hour")
            assertTrue(issued.items.all { it.originalUrl.startsWith("/files/${it.fileId}?v=original&exp=") }, "original urls")
            assertNull(issued.items.first().thumbnailUrl, "a pdf has no thumbnail")
        }
    }

    @Nested
    inner class Serving {

        private suspend fun FilesService.urlOf(
            stored: at.dergeorg.drawboard.files.domain.files.model.StoredFile,
            variant: FileVariant = FileVariant.ORIGINAL,
        ): OpenFileCommand {
            val query = signer.url(
                stored.id,
                variant,
                signer.expiry(),
            ).substringAfter('?').split('&').associate { it.substringBefore('=') to it.substringAfter('=') }
            return OpenFileCommand(stored.id, query.getValue("v"), query.getValue("exp").toLong(), query.getValue("sig"), range = null)
        }

        @Test
        fun `when the signature is valid then the variant is opened with its type, size and disposition`() = runTest {
            val service = service()
            val stored = service.upload(upload("a.png", Samples.png()))
            val png = service.open(service.urlOf(stored))

            assertEquals("image/png", png.mediaType, "media type")
            assertTrue(png.inline, "images are inline")
            assertEquals(stored.size, png.size, "size")
            assertNull(png.range, "whole")
            val pdf = service.upload(upload("b.pdf", Samples.pdf()))
            assertEquals(false, service.open(service.urlOf(pdf)).inline, "everything but images and videos is an attachment (S4.5)")
        }

        @Test
        fun `when the signature, the variant or the expiry is wrong then it is always the same FILES_URL_INVALID`() = runTest {
            val service = service()
            val stored = service.upload(upload("a.png", Samples.png()))
            val good = service.urlOf(stored)
            suspend fun bad(command: OpenFileCommand) = failure { service.open(command) }
            val unknownFile = OpenFileCommand(Uuid.generateV7(), good.variant, good.exp, good.signature, null)

            val failures = listOf(
                bad(OpenFileCommand(good.fileId, good.variant, good.exp, "A".repeat(43), null)),
                bad(OpenFileCommand(good.fileId, "pdf", good.exp, good.signature, null)),
                bad(OpenFileCommand(good.fileId, "nonsense", good.exp, good.signature, null)),
                bad(OpenFileCommand(good.fileId, good.variant, good.exp - 4000, good.signature, null)),
                bad(unknownFile),
            )

            assertTrue(
                failures.all { it.errorCode == ErrorCode.FILES_URL_INVALID },
                "one answer for every way it can be wrong: ${failures.map { it.errorCode }}",
            )
            assertEquals(1, failures.map { it.message }.toSet().size, "the same body")
        }

        @Test
        fun `when the url is valid but the file was deleted then it is a 404, not a 403`() = runTest {
            val service = service()
            val stored = service.upload(upload("a.png", Samples.png()))
            val command = service.urlOf(stored)
            service.deleteFile(board, stored.id)

            assertEquals(ErrorCode.FILES_FILE_NOT_FOUND, failure { service.open(command) }.errorCode, "valid url, gone file")
        }

        @Test
        fun `when a variant does not exist then a valid url answers 404`() = runTest {
            val service = service()
            val stored = service.upload(upload("a.pdf", Samples.pdf()))

            assertEquals(
                ErrorCode.FILES_FILE_NOT_FOUND,
                failure { service.open(service.urlOf(stored, FileVariant.THUMBNAIL)) }.errorCode,
                "no thumbnail",
            )
            assertEquals(
                ErrorCode.FILES_FILE_NOT_FOUND,
                failure { service.open(service.urlOf(stored, FileVariant.PDF)) }.errorCode,
                "no converted pdf",
            )
        }

        @Test
        fun `when a range is asked then one valid range is returned and anything else is a 416 carrying the size`() = runTest {
            val service = service()
            val stored = service.upload(upload("a.pdf", Samples.pdf()))
            val base = service.urlOf(stored)

            val partial = service.open(OpenFileCommand(base.fileId, base.variant, base.exp, base.signature, "bytes=2-9"))
            assertEquals(2L to 9L, partial.range?.first to partial.range?.last, "one range")
            listOf("bytes=0-1,5-6", "bytes=99999-", "garbage").forEach { header ->
                val error = assertFailsWith<RangeNotSatisfiableException>("range $header") {
                    service.open(OpenFileCommand(base.fileId, base.variant, base.exp, base.signature, header))
                }
                assertEquals(stored.size, error.size, "Content-Range carries the size")
            }
        }
    }

    @Nested
    inner class Cleaning {

        @Test
        fun `when boards are purged then their files and blobs are removed with an audit event per file`() = runTest {
            val service = service()
            val other = Uuid.generateV7()
            service.upload(upload("a.png", Samples.png()))
            service.upload(upload("b.pdf", Samples.pdf()))
            val kept = service.upload(upload("c.png", Samples.png(), boardId = other))

            val removed = service.deleteBoardData(listOf(board))

            assertEquals(2, removed, "files removed")
            assertEquals(listOf(kept.id), repository.rows.keys.toList(), "the other board is untouched")
            assertEquals(setOf(kept.id), storage.blobs.keys.map { it.fileId }.toSet(), "blobs follow")
            assertEquals(2, audit.events.count { it.eventType == "files.file.deleted" }, "audited")
        }

        @Test
        fun `when blobs have no metadata then the sweep removes them - but not young ones`() = runTest {
            val service = service()
            val stored = service.upload(upload("a.png", Samples.png()))
            val orphanOld = BlobKey(Uuid.generateV7(), BlobKind.ORIGINAL)
            val orphanYoung = BlobKey(Uuid.generateV7(), BlobKind.ORIGINAL)
            storage.blobs[orphanOld] = byteArrayOf(1)
            storage.modified[orphanOld] = clock.now() - 3.days
            storage.blobs[orphanYoung] = byteArrayOf(1)
            storage.modified[orphanYoung] = clock.now() - 1.seconds

            val removed = service.sweepOrphans()

            assertEquals(1, removed, "the old orphan")
            assertTrue(orphanOld !in storage.blobs && orphanYoung in storage.blobs, "a young blob may belong to a running upload")
            assertTrue(BlobKey(stored.id, BlobKind.ORIGINAL) in storage.blobs, "files with metadata stay")
        }
    }
}
