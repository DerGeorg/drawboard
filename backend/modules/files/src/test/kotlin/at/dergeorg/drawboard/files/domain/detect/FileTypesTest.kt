package at.dergeorg.drawboard.files.domain.detect

import at.dergeorg.drawboard.files.domain.files.Samples
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.CsvSource
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class FileTypesTest {

    private fun known(bytes: ByteArray): String? = (FileTypes.detect(bytes) as? FileTypes.Detection.Known)?.type?.mediaType

    @Nested
    inner class Detecting {

        @Test
        fun `when the content is an image then the type comes from the magic bytes`() {
            assertEquals("image/png", known(Samples.png()), "png")
            assertEquals("image/jpeg", known(Samples.jpeg()), "jpeg")
            assertEquals("image/gif", known(Samples.gif()), "gif")
            assertEquals("image/webp", known(Samples.webp()), "webp")
        }

        @Test
        fun `when the content is a video or a pdf then it is on the allowlist`() {
            assertEquals("video/mp4", known(Samples.mp4()), "mp4")
            assertEquals("video/webm", known(Samples.webm()), "webm")
            assertEquals("application/pdf", known(Samples.pdf()), "pdf")
        }

        @Test
        fun `when the content is an SVG then it is not allowed whatever its name is`() {
            val detection = FileTypes.detect(Samples.svg())

            assertIs<FileTypes.Detection.Other>(detection, "an SVG is XML text, never on the allowlist (S4.3)")
        }

        @Test
        fun `when the content is a QuickTime movie then it is not on the allowlist although it looks like MP4`() {
            assertIs<FileTypes.Detection.Other>(FileTypes.detect(Samples.quicktime()), "brand qt")
        }

        @Test
        fun `when the content is a Windows executable then it is not allowed`() {
            assertIs<FileTypes.Detection.Other>(FileTypes.detect(Samples.exe()), "MZ header")
        }

        @Test
        fun `when nothing is recognised then there is no media type to name`() {
            val detection = FileTypes.detect(ByteArray(200) { (it % 7).toByte() })

            assertEquals(FileTypes.Detection.Other(null), detection, "noise")
        }

        @Test
        fun `when the content is a ZIP then the real type needs the entry names`() {
            assertIs<FileTypes.Detection.Zip>(FileTypes.detect(Samples.ooxml("word/document.xml")), "ooxml")
            assertIs<FileTypes.Detection.Zip>(FileTypes.detect(Samples.odf(FileTypes.ODT)), "odf")
        }
    }

    @Nested
    inner class Extensions {

        @ParameterizedTest(name = "{0} as {1} -> {2}")
        @CsvSource(
            "photo.PNG,image/png,true", "photo.jpg,image/jpeg,true", "photo.jpeg,image/jpeg,true", "photo.png,image/jpeg,false",
            "noextension,image/png,false", "report.pdf,application/pdf,true", "evil.html.png,image/png,true",
            "x.docx,application/pdf,false",
        )
        fun `when comparing the extension with the detected type then only a fitting one passes`(
            name: String,
            media: String,
            fits: Boolean,
        ) {
            assertEquals(fits, FileTypes.extensionMatches(name, FileTypes.ALLOWED.getValue(media)), "extension of $name")
        }
    }

    @Nested
    inner class Zips {

        private fun sniff(bytes: ByteArray) = ZipSniffer(bytes.size.toLong()) { from, length ->
            bytes.copyOfRange(from.toInt(), minOf(bytes.size, from.toInt() + length))
        }.documentType()

        @Test
        fun `when the entries are those of a Word, Excel or PowerPoint file then the type is told apart`() {
            assertEquals(FileTypes.DOCX, sniff(Samples.ooxml("word/document.xml")), "docx")
            assertEquals(FileTypes.XLSX, sniff(Samples.ooxml("xl/workbook.xml")), "xlsx")
            assertEquals(FileTypes.PPTX, sniff(Samples.ooxml("ppt/presentation.xml")), "pptx")
        }

        @Test
        fun `when the first entry is the stored mimetype of OpenDocument then that type counts`() {
            assertEquals(FileTypes.ODT, sniff(Samples.odf(FileTypes.ODT)), "odt")
            assertEquals(FileTypes.ODS, sniff(Samples.odf(FileTypes.ODS)), "ods")
            assertEquals(FileTypes.ODP, sniff(Samples.odf(FileTypes.ODP)), "odp")
        }

        @Test
        fun `when it is some other ZIP then it is not a document`() {
            assertNull(sniff(Samples.zip("readme.txt" to "hi")), "a plain archive")
            assertNull(
                sniff(Samples.zip("[Content_Types].xml" to "<Types/>", "other/file.xml" to "<x/>")),
                "an OPC package that is no Office document",
            )
            assertNull(sniff(Samples.odf("application/x-evil")), "a mimetype entry that names no OpenDocument type")
        }

        @Test
        fun `when the bytes are not a ZIP or are cut off then nothing is read past the end`() {
            assertNull(sniff(ByteArray(10)), "too short")
            assertNull(sniff(Samples.ooxml("word/document.xml").copyOf(40)), "truncated: no end of central directory")
            assertFalse(sniff(Samples.png()) != null, "a png is no zip")
        }

        @Test
        fun `when a central directory claims to be huge then it is refused instead of read`() {
            val zip = Samples.ooxml("word/document.xml")
            val bytes = zip.copyOf()
            // end of central directory: size of the central directory (offset 12) set to 100 MB
            val eocd = bytes.size - 22
            bytes[eocd + 12] = 0; bytes[eocd + 13] = 0; bytes[eocd + 14] = 0x40; bytes[eocd + 15] = 6

            assertNull(sniff(bytes), "a directory above the limit")
            assertTrue(ZipSniffer.MAX_DIRECTORY_BYTES < 100L * 1024 * 1024, "the limit is far below")
        }
    }
}
