package at.dergeorg.drawboard.api.domain.gifs

import at.dergeorg.drawboard.api.common.Callers
import at.dergeorg.drawboard.api.common.SignedInUsers
import at.dergeorg.drawboard.contract.model.GifSearch
import at.dergeorg.drawboard.gifs.domain.search.model.GifResults
import at.dergeorg.drawboard.gifs.domain.search.model.GifSummary
import at.dergeorg.drawboard.gifs.domain.search.model.SearchGifsCommand
import at.dergeorg.drawboard.gifs.domain.search.provides.GifSearchUseCase
import at.dergeorg.drawboard.shared.context.CurrentGuest
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.testing.FIXED_NOW
import at.dergeorg.drawboard.shared.testing.FixedCurrentGuestProvider
import at.dergeorg.drawboard.shared.testing.FixedCurrentUserProvider
import at.dergeorg.drawboard.shared.testing.TestUsers
import at.dergeorg.drawboard.users.domain.users.provides.UserProfilesUseCase
import at.dergeorg.drawboard.users.testing.UserProfileFixtures.ALICE_ID
import at.dergeorg.drawboard.users.testing.UserProfileFixtures.aSyncFromLoginCommand
import at.dergeorg.drawboard.users.testing.UserProfileFixtures.aUserProfile
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.uuid.Uuid

class GifsApiServiceTest {

    private val gifs = mockk<GifSearchUseCase>()
    private val profiles = mockk<UserProfilesUseCase>()
    private val currentUsers = FixedCurrentUserProvider()
    private val guests = FixedCurrentGuestProvider()
    private val signedIn = SignedInUsers(currentUsers, profiles)
    private val service = GifsApiService(gifs, signedIn, Callers(signedIn, guests, mockk()))

    private fun enabled() {
        every { gifs.requireEnabled() } returns Unit
        coEvery { profiles.findByLogin(any(), any()) } returns aUserProfile(TestUsers.ALICE)
    }

    private val aGuest = CurrentGuest(
        id = Uuid.random(), shareId = Uuid.random(), resourceKind = "BOARD", resourceId = Uuid.random(), role = "EDITOR",
        name = "Guest", authTime = FIXED_NOW, tokenExpiresAt = FIXED_NOW, passwordVerified = false,
    )

    @Test
    fun `when searching given a signed-in user then the user's own id and the request go to the module and the page is mapped`() = runTest {
        enabled()
        val command = slot()
        coEvery { gifs.search(capture(command)) } returns GifResults(listOf(GifSummary("abc123", "Cat", 480, 270)), hasMore = true)

        val page = service.searchGifs(GifSearch(q = "cat", page = 2, lang = "de"))

        assertEquals(SearchGifsCommand(ALICE_ID, "cat", 2, "de"), command.captured, "the user's own id, not the subject")
        assertEquals(listOf("abc123", "Cat", 480, 270), page.items.single().let { listOf(it.id, it.title, it.width, it.height) }, "the GIF")
        assertEquals(true, page.hasMore, "hasMore passes through")
    }

    @Test
    fun `when searching given no page then page 0`() = runTest {
        enabled()
        coEvery { gifs.search(SearchGifsCommand(ALICE_ID, "cat", 0, null)) } returns GifResults(emptyList(), hasMore = false)

        assertEquals(emptyList(), service.searchGifs(GifSearch(q = "cat")).items, "the default page is 0")
    }

    @Test
    fun `when the instance has no key then 404 GIFS_DISABLED before anybody is looked up`() = runTest {
        every { gifs.requireEnabled() } throws DomainException(ErrorCode.GIFS_DISABLED)

        val error = assertFailsWith<DomainException>("disabled comes first (G7)") { service.searchGifs(GifSearch(q = "cat")) }

        assertEquals(ErrorCode.GIFS_DISABLED, error.errorCode, "error code")
        coVerify(exactly = 0) { profiles.findByLogin(any(), any()) }
    }

    @Test
    fun `when a guest searches then 403 FORBIDDEN, also with an EDITOR link, and the module is not asked`() = runTest {
        every { gifs.requireEnabled() } returns Unit
        guests.guest = aGuest

        val search = assertFailsWith<DomainException>("search") { service.searchGifs(GifSearch(q = "cat")) }
        val trending = assertFailsWith<DomainException>("trending") { service.listTrendingGifs() }

        assertEquals(listOf(ErrorCode.FORBIDDEN, ErrorCode.FORBIDDEN), listOf(search.errorCode, trending.errorCode),
            "guests are no callers (G5)")
        coVerify(exactly = 0) { gifs.search(any()) }
        coVerify(exactly = 0) { gifs.trending(any()) }
    }

    @Test
    fun `when listing the trending GIFs given a signed-in user then the module is asked for that user`() = runTest {
        enabled()
        coEvery { profiles.syncFromLogin(aSyncFromLoginCommand(TestUsers.ALICE)) } returns aUserProfile(TestUsers.ALICE)
        coEvery { gifs.trending(ALICE_ID) } returns GifResults(listOf(GifSummary("x1", "", 1, 1)), hasMore = false)

        val page = service.listTrendingGifs()

        assertEquals(listOf("x1"), page.items.map { it.id }, "the trending page")
    }

    private fun slot() = io.mockk.slot<SearchGifsCommand>()
}
