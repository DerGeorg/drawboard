package at.dergeorg.drawboard.shared.auditing

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class DomainEventsTest {

    private val events = DomainEvents(module = "board")

    @Test
    fun `when creating a created event then type module entity and snapshot are set`() {
        val event = events.created("task", entityId = 42, after = mapOf("title" to "Write tests"))

        assertEquals("board.task.created", event.eventType, "event type = <module>.<entity>.<what>")
        assertEquals("board", event.module, "module of the event")
        assertEquals("42", event.entityId, "entity id as text")
        assertEquals(AuditAction.CREATED, event.action, "action of a created event")
        assertNull(event.before, "nothing existed before")
    }

    @Test
    fun `when creating a custom event then its name becomes the last part of the type`() {
        val event = events.of("task", entityId = "7", action = AuditAction.UPDATED, name = "completed")

        assertEquals("board.task.completed", event.eventType, "type of a custom event")
    }
}
