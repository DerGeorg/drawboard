package at.dergeorg.drawboard.files.infra

import at.dergeorg.drawboard.files.domain.files.requires.FilesMetrics
import io.micrometer.core.instrument.MeterRegistry
import org.springframework.beans.factory.ObjectProvider

/**
 * `drawboard.uploads{result}` and `drawboard.scans{result}` (the malware scan, S4.12) and `drawboard.conversions{result}` (S7.1: what was uploaded, what was converted). The result is a
 * fixed set of words, never a file name, a user or a board.
 */
internal class MicrometerFilesMetrics(private val registry: ObjectProvider<MeterRegistry>) : FilesMetrics {

    override fun upload(result: String) {
        registry.ifAvailable?.counter("drawboard.uploads", "result", result)?.increment()
    }

    override fun scan(result: String) {
        registry.ifAvailable?.counter("drawboard.scans", "result", result)?.increment()
    }

    override fun conversion(result: String) {
        registry.ifAvailable?.counter("drawboard.conversions", "result", result)?.increment()
    }
}
