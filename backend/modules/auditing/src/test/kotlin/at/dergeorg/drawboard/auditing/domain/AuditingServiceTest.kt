package at.dergeorg.drawboard.auditing.domain

import at.dergeorg.drawboard.auditing.common.AuditJson
import at.dergeorg.drawboard.auditing.common.DetailsTypeRegistry
import at.dergeorg.drawboard.auditing.common.samples.valid.TaskCompleted
import at.dergeorg.drawboard.shared.auditing.AuditAction
import at.dergeorg.drawboard.shared.auditing.DomainEvents
import at.dergeorg.drawboard.shared.auditing.FieldChange
import at.dergeorg.drawboard.shared.context.Actor
import at.dergeorg.drawboard.shared.context.RequestContext
import at.dergeorg.drawboard.shared.testing.FIXED_NOW
import at.dergeorg.drawboard.shared.testing.FixedRequestContextProvider
import at.dergeorg.drawboard.shared.testing.MutableClock
import at.dergeorg.drawboard.shared.testing.TestUsers
import at.dergeorg.drawboard.shared.testing.version
import at.dergeorg.drawboard.shared.types.KotlinTypesJacksonModule
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import tools.jackson.databind.json.JsonMapper
import tools.jackson.module.kotlin.KotlinModule
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.time.Duration.Companion.hours

class AuditingServiceTest {

    private val store = InMemoryAuditEventStore()
    private val requestContext = FixedRequestContextProvider(
        RequestContext(
            actor = Actor.user(TestUsers.ALICE.subject),
            requestId = "req-0001-abcd",
            traceId = "4bf92f3577b34da6a3ce929d0e0e4736",
        ),
    )
    private val service = AuditingService(
        store = store,
        json = AuditJson(
            JsonMapper.builder().addModule(KotlinModule.Builder().build()).addModule(KotlinTypesJacksonModule()).build(),
            DetailsTypeRegistry(listOf("at.dergeorg.drawboard.auditing.common.samples.valid")),
        ),
        requestContext = requestContext,
        clock = MutableClock(),
    )
    private val events = DomainEvents(module = "board")

    @Nested
    inner class Record {

        @Test
        fun `when an event is recorded then actor request id and trace id come from the request context`() = runTest {
            service.record(events.created("task", "t-1", after = Task("Write tests", done = false)))

            val stored = store.events.single()
            assertEquals("USER", stored.actorType, "actor type")
            assertEquals(TestUsers.ALICE.subject, stored.actorId, "actor id = token subject")
            assertEquals("req-0001-abcd", stored.requestId, "request id of the request")
            assertEquals("4bf92f3577b34da6a3ce929d0e0e4736", stored.traceId, "trace id of the request")
            assertEquals(FIXED_NOW, stored.occurredAt, "time from the clock")
        }

        @Test
        fun `when an event is recorded then its id is a UUIDv7`() = runTest {
            val id = service.record(events.created("task", "t-1", after = Task("Write tests", done = false)))

            assertEquals(7, id.version(), "audit event ids are app-generated UUIDv7")
        }

        @Test
        fun `when there is no difference and no details then both JSON columns stay empty`() = runTest {
            service.record(events.of("task", "t-1", AuditAction.ACCESSED, "read"))

            val stored = store.events.single()
            assertNull(stored.changes, "changes of an event without snapshots")
            assertNull(stored.details, "details of an event without details")
        }
    }

    @Nested
    inner class History {

        @Test
        fun `when reading the history then changes and typed details are restored`() = runTest {
            val before = Task("Write tests", done = false)
            val after = before.copy(done = true)
            service.record(
                events.of("task", "t-1", AuditAction.UPDATED, "completed", TaskCompleted(2.hours), before, after),
            )

            val record = service.history("task", "t-1").single()

            assertEquals("board.task.completed", record.eventType, "event type")
            assertEquals(listOf(FieldChange("done", false, true)), record.changes, "changes")
            assertEquals(TaskCompleted(2.hours), record.detailsAs<TaskCompleted>(), "typed details")
            assertEquals(Actor.user(TestUsers.ALICE.subject), record.actor, "actor")
        }
    }

    data class Task(val title: String, val done: Boolean)
}
