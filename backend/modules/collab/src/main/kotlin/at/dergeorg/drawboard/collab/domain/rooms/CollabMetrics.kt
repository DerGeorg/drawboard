package at.dergeorg.drawboard.collab.domain.rooms

/** Why a message was dropped without closing the session. */
internal enum class DropReason(val tag: String) {
    /** An `UPDATE` from a viewer or commenter (S2.4). */
    ROLE("role"),

    /** An awareness update with several entries, or with a client id the session does not own (S2.6). */
    AWARENESS("awareness"),
}

/** What became of a compaction request. */
internal enum class CompactionResult(val tag: String) {
    REQUESTED("requested"),
    STORED("stored"),

    /** An upload nobody asked for, for another seq, or too late (409). */
    REJECTED("rejected"),

    /** The request ran out without an answer. */
    EXPIRED("expired"),
}

/**
 * What the rooms report for the dashboards (`drawboard_collab_*`). A port so the domain stays free of Micrometer;
 * implemented in infra. No implementation may put a user, board or ticket into a label (S7.10): the tags are the
 * reason, the close code and the result - nothing else.
 */
internal interface CollabMetrics {
    fun updateAccepted(bytes: Int)

    fun dropped(reason: DropReason)

    /** [code] is the WebSocket close code the server ordered, or `client` if the client left first. */
    fun closed(code: String)

    fun compaction(result: CompactionResult)

    /** Bytes held in the database, by kind: `snapshot` or `log`. */
    fun storageBytes(kind: String, bytes: Long)
}
