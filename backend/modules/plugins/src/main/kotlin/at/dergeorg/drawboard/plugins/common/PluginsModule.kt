package at.dergeorg.drawboard.plugins.common

/** Module-wide names. */
internal object PluginsModule {
    /** Module name in audit events (`plugins.plugin.installed`) and name of the database schema. */
    const val NAME = "plugins"

    /** The plugin API version this instance implements (docs/plugin-protocol.md of the API repository). */
    const val PLUGIN_API_VERSION = "1.0.0"
}
