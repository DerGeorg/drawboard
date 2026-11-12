package at.dergeorg.drawboard.core.infra.security

import at.dergeorg.drawboard.core.infra.types.expiresAtOrNull
import at.dergeorg.drawboard.shared.context.CurrentUser
import org.springframework.security.oauth2.jwt.Jwt

/** Turns an access token into the [CurrentUser] of the modules, following the claim configuration of the deployment. */
internal class JwtCurrentUserMapper(private val properties: OidcProperties) {

    /** null if the token lacks `iss` or `sub` - it then identifies nobody. */
    fun map(jwt: Jwt): CurrentUser? {
        val issuer = jwt.getClaimAsString("iss")?.takeIf { it.isNotBlank() } ?: return null
        val subject = jwt.subject?.takeIf { it.isNotBlank() } ?: return null
        val groups = JwtClaimReader.texts(jwt, properties.claimGroups)
        return CurrentUser(
            issuer = issuer,
            subject = subject,
            username = JwtClaimReader.text(jwt, properties.claimUsername) ?: subject,
            displayName = jwt.getClaimAsString("name")?.takeIf { it.isNotBlank() },
            // An unverified address is whatever the user typed: only a verified one is stored and shown.
            email = jwt.getClaimAsString("email")?.takeIf { it.isNotBlank() && jwt.getClaimAsBoolean("email_verified") == true },
            groups = groups,
            admin = properties.adminGroupOrNull?.let { it in groups } ?: false,
            tokenExpiresAt = jwt.expiresAtOrNull(),
        )
    }
}
