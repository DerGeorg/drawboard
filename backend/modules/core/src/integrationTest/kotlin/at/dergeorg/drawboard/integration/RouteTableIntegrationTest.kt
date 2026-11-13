package at.dergeorg.drawboard.integration

import at.dergeorg.drawboard.contract.model.ErrorCode
import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.shared.context.CurrentUser
import at.dergeorg.drawboard.shared.testing.TestUsers.ALICE
import at.dergeorg.drawboard.shared.testing.TestUsers.CAROL
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.MethodSource
import org.springframework.core.io.ClassPathResource
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import org.yaml.snakeyaml.Yaml
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.uuid.Uuid

/**
 * The route table (core's SecurityConfig) is the only place where access is decided. This test reads every operation
 * from the contract the backend implements (the bundled spec in the contract jar) and checks each one twice: signed
 * in (the route table lets it through: neither 401 nor 403 - what the operation then answers is the business of the
 * API tests) and without a token (401). A new operation in the contract is covered here automatically - and fails
 * until it has its line in the route table, because the last rule denies everything.
 */
@IntegrationTest
class RouteTableIntegrationTest(private val client: WebTestClient) {

    private fun call(operation: Operation, user: CurrentUser?) =
        (user?.let(client::signedInAs) ?: client).method(operation.method).uri(operation.uri)
            .contentType(MediaType.APPLICATION_JSON).bodyValue("{}")
            .exchange().expectBody<String>().returnResult()

    @Nested
    inner class Operations {

        @Test
        fun `when reading the contract then it lists every operation of the API`() {
            assertEquals(
                setOf(
                    "listBoards", "listTemplates", "createBoard", "getBoard", "updateBoard", "deleteBoard", "moveBoard", "listTrash",
                    "restoreBoard",
                    "purgeBoard", "listFolders", "createFolder", "getFolder", "updateFolder", "deleteFolder", "restoreFolder",
                    "purgeFolder", "listSharedWithMe", "listBoardMembers", "setBoardUserMember", "removeBoardUserMember",
                    "setBoardGroupMember", "removeBoardGroupMember", "listFolderMembers", "setFolderUserMember",
                    "removeFolderUserMember", "setFolderGroupMember", "removeFolderGroupMember", "listBoardShareLinks",
                    "createBoardShareLink", "listFolderShareLinks", "createFolderShareLink", "revokeShareLink", "exchangeShareToken",
                    "refreshGuestSession", "createCollabTicket", "uploadBoardSnapshot", "listBoardVersions", "restoreBoardVersion",
                    "getCurrentUser", "searchUsers", "listFiles", "uploadFile", "getFileUrls", "getFile", "deleteFile", "downloadFile",
                    "listPlugins", "installPlugin", "getPlugin", "updatePlugin", "removePlugin", "listEnabledPlugins",
                    "getPluginStorage", "putPluginStorage", "listPokerRounds", "createPokerRound", "getPokerRound", "castPokerVote",
                    "revealPokerRound", "cancelPokerRound",
                ),
                operations().map { it.operationId }.toSet(),
                "operations of the contract - a new one needs a line in the route table and a test here",
            )
        }

        @ParameterizedTest(name = "{0}")
        @MethodSource("at.dergeorg.drawboard.integration.RouteTableIntegrationTest#userOperations")
        fun `when calling an operation given a signed-in user then the route table lets it through`(operation: Operation) {
            val result = call(operation, ALICE)

            assertTrue(
                result.status !in setOf(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN),
                "${operation.operationId} must pass the route table, was ${result.status}",
            )
        }

        @ParameterizedTest(name = "{0}")
        @MethodSource("at.dergeorg.drawboard.integration.RouteTableIntegrationTest#ordinaryOperations")
        fun `when calling an operation given a signed-in user without any claim but the subject then it is let through too`(
            operation: Operation,
        ) {
            val result = call(operation, CAROL)

            assertTrue(
                result.status !in setOf(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN),
                "${operation.operationId}: groups and names are not needed to pass, was ${result.status}",
            )
        }

        @ParameterizedTest(name = "{0}")
        @MethodSource("at.dergeorg.drawboard.integration.RouteTableIntegrationTest#signedInOperations")
        fun `when calling an operation given no token then 401 UNAUTHORIZED with a Bearer challenge`(operation: Operation) {
            val result = call(operation, user = null)

            assertEquals(HttpStatus.UNAUTHORIZED, result.status, "${operation.operationId} anonymous")
            assertEquals("Bearer", result.responseHeaders.getFirst(HttpHeaders.WWW_AUTHENTICATE), "challenge of ${operation.operationId}")
        }
    }

