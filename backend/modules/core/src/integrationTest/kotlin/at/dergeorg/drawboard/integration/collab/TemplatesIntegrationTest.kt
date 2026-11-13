package at.dergeorg.drawboard.integration.collab

import at.dergeorg.drawboard.contract.model.Board
import at.dergeorg.drawboard.contract.model.BoardPage
import at.dergeorg.drawboard.contract.model.BoardRole
import at.dergeorg.drawboard.contract.model.BoardUpdate
import at.dergeorg.drawboard.contract.model.CreatedShareLink
import at.dergeorg.drawboard.contract.model.ErrorCode
import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.contract.model.GrantRole
import at.dergeorg.drawboard.contract.model.MemberUpdate
import at.dergeorg.drawboard.contract.model.NewBoard
import at.dergeorg.drawboard.contract.model.NewShareLink
import at.dergeorg.drawboard.contract.model.ShareAudience
import at.dergeorg.drawboard.contract.model.ShareExchange
import at.dergeorg.drawboard.shared.testing.PostgresTestcontainerInitializer
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.boot.micrometer.tracing.test.autoconfigure.AutoConfigureTracing
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.boot.webtestclient.autoconfigure.AutoConfigureWebTestClient
import org.springframework.http.HttpStatus
import org.springframework.test.context.ContextConfiguration
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.uuid.Uuid

