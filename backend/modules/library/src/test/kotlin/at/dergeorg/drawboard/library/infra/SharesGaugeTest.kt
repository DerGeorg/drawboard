package at.dergeorg.drawboard.library.infra

import at.dergeorg.drawboard.library.domain.sharing.model.ShareAudience
import at.dergeorg.drawboard.library.domain.sharing.requires.ShareLinkRepository
import at.dergeorg.drawboard.shared.testing.FixedClock
import at.dergeorg.drawboard.shared.testing.RecordingAppLogger
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.simple.SimpleMeterRegistry
import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.ObjectProvider
import kotlin.test.assertEquals

class SharesGaugeTest {

    @Test
    fun `when the usable links are counted then the gauge drawboard_share_links_active shows them per audience`() = runTest {
        val registry = SimpleMeterRegistry()
        val provider = mockk<ObjectProvider<MeterRegistry>> { every { getObject() } returns registry }
        val links = mockk<ShareLinkRepository>()
        ShareAudience.entries.forEachIndexed { index, audience -> coEvery { links.countUsable(audience, any()) } returns index + 3L }

        SharesGauge(links, provider, FixedClock(), RecordingAppLogger()).refresh()

        ShareAudience.entries.forEachIndexed { index, audience ->
            val gauge = registry.get("drawboard.share.links.active").tag("audience", audience.name.lowercase()).gauge()
            assertEquals(index + 3.0, gauge.value(), "links of audience $audience")
        }
    }
}
