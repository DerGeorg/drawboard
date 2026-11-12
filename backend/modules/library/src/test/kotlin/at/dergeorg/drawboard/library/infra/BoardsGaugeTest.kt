package at.dergeorg.drawboard.library.infra

import at.dergeorg.drawboard.library.domain.InMemoryBoardRepository
import at.dergeorg.drawboard.library.testing.BoardFixtures.aBoard
import at.dergeorg.drawboard.shared.testing.RecordingAppLogger
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.simple.SimpleMeterRegistry
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.ObjectProvider
import kotlin.test.assertEquals
import kotlin.uuid.Uuid

class BoardsGaugeTest {

    @Test
    fun `when the number of boards is read then the gauge drawboard_boards shows it`() = runTest {
        val registry = SimpleMeterRegistry()
        val provider = mockk<ObjectProvider<MeterRegistry>> { every { getObject() } returns registry }
        val boards = InMemoryBoardRepository(aBoard(), aBoard(id = Uuid.random()))

        BoardsGauge(boards, provider, RecordingAppLogger()).refresh()

        assertEquals(2.0, registry.get("drawboard.boards").gauge().value(), "boards")
    }
}
