package at.dergeorg.drawboard.files.domain.images

import at.dergeorg.drawboard.files.domain.files.Samples
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import javax.imageio.ImageIO
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ImagesTest {

    @Nested
    inner class Headers {

        @Test
        fun `when reading the header of an image then the size comes without decoding`() {
            assertEquals(Dimensions(40, 30), ImageHeaders.dimensions("image/png", Samples.png(40, 30)), "png")
            assertEquals(Dimensions(41, 31), ImageHeaders.dimensions("image/jpeg", Samples.jpeg(41, 31)), "jpeg")
            assertEquals(Dimensions(42, 32), ImageHeaders.dimensions("image/gif", Samples.gif(42, 32)), "gif")
            assertEquals(Dimensions(8, 6), ImageHeaders.dimensions("image/webp", Samples.webp(8, 6)), "webp")
        }

        @Test
        fun `when the frame header of a JPEG is progressive then the size says so, a baseline one does not`() {
            val progressive = assertNotNull(ImageHeaders.dimensions("image/jpeg", Samples.progressiveJpeg(64, 48)), "progressive")
            val baseline = assertNotNull(ImageHeaders.dimensions("image/jpeg", Samples.jpeg(64, 48)), "baseline")

            assertEquals(Dimensions(64, 48, progressive = true), progressive, "SOF2 is progressive")
            assertEquals(Dimensions(64, 48, progressive = false), baseline, "SOF0 is not")
        }

        @Test
        fun `when the frame marker is any of the progressive ones then it counts, the sequential ones do not`() {
            fun jpegWith(marker: Int) = byteArrayOf(
                0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), marker.toByte(), 0, 11, 8, 0, 20, 0, 30, 1, 1, 0x11, 0,
            )

            val progressive = listOf(0xC2, 0xC6, 0xCA, 0xCE).map { ImageHeaders.dimensions("image/jpeg", jpegWith(it))?.progressive }
            val sequential = listOf(0xC0, 0xC1, 0xC3, 0xC5, 0xC9).map { ImageHeaders.dimensions("image/jpeg", jpegWith(it))?.progressive }

            assertEquals(List(4) { true }, progressive, "SOF2, SOF6, SOF10, SOF14")
            assertEquals(List(5) { false }, sequential, "SOF0, SOF1, SOF3, SOF5, SOF9")
        }

        @Test
        fun `when the header claims a huge image then the size is known from the first bytes alone`() {
            // IHDR width and height set to 20000 x 20000 = 400 MP, far above the cap of 50 MP
            val png = Samples.withPngSize(Samples.png(), 20000, 20000).copyOf(24)

            val dimensions = assertNotNull(ImageHeaders.dimensions("image/png", png), "only 24 bytes are needed")
            assertTrue(dimensions.pixels > 50_000_000, "the caller rejects it before decoding: ${dimensions.pixels}")
        }

        @Test
        fun `when the bytes are cut off or are not of the claimed format then there is no size`() {
            assertNull(ImageHeaders.dimensions("image/png", ByteArray(10)), "truncated png")
            assertNull(ImageHeaders.dimensions("image/jpeg", Samples.png()), "a png is no jpeg")
            assertNull(ImageHeaders.dimensions("image/jpeg", Samples.jpeg().copyOf(12)), "jpeg cut before its frame header")
            assertNull(ImageHeaders.dimensions("application/pdf", Samples.pdf()), "not an image type")
        }
    }

    @Nested
    inner class Jpeg {

        /** A JPEG whose header carries an EXIF block with a GPS-like payload and the orientation 6, plus an XMP block and a comment. */
        private fun jpegWithMetadata(orientation: Int? = 6): ByteArray {
            val plain = Samples.jpeg(16, 8)
            val exif = StringBuilder().also { it.append("Exif\u0000\u0000") }.toString().toByteArray(Charsets.ISO_8859_1) +
                byteArrayOf('M'.code.toByte(), 'M'.code.toByte(), 0, 42, 0, 0, 0, 8) +
                (if (orientation != null) byteArrayOf(
                    0,
                    1,
                    0x01,
                    0x12,
                    0,
                    3,
                    0,
                    0,
                    0,
                    1,
                    0,
                    orientation.toByte(),
                    0,
                    0,
                ) else byteArrayOf(0, 0)) +
                byteArrayOf(0, 0, 0, 0) + "GPS: 48.2082N 16.3738E".toByteArray()
            fun segment(
                marker: Int,
                payload: ByteArray,
            ) = byteArrayOf(0xFF.toByte(), marker.toByte(), ((payload.size + 2) shr 8).toByte(), (payload.size + 2).toByte()) + payload
            val out = ByteArrayOutputStream()
            out.write(plain, 0, 2) // SOI
            out.write(segment(0xE1, exif))
            out.write(segment(0xE1, "http://ns.adobe.com/xap/1.0/\u0000<x:xmpmeta>author</x:xmpmeta>".toByteArray()))
            out.write(segment(0xFE, "made by someone".toByteArray()))
            out.write(plain, 2, plain.size - 2)
            return out.toByteArray()
        }

        private fun strippedOf(original: ByteArray): JpegMetadata.Stripped =
            assertIs<JpegMetadata.Stripped>(JpegMetadata.strip(original), "something to strip")

        private fun segment(marker: Int, payload: ByteArray) =
            byteArrayOf(0xFF.toByte(), marker.toByte(), ((payload.size + 2) shr 8).toByte(), (payload.size + 2).toByte()) + payload

        /** [Samples.jpeg] with [segments] right behind SOI. */
        private fun jpegWith(vararg segments: ByteArray): ByteArray {
            val plain = Samples.jpeg(16, 8)
            return plain.copyOf(2) + segments.fold(ByteArray(0)) { all, next -> all + next } + plain.copyOfRange(2, plain.size)
        }

        @Test
        fun `when a JPEG carries EXIF, XMP and a comment then they are removed and the image data is untouched`() {
            val original = jpegWithMetadata(orientation = null)
            val stripped = strippedOf(original)

            val result = stripped.head + original.copyOfRange(stripped.replacedBytes, original.size)

            val text = String(result, Charsets.ISO_8859_1)
            assertTrue("GPS" !in text && "xmpmeta" !in text && "made by someone" !in text, "no metadata is left")
            assertEquals(Dimensions(16, 8), ImageHeaders.dimensions("image/jpeg", result), "still the same image")
            assertNotNull(ImageIO.read(ByteArrayInputStream(result)), "still decodes")
        }

        @Test
        fun `when a JPEG has an orientation then only that tag survives, so the photo stays upright`() {
            val original = jpegWithMetadata(orientation = 6)
            val stripped = strippedOf(original)

            val result = stripped.head + original.copyOfRange(stripped.replacedBytes, original.size)

            val start = String(result, Charsets.ISO_8859_1).indexOf("Exif")
            assertEquals(6, JpegMetadata.orientationOf(result, start, 6 + 8 + 14 + 4), "orientation kept")
            assertTrue("GPS" !in String(result, Charsets.ISO_8859_1), "nothing else of the EXIF block")
        }

        @Test
        fun `when the walk reaches the start of the scan with nothing to remove then the answer is NothingToStrip`() {
            assertEquals(JpegMetadata.NothingToStrip, JpegMetadata.strip(Samples.jpeg()), "a clean file")
        }

        @Test
        fun `when the segments are damaged then the walk failed and nothing is read past the prefix`() {
            val original = jpegWithMetadata()

            assertEquals(JpegMetadata.WalkFailed, JpegMetadata.strip(original.copyOf(20)), "cut inside the header segments")
            assertEquals(
                JpegMetadata.WalkFailed,
                JpegMetadata.strip(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE1.toByte(), 0xFF.toByte(), 0xFF.toByte())),
                "a length beyond the data",
            )
            assertEquals(JpegMetadata.WalkFailed, JpegMetadata.strip(Samples.png()), "not a JPEG at all")
            assertEquals(JpegMetadata.WalkFailed, JpegMetadata.strip(Samples.jpeg().copyOf(60)), "no start of scan within the bytes")
        }

        @Test
        fun `when the walk breaks but the bytes FF DA appear later then it is still a failed walk - no byte scan`() {
            val plain = Samples.jpeg(16, 8)
            val broken = plain.copyOf(2) + segment(0xE1, ByteArray(10)) + byteArrayOf(0x00, 0x01) + ByteArray(20) +
                byteArrayOf(0xFF.toByte(), 0xDA.toByte()) + ByteArray(20)

            assertEquals(JpegMetadata.WalkFailed, JpegMetadata.strip(broken), "garbage between the segments is no way to the scan")
        }

        @Test
        fun `when a camera JPEG carries a multi-picture APP2 then it is removed, an ICC profile APP2 is kept`() {
            val icc = segment(0xE2, "ICC_PROFILE\u0000".toByteArray(Charsets.ISO_8859_1) + byteArrayOf(1, 1) + ByteArray(30) { 7 })
            val mpf = segment(0xE2, "MPF\u0000".toByteArray(Charsets.ISO_8859_1) + "Exif preview GPS: 48.2N".toByteArray())
            val original = jpegWith(icc, mpf)

            val stripped = strippedOf(original)
            val result = stripped.head + original.copyOfRange(stripped.replacedBytes, original.size)

            val text = String(result, Charsets.ISO_8859_1)
            assertTrue("MPF" !in text && "GPS" !in text, "the multi-picture block is gone")
            assertTrue("ICC_PROFILE" in text, "the colour profile stays")
            assertNotNull(ImageIO.read(ByteArrayInputStream(result)), "still decodes")
        }

        @Test
        fun `when an APP2 is too short to name itself then it is removed`() {
            val original = jpegWith(segment(0xE2, byteArrayOf(1, 2, 3)))

            assertEquals(true, JpegMetadata.strip(original) is JpegMetadata.Stripped, "an unnamed APP2 goes")
        }
    }

    @Nested
    inner class Thumbnails {

        @Test
        fun `when making a thumbnail of a big JPEG then it is at most 512 pixels, re-encoded as JPEG`() {
            val thumbnail = assertNotNull(ImageThumbnails.create(Samples.jpeg(2000, 1000), "image/jpeg"), "decodes")

            val image = checkNotNull(ImageIO.read(ByteArrayInputStream(thumbnail.data)))
            assertEquals("image/jpeg", thumbnail.mediaType, "media type")
            assertEquals(512, image.width, "long side")
            assertEquals(256, image.height, "aspect ratio kept")
        }

        @Test
        fun `when making a thumbnail of a PNG with transparency then it stays a PNG`() {
            val thumbnail = assertNotNull(ImageThumbnails.create(Samples.png(30, 20, alpha = true), "image/png"), "decodes")

            assertEquals("image/png", thumbnail.mediaType, "alpha needs png")
            assertContentEquals(
                byteArrayOf(0x89.toByte(), 'P'.code.toByte(), 'N'.code.toByte(), 'G'.code.toByte()),
                thumbnail.data.copyOf(4),
                "a png file",
            )
        }

        @Test
        fun `when the thumbnail is made then no metadata of the source is in it`() {
            val thumbnail = assertNotNull(ImageThumbnails.create(Samples.jpeg(100, 100), "image/jpeg"), "decodes")

            val text = String(thumbnail.data, Charsets.ISO_8859_1)
            assertTrue("Exif" !in text && "xmpmeta" !in text, "freshly encoded: no APP1 segment")
        }

        @Test
        fun `when the bytes cannot be decoded then there is no thumbnail and no exception`() {
            assertNull(ImageThumbnails.create(Samples.png().copyOf(30), "image/png"), "truncated")
            assertNull(ImageThumbnails.create(ByteArray(100), "image/png"), "noise")
            assertNull(ImageThumbnails.create(Samples.webp(), "image/webp"), "the JDK has no WebP decoder")
        }
    }
}
