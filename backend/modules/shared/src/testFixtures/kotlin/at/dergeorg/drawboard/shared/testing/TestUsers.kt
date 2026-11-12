package at.dergeorg.drawboard.shared.testing

import at.dergeorg.drawboard.shared.context.CurrentUser

/**
 * The users of the dev realm (dev/keycloak/drawboard-realm.json) as test data, so tests read like the manual checks
 * with `dev/scripts/token.sh alice|bob`. Subjects are fixed; Keycloak would assign random ones.
 */
object TestUsers {
    const val ISSUER = "http://localhost:18180/realms/drawboard"

    /** Group drawboard-admins: instance administrator. */
    val ALICE = CurrentUser(
        issuer = ISSUER,
        subject = "4f7a1c2e-0b6d-4c1e-9a55-3d2b8e6f1a01",
        username = "alice",
        displayName = "Alice Admin",
        email = "alice@example.test",
        groups = setOf("drawboard-admins"),
        admin = true,
    )

    /** Group drawboard-users: a normal user. */
    val BOB = CurrentUser(
        issuer = ISSUER,
        subject = "9c3e5d7f-2a4b-4d6e-8f10-5b7c9d1e3f02",
        username = "bob",
        displayName = "Bob Builder",
        email = "bob@example.test",
        groups = setOf("drawboard-users"),
    )

    /** Signed in at the provider without a name, an email or any group (a minimal token). */
    val CAROL = CurrentUser(
        issuer = ISSUER,
        subject = "carol-subject",
        username = "carol",
    )
}
