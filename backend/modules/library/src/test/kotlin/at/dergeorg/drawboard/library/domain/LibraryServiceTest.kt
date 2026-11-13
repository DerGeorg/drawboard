package at.dergeorg.drawboard.library.domain

import at.dergeorg.drawboard.library.common.LibraryProperties
import at.dergeorg.drawboard.library.domain.access.model.Grant
import at.dergeorg.drawboard.library.domain.boards.requires.TemplateMetrics
import at.dergeorg.drawboard.shared.error.RateLimitedException
import at.dergeorg.drawboard.library.domain.access.model.PrincipalKind
import at.dergeorg.drawboard.library.domain.access.model.ResourceKind
import at.dergeorg.drawboard.library.domain.boards.model.BoardCreated
import at.dergeorg.drawboard.library.domain.boards.model.BoardTemplateChanged
import at.dergeorg.drawboard.library.domain.folders.model.Folder
import at.dergeorg.drawboard.library.domain.sharing.model.ShareAudience
import at.dergeorg.drawboard.library.domain.sharing.model.ShareLink
import at.dergeorg.drawboard.library.domain.access.model.Caller
import at.dergeorg.drawboard.library.domain.boards.model.BoardDeleted
import at.dergeorg.drawboard.library.domain.boards.model.BoardRenamed
import at.dergeorg.drawboard.library.domain.boards.model.Board
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.library.domain.boards.provides.CreateBoardCommand
import at.dergeorg.drawboard.library.testing.BoardFixtures.BOARD
import at.dergeorg.drawboard.library.domain.access.AccessResolver
import at.dergeorg.drawboard.library.testing.BoardFixtures.OWNER
import at.dergeorg.drawboard.library.testing.BoardFixtures.asUser
import at.dergeorg.drawboard.library.testing.BoardFixtures.STRANGER
import at.dergeorg.drawboard.library.testing.BoardFixtures.aBoard
import at.dergeorg.drawboard.library.testing.BoardFixtures.aCreateBoardCommand
import at.dergeorg.drawboard.library.testing.BoardFixtures.anUpdateBoardCommand
import at.dergeorg.drawboard.shared.auditing.AuditAction
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.ValidationFailedException
import at.dergeorg.drawboard.shared.paging.PageQuery
import at.dergeorg.drawboard.shared.testing.FIXED_NOW
import at.dergeorg.drawboard.shared.testing.MutableClock
import at.dergeorg.drawboard.shared.testing.RecordingAuditTrail
import at.dergeorg.drawboard.shared.testing.version
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.minutes
import kotlin.uuid.Uuid

class LibraryServiceTest {

    private val clock = MutableClock()
    private val audit = RecordingAuditTrail()

    private val folders = InMemoryFolderRepository()

    private val metrics = object : TemplateMetrics {
        var refused = 0

        override fun listRefused() {
            refused++
        }
    }

    private fun serviceWith(
        repository: InMemoryBoardRepository,
        grants: InMemoryGrantRepository = InMemoryGrantRepository(),
        links: InMemoryShareLinkRepository = InMemoryShareLinkRepository(),
    ): LibraryService {
        val access = AccessResolver(folders, grants, links, clock)
        return LibraryService(repository, folders, grants, access, audit, clock, metrics, LibraryProperties())
    }

    private fun grant(
        kind: ResourceKind,
        resource: Uuid,
        principalKind: PrincipalKind,
        principal: String,
        role: BoardRole,
        linkId: Uuid? = null,
    ) = Grant(Uuid.generateV7(), kind, resource, principalKind, principal, role, linkId, FIXED_NOW, FIXED_NOW)

    private fun userGrant(kind: ResourceKind, resource: Uuid, user: Uuid, role: BoardRole) =
        InMemoryGrantRepository(grant(kind, resource, PrincipalKind.USER, user.toString(), role))

