package at.dergeorg.drawboard.files.domain.files.requires

import kotlinx.coroutines.flow.Flow

/** The conversion of an Office document failed; [reason] is a short code for the audit event - never a message of the converter. */
internal class ConversionFailedException(val reason: String, cause: Throwable? = null) : RuntimeException(reason, cause)

/**
 * Port: turns an Office document into a PDF. Drawboard never opens Office files itself (S4.11): the adapter hands the
 * bytes to a sidecar (Gotenberg, [at.dergeorg.drawboard.files.domain.files.requires.impl.GotenbergConverter]).
 */
internal interface Converter {

    /**
     * Converts [source]; [extension] (`docx`, `odt`, ...) tells the converter what it is. Returns the PDF as a flow of
     * bytes, which throws [ConversionFailedException] when the converter fails. The caller caps the size, sniffs the
     * result and bounds the time.
     */
    fun toPdf(extension: String, source: Flow<ByteArray>): Flow<ByteArray>
}