    @Nested
    inner class SpecialOperations {

        @ParameterizedTest(name = "{0}")
        @MethodSource("at.dergeorg.drawboard.integration.RouteTableIntegrationTest#adminOperations")
        fun `when calling an admin operation given a signed-in user who is not an instance admin then 403 FORBIDDEN from the route table`(
            operation: Operation,
        ) {
            val result = call(operation, CAROL)

            assertEquals(HttpStatus.FORBIDDEN, result.status, "${operation.operationId} is for instance admins only (S6.6)")
        }

        @ParameterizedTest(name = "{0}")
        @MethodSource("at.dergeorg.drawboard.integration.RouteTableIntegrationTest#adminOperations")
        fun `when calling an admin operation given an instance admin then the route table lets it through`(operation: Operation) {
            val result = call(operation, ALICE)

            assertTrue(
                result.status !in setOf(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN),
                "${operation.operationId} for an admin, was ${result.status}",
            )
        }

        @Test
        fun `when downloading a file given no token then the route table lets it through - the signature decides, so 400 without one`() {
            val operation = operations().single { it.operationId == "downloadFile" }

            val result = call(operation, user = null)

            assertEquals("/files/", operation.uri.substring(0, 7), "outside /api: the operation-level servers entry of the contract")
            assertEquals(HttpStatus.BAD_REQUEST, result.status, "permitAll, then the missing parameters")
        }

        @Test
        fun `when sending another method than GET to the file route then it is not open`() {
            val operation = operations().single { it.operationId == "downloadFile" }

            val post = client.post().uri(operation.uri).exchange().expectBody<String>().returnResult()
            val delete = client.delete().uri(operation.uri).exchange().expectBody<String>().returnResult()

            assertEquals(HttpStatus.UNAUTHORIZED, post.status, "POST falls through to denyAll (no token: 401)")
            assertEquals(HttpStatus.UNAUTHORIZED, delete.status, "DELETE too")
        }

        @Test
        fun `when a signed-in user renews a guest session then 403 - the refresh is for guests only`() {
            val operation = operations().single { it.operationId == "refreshGuestSession" }

            assertEquals(HttpStatus.FORBIDDEN, call(operation, ALICE).status, "a user has no guest session")
        }

        @Test
        fun `when exchanging a link given no token then the route table lets it through (the service decides)`() {
            val operation = operations().single { it.operationId == "exchangeShareToken" }

            val result = call(operation, user = null)

            assertTrue(
                result.status !in setOf(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN),
                "anonymous exchange passes, was ${result.status}",
            )
        }
    }

    @Nested
    inner class FailClosed {

        @Test
        fun `when calling a route the table does not list given a signed-in user then 403 FORBIDDEN`() {
            val result = client.signedInAs(ALICE).get().uri("/api/not-in-the-route-table").exchange()
                .expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.FORBIDDEN, result.status, "denyAll for unlisted routes")
            assertEquals(ErrorCode.FORBIDDEN, result.responseBody?.code, "error code")
        }