    @Nested
    inner class ListBoards {

        @Test
        fun `when listing given boards of two owners then only the own ones come, most recently changed first`() = runTest {
            val old = aBoard(id = Uuid.random(), title = "old", updatedAt = FIXED_NOW)
            val recent = aBoard(id = Uuid.random(), title = "recent", updatedAt = FIXED_NOW + 1.hours)
            val foreign = aBoard(id = Uuid.random(), title = "foreign", ownerId = STRANGER, updatedAt = FIXED_NOW + 2.hours)

            val page = serviceWith(InMemoryBoardRepository(old, foreign, recent)).listBoards(asUser(OWNER), null, PageQuery(0, 20))

            assertEquals(listOf("recent", "old"), page.items.map { it.board.title }, "own boards, newest change first")
            assertEquals(setOf(BoardRole.OWNER), page.items.map { it.role }.toSet(), "role on own boards")
            assertEquals(2, page.totalElements, "total of the own boards")
        }

        @Test
        fun `when listing given a user without boards then the page is empty`() = runTest {
            val page = serviceWith(InMemoryBoardRepository(aBoard())).listBoards(asUser(STRANGER), null, PageQuery(0, 20))

            assertTrue(page.items.isEmpty(), "nothing owned")
            assertEquals(0, page.totalElements, "total")
        }
    }

    @Nested
    inner class CreateBoard {

        @Test
        fun `when creating then the owner gets a trimmed board with a v7 id and the creation is audited`() = runTest {
            val repository = InMemoryBoardRepository()

            val view = serviceWith(repository).createBoard(aCreateBoardCommand(title = "  Roadmap  "))

            assertEquals("Roadmap", view.board.title, "title is trimmed")
            assertEquals(OWNER, view.board.ownerId, "creator owns it")
            assertEquals(BoardRole.OWNER, view.role, "creator is the owner")
            assertEquals(7, view.board.id.version(), "the application assigns a UUIDv7")
            assertEquals(FIXED_NOW, view.board.createdAt, "creation time")
            assertEquals(view.board.createdAt, view.board.updatedAt, "not changed yet")
            assertEquals(listOf(view.board), repository.all, "stored boards")
            val event = audit.events.single()
            assertEquals("library.board.created", event.eventType, "event type")
            assertEquals(AuditAction.CREATED, event.action, "action")
            assertEquals(BoardCreated(submittedTitle = "  Roadmap  "), event.details, "details keep the submitted title")
        }

        @Test
        fun `when creating given template true then the board is a template, and by default it is not`() = runTest {
            val service = serviceWith(InMemoryBoardRepository())

            val template = service.createBoard(aCreateBoardCommand(template = true))
            val plain = service.createBoard(aCreateBoardCommand())

            assertTrue(template.board.template, "created as a template")
            assertEquals(false, plain.board.template, "not a template unless asked")
        }

        @Test
        fun `when creating given a blank title then VALIDATION_FAILED and nothing is stored or audited`() = runTest {
            val repository = InMemoryBoardRepository()

            val failure = assertFailsWith<ValidationFailedException>("a blank title is rejected") {
                serviceWith(repository).createBoard(CreateBoardCommand(OWNER, "   "))
            }

            assertEquals("title", failure.invalidFields.single().field, "invalid field")
            assertTrue(repository.all.isEmpty() && audit.events.isEmpty(), "no board, no event")
        }

        @Test
        fun `when creating given a title over 200 characters then VALIDATION_FAILED`() = runTest {
            val failure = assertFailsWith<ValidationFailedException>("too long") {
                serviceWith(InMemoryBoardRepository()).createBoard(aCreateBoardCommand(title = "x".repeat(201)))
            }

            assertEquals("Size", failure.invalidFields.single().constraint, "violated constraint")
        }
    }

    @Nested
    inner class GetBoard {

        @Test
        fun `when getting given the owner then the board comes with the role OWNER`() = runTest {
            val view = serviceWith(InMemoryBoardRepository(aBoard())).getBoard(asUser(OWNER), BOARD)

            assertEquals(aBoard(), view.board, "the board")
            assertEquals(BoardRole.OWNER, view.role, "role")
        }

        @Test
        fun `when getting given another user then LIBRARY_BOARD_NOT_FOUND so the existence is not revealed`() = runTest {
            val failure = assertFailsWith<DomainException>("a foreign board looks like it does not exist") {
                serviceWith(InMemoryBoardRepository(aBoard())).getBoard(asUser(STRANGER), BOARD)
            }

            assertEquals(ErrorCode.LIBRARY_BOARD_NOT_FOUND, failure.errorCode, "error code")
        }

        @Test
        fun `when getting given an unknown id then LIBRARY_BOARD_NOT_FOUND`() = runTest {
            val failure = assertFailsWith<DomainException>("unknown id") {
                serviceWith(InMemoryBoardRepository()).getBoard(asUser(OWNER), BOARD)
            }

            assertEquals(ErrorCode.LIBRARY_BOARD_NOT_FOUND, failure.errorCode, "same answer as for a foreign board")
            assertEquals(mapOf("boardId" to BOARD.toString()), failure.params, "params")
        }
    }

