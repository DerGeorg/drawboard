package at.dergeorg.drawboard.library.domain.sharing.requires

/** Port for the share metrics (no personal data in any label). Implemented in infra with Micrometer. */
internal interface ShareMetrics {

    /** An exchange ended; [result] is `signed_in`, `guest` or the lower-case failure reason. */
    fun exchange(result: String)

    /** A guest session started or was renewed. */
    fun guestSession()
}
