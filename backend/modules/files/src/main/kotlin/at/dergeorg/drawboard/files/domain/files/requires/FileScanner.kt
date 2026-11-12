package at.dergeorg.drawboard.files.domain.files.requires

import java.nio.channels.ReadableByteChannel

/** What a scanner found in a file. */
internal sealed interface ScanVerdict {

    /** Nothing found. */
    data object Clean : ScanVerdict

    /** A signature matched; [signature] is the name the scanner gave it (printable, cut), never part of the file. */
    data class Infected(val signature: String) : ScanVerdict

    /** The scanner could not decide: not reachable, too slow, an error, or the file could not be opened ([reason] is a short code). */
    data class Unavailable(val reason: String) : ScanVerdict

    /** The file is larger than the scanner takes ([limitBytes], `files.clamav-max-bytes`): the scanner is fine, the file is too big for it. */
    data class TooLarge(val limitBytes: Long) : ScanVerdict
}

/**
 * Port: a malware scan of an uploaded file, before the file becomes visible (S4.12). The default adapter does nothing
 * ([at.dergeorg.drawboard.files.domain.files.requires.impl.NoOpFileScanner]); ClamAV is optional
 * ([at.dergeorg.drawboard.files.domain.files.requires.impl.ClamavFileScanner]). The scanner never throws for a scan that
 * did not work - it answers [ScanVerdict.Unavailable] and the service applies the configured policy (fail open or closed).
 */
internal interface FileScanner {

    /** False for the adapter that scans nothing: the service then does not even open the file. */
    val enabled: Boolean get() = true

    /** Scans the [size] bytes [content] delivers. The caller opens and closes the channel; reading blocks. */
    suspend fun scan(content: ReadableByteChannel, size: Long): ScanVerdict
}
