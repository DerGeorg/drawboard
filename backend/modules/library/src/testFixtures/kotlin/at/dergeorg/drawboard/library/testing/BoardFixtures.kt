package at.dergeorg.drawboard.library.testing

import at.dergeorg.drawboard.library.domain.access.model.Caller
import at.dergeorg.drawboard.library.domain.boards.model.Board
import at.dergeorg.drawboard.library.domain.boards.provides.CreateBoardCommand
import at.dergeorg.drawboard.library.domain.boards.provides.UpdateBoardCommand
import at.dergeorg.drawboard.shared.testing.FIXED_NOW
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Test data of the library module (public types only) - usable by every module's tests. */
object BoardFixtures {

    val BOARD: Uuid = Uuid.parse("0192f5e0-7c1a-7b3e-8f00-2a1b3c4d5e6f")

    val OWNER: Uuid = Uuid.parse("0192f5e0-7c1a-7b3e-8f00-2a1b3c4d5e01")

    val STRANGER: Uuid = Uuid.parse("0192f5e0-7c1a-7b3e-8f00-2a1b3c4d5e02")

    fun aBoard(
        id: Uuid = BOARD,
        title: String = "Sprint planning",
        ownerId: Uuid = OWNER,
        createdAt: Instant = FIXED_NOW,
        updatedAt: Instant = createdAt,
        version: Long = 0,
        folderId: Uuid? = null,
        deletedAt: Instant? = null,
        template: Boolean = false,
    ) = Board(
        id = id,
        title = title,
        ownerId = ownerId,
        createdAt = createdAt,
        updatedAt = updatedAt,
        version = version,
        folderId = folderId,
        deletedAt = deletedAt,
        template = template,
    )

    fun aCreateBoardCommand(ownerId: Uuid = OWNER, title: String = "Sprint planning", folderId: Uuid? = null, template: Boolean = false) =
        CreateBoardCommand(ownerId = ownerId, title = title, folderId = folderId, template = template)

    fun anUpdateBoardCommand(
        caller: Caller = asUser(OWNER),
        boardId: Uuid = BOARD,
        title: String = "Retrospective",
        version: Long = 0,
        template: Boolean? = null,
    ) = UpdateBoardCommand(caller = caller, boardId = boardId, title = title, version = version, template = template)

    /** A signed-in user without groups as the library sees the caller. */
    fun asUser(id: Uuid, vararg groups: String): Caller.User = Caller.User(id, groups.toSet())
}
