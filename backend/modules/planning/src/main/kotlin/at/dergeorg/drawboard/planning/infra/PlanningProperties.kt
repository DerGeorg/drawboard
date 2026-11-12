package at.dergeorg.drawboard.planning.infra

import at.dergeorg.drawboard.planning.domain.rounds.PlanningSettings
import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * Settings of the planning module, bound from `planning.*` (environment variables `PLANNING_*`, relaxed binding). The defaults are the
 * numbers of the contract and the M4 review; change them only to test a cap.
 *
 * @param maxParticipants `PLANNING_MAX_PARTICIPANTS`: participants per round (members and guests).
 * @param maxGuests `PLANNING_MAX_GUESTS`: guests per round.
 * @param maxGuestsPerShare `PLANNING_MAX_GUESTS_PER_SHARE`: guests of one link per round.
 * @param maxOpenRounds `PLANNING_MAX_OPEN_ROUNDS`: OPEN rounds per board.
 * @param maxClosedRounds `PLANNING_MAX_CLOSED_ROUNDS`: closed rounds a board keeps; a create prunes the oldest CANCELLED, then REVEALED.
 */
@ConfigurationProperties("planning")
internal data class PlanningProperties(
    val maxParticipants: Int = 200,
    val maxGuests: Int = 50,
    val maxGuestsPerShare: Int = 20,
    val maxOpenRounds: Int = 10,
    val maxClosedRounds: Int = 500,
    val listsPerMinute: Int = 30,
    val createsPerMinute: Int = 10,
    val votesPerMinute: Int = 30,
    val getsPerMinute: Int = 60,
    val shareListsPerMinute: Int = 300,
    val shareVotesPerMinute: Int = 100,
    val shareGetsPerMinute: Int = 300,
) {
    fun toSettings() = PlanningSettings(
        maxParticipants, maxGuests, maxGuestsPerShare, maxOpenRounds, maxClosedRounds, listsPerMinute, createsPerMinute, votesPerMinute,
        getsPerMinute, shareListsPerMinute, shareVotesPerMinute, shareGetsPerMinute,
    )
}
