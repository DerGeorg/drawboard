package at.dergeorg.drawboard.planning.domain.rounds

import at.dergeorg.drawboard.planning.domain.common.ValueStats
import at.dergeorg.drawboard.planning.domain.rounds.model.Deck
import at.dergeorg.drawboard.planning.domain.rounds.model.ResultVote
import at.dergeorg.drawboard.planning.domain.rounds.model.RoundResult
import at.dergeorg.drawboard.planning.domain.rounds.model.StoredParticipant

/**
 * The result of a revealed round, computed from the votes (nothing of it is stored): every vote in the order of joining, the mean and
 * the median of the numeric deck values, how often each value was chosen, and the suggestion - the value chosen most often, ignoring
 * `?` and `coffee`, the higher one (later in the deck) on a tie.
 */
internal object RoundResults {

    fun of(deck: Deck, participants: List<StoredParticipant>): RoundResult {
        val voted = participants.filter { it.vote != null }
        val votes = voted.map { ResultVote(it.displayName, it.guest, checkNotNull(it.vote), if (it.guest) null else it.principalId) }
        val stats = ValueStats.of(deck, votes.map { it.value })
        return RoundResult(
            votes = votes,
            average = stats.average,
            median = stats.median,
            distribution = stats.distribution,
            suggestion = stats.suggestion,
        )
    }
}
