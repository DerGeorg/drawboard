package at.dergeorg.drawboard.api.infra.web.docs

import at.dergeorg.drawboard.api.infra.web.WebSliceTestConfiguration
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.boot.webflux.test.autoconfigure.WebFluxTest
import org.springframework.context.annotation.Import
import org.springframework.http.HttpStatus
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse

@WebFluxTest(ContractDocumentController::class, properties = ["app.openapi.oidc-issuer=$LOCAL_ISSUER/"])
@Import(WebSliceTestConfiguration::class)
class ContractDocumentControllerTest(private val client: WebTestClient) {

    @Nested
    inner class ServedDocument {

        @Test
        fun `when GET the contract given a configured issuer then the discovery URL points to that provider`() {
            val result = client.get().uri("/openapi/drawboard-api.yaml").exchange().expectBody<String>().returnResult()

            assertEquals(HttpStatus.OK, result.status, "status of the contract document")
            val document = result.responseBody.orEmpty()
            assertContains(
                document,
                "openIdConnectUrl: $LOCAL_ISSUER/.well-known/openid-configuration",
                message = "login discovery of Swagger UI",
            )
            assertFalse("auth.dergeorg.at" in document, "the issuer of the contract build is replaced")
            assertContains(document, "operationId: updateBoard", message = "the rest is the contract")
        }
    }

    @Nested
    inner class Rewrite {

        private val document = """
            oidc:
              type: openIdConnect
              openIdConnectUrl: https://auth.example.test/realms/central/.well-known/openid-configuration
            other:
              openIdConnectUrl: 'https://other.example.test/.well-known/openid-configuration'
            description: see https://auth.example.test/realms/central/.well-known/openid-configuration
        """.trimIndent()

        @Test
        fun `when rewriting given an issuer then only the openIdConnectUrl properties change, quoted or not`() {
            val rewritten = OidcDiscoveryUrl.withIssuer(document, "http://localhost:1/realms/dev/")

            assertContains(
                rewritten,
                "openIdConnectUrl: http://localhost:1/realms/dev/.well-known/openid-configuration",
                message = "unquoted URL, trailing slash of the issuer removed",
            )
            assertContains(
                rewritten,
                "other:\n  openIdConnectUrl: 'http://localhost:1/realms/dev/.well-known/openid-configuration'",
                message = "quoted URL",
            )
            assertContains(
                rewritten,
                "description: see https://auth.example.test/realms/central/.well-known/openid-configuration",
                message = "other properties stay untouched",
            )
        }

        @Test
        fun `when rewriting given an empty issuer then the document is unchanged`() {
            assertEquals(document, OidcDiscoveryUrl.withIssuer(document, " "), "document without an issuer")
        }
    }
}

private const val LOCAL_ISSUER = "http://localhost:18180/realms/drawboard"
