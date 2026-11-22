package at.dergeorg.drawboard.planning.infra

import at.dergeorg.drawboard.planning.domain.sessions.EstimationLimits
import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * Caps and rates of the estimation sessions, bound from `planning.estimation.*` (environment variables `PLANNING_ESTIMATION_*`,
 * relaxed binding). The defaults are the numbers of the Fable decisions E10, E16 and E17; change them only to test a cap.
 */
@ConfigurationProperties("planning.estimation")
internal data class EstimationProperties(
    val maxActiveSessions: Int = 3,
    val maxClosedSessions: Int = 100,
    val maxSeats: Int = 30,
    val maxGuests: Int = 15,
    val maxGuestsPerShare: Int = 10,
    val maxMovesPerSession: Int = 5000,
    val createsPerMinute: Int = 10,
    val listsPerMinute: Int = 30,
    val shareListsPerMinute: Int = 300,
    val getsPerMinute: Int = 75,
    val shareGetsPerMinute: Int = 600,
    val seatChangesPerMinute: Int = 10,
    val shareSeatChangesPerMinute: Int = 30,
    val placementsPerMinute: Int = 60,
    val sharePlacementsPerMinute: Int = 300,
    val estimatesPerMinute: Int = 30,
    val shareEstimatesPerMinute: Int = 150,
    val moderatorOpsPerMinute: Int = 120,
) {
    fun toLimits() = EstimationLimits(
        maxActiveSessions = maxActiveSessions,
        maxClosedSessions = maxClosedSessions,
        maxSeats = maxSeats,
        maxGuests = maxGuests,
        maxGuestsPerShare = maxGuestsPerShare,
        maxMovesPerSession = maxMovesPerSession,
        createsPerMinute = createsPerMinute,
        listsPerMinute = listsPerMinute,
        shareListsPerMinute = shareListsPerMinute,
        getsPerMinute = getsPerMinute,
        shareGetsPerMinute = shareGetsPerMinute,
        seatChangesPerMinute = seatChangesPerMinute,
        shareSeatChangesPerMinute = shareSeatChangesPerMinute,
        placementsPerMinute = placementsPerMinute,
        sharePlacementsPerMinute = sharePlacementsPerMinute,
        estimatesPerMinute = estimatesPerMinute,
        shareEstimatesPerMinute = shareEstimatesPerMinute,
        moderatorOpsPerMinute = moderatorOpsPerMinute,
    )
}
