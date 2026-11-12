package at.dergeorg.drawboard.shared.context

/** Actor, request id and trace id of the current request or job. Implemented in core. Same caveat as [CurrentUserProvider]. */
interface RequestContextProvider {
    suspend fun current(): RequestContext
}
