package at.dergeorg.drawboard.gifs.infra

import at.dergeorg.drawboard.gifs.domain.search.GifsSettings
import at.dergeorg.drawboard.gifs.domain.search.model.ApiKey
import at.dergeorg.drawboard.gifs.domain.search.model.Rating
import org.springframework.boot.context.properties.ConfigurationProperties
import java.io.IOException
import java.io.UncheckedIOException
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.nio.file.Path

/**
 * Settings of GIF search, bound from `gifs.*` (environment variables in application.yaml).
 *
 * @param apiKey `DRAWBOARD_GIPHY_API_KEY`: the GIPHY key of this installation (G1). Missing or blank: GIF search is off.
 * @param apiKeyFile `DRAWBOARD_GIPHY_API_KEY_FILE`: the same in a file (Docker/Kubernetes secret); wins over [apiKey]. A file that is
 *   empty, blank or not there means "off" too - an empty file is how a deployment says "no key yet".
 * @param rating `DRAWBOARD_GIPHY_RATING`: `g` (default), `pg` or `pg-13` (G6); anything else, `r` too, stops the start.
 * @param hourlyBudget `DRAWBOARD_GIPHY_HOURLY_BUDGET`: calls to GIPHY per hour for the whole instance (G7), default 90; a new
 *   GIPHY key is a beta key with 100 per hour.
 */
@ConfigurationProperties("gifs")
internal data class GifsProperties(
    val apiKey: String? = null,
    val apiKeyFile: String? = null,
    val rating: String? = null,
    val hourlyBudget: Int = GifsSettings.DEFAULT_HOURLY_BUDGET,
) {
    /** The settings; a key of the wrong shape, an unknown rating or a bad budget stops the start. No call to GIPHY (G1). */
    fun toSettings(): GifsSettings = GifsSettings(
        apiKey = ApiKey.parse(keyText()),
        rating = Rating.parse(rating),
        hourlyBudget = hourlyBudget,
    )

    private fun keyText(): String? {
        val file = apiKeyFile?.takeIf { it.isNotBlank() } ?: return apiKey
        return try {
            Files.readString(Path.of(file.trim()))
        } catch (_: NoSuchFileException) {
            null // configured but not there: no key
        } catch (e: IOException) {
            // present but unreadable is a broken deployment; an I/O error names the path (an operator's own setting), never the content
            throw UncheckedIOException("the file of DRAWBOARD_GIPHY_API_KEY_FILE cannot be read", e)
        }
    }

    /** Never prints the key: Spring may show a bean's values in a failure report. */
    override fun toString(): String = "GifsProperties(rating=$rating, hourlyBudget=$hourlyBudget)"
}
