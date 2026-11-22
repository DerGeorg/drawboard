package at.dergeorg.drawboard.api.common

import at.dergeorg.drawboard.planning.domain.rounds.provides.PlanningUseCase
import at.dergeorg.drawboard.planning.domain.sessions.provides.EstimationUseCase
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.uuid.Uuid

class BoardDataEraserTest {

    private val planning = mockk<PlanningUseCase>()
    private val estimation = mockk<EstimationUseCase>()
    private val eraser = BoardDataEraser(mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true), planning, estimation)
    private val boards = listOf(Uuid.generateV7())

    @Test
    fun `when boards are purged then the poker rounds and the estimation sessions are both erased`() = runTest {
        coEvery { planning.deleteBoardData(boards) } returns Unit
        coEvery { estimation.deleteBoardData(boards) } returns Unit

        eraser.erase(boards)

        coVerify(exactly = 1) { planning.deleteBoardData(boards) }
        coVerify(exactly = 1) { estimation.deleteBoardData(boards) }
    }

    @Test
    fun `when erasing the rounds fails then the sessions are still erased and the failure comes afterwards (E24)`() = runTest {
        val failure = IllegalStateException("rounds")
        coEvery { planning.deleteBoardData(boards) } throws failure
        coEvery { estimation.deleteBoardData(boards) } returns Unit

        val thrown = assertFailsWith<IllegalStateException>("the failure is not swallowed") { eraser.erase(boards) }

        coVerify(exactly = 1) { estimation.deleteBoardData(boards) }
        assertEquals(failure, thrown, "the first failure")
    }

    @Test
    fun `when both fail then the second failure is attached to the first`() = runTest {
        coEvery { planning.deleteBoardData(boards) } throws IllegalStateException("rounds")
        coEvery { estimation.deleteBoardData(boards) } throws IllegalArgumentException("sessions")

        val thrown = assertFailsWith<IllegalStateException>("first") { eraser.erase(boards) }

        assertEquals(listOf("sessions"), thrown.suppressed.map { it.message }, "suppressed")
    }
}
