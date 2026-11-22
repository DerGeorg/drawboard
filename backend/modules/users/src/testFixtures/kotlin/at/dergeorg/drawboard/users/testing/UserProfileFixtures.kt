package at.dergeorg.drawboard.users.testing

import at.dergeorg.drawboard.shared.context.CurrentUser
import at.dergeorg.drawboard.shared.testing.FIXED_NOW
import at.dergeorg.drawboard.shared.testing.TestUsers
import at.dergeorg.drawboard.users.domain.users.model.ColorTheme
import at.dergeorg.drawboard.users.domain.users.model.UserProfile
import at.dergeorg.drawboard.users.domain.users.provides.SyncFromLoginCommand
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Test data of the users module (public types only) - usable by every module's tests. */
object UserProfileFixtures {

    /** Fixed id of [TestUsers.ALICE]'s profile in tests that need to predict it (the service generates random ones). */
    val ALICE_ID: Uuid = Uuid.parse("0192f5e0-7c1a-7b3e-8f00-2a1b3c4d5e01")

    val BOB_ID: Uuid = Uuid.parse("0192f5e0-7c1a-7b3e-8f00-2a1b3c4d5e02")

    fun aUserProfile(
        user: CurrentUser = TestUsers.ALICE,
        id: Uuid = ALICE_ID,
        firstLoginAt: Instant = FIXED_NOW,
        lastLoginAt: Instant = firstLoginAt,
        theme: ColorTheme = ColorTheme.SYSTEM,
        version: Long = 0,
    ) = UserProfile(
        id = id,
        issuer = user.issuer,
        subject = user.subject,
        username = user.username,
        displayName = user.displayName,
        email = user.email,
        groups = user.groups.toList(),
        firstLoginAt = firstLoginAt,
        lastLoginAt = lastLoginAt,
        theme = theme,
        version = version,
    )

    fun aSyncFromLoginCommand(user: CurrentUser = TestUsers.ALICE) = SyncFromLoginCommand(
        issuer = user.issuer,
        subject = user.subject,
        username = user.username,
        displayName = user.displayName,
        email = user.email,
        groups = user.groups.toList(),
    )
}
