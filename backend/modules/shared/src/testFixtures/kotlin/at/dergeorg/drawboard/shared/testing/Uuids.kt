package at.dergeorg.drawboard.shared.testing

import kotlin.uuid.Uuid

/** The RFC 9562 version of this id (7 for `Uuid.generateV7()`, 4 for `Uuid.random()`): the 13th hex digit. */
fun Uuid.version(): Int = toHexDashString()[VERSION_DIGIT].digitToInt(radix = 16)

private const val VERSION_DIGIT = 14
