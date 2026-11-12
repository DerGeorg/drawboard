package at.dergeorg.drawboard.planning.domain.rounds

/**
 * The caps and rates of the planning module. The defaults are the numbers of the contract and the M4 review (200 participants of
 * which 50 guests and 20 per link, 10 OPEN rounds per board, 500 closed ones, S7.3 rates); they are settings only so that a test can
 * reach a cap without making hundreds of requests.
 */
internal data class PlanningSettings(
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
    init {
        require(maxParticipants >= 1 && maxGuests >= 0 && maxGuestsPerShare >= 0 && maxOpenRounds >= 1 && maxClosedRounds >= 0) {
            "the planning caps must be positive"
        }
        require(
            listOf(listsPerMinute, createsPerMinute, votesPerMinute, getsPerMinute, shareListsPerMinute, shareVotesPerMinute,
                shareGetsPerMinute)
                .all { it >= 1 },
        ) { "the planning rate limits must be positive" }
    }
}
