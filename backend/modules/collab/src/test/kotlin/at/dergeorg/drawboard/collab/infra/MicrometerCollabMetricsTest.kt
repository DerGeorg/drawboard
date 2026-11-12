package at.dergeorg.drawboard.collab.infra

import at.dergeorg.drawboard.collab.domain.rooms.CompactionResult
import at.dergeorg.drawboard.collab.domain.rooms.DropReason
import io.micrometer.core.instrument.simple.SimpleMeterRegistry
import io.mockk.every
import io.mockk.mockk
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.ObjectProvider
import kotlin.test.assertEquals

class MicrometerCollabMetricsTest {

    private val registry = SimpleMeterRegistry()
    private val provider = mockk<ObjectProvider<io.micrometer.core.instrument.MeterRegistry>> { every { getObject() } returns registry }
    private val metrics = MicrometerCollabMetrics(provider)

    @Test
    fun `when reporting then the counters carry only reason, code and result as tags`() {
        metrics.updateAccepted(100)
        metrics.updateAccepted(50)
        metrics.dropped(DropReason.ROLE)
        metrics.closed("4403")
        metrics.compaction(CompactionResult.STORED)

        assertEquals(2.0, registry.get("drawboard.collab.updates").counter().count(), "updates")
        assertEquals(150.0, registry.get("drawboard.collab.update.bytes").summary().totalAmount(), "update bytes (sum)")
        assertEquals(2L, registry.get("drawboard.collab.update.bytes").summary().count(), "update bytes (count)")
        assertEquals(1.0, registry.get("drawboard.collab.dropped").tag("reason", "role").counter().count(), "dropped by reason")
        assertEquals(1.0, registry.get("drawboard.collab.closes").tag("code", "4403").counter().count(), "closes by code")
        assertEquals(1.0, registry.get("drawboard.collab.compactions").tag("result", "stored").counter().count(), "compactions by result")
        val tagKeys = registry.meters.flatMap { meter -> meter.id.tags.map { it.key } }.toSet()
        assertEquals(setOf("reason", "code", "result"), tagKeys, "no user, board or ticket in a label")
    }

    @Test
    fun `when the storage is read again then the gauge shows the last value per kind`() {
        metrics.storageBytes("snapshot", 10)
        metrics.storageBytes("log", 4)
        metrics.storageBytes("snapshot", 25)

        assertEquals(25.0, registry.get("drawboard.storage.bytes").tag("kind", "snapshot").gauge().value(), "snapshot bytes")
        assertEquals(4.0, registry.get("drawboard.storage.bytes").tag("kind", "log").gauge().value(), "log bytes")
    }
}
