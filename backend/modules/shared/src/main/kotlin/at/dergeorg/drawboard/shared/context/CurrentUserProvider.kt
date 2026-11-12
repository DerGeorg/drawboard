package at.dergeorg.drawboard.shared.context

/**
 * The signed-in user of the current request. Implemented in core (Spring Security).
 *
 * Works as long as the call stays inside the coroutine Spring started for the request - the Reactor context
 * travels with it. A new `CoroutineScope(...).launch { }` loses it.
 */
interface CurrentUserProvider {
    /** null for anonymous requests (public routes, jobs). */
    suspend fun currentUserOrNull(): CurrentUser?
}
