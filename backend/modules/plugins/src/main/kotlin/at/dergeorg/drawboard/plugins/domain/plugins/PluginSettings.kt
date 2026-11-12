package at.dergeorg.drawboard.plugins.domain.plugins

/**
 * What the plugin use cases need to know about the deployment. [appOrigin] is the origin of the app (`scheme://host[:port]`,
 * the only origin allowed to embed a plugin frame); [pluginOrigin] the origin of the plugin assets if the deployment has
 * one of its own (S3.4), else null and the assets are served from the app origin. [pseudonymKey] is the dedicated secret of
 * the user pseudonyms (S3.8).
 */
internal class PluginSettings(
    val appOrigin: String,
    val pluginOrigin: String?,
    val pseudonymKey: ByteArray,
    val installsPerMinute: Int = 10,
    val storageWritesPerMinute: Int = 60,
) {
    /** The origin the assets are served from. */
    val assetOrigin: String get() = pluginOrigin ?: appOrigin

    /** What `assetBase` looks like to the browser: a URL on the plugin origin, else just the path. */
    fun assetBase(path: String): String = (pluginOrigin ?: "") + path
}
