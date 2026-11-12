package at.dergeorg.drawboard.core.infra.security

import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.core.env.Environment
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.Base64

/**
 * One secret per purpose: the key that pseudonymises users for plugins (`DRAWBOARD_PLUGIN_PSEUDONYM_KEY`) must not be a key
 * that signs file URLs (`DRAWBOARD_FILE_URL_KEYS`). Both are HMAC-SHA256 keys over different strings, so equal keys would not
 * allow a forgery today - but they would the day one of the formats changes, and a leaked file key would then also reveal
 * the pseudonyms (M3 backend review, SHOULD 6). The two modules do not know each other, so core, which sees the whole
 * configuration, checks it - the application does not start otherwise.
 */
internal object KeySeparation {

    /** Throws [IllegalStateException] (no key text in the message) when [pseudonymKey] is one of [fileUrlKeys]. */
    fun check(fileUrlKeys: List<ByteArray>, pseudonymKey: ByteArray) {
        check(fileUrlKeys.none { MessageDigest.isEqual(it, pseudonymKey) }) {
            "DRAWBOARD_PLUGIN_PSEUDONYM_KEY must not be one of the keys in DRAWBOARD_FILE_URL_KEYS: " +
                "use a secret of its own for each purpose"
        }
    }

    /**
     * The keys of a list separated by commas or white space, base64 or base64url. What is not a key is left out: the
     * modules reject it themselves, with their own message.
     */
    fun keys(text: String): List<ByteArray> =
        text.split(',', '\n', '\r', ' ', '\t').map { it.trim() }.filter { it.isNotEmpty() }.mapNotNull {
            try {
                Base64.getDecoder().decode(it.replace('-', '+').replace('_', '/'))
            } catch (_: IllegalArgumentException) {
                null
            }
        }

    /** The value of a setting that may also come as a file (`Docker/Kubernetes secret`): the file wins. */
    fun valueOrFile(environment: Environment, value: String, file: String): String {
        val path = environment.getProperty(file)?.takeIf { it.isNotBlank() }
        return if (path != null) Files.readString(Path.of(path)) else environment.getProperty(value).orEmpty()
    }
}

@Configuration(proxyBeanMethods = false)
internal class KeySeparationConfiguration {

    /** Evaluated while the context starts; a violation stops the start. */
    @Bean
    fun keySeparationCheck(environment: Environment): KeySeparationCheck {
        val fileKeys = KeySeparation.keys(KeySeparation.valueOrFile(environment, "files.url-keys", "files.url-keys-file"))
        val pseudonym = KeySeparation.keys(KeySeparation.valueOrFile(environment, "plugins.pseudonym-key", "plugins.pseudonym-key-file"))
        pseudonym.forEach { KeySeparation.check(fileKeys, it) }
        return KeySeparationCheck
    }
}

/** Marker of the passed check. */
internal object KeySeparationCheck