    @Nested
    inner class RenameBoard {

        @Test
        fun `when renaming given the current version then title, version and update time change and it is audited`() = runTest {
            val stored = aBoard()
            val repository = InMemoryBoardRepository(stored)
            clock.advanceBy(10.minutes)

            val view = serviceWith(repository).updateBoard(anUpdateBoardCommand(title = " Retro "))

            assertEquals("Retro", view.board.title, "new title")
            assertEquals(1, view.board.version, "version raised")
            assertEquals(FIXED_NOW + 10.minutes, view.board.updatedAt, "update time")
            assertEquals(stored.createdAt, view.board.createdAt, "creation time stays")
            assertEquals(listOf(view.board), repository.all, "stored boards")
            val event = audit.events.single()
            assertEquals("library.board.updated", event.eventType, "event type")
            assertEquals(stored, event.before, "snapshot before")
            assertEquals(view.board, event.after, "snapshot after")
            assertEquals(BoardRenamed(submittedTitle = " Retro ", basedOnVersion = 0), event.details, "details")
        }

        @Test
        fun `when renaming given a stale version then CONFLICT and nothing changes`() = runTest {
            val repository = InMemoryBoardRepository(aBoard(version = 3))

            val failure = assertFailsWith<DomainException>("stale version") {
                serviceWith(repository).updateBoard(anUpdateBoardCommand(version = 2))
            }

            assertEquals(ErrorCode.CONFLICT, failure.errorCode, "error code")
            assertEquals(aBoard(version = 3), repository.all.single(), "board untouched")
            assertTrue(audit.events.isEmpty(), "no event")
        }

        @Test
        fun `when renaming given a concurrent change between read and write then CONFLICT`() = runTest {
            val repository = InMemoryBoardRepository(aBoard())
            repository.failNextUpdate = true

            val failure = assertFailsWith<DomainException>("lost the race") {
                serviceWith(repository).updateBoard(anUpdateBoardCommand())
            }

            assertEquals(ErrorCode.CONFLICT, failure.errorCode, "error code")
            assertTrue(audit.events.isEmpty(), "no event for a change that did not happen")
        }

        @Test
        fun `when renaming given the same title then nothing is written or audited`() = runTest {
            val repository = InMemoryBoardRepository(aBoard(title = "Retro"))

            val view = serviceWith(repository).updateBoard(anUpdateBoardCommand(title = " Retro"))

            assertEquals(0, view.board.version, "version unchanged")
            assertTrue(audit.events.isEmpty(), "no event")
        }

        @Test
        fun `when renaming given another user then LIBRARY_BOARD_NOT_FOUND`() = runTest {
            val failure = assertFailsWith<DomainException>("a foreign board looks like it does not exist") {
                serviceWith(InMemoryBoardRepository(aBoard())).updateBoard(anUpdateBoardCommand(caller = asUser(STRANGER)))
            }

            assertEquals(ErrorCode.LIBRARY_BOARD_NOT_FOUND, failure.errorCode, "error code")
            assertTrue(audit.events.isEmpty(), "no event")
        }

        @Test
        fun `when renaming given a blank title then VALIDATION_FAILED`() = runTest {
            assertFailsWith<ValidationFailedException>("blank title") {
                serviceWith(InMemoryBoardRepository(aBoard())).updateBoard(anUpdateBoardCommand(title = " "))
            }
        }
    }