/**
 * Template boards end to end: who may switch the flag and what GET /api/templates shows - own templates, shared ones
 * (user, group, inherited from a folder, opened link) with the effective role, never the trash, never what the caller
 * has no right on. Real signed tokens, so the groups come from the claims.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "OIDC_ISSUER_URI=$COLLAB_ISSUER",
        "OIDC_AUDIENCE=drawboard-api",
        "DRAWBOARD_PUBLIC_URL=$PUBLIC_URL",
        "management.otlp.metrics.export.enabled=false",
        "DRAWBOARD_TRUSTED_PROXIES=127.0.0.0/8,::1",
    ],
)
@AutoConfigureWebTestClient(timeout = "PT30S")
@AutoConfigureTracing
@ContextConfiguration(initializers = [PostgresTestcontainerInitializer::class])
class TemplatesIntegrationTest(private val client: WebTestClient, @LocalServerPort private val port: Int) {

    private fun user(name: String, vararg groups: String) = SharingUser(client, port, name, groups.toList())

    private fun SharingUser.createTemplate(title: String, folderId: Uuid? = null): Board = checkNotNull(
        http().post().uri("/api/boards").bodyValue(NewBoard(title, folderId, template = true)).exchange()
            .expectBody<Board>().returnResult().responseBody,
    ) { "creating template '$title' failed" }

    private fun SharingUser.templates(query: String = ""): BoardPage = checkNotNull(
        http().get().uri("/api/templates$query").exchange().expectBody<BoardPage>().returnResult().responseBody,
    ) { "listing templates failed" }

    private fun SharingUser.templateIds(): List<Uuid> = templates().items.map { it.id }

    @Nested
    inner class ChangeTheFlag {

        @Test
        fun `when an editor sends another template value then 403 LIBRARY_BOARD_ACCESS_DENIED and the board is unchanged`() {
            val owner = user("Olga")
            val editor = user("Edda")
            val board = owner.createBoard("Plan")
            owner.grantUser("boards", board.id, editor, GrantRole.EDITOR)

            val result = editor.http().put().uri("/api/boards/{id}", board.id)
                .bodyValue(BoardUpdate(title = board.title, version = board.version, template = true)).exchange()
                .expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.FORBIDDEN, result.status, "an editor does not decide what is a template")
            assertEquals(ErrorCode.LIBRARY_BOARD_ACCESS_DENIED, result.responseBody?.code, "same code as every other role failure")
            assertEquals("OWNER", result.responseBody?.params?.get("required"), "required role")
            val read = owner.http().get().uri("/api/boards/{id}", board.id).exchange().expectBody<Board>().returnResult().responseBody
            assertEquals(false to board.version, read?.let { it.template to it.version }, "unchanged")
        }

        @Test
        fun `when an editor renames a template and sends the current flag or none then the rename works and it stays a template`() {
            val owner = user("Olga")
            val editor = user("Edda")
            val board = owner.createTemplate("Old name")
            owner.grantUser("boards", board.id, editor, GrantRole.EDITOR)

            val withFlag = editor.http().put().uri("/api/boards/{id}", board.id)
                .bodyValue(BoardUpdate(title = "Name 2", version = board.version, template = true)).exchange()
                .expectBody<Board>().returnResult()
            val withoutFlag = editor.http().put().uri("/api/boards/{id}", board.id)
                .bodyValue(BoardUpdate(title = "Name 3", version = board.version + 1)).exchange().expectBody<Board>().returnResult()

            assertEquals(HttpStatus.OK, withFlag.status, "same value as the current one is allowed")
            assertEquals(HttpStatus.OK, withoutFlag.status, "an absent flag is allowed")
            assertEquals(listOf("Name 3", "true"), listOf(withoutFlag.responseBody?.title, withoutFlag.responseBody?.template.toString()),
                "renamed, still a template")
        }

        @Test
        fun `when a viewer sends a template change then 403, and a stranger gets 404 as before`() {
            val owner = user("Olga")
            val viewer = user("Vera")
            val stranger = user("Sam")
            val board = owner.createBoard()
            owner.grantUser("boards", board.id, viewer, GrantRole.VIEWER)
            val body = BoardUpdate(title = board.title, version = board.version, template = true)

            assertEquals(HttpStatus.FORBIDDEN, viewer.status("PUT", "/api/boards/${board.id}", body), "viewer")
            assertEquals(HttpStatus.NOT_FOUND, stranger.status("PUT", "/api/boards/${board.id}", body), "stranger")
        }
    }

    @Nested
    inner class ListTemplates {

        @Test
        fun `when listing given own templates then they come with OWNER from every folder, normal boards and foreign ones left out`() {
            val owner = user("Olga")
            val other = user("Otto")
            val folder = owner.createFolder("Team")
            val atRoot = owner.createTemplate("root")
            val inFolder = owner.createTemplate("in folder", folder.id)
            owner.createBoard("plain")
            other.createTemplate("foreign")

            val page = owner.templates()

            assertEquals(listOf(inFolder.id, atRoot.id), page.items.map { it.id }, "newest first")
            assertEquals(setOf(BoardRole.OWNER), page.items.map { it.role }.toSet(), "role")
            assertTrue(page.items.all { it.template }, "all are templates")
            assertEquals(2L, page.page.totalElements, "total")
        }

        @Test
        fun `when a template is shared with a user then it is listed with the granted role, an unshared one is not`() {
            val owner = user("Olga")
            val reader = user("Rita")
            val shared = owner.createTemplate("shared")
            owner.createTemplate("private")
            owner.grantUser("boards", shared.id, reader, GrantRole.VIEWER)

            val page = reader.templates()

            assertEquals(listOf(shared.id), page.items.map { it.id }, "only what Rita may open")
            assertEquals(BoardRole.VIEWER, page.items.single().role, "effective role")
        }

        @Test
        fun `when a board is shared directly without being a template then it is not listed, a template next to it is`() {
            val owner = user("Olga")
            val reader = user("Rita")
            val plain = owner.createBoard("plain but shared")
            val template = owner.createTemplate("template and shared")
            owner.grantUser("boards", plain.id, reader, GrantRole.VIEWER)
            owner.grantUser("boards", template.id, reader, GrantRole.VIEWER)

            assertEquals(listOf(template.id), reader.templateIds(), "the template filter binds tighter than the OR over the rights")
        }

        @Test
        fun `when a huge page number is asked then 200 with an empty page`() {
            val owner = user("Olga")
            owner.createTemplate("one")

            val page = owner.templates("?page=2147483647&size=100")

            assertTrue(page.items.isEmpty(), "past the end")
            assertEquals(1L, page.page.totalElements, "total")
        }

        @Test
        fun `when a template is shared with a group then only a token carrying the group sees it`() {
            val owner = user("Olga")
            val inGroup = user("Gina", "designers")
            val outside = user("Otto")
            val board = owner.createTemplate("for designers")
            assertEquals(
                HttpStatus.OK,
                owner.status("PUT", "/api/boards/${board.id}/members/groups/designers", MemberUpdate(GrantRole.EDITOR)),
                "grant to the group",
            )

            assertEquals(listOf(board.id), inGroup.templateIds(), "member of the group")
            assertEquals(BoardRole.EDITOR, inGroup.templates().items.single().role, "role of the group")
            assertEquals(emptyList(), outside.templateIds(), "no group claim, no template")
        }

        @Test
        fun `when a template lies in a shared folder then it is listed with the inherited role`() {
            val owner = user("Olga")
            val reader = user("Rita")
            val top = owner.createFolder("Top")
            val below = owner.createFolder("Below", top.id)
            val inherited = owner.createTemplate("inherited", below.id)
            owner.grantUser("folders", top.id, reader, GrantRole.COMMENTER)

            val page = reader.templates()

            assertEquals(listOf(inherited.id), page.items.map { it.id }, "inherited from two levels up")
            assertEquals(BoardRole.COMMENTER, page.items.single().role, "role of the folder grant")
        }

        @Test
        fun `when a signed-in user opened a link to a template then it is listed until the link is revoked`() {
            val owner = user("Olga")
            val reader = user("Rita")
            val board = owner.createTemplate("by link")
            val created = owner.http().post().uri("/api/boards/{id}/links", board.id)
                .bodyValue(NewShareLink(GrantRole.VIEWER, ShareAudience.SIGNED_IN, null, null)).exchange()
                .expectBody<CreatedShareLink>().returnResult().responseBody
            val link = assertNotNull(created, "link")
            assertEquals(emptyList(), reader.templateIds(), "before opening the link")

            val exchange = reader.http().post().uri("/api/shares/exchange")
                .bodyValue(ShareExchange(link.url.substringAfter('#'), null, null)).exchange().expectBody<String>().returnResult()
            assertEquals(HttpStatus.OK, exchange.status, "opening the link")
            assertEquals(listOf(board.id), reader.templateIds(), "after opening it")

            assertEquals(HttpStatus.NO_CONTENT, owner.status("DELETE", "/api/links/${link.link.id}"), "revoke")
            assertEquals(emptyList(), reader.templateIds(), "a revoked link grants nothing any more")
        }

        @Test
        fun `when a template is in the trash itself or through its folder then it is not listed, for nobody`() {
            val owner = user("Olga")
            val reader = user("Rita")
            val folder = owner.createFolder("Doomed")
            val viaFolder = owner.createTemplate("via folder", folder.id)
            val itself = owner.createTemplate("itself")
            val kept = owner.createTemplate("kept")
            owner.grantUser("folders", folder.id, reader, GrantRole.VIEWER)
            owner.grantUser("boards", itself.id, reader, GrantRole.VIEWER)
            assertEquals(listOf(itself.id, viaFolder.id).toSet(), reader.templateIds().toSet(), "visible before the trash")

            assertEquals(HttpStatus.NO_CONTENT, owner.status("DELETE", "/api/boards/${itself.id}"), "board to the trash")
            assertEquals(HttpStatus.NO_CONTENT, owner.status("DELETE", "/api/folders/${folder.id}"), "folder to the trash")

            assertEquals(listOf(kept.id), owner.templateIds(), "the owner sees only the one that is left")
            assertEquals(emptyList(), reader.templateIds(), "the reader sees nothing")
        }

        @Test
        fun `when a board stops being a template then it leaves the list`() {
            val owner = user("Olga")
            val board = owner.createTemplate("temporary")

            val unmarked = owner.http().put().uri("/api/boards/{id}", board.id)
                .bodyValue(BoardUpdate(title = board.title, version = board.version, template = false)).exchange()
                .expectBody<Board>().returnResult()

            assertEquals(HttpStatus.OK, unmarked.status, "unmark")
            assertEquals(emptyList(), owner.templateIds(), "no longer listed")
        }

        @Test
        fun `when a user lists templates more than 30 times a minute then 429 with Retry-After, others are fine`() {
            val greedy = user("Gregor")
            val other = user("Otto")
            repeat(30) { assertEquals(HttpStatus.OK, greedy.status("GET", "/api/templates"), "call ${it + 1}") }

            val refused = greedy.http().get().uri("/api/templates").exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.TOO_MANY_REQUESTS, refused.status, "the 31st call")
            assertEquals(ErrorCode.TOO_MANY_REQUESTS, refused.responseBody?.code, "error code")
            assertTrue((refused.responseHeaders.getFirst("Retry-After")?.toLongOrNull() ?: 0) > 0, "Retry-After header")
            assertEquals(HttpStatus.OK, other.status("GET", "/api/templates"), "another user")
        }

        @Test
        fun `when paging then the pages are cut after sorting and the paging info counts the whole list`() {
            val owner = user("Olga")
            val created = (1..5).map { owner.createTemplate("t$it") }

            val first = owner.templates("?page=0&size=2")
            val last = owner.templates("?page=2&size=2")

            assertEquals(created.reversed().take(2).map { it.id }, first.items.map { it.id }, "first page, newest first")
            assertEquals(listOf(created.first().id), last.items.map { it.id }, "last page holds the rest")
            assertEquals(5L, first.page.totalElements, "total")
            assertEquals(3, first.page.totalPages, "pages")
        }

        @Test
        fun `when listing without a token then 401 and with a page size above 100 then 400`() {
            val owner = user("Olga")

            val anonymous = client.get().uri("/api/templates").exchange().expectBody<String>().returnResult()

            assertEquals(HttpStatus.UNAUTHORIZED, anonymous.status, "anonymous")
            assertEquals(HttpStatus.BAD_REQUEST, owner.status("GET", "/api/templates?size=101"), "page size")
        }
    }

    companion object {
        @JvmStatic
        @DynamicPropertySource
        fun jwks(registry: DynamicPropertyRegistry) {
            registry.add("OIDC_JWK_SET_URI") { SignedTokens.jwkSetUri }
        }
    }
}
