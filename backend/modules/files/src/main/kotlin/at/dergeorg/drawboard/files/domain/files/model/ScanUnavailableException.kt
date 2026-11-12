package at.dergeorg.drawboard.files.domain.files.model

/** A scanner is configured to fail closed and could not scan: the upload is refused. Answered as 503 with `Retry-After`. */
class ScanUnavailableException(val reason: String) : RuntimeException("the upload could not be scanned: $reason")