    @Nested
    inner class SetTemplate {

        private val editor = asUser(STRANGER)
        private val editorGrant = grant(ResourceKind.BOARD, BOARD, PrincipalKind.USER, STRANGER.toString(), BoardRole.EDITOR)

        @Test
        fun `when the owner marks the board as a template then the flag and the version change and it is audited`() = runTest {
            val repository = InMemoryBoardRepository(aBoard(title = "Retro"))

            val view = serviceWith(repository).updateBoard(anUpdateBoardCommand(title = "Retro", template = true))

            assertTrue(view.board.template, "template")
            assertEquals(1, view.board.version, "version raised like for a rename")
            val event = audit.events.single()
            assertEquals(BoardTemplateChanged(template = true, basedOnVersion = 0), event.details, "details")
            assertEquals(false, (event.before as Board).template, "snapshot before")
        }

        @Test
        fun `when the owner unmarks a template then it is a normal board again`() = runTest {
            val repository = InMemoryBoardRepository(aBoard(title = "Retro", template = true))

            val view = serviceWith(repository).updateBoard(anUpdateBoardCommand(title = "Retro", template = false))

            assertEquals(false, view.board.template, "no longer a template")
            assertEquals(1, view.board.version, "version raised")
        }

        @Test
        fun `when the template flag is absent then it stays as it is`() = runTest {
            val repository = InMemoryBoardRepository(aBoard(title = "Old", template = true))

            val view = serviceWith(repository).updateBoard(anUpdateBoardCommand(title = "New", template = null))

            assertTrue(view.board.template, "still a template")
            assertEquals(listOf(BoardRenamed("New", 0)), audit.events.map { it.details }, "only the rename is audited")
        }

        @Test
        fun `when renaming and changing the template together then both are audited`() = runTest {
            val repository = InMemoryBoardRepository(aBoard(title = "Old"))

            serviceWith(repository).updateBoard(anUpdateBoardCommand(title = "New", template = true))

            assertEquals(
                listOf(BoardRenamed("New", 0), BoardTemplateChanged(true, 0)),
                audit.events.map { it.details },
                "one event per kind of change",
            )
        }

        @Test
        fun `when an editor changes the template flag then LIBRARY_BOARD_ACCESS_DENIED requiring OWNER and nothing changes`() = runTest {
            val repository = InMemoryBoardRepository(aBoard(title = "Retro"))

            val failure = assertFailsWith<DomainException>("only the owner decides") {
                serviceWith(repository, InMemoryGrantRepository(editorGrant))
                    .updateBoard(anUpdateBoardCommand(caller = editor, title = "Retro", template = true))
            }

            assertEquals(ErrorCode.LIBRARY_BOARD_ACCESS_DENIED, failure.errorCode, "same code as every other role failure")
            assertEquals("OWNER", failure.params["required"], "what would be needed")
            assertEquals(aBoard(title = "Retro"), repository.all.single(), "board untouched")
            assertTrue(audit.events.isEmpty(), "no event")
        }

        @Test
        fun `when an editor renames and sends the current template value then the rename works and the flag stays`() = runTest {
            val repository = InMemoryBoardRepository(aBoard(title = "Old", template = true))

            val view = serviceWith(repository, InMemoryGrantRepository(editorGrant))
                .updateBoard(anUpdateBoardCommand(caller = editor, title = "New", template = true))

            assertEquals("New", view.board.title, "renamed")
            assertTrue(view.board.template, "template unchanged")
            assertEquals(BoardRole.EDITOR, view.role, "as editor")
        }

        @Test
        fun `when an editor renames without the template field then it works`() = runTest {
            val repository = InMemoryBoardRepository(aBoard(title = "Old"))

            val view = serviceWith(repository, InMemoryGrantRepository(editorGrant))
                .updateBoard(anUpdateBoardCommand(caller = editor, title = "New"))

            assertEquals("New", view.board.title, "renamed")
        }
    }

