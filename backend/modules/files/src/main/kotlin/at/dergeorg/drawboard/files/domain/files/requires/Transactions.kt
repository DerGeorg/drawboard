package at.dergeorg.drawboard.files.domain.files.requires

/** Port: a short database transaction around [block] (metadata row and audit event together). */
internal interface Transactions {
    suspend fun <T> required(block: suspend () -> T): T
}
