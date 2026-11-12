package at.dergeorg.drawboard.api.domain.users.users.provides

import at.dergeorg.drawboard.contract.model.CurrentUser
import at.dergeorg.drawboard.contract.model.UserSummaryList

/** The users part of the API in contract types. */
interface UsersApiUseCase {

    /** The signed-in user; also creates or refreshes their profile in the users module (counts as a login). */
    suspend fun getCurrentUser(): CurrentUser

    /** Users whose username or display name starts with [q] (S6.9): at most 20, 30 searches per user and minute. */
    suspend fun searchUsers(q: String): UserSummaryList
}
