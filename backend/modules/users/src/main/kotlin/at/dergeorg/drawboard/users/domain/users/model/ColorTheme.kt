package at.dergeorg.drawboard.users.domain.users.model

/**
 * Light or dark appearance a user chose for the app and the board canvas: [SYSTEM] follows the operating system,
 * [LIGHT] and [DARK] fix it. Only the view changes. New users start with [SYSTEM].
 */
enum class ColorTheme { SYSTEM, LIGHT, DARK }
