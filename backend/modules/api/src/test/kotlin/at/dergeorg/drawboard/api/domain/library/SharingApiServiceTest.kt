package at.dergeorg.drawboard.api.domain.library

import at.dergeorg.drawboard.api.common.SignedInUsers
import at.dergeorg.drawboard.library.domain.access.model.Caller
import at.dergeorg.drawboard.library.domain.access.model.ResourceKind
import at.dergeorg.drawboard.library.domain.sharing.provides.LinksUseCase
import at.dergeorg.drawboard.library.domain.sharing.provides.RevokedLink
import at.dergeorg.drawboard.planning.domain.rounds.provides.PlanningUseCase
import at.dergeorg.drawboard.planning.domain.sessions.provides.EstimationUseCase
import at.dergeorg.drawboard.collab.domain.rooms.provides.CollabUseCase
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.testing.FixedClock
import at.dergeorg.drawboard.shared.testing.FIXED_NOW
import at.dergeorg.drawboard.shared.testing.FixedCurrentUserProvider
import at.dergeorg.drawboard.shared.testing.RecordingAppLogger
import at.dergeorg.drawboard.shared.testing.RecordingAppLogger.LogLevel
import at.dergeorg.drawboard.shared.testing.TestUsers.ALICE
import at.dergeorg.drawboard.users.domain.users.provides.UserProfilesUseCase
import at.dergeorg.drawboard.users.testing.UserProfileFixtures.aUserProfile
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.coVerifyOrder
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertSame
import kotlin.uuid.Uuid

class SharingApiServiceTest {

    private val profiles = mockk<UserProfilesUseCase>()
    private val links = mockk<LinksUseCase>()
    private val collab = mockk<CollabUseCase>(relaxUnitFun = true)
    private val planning = mockk<PlanningUseCase>()
    private val estimation = mockk<EstimationUseCase>()
    private val log = RecordingAppLogger()
    private val linkId = Uuid.generateV7()

    private val service = SharingApiService(
        signedIn = SignedInUsers(FixedCurrentUserProvider(ALICE), profiles),
        members = mockk(),
        links = links,
        callers = mockk(),
        guestTokens = mockk(),
        clock = FixedClock(FIXED_NOW),
        clientAddress = mockk(),
        properties = mockk(),
        profiles = profiles,
        collab = collab,
        planning = planning,
        estimation = estimation,
        log = log,
    )

    init {
        coEvery { profiles.findByLogin(ALICE.issuer, ALICE.subject) } returns aUserProfile(ALICE)
        coEvery { links.revokeLink(any(), linkId) } returns RevokedLink(ResourceKind.BOARD, Uuid.generateV7())
    }

    @Test
    fun `when a link is revoked then its guests leave the open rounds and the estimation sessions after the recheck`() =
        runTest {
            coEvery { planning.removeGuestsOfShare(linkId) } returns Unit
            coEvery { estimation.removeGuestsOfShare(linkId) } returns Unit

            service.revokeLink(linkId)

            coVerifyOrder {
                links.revokeLink(any<Caller>(), linkId)
                collab.recheckAll()
                planning.removeGuestsOfShare(linkId)
                estimation.removeGuestsOfShare(linkId)
            }
            assertEquals(emptyList(), log.entries, "nothing to report")
        }

    @Test
    fun `when removing the guests from the rounds fails then the estimation sessions are still cleaned up (E24)`() = runTest {
        coEvery { planning.removeGuestsOfShare(linkId) } throws IllegalStateException("database gone")
        coEvery { estimation.removeGuestsOfShare(linkId) } returns Unit

        service.revokeLink(linkId)

        coVerify(exactly = 1) { estimation.removeGuestsOfShare(linkId) }
        assertEquals(1, log.entries.size, "one failure logged")
    }

    @Test
    fun `when removing the guests from the estimation sessions fails then the rounds were cleaned up and the failure is logged`() =
        runTest {
            coEvery { planning.removeGuestsOfShare(linkId) } returns Unit
            coEvery { estimation.removeGuestsOfShare(linkId) } throws IllegalStateException("database gone")

            service.revokeLink(linkId)

            coVerify(exactly = 1) { planning.removeGuestsOfShare(linkId) }
            assertEquals(LogLevel.ERROR, log.entries.single().level, "logged at ERROR")
        }

    @Test
    fun `when removing the guests fails then the revoke still succeeds and the failure is logged at ERROR with the share id`() = runTest {
        val failure = IllegalStateException("database gone")
        coEvery { planning.removeGuestsOfShare(linkId) } throws failure
        coEvery { estimation.removeGuestsOfShare(linkId) } returns Unit

        service.revokeLink(linkId) // no exception: the link is revoked and the sessions are cut

        val entry = log.entries.single()
        assertEquals(LogLevel.ERROR, entry.level, "level")
        assertSame(failure, entry.cause, "the cause goes to the log")
        assertEquals(linkId.toString(), entry.fields["share.id"], "the share id is a field")
        coVerify(exactly = 1) { collab.recheckAll() }
    }

    @Test
    fun `when the revoke itself fails then the guests are not touched and the error reaches the caller`() = runTest {
        coEvery { links.revokeLink(any(), linkId) } throws DomainException(ErrorCode.LIBRARY_SHARE_NOT_FOUND)

        assertFailsWith<DomainException>("revoke refused") { service.revokeLink(linkId) }

        coVerify(exactly = 0) { planning.removeGuestsOfShare(any()) }
        coVerify(exactly = 0) { estimation.removeGuestsOfShare(any()) }
    }
}