    @Nested
    inner class ListTemplates {

        private val reader = STRANGER
        private val query = PageQuery(0, 20)

        private fun template(title: String, at: Int, owner: Uuid = OWNER, folderId: Uuid? = null, deletedAt: kotlin.time.Instant? = null) =
            aBoard(id = Uuid.generateV7(), title = title, ownerId = owner, updatedAt = FIXED_NOW + at.hours, folderId = folderId,
                template = true, deletedAt = deletedAt)

        private suspend fun titlesFor(
            caller: Caller,
            repository: InMemoryBoardRepository,
            grants: InMemoryGrantRepository = InMemoryGrantRepository(),
            links: InMemoryShareLinkRepository = InMemoryShareLinkRepository(),
            page: PageQuery = query,
        ) = serviceWith(repository, grants, links).listTemplates(caller, page).items.map { it.board.title }

        @Test
        fun `when listing given own templates then OWNER templates of any folder come, newest first, plain boards left out`() = runTest {
            val folder = Folder(Uuid.generateV7(), "f", OWNER, null, FIXED_NOW, FIXED_NOW)
            folders.insert(folder)
            val repository = InMemoryBoardRepository(
                template("old", at = 1), template("in folder", at = 3, folderId = folder.id), template("new", at = 2),
                aBoard(id = Uuid.generateV7(), title = "plain"),
            )

            val page = serviceWith(repository).listTemplates(asUser(OWNER), query)

            assertEquals(listOf("in folder", "new", "old"), page.items.map { it.board.title }, "templates only, newest first")
            assertEquals(setOf(BoardRole.OWNER), page.items.map { it.role }.toSet(), "role")
            assertEquals(3, page.totalElements, "total")
        }

        @Test
        fun `when two templates changed in the same instant then the higher id comes first`() = runTest {
            val first = template("first", at = 1)
            val second = template("second", at = 1)

            val titles = titlesFor(asUser(OWNER), InMemoryBoardRepository(first, second))

            assertEquals(listOf("second", "first"), titles, "UUIDv7 of the later one is higher")
        }

        @Test
        fun `when a template is shared with a user then it is listed with that role, others are not`() = runTest {
            val shared = template("shared", at = 1)
            val hidden = template("hidden", at = 2)
            val grants = userGrant(ResourceKind.BOARD, shared.id, reader, BoardRole.VIEWER)

            val page = serviceWith(InMemoryBoardRepository(shared, hidden), grants).listTemplates(asUser(reader), query)

            assertEquals(listOf("shared"), page.items.map { it.board.title }, "only what the user may open")
            assertEquals(BoardRole.VIEWER, page.items.single().role, "effective role")
            assertEquals(1, page.totalElements, "total counts the visible ones only")
        }

        @Test
        fun `when a template is shared with a group then it counts only for a token that has the group`() = runTest {
            val shared = template("shared", at = 1)
            val grants = InMemoryGrantRepository(grant(ResourceKind.BOARD, shared.id, PrincipalKind.GROUP, "designers", BoardRole.EDITOR))
            val repository = InMemoryBoardRepository(shared)

            assertEquals(listOf("shared"), titlesFor(asUser(reader, "designers"), repository, grants), "token with the group")
            assertEquals(emptyList(), titlesFor(asUser(reader), repository, grants), "token without it")
        }

        @Test
        fun `when a template lies in a shared folder then it is inherited, also from a parent folder`() = runTest {
            val top = Folder(Uuid.generateV7(), "top", OWNER, null, FIXED_NOW, FIXED_NOW)
            val below = Folder(Uuid.generateV7(), "below", OWNER, top.id, FIXED_NOW, FIXED_NOW)
            folders.insert(top)
            folders.insert(below)
            val inherited = template("inherited", at = 1, folderId = below.id)
            val grants = userGrant(ResourceKind.FOLDER, top.id, reader, BoardRole.COMMENTER)

            val page = serviceWith(InMemoryBoardRepository(inherited), grants).listTemplates(asUser(reader), query)

            assertEquals(BoardRole.COMMENTER, page.items.single().role, "role of the folder grant")
        }

        @Test
        fun `when a template was opened through a link then it is listed while the link works, not after it was revoked`() = runTest {
            val opened = template("opened", at = 1)
            val link = ShareLink(
                id = Uuid.generateV7(), resourceKind = ResourceKind.BOARD, resourceId = opened.id, role = BoardRole.VIEWER,
                audience = ShareAudience.SIGNED_IN, tokenHash = "h", passwordHash = null, expiresAt = null, revokedAt = null,
                useCount = 1, createdAt = FIXED_NOW, createdBy = OWNER,
            )
            val grants = InMemoryGrantRepository(
                grant(ResourceKind.BOARD, opened.id, PrincipalKind.LINK_USER, reader.toString(), BoardRole.VIEWER, link.id),
            )
            val repository = InMemoryBoardRepository(opened)

            assertEquals(listOf("opened"), titlesFor(asUser(reader), repository, grants, InMemoryShareLinkRepository(link)), "link works")
            val revoked = link.copy(revokedAt = FIXED_NOW)
            assertEquals(emptyList(), titlesFor(asUser(reader), repository, grants, InMemoryShareLinkRepository(revoked)), "link revoked")
        }

        @Test
        fun `when a template is in the trash itself or through its folder then it is not listed, also not for the owner`() = runTest {
            val folder = Folder(Uuid.generateV7(), "gone", OWNER, null, FIXED_NOW, FIXED_NOW, deletedAt = FIXED_NOW)
            folders.insert(folder)
            val repository = InMemoryBoardRepository(
                template("deleted", at = 1, deletedAt = FIXED_NOW),
                // the cascade of a folder deletion marks the boards below it too
                template("in deleted folder", at = 2, folderId = folder.id, deletedAt = FIXED_NOW),
            )
            val grants = userGrant(ResourceKind.FOLDER, folder.id, reader, BoardRole.VIEWER)

            assertEquals(emptyList(), titlesFor(asUser(OWNER), repository, grants), "owner")
            assertEquals(emptyList(), titlesFor(asUser(reader), repository, grants), "reader of the folder")
        }

        @Test
        fun `when listing given a template of a stranger without any right then nothing is listed`() = runTest {
            assertEquals(emptyList(), titlesFor(asUser(reader), InMemoryBoardRepository(template("foreign", at = 1))), "no right, no entry")
        }

        @Test
        fun `when listing given more templates than a page holds then pages are cut after sorting and the total is the whole`() = runTest {
            val repository = InMemoryBoardRepository(*(1..5).map { template("t$it", at = it) }.toTypedArray())
            val service = serviceWith(repository)

            val second = service.listTemplates(asUser(OWNER), PageQuery(1, 2))
            val beyond = service.listTemplates(asUser(OWNER), PageQuery(5, 2))

            assertEquals(listOf("t3", "t2"), second.items.map { it.board.title }, "second page")
            assertEquals(5, second.totalElements, "total")
            assertEquals(3, second.totalPages, "pages")
            assertTrue(beyond.items.isEmpty(), "a page past the end is empty")
        }

        @Test
        fun `when a user without any grant lists templates then only the own ones come, with one bounded candidate query`() = runTest {
            val repository = InMemoryBoardRepository(template("mine", at = 1, owner = reader), template("foreign", at = 2))

            val service = serviceWith(repository)
            val page = service.listTemplates(asUser(reader), query)

            assertEquals(listOf("mine"), page.items.map { it.board.title }, "only the own template")
            assertEquals(listOf(1000), repository.candidateLimits, "one statement, at most 1000 rows")
            assertEquals(0, folders.childQueries, "no folder is shared, so no subtree is read")
        }

        @Test
        fun `when a stranger owns 1001 templates then they cost one bounded query and none of them shows up`() = runTest {
            val repository = InMemoryBoardRepository(*(1..1001).map { template("t$it", at = it, owner = OWNER) }.toTypedArray())

            val page = serviceWith(repository).listTemplates(asUser(reader), query)

            assertTrue(page.items.isEmpty(), "nothing is reachable for the reader")
            assertEquals(listOf(1000), repository.candidateLimits, "a single query with the cap")
        }

        @Test
        fun `when more than 1000 templates are reachable then the 1000 newest are the candidates`() = runTest {
            val repository = InMemoryBoardRepository(*(1..1001).map { template("t$it", at = it) }.toTypedArray())

            val page = serviceWith(repository).listTemplates(asUser(OWNER), PageQuery(0, 100))

            assertEquals(1000L, page.totalElements, "capped")
            assertEquals("t1001", page.items.first().board.title, "newest first")
            assertTrue(page.items.none { it.board.title == "t1" }, "the oldest one falls off")
        }

        @Test
        fun `when a folder is shared then its whole subtree is searched, level by level`() = runTest {
            val top = Folder(Uuid.generateV7(), "top", OWNER, null, FIXED_NOW, FIXED_NOW)
            val mid = Folder(Uuid.generateV7(), "mid", OWNER, top.id, FIXED_NOW, FIXED_NOW)
            val leaf = Folder(Uuid.generateV7(), "leaf", OWNER, mid.id, FIXED_NOW, FIXED_NOW)
            listOf(top, mid, leaf).forEach { folders.insert(it) }
            val deep = template("deep", at = 1, folderId = leaf.id)
            val grants = userGrant(ResourceKind.FOLDER, top.id, reader, BoardRole.VIEWER)

            assertEquals(listOf("deep"), titlesFor(asUser(reader), InMemoryBoardRepository(deep), grants), "inherited three levels down")
        }

        @Test
        fun `when a user lists templates more than 30 times a minute then 429 with a metric, others are fine, it passes later`() = runTest {
            val service = serviceWith(InMemoryBoardRepository(template("t", at = 1)))
            repeat(30) { service.listTemplates(asUser(reader), query) }

            val failure = assertFailsWith<RateLimitedException>("the 31st call") { service.listTemplates(asUser(reader), query) }

            assertEquals(ErrorCode.TOO_MANY_REQUESTS, failure.errorCode, "error code")
            assertTrue(failure.retryAfterSeconds > 0, "Retry-After")
            assertEquals(1, metrics.refused, "counted")
            assertTrue(audit.events.isEmpty(), "never audited")
            service.listTemplates(asUser(OWNER), query)
            clock.advanceBy(2.minutes)
            service.listTemplates(asUser(reader), query)
        }

        @Test
        fun `when a shared folder has 1500 subfolders then the search is capped at 1000 folders, one level query, no failure`() = runTest {
            val top = Folder(Uuid.generateV7(), "top", OWNER, null, FIXED_NOW, FIXED_NOW)
            folders.insert(top)
            repeat(1500) { folders.insert(Folder(Uuid.generateV7(), "f$it", OWNER, top.id, FIXED_NOW, FIXED_NOW)) }
            val repository = InMemoryBoardRepository(template("in top", at = 1, folderId = top.id))
            val grants = userGrant(ResourceKind.FOLDER, top.id, reader, BoardRole.VIEWER)

            val page = serviceWith(repository, grants).listTemplates(asUser(reader), query)

            assertEquals(listOf("in top"), page.items.map { it.board.title }, "the shared folder itself is always searched")
            assertEquals(1000, repository.lastListSizes.second, "folder budget")
            assertEquals(1, folders.childQueries, "the budget is used up after the first level, so the search stops")
        }

        @Test
        fun `when a user holds 1500 board grants then at most 1000 board ids are searched`() = runTest {
            val ids = (1..1500).map { Uuid.generateV7() }
            val granted = ids.map { grant(ResourceKind.BOARD, it, PrincipalKind.USER, reader.toString(), BoardRole.VIEWER) }
            val grants = InMemoryGrantRepository(*granted.toTypedArray())
            val repository = InMemoryBoardRepository()

            serviceWith(repository, grants).listTemplates(asUser(reader), query)

            assertEquals(1000, repository.lastListSizes.first, "board budget")
        }

        @Test
        fun `when the page number is huge then the page is empty instead of failing`() = runTest {
            val repository = InMemoryBoardRepository(template("t", at = 1))

            val page = serviceWith(repository).listTemplates(asUser(OWNER), PageQuery(Int.MAX_VALUE, 100))

            assertTrue(page.items.isEmpty(), "past the end")
            assertEquals(1, page.totalElements, "total is still right")
        }

        @Test
        fun `when templates sit in one shared folder then the way up the tree is walked once, and never for the owner`() = runTest {
            val top = Folder(Uuid.generateV7(), "top", OWNER, null, FIXED_NOW, FIXED_NOW)
            val below = Folder(Uuid.generateV7(), "below", OWNER, top.id, FIXED_NOW, FIXED_NOW)
            folders.insert(top)
            folders.insert(below)
            val repository = InMemoryBoardRepository(*(1..5).map { template("t$it", at = it, folderId = below.id) }.toTypedArray())
            val grants = userGrant(ResourceKind.FOLDER, top.id, reader, BoardRole.VIEWER)
            val service = serviceWith(repository, grants)
            val before = folders.lookups

            val asReader = service.listTemplates(asUser(reader), query)
            val readerLookups = folders.lookups - before
            service.listTemplates(asUser(OWNER), query)
            val ownerLookups = folders.lookups - before - readerLookups

            assertEquals(5, asReader.items.size, "all five are visible")
            assertEquals(2, readerLookups, "two levels, once for all five boards")
            assertEquals(0, ownerLookups, "the owner is known without the folders")
        }

        @Test
        fun `when a guest lists templates then FORBIDDEN`() = runTest {
            val guest = Caller.Guest(Uuid.generateV7(), ResourceKind.BOARD, BOARD, BoardRole.VIEWER)

            val failure = assertFailsWith<DomainException>("guests have no space and no templates") {
                serviceWith(InMemoryBoardRepository(template("t", at = 1))).listTemplates(guest, query)
            }

            assertEquals(ErrorCode.FORBIDDEN, failure.errorCode, "error code")
        }
    }

