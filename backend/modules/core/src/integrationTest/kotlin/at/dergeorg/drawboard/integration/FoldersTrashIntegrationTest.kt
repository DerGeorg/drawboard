package at.dergeorg.drawboard.integration

import at.dergeorg.drawboard.contract.model.Board
import at.dergeorg.drawboard.contract.model.BoardPage
import at.dergeorg.drawboard.contract.model.ErrorCode
import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.contract.model.Folder
import at.dergeorg.drawboard.contract.model.FolderList
import at.dergeorg.drawboard.contract.model.FolderUpdate
import at.dergeorg.drawboard.contract.model.NewBoard
import at.dergeorg.drawboard.contract.model.Trash
import at.dergeorg.drawboard.shared.testing.TestUsers
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.http.HttpStatus
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Folders, moving boards and the trash through the whole stack (route table, services, PostgreSQL). */
@IntegrationTest
class FoldersTrashIntegrationTest(private val client: WebTestClient) {

    private val alice = ApiAs(client, uniqueUser(TestUsers.ALICE))
    private val bob = ApiAs(client, uniqueUser(TestUsers.BOB))

    private fun boardsIn(who: ApiAs, folder: Folder?) = checkNotNull(
        client.signedInAs(who.user).get().uri(if (folder == null) "/api/boards" else "/api/boards?folderId=${folder.id}").exchange()
            .expectBody<BoardPage>().returnResult().responseBody,
    ).items

    private fun trashOf(who: ApiAs) =
        checkNotNull(client.signedInAs(who.user).get().uri("/api/trash").exchange().expectBody<Trash>().returnResult().responseBody)

    @Nested
    inner class Folders {

        @Test
        fun `when creating nested folders and boards then the lists show the tree and the boards leave the root`() {
            val projects = alice.createFolder("Projects")
            val sprint = alice.createFolder("Sprint", projects.id)
            val inSprint = alice.createBoard("Planning", sprint.id)
            val inRoot = alice.createBoard("Loose")

            val children = checkNotNull(
                client.signedInAs(alice.user).get().uri("/api/folders?parentId=${projects.id}").exchange()
                    .expectBody<FolderList>().returnResult().responseBody,
            ).items

            assertEquals(listOf(sprint.id), children.map { it.id }, "children of Projects")
            assertEquals(listOf(inRoot.id), boardsIn(alice, null).map { it.id }, "root holds only the loose board")
            assertEquals(listOf(inSprint.id), boardsIn(alice, sprint).map { it.id }, "folder holds its board")
            assertEquals(sprint.id, inSprint.folderId, "board knows its folder")
        }

        @Test
        fun `when moving a folder into its own child then 409 LIBRARY_FOLDER_CYCLE`() {
            val parent = alice.createFolder("Parent")
            val child = alice.createFolder("Child", parent.id)

            val result = client.signedInAs(alice.user).put().uri("/api/folders/{id}", parent.id)
                .bodyValue(FolderUpdate(name = "Parent", parentId = child.id, version = parent.version)).exchange()
                .expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.CONFLICT, result.status, "status")
            assertEquals(ErrorCode.LIBRARY_FOLDER_CYCLE, result.responseBody?.code, "error code")
        }

