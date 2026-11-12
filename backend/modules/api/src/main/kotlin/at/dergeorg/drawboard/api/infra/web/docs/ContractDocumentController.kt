package at.dergeorg.drawboard.api.infra.web.docs

import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.beans.factory.annotation.Value
import org.springframework.core.io.ClassPathResource
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

/**
 * Serves the contract (the bundled spec from the contract jar) for Swagger UI - with the OpenID Connect discovery URL
 * pointing to the OIDC provider of THIS deployment. The jar carries the discovery URL it was built with (the central
 * dergeorg Keycloak, `https://auth.dergeorg.at/realms/dergeorg`); springdoc cannot change it
 * (`springdoc.swagger-ui.oauth.*` only sets client id, PKCE and scopes), and a contract build per environment would
 * break "one contract version for all". So the `openIdConnectUrl` of the `oidc` security scheme becomes
 * `<OIDC_ISSUER_URI>/.well-known/openid-configuration` once at startup (`app.openapi.oidc-issuer`, empty = serve
 * unchanged).
 *
 * Takes precedence over the static copy under META-INF/resources (handler mappings come before resource handling).
 * Reachable only where Swagger UI is on - the route table in core guards `/openapi/`.
 */
@RestController
internal class ContractDocumentController(@Value("\${app.openapi.oidc-issuer:}") issuer: String) {

    private val document: String = OidcDiscoveryUrl.withIssuer(
        checkNotNull(ClassPathResource(RESOURCE).takeIf { it.exists() }) { "$RESOURCE missing - is the contract jar on the classpath?" }
            .getContentAsString(Charsets.UTF_8),
        issuer,
    )

    @WithSpan
    @GetMapping(PATH, produces = [YAML])
    fun contract(): ResponseEntity<String> = ResponseEntity.ok().contentType(MediaType.parseMediaType(YAML)).body(document)

    private companion object {
        const val PATH = "/openapi/drawboard-api.yaml"
        const val RESOURCE = "META-INF/resources$PATH"
        const val YAML = "application/yaml"
    }
}

/** Rewrites the `openIdConnectUrl` of an OpenAPI document (YAML) to the discovery document of another issuer. */
internal object OidcDiscoveryUrl {

    private const val DISCOVERY_PATH = "/.well-known/openid-configuration"

    // `  openIdConnectUrl: https://auth.example/realms/x/.well-known/openid-configuration` - issuer = everything before the path
    private val URL_LINE = Regex("""(?m)^(\s*openIdConnectUrl:\s*['"]?)(\S+?)(/\.well-known/openid-configuration)""")

    fun withIssuer(document: String, issuer: String): String {
        val target = issuer.trim().trimEnd('/')
        if (target.isEmpty()) return document
        return URL_LINE.replace(document) { match -> match.groupValues[1] + target + DISCOVERY_PATH }
    }
}