        @Test
        fun `when calling a listed route with an unlisted method given a signed-in user then 403 FORBIDDEN, not 405`() {
            val result = client.signedInAs(ALICE).method(HttpMethod.PATCH).uri("/api/boards/{id}", Uuid.random()).exchange()
                .expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.FORBIDDEN, result.status, "the table lists verb + path, everything else is denied")
        }

        @Test
        fun `when calling a route the table does not list given no token then 401 without revealing whether it exists`() {
            val result = client.get().uri("/api/not-in-the-route-table").exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.UNAUTHORIZED, result.status, "security runs before routing")
        }

        @Test
        fun `when calling an operation given a token that is not a valid JWT then 401 UNAUTHORIZED`() {
            val result = client.get().uri("/api/users/me").header(HttpHeaders.AUTHORIZATION, "Bearer not-a-jwt").exchange()
                .expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.UNAUTHORIZED, result.status, "garbage token")
            assertEquals(ErrorCode.UNAUTHORIZED, result.responseBody?.code, "error code")
        }
    }

    @Nested
    inner class Documentation {

        @Test
        fun `when opening Swagger UI given the default configuration then it is not reachable`() {
            val result = client.get().uri("/swagger-ui.html").exchange().expectBody<String>().returnResult()

            assertEquals(HttpStatus.UNAUTHORIZED, result.status, "Swagger UI is off outside the dev profile")
        }

        @Test
        fun `when reading the contract file given the default configuration then it is not reachable`() {
            val result = client.get().uri("/openapi/drawboard-api.yaml").exchange().expectBody<String>().returnResult()

            assertEquals(HttpStatus.UNAUTHORIZED, result.status, "the bundled spec is only public together with Swagger UI")
        }
    }

    /** One operation of the contract; path parameters are filled with a random id (a 404 still passed security). */
    data class Operation(val operationId: String, val method: HttpMethod, val uri: String) {
        override fun toString() = "$operationId ($method $uri)"
    }

    companion object {
        private const val CONTRACT = "META-INF/resources/openapi/drawboard-api.yaml"
        private val METHODS = setOf("get", "put", "post", "delete", "patch")
        private val PATH_PARAMETER = Regex("\\{[^}]+}")

        /** Instance admins only (S6.6): the route table decides by the groups claim, the services do not need to. */
        private val ADMIN_OPERATIONS = setOf("listPlugins", "installPlugin", "getPlugin", "updatePlugin", "removePlugin")

        /** What a signed-in user (an admin, like Alice, too) may pass: every operation but the renewal of a guest session (guests only). */
        @JvmStatic
        fun userOperations(): List<Operation> = operations().filterNot { it.operationId == "refreshGuestSession" }

        /** What a signed-in user without the admin group passes: [userOperations] without the admin ones. */
        @JvmStatic
        fun ordinaryOperations(): List<Operation> = userOperations().filterNot { it.operationId in ADMIN_OPERATIONS }

        @JvmStatic
        fun adminOperations(): List<Operation> = operations().filter { it.operationId in ADMIN_OPERATIONS }

        /**
         * The operations that need a token: every one but the exchange of a link (S1), which anonymous guests call, and
         * the delivery of file bytes, which the signature in the URL authorises (S4.4).
         */
        @JvmStatic
        fun signedInOperations(): List<Operation> = operations().filterNot { it.operationId in setOf("exchangeShareToken", "downloadFile") }

        @JvmStatic
        fun operations(): List<Operation> {
            val spec: Map<String, Any?> = ClassPathResource(CONTRACT).inputStream.use { Yaml().load(it) }
            val basePath = (spec.list("servers").single() as Map<*, *>)["url"].toString()
            return spec.map("paths").flatMap { (path, item) ->
                (item as Map<*, *>).filterKeys { it in METHODS }.map { (method, operation) ->
                    operation as Map<*, *>
                    // an operation-level `servers` entry replaces the base path (downloadFile lives at /files, not /api/files)
                    val server = (operation["servers"] as? List<*>)?.singleOrNull() as? Map<*, *>
                    val base = server?.get("url")?.toString()?.trimEnd('/') ?: basePath
                    Operation(
                        operationId = operation["operationId"].toString(),
                        method = HttpMethod.valueOf(method.toString().uppercase()),
                        uri = base + path.replace("{pluginId}", "org.example.timer").replace(PATH_PARAMETER, Uuid.random().toString()),
                    )
                }
            }
        }

        @Suppress("UNCHECKED_CAST")
        private fun Map<String, Any?>.map(key: String) = this[key] as Map<String, Any?>

        private fun Map<String, Any?>.list(key: String) = this[key] as List<*>
    }
}