    @Nested
    inner class DeleteBoard {

        @Test
        fun `when deleting given the owner then the board is in the trash and the deletion is audited`() = runTest {
            val repository = InMemoryBoardRepository(aBoard())
            clock.advanceBy(2.hours)

            serviceWith(repository).deleteBoard(asUser(OWNER), BOARD)

            assertEquals(clock.now(), repository.all.single().deletedAt, "board is marked as deleted, not removed")
            val event = audit.events.single()
            assertEquals("library.board.deleted", event.eventType, "event type")
            assertEquals(BoardDeleted(age = 2.hours), event.details, "details: how old the board was")
            assertEquals(aBoard(), event.before, "snapshot before")
        }

        @Test
        fun `when deleting given another user then LIBRARY_BOARD_NOT_FOUND and the board stays`() = runTest {
            val repository = InMemoryBoardRepository(aBoard())

            val failure = assertFailsWith<DomainException>("a foreign board looks like it does not exist") {
                serviceWith(repository).deleteBoard(asUser(STRANGER), BOARD)
            }

            assertEquals(ErrorCode.LIBRARY_BOARD_NOT_FOUND, failure.errorCode, "error code")
            assertEquals(1, repository.all.size, "board stays")
            assertTrue(audit.events.isEmpty(), "no event")
        }

        @Test
        fun `when deleting given an unknown id then LIBRARY_BOARD_NOT_FOUND`() = runTest {
            val failure = assertFailsWith<DomainException>("unknown id") {
                serviceWith(InMemoryBoardRepository()).deleteBoard(asUser(OWNER), BOARD)
            }

            assertEquals(ErrorCode.LIBRARY_BOARD_NOT_FOUND, failure.errorCode, "error code")
        }
    }

