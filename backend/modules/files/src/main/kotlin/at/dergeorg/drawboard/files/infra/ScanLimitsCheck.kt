package at.dergeorg.drawboard.files.infra

import at.dergeorg.drawboard.shared.logging.AppLogger
import org.springframework.beans.factory.InitializingBean

/**
 * Warns at start when the scanner cannot take every file the API accepts while an unscanned file is refused (S4.12): fail closed with
 * `clamav-max-bytes` below `max-video-bytes` makes every larger upload a 413. Only a warning - a deployment may want exactly that - but
 * never a surprise. clamd's own `StreamMaxLength`, `MaxFileSize` and `MaxScanSize` are not visible from here; the README names them.
 */
internal class ScanLimitsCheck(private val properties: FilesProperties, private val log: AppLogger) : InitializingBean {

    override fun afterPropertiesSet() {
        val scanning = !properties.clamavHost.isNullOrBlank()
        if (!scanning || !properties.clamavFailClosed || properties.clamavMaxBytes >= properties.maxVideoBytes) return
        log.warn(
            "the scanner fails closed but takes less than the largest upload: files above the scanner limit are refused with 413",
            "files.clamav.max_bytes" to properties.clamavMaxBytes,
            "files.max_video_bytes" to properties.maxVideoBytes,
        )
    }
}