        @Test
        fun `when another user asks for a folder then 404 LIBRARY_FOLDER_NOT_FOUND`() {
            val folder = alice.createFolder("Private")

            val result = client.signedInAs(bob.user).get().uri("/api/folders/{id}", folder.id).exchange()
                .expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.NOT_FOUND, result.status, "status")
            assertEquals(ErrorCode.LIBRARY_FOLDER_NOT_FOUND, result.responseBody?.code, "error code")
        }

        @Test
        fun `when creating a board in a folder of another user then 404 LIBRARY_FOLDER_NOT_FOUND`() {
            val folder = alice.createFolder("Alice only")

            val result = client.signedInAs(bob.user).post().uri("/api/boards")
                .bodyValue(NewBoard("Intruder", folder.id)).exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.NOT_FOUND, result.status, "foreign folder")
        }

        @Test
        fun `when moving a board into a folder and back then the lists follow and a stale version conflicts`() {
            val folder = alice.createFolder("Target")
            val board = alice.createBoard("Mover")

            val moved = alice.move(board, folder.id)
            assertEquals(HttpStatus.OK, moved.status, "moved")
            val stale = alice.move(board, null)

            assertEquals(HttpStatus.CONFLICT, stale.status, "the old version no longer fits")
            assertTrue(boardsIn(alice, null).none { it.id == board.id }, "left the root")
            assertEquals(listOf(board.id), boardsIn(alice, folder).map { it.id }, "is in the folder")
        }
    }

    @Nested
    inner class TrashFlow {

        @Test
        fun `when deleting a folder then its boards answer 404, the trash lists one entry, and a restore brings it all back`() {
            val folder = alice.createFolder("Doomed")
            val sub = alice.createFolder("Doomed child", folder.id)
            val board = alice.createBoard("Inside", sub.id)

            assertEquals(HttpStatus.NO_CONTENT, alice.status("DELETE", "/api/folders/{id}", folder.id), "delete folder")

            assertEquals(HttpStatus.NOT_FOUND, alice.status("GET", "/api/boards/{id}", board.id), "board in the trash looks gone")
            assertEquals(HttpStatus.NOT_FOUND, alice.status("GET", "/api/folders/{id}", sub.id), "subfolder looks gone")
            val trash = trashOf(alice)
            assertEquals(listOf(folder.id), trash.folders.map { it.id }, "one entry for the whole deletion")
            assertTrue(trash.boards.isEmpty(), "the board is not listed on its own")
            assertNotNull(trash.folders.single().deletedAt, "deletedAt is set")

            assertEquals(HttpStatus.OK, alice.status("POST", "/api/trash/folders/{id}/restore", folder.id), "restore")
            assertEquals(HttpStatus.OK, alice.status("GET", "/api/boards/{id}", board.id), "board is back")
            assertTrue(trashOf(alice).folders.isEmpty(), "trash is empty again")
        }

        @Test
        fun `when deleting a board then it is in the trash, can be restored, and a purge deletes it for good`() {
            val board = alice.createBoard("Short lived")

            assertEquals(HttpStatus.NO_CONTENT, alice.status("DELETE", "/api/boards/{id}", board.id), "delete")
            assertEquals(listOf(board.id), trashOf(alice).boards.map { it.id }, "in the trash")
            assertEquals(HttpStatus.OK, alice.status("POST", "/api/trash/boards/{id}/restore", board.id), "restore")
            alice.status("DELETE", "/api/boards/{id}", board.id)
            assertEquals(HttpStatus.NO_CONTENT, alice.status("DELETE", "/api/trash/boards/{id}", board.id), "purge")

            assertEquals(HttpStatus.NOT_FOUND, alice.status("POST", "/api/trash/boards/{id}/restore", board.id), "gone for good")
        }

        @Test
        fun `when restoring a board whose folder is in the trash then it lands in the root`() {
            val folder = alice.createFolder("Folder")
            val board = alice.createBoard("Inner", folder.id)
            alice.status("DELETE", "/api/boards/{id}", board.id)
            alice.status("DELETE", "/api/folders/{id}", folder.id)

            assertEquals(HttpStatus.OK, alice.status("POST", "/api/trash/boards/{id}/restore", board.id), "restore")

            val restored = checkNotNull(
                client.signedInAs(alice.user).get().uri("/api/boards/{id}", board.id).exchange()
                    .expectBody<Board>().returnResult().responseBody,
            )
            assertNull(restored.folderId, "the folder is in the trash: the board goes to the root")
        }

        @Test
        fun `when another user touches the trash entry then 404`() {
            val board = alice.createBoard("Alice's")
            alice.status("DELETE", "/api/boards/{id}", board.id)

            assertEquals(HttpStatus.NOT_FOUND, bob.status("POST", "/api/trash/boards/{id}/restore", board.id), "foreign restore")
            assertEquals(HttpStatus.NOT_FOUND, bob.status("DELETE", "/api/trash/boards/{id}", board.id), "foreign purge")
            assertTrue(trashOf(bob).boards.isEmpty(), "bob's trash is empty")
        }
    }
}
