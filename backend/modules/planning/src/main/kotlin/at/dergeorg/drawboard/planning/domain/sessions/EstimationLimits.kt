package at.dergeorg.drawboard.planning.domain.sessions

/**
 * The caps and rates of the estimation sessions. The defaults are the numbers of the Fable decisions E10, E16 and E17 (and of the
 * contract); they are settings only so that a test can reach a cap without hundreds of requests. Rates are per minute; a guest is
 * counted per session of the caller and, with the `share` rates, per share link as well.
 */
internal data class EstimationLimits(
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
    init {
        require(maxActiveSessions >= 1 && maxClosedSessions >= 0 && maxSeats >= 2 && maxGuests >= 0 && maxGuestsPerShare >= 0) {
            "the estimation caps must be positive"
        }
        require(maxMovesPerSession >= 1) { "the move backstop must be positive" }
        require(
            listOf(
                createsPerMinute, listsPerMinute, shareListsPerMinute, getsPerMinute, shareGetsPerMinute, seatChangesPerMinute,
                shareSeatChangesPerMinute, placementsPerMinute, sharePlacementsPerMinute, estimatesPerMinute, shareEstimatesPerMinute,
                moderatorOpsPerMinute,
            ).all { it >= 1 },
        ) { "the estimation rate limits must be positive" }
    }
}