    @Nested
    inner class RoleOf {

        @Test
        fun `when asking for the role then the owner is OWNER and a stranger or an unknown board has none`() = runTest {
            val service = serviceWith(InMemoryBoardRepository(aBoard()))

            assertEquals(BoardRole.OWNER, service.roleOf(asUser(OWNER), BOARD), "owner")
            assertNull(service.roleOf(asUser(STRANGER), BOARD), "stranger")
            assertNull(service.roleOf(asUser(OWNER), Uuid.random()), "unknown board - null, not an exception")
        }
    }

    @Nested
    inner class RecordContentChange {

        @Test
        fun `when the drawing changed then updatedAt moves forward, the version stays and nothing is audited`() = runTest {
            val repository = InMemoryBoardRepository(aBoard(updatedAt = FIXED_NOW, version = 3))

            serviceWith(repository).recordContentChange(BOARD, FIXED_NOW + 1.hours)

            assertEquals(FIXED_NOW + 1.hours, repository.all.single().updatedAt, "updated at")
            assertEquals(3, repository.all.single().version, "a rename in progress must not conflict with the drawing")
            assertTrue(audit.events.isEmpty(), "content changes are not audited")
        }

        @Test
        fun `when an older change is reported late then updatedAt is not lowered, and an unknown board is ignored`() = runTest {
            val repository = InMemoryBoardRepository(aBoard(updatedAt = FIXED_NOW + 2.hours))
            val service = serviceWith(repository)

            service.recordContentChange(BOARD, FIXED_NOW + 1.hours)
            service.recordContentChange(Uuid.random(), FIXED_NOW)

            assertEquals(FIXED_NOW + 2.hours, repository.all.single().updatedAt, "never lowered")
        }
    }
}
