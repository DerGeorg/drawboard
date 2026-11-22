package at.dergeorg.drawboard.api.domain.users.users.provides.impl

import at.dergeorg.drawboard.api.domain.users.users.provides.UsersApiUseCase
import at.dergeorg.drawboard.contract.api.UsersApi
import at.dergeorg.drawboard.contract.model.CurrentUser
import at.dergeorg.drawboard.contract.model.UserPreferences
import at.dergeorg.drawboard.contract.model.UserSummaryList
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.RestController

/**
 * HTTP only: implements the generated [UsersApi] (the provides side of the users subdomain) and delegates to
 * [UsersApiUseCase]. "Signed in" is checked by the route table in core.
 */
@RestController
internal class UsersController(private val users: UsersApiUseCase) : UsersApi {

    @WithSpan
    override suspend fun getCurrentUser(): ResponseEntity<CurrentUser> = ResponseEntity.ok(users.getCurrentUser())

    @WithSpan
    override suspend fun updateUserPreferences(userPreferences: UserPreferences): ResponseEntity<UserPreferences> =
        ResponseEntity.ok(users.updateUserPreferences(userPreferences))

    @WithSpan
    override suspend fun searchUsers(q: String): ResponseEntity<UserSummaryList> = ResponseEntity.ok(users.searchUsers(q))
}
