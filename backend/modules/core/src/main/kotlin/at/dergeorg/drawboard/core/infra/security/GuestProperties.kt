package at.dergeorg.drawboard.core.infra.security

import org.springframework.boot.context.properties.ConfigurationProperties
import java.nio.file.Files
import java.nio.file.Path

/**
 * Guest access via share links (S1): the application signs its own tokens for visitors without an account.
 *
 * @param enabled `DRAWBOARD_GUESTS_ENABLED`, default false: the instance switch (S1.14). Without it no guest token is
 *   ever issued or accepted. Enabling it without keys stops the start.
 * @param signingKeys `DRAWBOARD_GUEST_SIGNING_KEYS`: one or more EC P-256 private keys as PKCS#8 PEM (ES256), the first
 *   signs, all verify (S1.5). Newlines may be written as `\n`.
 * @param signingKeysFile `DRAWBOARD_GUEST_SIGNING_KEYS_FILE`: the same PEM list in a file (Docker/Kubernetes secret);
 *   wins over [signingKeys]. Rotation: put the new key first, remove the old one after 12 hours.
 * @param publicUrl `DRAWBOARD_PUBLIC_URL`: the issuer of guest tokens is `<publicUrl>/guest`. It must differ from the
 *   OIDC issuer, or a token of one issuer could be taken for the other (S1.3).
 */
@ConfigurationProperties("app.security.guest")
internal data class GuestProperties(
    val enabled: Boolean = false,
    val signingKeys: String? = null,
    val signingKeysFile: String? = null,
    val publicUrl: String? = null,
) {
    /** The issuer claim of guest tokens. */
    val issuer: String get() = publicUrl.orEmpty().trim().trimEnd('/') + "/guest"

    /** The PEM text of the configured keys: the file wins; empty if none is configured. */
    fun pem(): String {
        val file = signingKeysFile?.takeIf { it.isNotBlank() }
        val text = if (file != null) Files.readString(Path.of(file)) else signingKeys.orEmpty()
        return text.replace("\\n", "\n")
    }
}
