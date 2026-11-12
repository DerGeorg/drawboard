package at.dergeorg.drawboard.files.domain.files.requires

/**
 * Port: the numbers about files that Grafana shows. The labels are a fixed set - never a user, a board or a file name.
 * [None] is for code and tests that do not measure.
 */
internal interface FilesMetrics {

    /** An upload ended: [result] is `accepted`, `type_not_allowed`, `quota_exceeded`, `too_large`, `rate_limited`, `infected`, `scan_failed` or `error`. */
    fun upload(result: String)

    /** A scan ended: [result] is `clean`, `infected` or `unavailable` (the scanner could not decide: the policy applied). */
    fun scan(result: String)

    /** A document conversion ended: [result] is `done` or `failed`. */
    fun conversion(result: String)

    object None : FilesMetrics {
        override fun upload(result: String) = Unit

        override fun scan(result: String) = Unit

        override fun conversion(result: String) = Unit
    }
}
