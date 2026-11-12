package at.dergeorg.drawboard.api.domain.planning

import at.dergeorg.drawboard.library.domain.access.model.Caller
import at.dergeorg.drawboard.library.domain.sharing.provides.LinksUseCase
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.uuid.Uuid

class LibraryGuestSharesTest {

    private val links = mockk<LinksUseCase>()
    private val alive = Uuid.generateV7()
    private val revoked = Uuid.generateV7()

    @Test
    fun `when library no longer knows a guest for a link then the link is revoked, the others are not`() = runTest {
        coEvery { links.guestCaller(alive) } returns mockk<Caller.Guest>()
        coEvery { links.guestCaller(revoked) } returns null

        assertEquals(setOf(revoked), LibraryGuestShares(links).revoked(listOf(alive, revoked)), "only the revoked one")
    }

    @Test
    fun `when no links are asked about then nothing is revoked`() = runTest {
        assertEquals(emptySet(), LibraryGuestShares(links).revoked(emptyList()), "empty")
    }
}
