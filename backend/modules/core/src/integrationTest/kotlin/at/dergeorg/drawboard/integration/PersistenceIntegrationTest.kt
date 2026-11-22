package at.dergeorg.drawboard.integration

import at.dergeorg.drawboard.library.domain.access.model.Caller
import at.dergeorg.drawboard.library.domain.boards.provides.BoardsUseCase
import at.dergeorg.drawboard.library.domain.boards.provides.CreateBoardCommand
import at.dergeorg.drawboard.library.domain.boards.provides.UpdateBoardCommand
import at.dergeorg.drawboard.shared.auditing.AuditFilter
import at.dergeorg.drawboard.shared.auditing.AuditLog
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.paging.PageQuery
import at.dergeorg.drawboard.users.domain.users.provides.SyncFromLoginCommand
import at.dergeorg.drawboard.users.domain.users.provides.UserProfilesUseCase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runTest
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.transaction.reactive.TransactionalOperator
import org.springframework.transaction.reactive.executeAndAwait
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlin.uuid.Uuid

/**
 * What only the database can prove: one schema per module with its own history, row locks and savepoints, change and
 * audit share a transaction. Everything is read through use cases, ports and Flyway - never with SQL. (Append-only of
 * the audit table is enforced in code and checked by ArchUnit, not by database triggers.)
 */
@IntegrationTest
class PersistenceIntegrationTest(
    private val flyway: Flyway,
    private val transactions: TransactionalOperator,
    private val boards: BoardsUseCase,
    private val profiles: UserProfilesUseCase,
    private val auditLog: AuditLog,
) {

    @Nested
    inner class Migrations {

        @Test
        fun `when the application has started then every module has its schema with its own Flyway history`() {
            val versions = SCHEMAS.associateWith { schema ->
                Flyway.configure().configuration(flyway.configuration).schemas(schema).defaultSchema(schema)
                    .locations("classpath:db/migration/$schema").load().info().current()?.version?.version
            }

            assertEquals(SCHEMAS.associateWith { LATEST_MIGRATION[it] ?: "1" }, versions, "current migration per module schema")
        }
    }

    @Nested
    inner class Locks {

        /** updateBoard checks the version in `save()` (UPDATE … WHERE version = ?): of parallel renames only one wins. */
        @Test
        fun `when renaming in parallel on the same version then exactly one wins and the others get CONFLICT`() = runTest {
            val board = boards.createBoard(CreateBoardCommand(OWNER, "Rename me in parallel")).board

            val results = List(PARALLEL) { i ->
                async(Dispatchers.IO) {
                    runCatching { boards.updateBoard(UpdateBoardCommand(Caller.User(OWNER), board.id, "Winner $i", board.version)) }
                }
            }.awaitAll()

            assertEquals(1, results.count { it.isSuccess }, "exactly one rename succeeds")
            val failures = results.mapNotNull { it.exceptionOrNull() }
            assertEquals(setOf(ErrorCode.CONFLICT), failures.map { (it as DomainException).errorCode }.toSet(), "the others get CONFLICT")
            assertEquals(
                listOf("library.board.created", "library.board.updated"),
                auditLog.history("board", board.id.toString()).map { it.eventType },
                "audited exactly once",
            )
        }

        /** deleteBoard reads with @Lock(PESSIMISTIC_WRITE) (SELECT … FOR UPDATE): the others wait and find nothing. */
        @Test
        fun `when a board is deleted by parallel requests then exactly one deletion happens and the others get NOT_FOUND`() = runTest {
            val board = boards.createBoard(CreateBoardCommand(OWNER, "Delete me in parallel")).board

            val owner = Caller.User(OWNER)
            val results = List(PARALLEL) { async(Dispatchers.IO) { runCatching { boards.deleteBoard(owner, board.id) } } }.awaitAll()

            assertEquals(1, results.count { it.isSuccess }, "exactly one deletion succeeds")
            assertEquals(
                setOf(ErrorCode.LIBRARY_BOARD_NOT_FOUND),
                results.mapNotNull { it.exceptionOrNull() }.map { (it as DomainException).errorCode }.toSet(),
                "the others find nothing",
            )
            assertEquals(
                listOf("library.board.created", "library.board.deleted"),
                auditLog.history("board", board.id.toString()).map { it.eventType },
                "audited exactly once",
            )
        }
    }

    @Nested
    inner class Inserts {

        /** The login key is unique: the insert runs in a savepoint, a duplicate key rolls back only that. */
        @Test
        fun `when a new user arrives with parallel first requests then one profile is created and none fails`() = runTest {
            val command = SyncFromLoginCommand(
                issuer = "https://idp.example.test",
                subject = "parallel-${Uuid.random()}",
                username = "parallel",
                displayName = null,
                email = null,
                groups = listOf("g"),
            )

            val results = List(PARALLEL) { async(Dispatchers.IO) { runCatching { profiles.syncFromLogin(command) } } }.awaitAll()

            assertEquals(emptyList(), results.mapNotNull { it.exceptionOrNull() }, "no parallel first request may fail")
            val ids = results.map { it.getOrThrow().id }.toSet()
            assertEquals(1, ids.size, "all return the one stored profile")
            assertEquals(
                listOf("users.profile.created"),
                auditLog.history("profile", ids.single().toString()).map { it.eventType },
                "audited exactly once",
            )
        }
    }

    @Nested
    inner class Transactions {

        @Test
        fun `when the transaction of a change rolls back then neither the change nor its audit event remain`() = runTest {
            var createdId: Uuid? = null

            val result = runCatching {
                transactions.executeAndAwait {
                    createdId = boards.createBoard(CreateBoardCommand(OWNER, "Roll me back")).board.id
                    error("simulated failure after the change")
                }
            }

            val id = checkNotNull(createdId) { "the board was not created inside the transaction" }
            assertContains(result.exceptionOrNull()?.message.orEmpty(), "simulated failure", message = "the simulated failure")
            val gone = assertFailsWith<DomainException>("the rolled back board must not exist") { boards.getBoard(Caller.User(OWNER), id) }
            assertEquals(ErrorCode.LIBRARY_BOARD_NOT_FOUND, gone.errorCode, "error code of the rolled back board")
            assertTrue(
                auditLog.find(AuditFilter(entityType = "board", entityId = id.toString()), PageQuery(0, 10)).items.isEmpty(),
                "no audit event may be left after the rollback",
            )
        }
    }

    private companion object {
        const val PARALLEL = 8
        val SCHEMAS = listOf("auditing", "library", "users")

        /** The newest migration per schema where it is not V1. */
        val LATEST_MIGRATION = mapOf("library" to "5", "users" to "2")
        val OWNER: Uuid = Uuid.random()
    }
}
