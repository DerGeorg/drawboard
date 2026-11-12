package at.dergeorg.drawboard.plugins.infra

import at.dergeorg.drawboard.plugins.domain.plugins.UserPseudonyms
import org.springframework.boot.context.properties.ConfigurationProperties
import java.net.URI
import java.net.URISyntaxException
import java.nio.file.Files
import java.nio.file.Path

/**
 * Settings of the plugins, bound from `plugins.*` (environment variables in application.yaml).
 *
 * @param pseudonymKey `DRAWBOARD_PLUGIN_PSEUDONYM_KEY`, REQUIRED (the application does not start without it): the secret
 *   of the pseudonymous user ids plugins see (S3.8), base64 of at least 32 random bytes. A secret of its own - never the
 *   key of the file URLs. Rotating it gives every user a new id per plugin.
 * @param pseudonymKeyFile `DRAWBOARD_PLUGIN_PSEUDONYM_KEY_FILE`: the same in a file (Docker/Kubernetes secret); wins.
 * @param pluginOrigin `DRAWBOARD_PLUGIN_ORIGIN`, optional (S3.4): the origin plugin assets are served from, e.g.
 *   `https://plugins.example.org`; the reverse proxy routes `/plugin-assets/` there. Without it they are served from the
 *   app origin and S3.2 / S3.3 (sandbox, CSP) carry alone.
 * @param publicUrl `DRAWBOARD_PUBLIC_URL`: the app origin - the only `frame-ancestors` of a plugin frame.
 * @param installsPerMinute plugin uploads an admin may start per minute (S7.3).
 * @param storageWritesPerMinute plugin storage writes (1 MiB each) one user may make to one board per minute (M3 review, SHOULD 5).
 */
@ConfigurationProperties("plugins")
internal data class PluginsProperties(
    val publicUrl: String,
    val pseudonymKey: String? = null,
    val pseudonymKeyFile: String? = null,
    val pluginOrigin: String? = null,
    val installsPerMinute: Int = 10,
    val storageWritesPerMinute: Int = 60,
) {
    init {
        require(installsPerMinute >= 1 && storageWritesPerMinute >= 1) { "the plugin rate limits must be positive" }
    }

    fun key(): ByteArray {
        val file = pseudonymKeyFile?.takeIf { it.isNotBlank() }
        val text = if (file != null) Files.readString(Path.of(file)) else pseudonymKey.orEmpty()
        return UserPseudonyms.parseKey(text, "DRAWBOARD_PLUGIN_PSEUDONYM_KEY")
    }

    val appOrigin: String get() = origin(publicUrl, "DRAWBOARD_PUBLIC_URL")

    val pluginOriginOrNull: String? get() = pluginOrigin?.takeIf { it.isNotBlank() }?.let { origin(it, "DRAWBOARD_PLUGIN_ORIGIN") }

    private fun origin(value: String, name: String): String {
        val uri = try {
            URI(value.trim())
        } catch (_: URISyntaxException) {
            throw IllegalArgumentException("$name is not a valid URL; expected an origin like https://plugins.example.org")
        }
        val scheme = uri.scheme?.lowercase()
        require(scheme == "http" || scheme == "https") { "$name must start with http:// or https://" }
        require(!uri.host.isNullOrEmpty() && uri.rawUserInfo == null && (uri.rawPath.isNullOrEmpty() || uri.rawPath == "/") &&
            uri.rawQuery == null && uri.rawFragment == null) { "$name must be an origin: scheme, host and optionally a port" }
        val defaultPort = if (scheme == "https") HTTPS_PORT else HTTP_PORT
        val port = if (uri.port == -1 || uri.port == defaultPort) "" else ":${uri.port}"
        return "$scheme://${uri.host.lowercase()}$port"
    }

    private companion object {
        const val HTTP_PORT = 80
        const val HTTPS_PORT = 443
    }
}
