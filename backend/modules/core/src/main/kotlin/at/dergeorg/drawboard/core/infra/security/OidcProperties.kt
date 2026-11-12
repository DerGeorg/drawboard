package at.dergeorg.drawboard.core.infra.security

import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * The OpenID Connect provider this deployment is bound to - nothing here is specific to one provider. Bound from
 * `app.security.oidc.*` (environment variables in application.yaml).
 *
 * @param issuerUri `OIDC_ISSUER_URI`, required. Must equal the token's `iss` byte for byte.
 * @param jwkSetUri `OIDC_JWK_SET_URI`, optional. URL of the signing keys when the backend reaches the provider under
 *   another address than the browser (container network). Without it, the keys are found through the discovery
 *   document of the issuer (`/.well-known/openid-configuration`) on the first token.
 * @param audience `OIDC_AUDIENCE`, REQUIRED (the application does not start without it). A token is only accepted when
 *   its `aud` contains this value, so tokens minted for other applications of the same provider are useless here.
 * @param claimUsername `OIDC_CLAIM_USERNAME`: claim with the user name (default `preferred_username`).
 * @param claimGroups `OIDC_CLAIM_GROUPS`: claim with the groups. A dot path walks into nested objects, e.g.
 *   `resource_access.drawboard-api.roles` (Keycloak client roles); a claim whose own name contains dots wins.
 * @param adminGroup `DRAWBOARD_ADMIN_GROUP`, optional: a user is an instance admin when the groups claim of the
 *   CURRENT token contains it (exact match). Empty = nobody is admin (fail closed).
 */
@ConfigurationProperties("app.security.oidc")
internal data class OidcProperties(
    val issuerUri: String,
    val jwkSetUri: String? = null,
    val audience: String,
    val claimUsername: String = "preferred_username",
    val claimGroups: String = "groups",
    val adminGroup: String? = null,

) {
    init {
        require(issuerUri.isNotBlank()) { "OIDC_ISSUER_URI must be set" }
        require(audience.isNotBlank()) { "OIDC_AUDIENCE must be set: tokens minted for other applications must not be accepted" }
    }

    /** An environment variable that is set but empty means "not configured". */
    val jwkSetUriOrNull: String? get() = jwkSetUri?.takeIf { it.isNotBlank() }
    val adminGroupOrNull: String? get() = adminGroup?.takeIf { it.isNotBlank() }
}
