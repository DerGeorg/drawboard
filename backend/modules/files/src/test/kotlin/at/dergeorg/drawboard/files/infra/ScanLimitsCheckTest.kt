package at.dergeorg.drawboard.files.infra

import at.dergeorg.drawboard.shared.testing.RecordingAppLogger
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ScanLimitsCheckTest {

    private val logger = RecordingAppLogger()

    private fun check(host: String? = "clamd", failClosed: Boolean = true, scannerBytes: Long = 25L * MIB, videoBytes: Long = 500L * MIB) =
        ScanLimitsCheck(
            FilesProperties(
                dir = "/data", clamavHost = host, clamavFailClosed = failClosed, clamavMaxBytes = scannerBytes, maxVideoBytes = videoBytes,
            ),
            logger,
        ).afterPropertiesSet()

    @Test
    fun `when the scanner fails closed and takes less than the largest video then a warning names both limits`() {
        check()

        val warning = logger.entries.single()
        assertTrue(warning.message.contains("fails closed"), "the warning says what is wrong")
        assertEquals(25L * MIB, warning.fields["files.clamav.max_bytes"], "scanner limit")
        assertEquals(500L * MIB, warning.fields["files.max_video_bytes"], "upload cap")
    }

    @Test
    fun `when the scanner takes at least the largest video then there is no warning`() {
        check(scannerBytes = 500L * MIB)

        assertEquals(emptyList(), logger.entries, "limits agree")
    }

    @Test
    fun `when the policy is open or no scanner is configured then there is no warning`() {
        check(failClosed = false)
        check(host = null)
        check(host = " ")

        assertEquals(emptyList(), logger.entries, "nothing to warn about")
    }

    private companion object {
        const val MIB = 1024L * 1024
    }
}
