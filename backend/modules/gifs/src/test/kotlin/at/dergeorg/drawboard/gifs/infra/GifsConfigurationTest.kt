package at.dergeorg.drawboard.gifs.infra

import at.dergeorg.drawboard.gifs.domain.search.GifsSettings
import at.dergeorg.drawboard.gifs.domain.search.TEST_KEY
import at.dergeorg.drawboard.gifs.domain.search.model.ApiKey
import at.dergeorg.drawboard.gifs.domain.search.model.Rating
import at.dergeorg.drawboard.shared.logging.AppLogger
import at.dergeorg.drawboard.shared.testing.RecordingAppLogger
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.boot.test.context.assertj.AssertableApplicationContext
import org.springframework.boot.test.context.runner.ApplicationContextRunner
import org.springframework.context.annotation.Configuration
import java.nio.file.Path
import kotlin.io.path.writeText
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** G1 and G6: when the module is on, when it is off, and what stops the start - without a Spring Boot application around it. */
class GifsConfigurationTest {

    @Configuration(proxyBeanMethods = false)
    @EnableConfigurationProperties(GifsProperties::class)
    internal class PropertiesConfiguration

    private val logger = RecordingAppLogger()

    private val runner = ApplicationContextRunner()
        .withUserConfiguration(PropertiesConfiguration::class.java, GifsConfiguration::class.java)
        .withBean(AppLogger::class.java, { logger })

    private fun settingsOf(context: AssertableApplicationContext): GifsSettings {
        assertNull(context.startupFailure, "the context starts: ${context.startupFailure?.javaClass}")
        return context.getBean(GifsSettings::class.java)
    }

    private fun startupFailureOf(vararg properties: String): Throwable {
        var failure: Throwable? = null
        runner.withPropertyValues(*properties).run { failure = it.startupFailure }
        return assertNotNull(failure, "the start fails for ${properties.toList().map { it.substringBefore('=') }}")
    }

    private fun Throwable.everything(): String =
        generateSequence(this) { it.cause }.joinToString("\n") { "${it.javaClass.name}: ${it.message}" }

    @Nested
    inner class On {

        @Test
        fun `when the key is in the variable then GIF search is on with the rating g and a budget of 90`() {
            runner.withPropertyValues("gifs.api-key=$TEST_KEY").run { context ->
                val settings = settingsOf(context)

                assertEquals(Triple(true, Rating.G, 90), Triple(settings.enabled, settings.rating, settings.hourlyBudget),
                    "defaults (G6, G7)")
            }
        }

        @Test
        fun `when the key is in a file then it is read, surrounding white space ignored`(@TempDir dir: Path) {
            val file = dir.resolve("giphy_api_key").also { it.writeText("  $TEST_KEY\n") }

            runner.withPropertyValues("gifs.api-key-file=$file").run { context ->
                assertEquals(true, settingsOf(context).enabled, "a file with a key")
            }
        }

        @Test
        fun `when both are set then the file wins`(@TempDir dir: Path) {
            val file = dir.resolve("giphy_api_key").also { it.writeText("FromTheFile0123456789") }

            runner.withPropertyValues("gifs.api-key=$TEST_KEY", "gifs.api-key-file=$file").run { context ->
                assertEquals("FromTheFile0123456789", settingsOf(context).apiKey?.reveal(), "file wins (G1)")
            }
        }

        @Test
        fun `when the rating and the budget are set then they are used`() {
            runner.withPropertyValues("gifs.api-key=$TEST_KEY", "gifs.rating=PG-13", "gifs.hourly-budget=40").run { context ->
                val settings = settingsOf(context)

                assertEquals(Rating.PG_13 to 40, settings.rating to settings.hourlyBudget, "rating (any case) and budget")
            }
        }

        @Test
        fun `when it starts then it writes one line - on or off and the rating - and nothing of the key`() {
            runner.withPropertyValues("gifs.api-key=$TEST_KEY", "gifs.rating=pg").run { context ->
                settingsOf(context)

                val line = logger.entries.single { it.message == "GIF search" }
                assertEquals(mapOf("gifs.enabled" to true, "gifs.rating" to "pg"), line.fields, "fields of the start line")
                assertEquals(false, logger.entries.any { TEST_KEY in "${it.message} ${it.fields}" }, "no key in the log")
            }
        }
    }

    @Nested
    inner class Off {

        @Test
        fun `when there is no key at all then GIF search is off and the start says so`() {
            runner.run { context ->
                assertEquals(false, settingsOf(context).enabled, "no key = off (G1)")
                assertEquals(false, logger.entries.single { it.message == "GIF search" }.fields["gifs.enabled"], "start line")
            }
        }

        @Test
        fun `when the variable is empty or blank then off`() {
            listOf("", "   ").forEach { value ->
                runner.withPropertyValues("gifs.api-key=$value").run { context -> assertEquals(false, settingsOf(context).enabled,
                    "'$value'") }
            }
        }

        @Test
        fun `when the file is empty or blank then off - that is how a deployment says no key yet`(@TempDir dir: Path) {
            listOf("", "\n", "  \n\t ").forEach { content ->
                val file = dir.resolve("key-${content.length}").also { it.writeText(content) }

                runner.withPropertyValues("gifs.api-key-file=$file").run { context ->
                    assertEquals(false, settingsOf(context).enabled, "file of ${content.length} characters")
                }
            }
        }

        @Test
        fun `when the file is empty then it wins over a key in the variable - the operator said off`(@TempDir dir: Path) {
            val file = dir.resolve("giphy_api_key").also { it.writeText("") }

            runner.withPropertyValues("gifs.api-key=$TEST_KEY", "gifs.api-key-file=$file").run { context ->
                assertEquals(false, settingsOf(context).enabled, "the file wins, empty or not (G1)")
            }
        }

        @Test
        fun `when the file is not there then off`(@TempDir dir: Path) {
            runner.withPropertyValues("gifs.api-key-file=${dir.resolve("nothing")}").run { context ->
                assertEquals(false, settingsOf(context).enabled, "a missing file is a missing key")
            }
        }
    }

    @Nested
    inner class StartFails {

        @ParameterizedTest(name = "[{index}]")
        @ValueSource(
            strings = [
                "short", "has space in the key 123456", "contains-dash-0123456789", "ümlaut0123456789abc", "0123456789abcde",
                "x/0123456789abcdefg",
            ],
        )
        fun `when the key has not the shape of a GIPHY key then the start fails and the failure does not show the key`(key: String) {
            val failure = startupFailureOf("gifs.api-key=$key")

            assertTrue(key !in failure.everything(), "the value is not in the failure: ${failure.everything()}")
            assertTrue("GIPHY API key" in failure.everything(), "the failure says what is wrong: ${failure.everything()}")
        }

        @Test
        fun `when the key is 65 characters then the start fails, 64 starts`() {
            val failure = startupFailureOf("gifs.api-key=${"a".repeat(65)}")
            runner.withPropertyValues("gifs.api-key=${"a".repeat(64)}").run { context -> assertEquals(true, settingsOf(context).enabled,
                "64") }

            assertTrue("a".repeat(65) !in failure.everything(), "the value is not in the failure")
        }

        @Test
        fun `when the file holds a key of the wrong shape then the start fails without showing its content`(@TempDir dir: Path) {
            val file = dir.resolve("giphy_api_key").also { it.writeText("not a key at all\nsecond line") }

            val failure = startupFailureOf("gifs.api-key-file=$file")

            assertTrue("not a key" !in failure.everything() && "second line" !in failure.everything(),
                "no content: ${failure.everything()}")
        }

        @Test
        fun `when the file is a directory then the start fails`(@TempDir dir: Path) {
            val failure = startupFailureOf("gifs.api-key-file=$dir")

            assertTrue("cannot be read" in failure.everything(), "says what is wrong: ${failure.everything()}")
        }

        @ParameterizedTest(name = "[{index}]")
        @ValueSource(strings = ["r", "R", "nc-17", "pg13", "x", "g pg"])
        fun `when the rating is not g, pg or pg-13 then the start fails`(rating: String) {
            val failure = startupFailureOf("gifs.api-key=$TEST_KEY", "gifs.rating=$rating")

            assertTrue("DRAWBOARD_GIPHY_RATING" in failure.everything(), "says which setting: ${failure.everything()}")
        }

        @Test
        fun `when the rating is wrong then the start fails even without a key - a typo is not hidden by being off`() {
            startupFailureOf("gifs.rating=r")
        }

        @ParameterizedTest(name = "[{index}]")
        @ValueSource(strings = ["0", "-5"])
        fun `when the budget is below 1 then the start fails`(budget: String) {
            startupFailureOf("gifs.api-key=$TEST_KEY", "gifs.hourly-budget=$budget")
        }

        @Test
        fun `when the properties are printed then the key is not in them`() {
            val shown = GifsProperties(apiKey = TEST_KEY, apiKeyFile = "/run/secrets/x", rating = "g").toString()

            assertEquals(false, TEST_KEY in shown, "G2: Spring may print a bean's values in a failure report")
        }
    }

    @Nested
    inner class KeyAndRating {

        @Test
        fun `when a key is printed or shown then it says nothing`() {
            val key = assertNotNull(ApiKey.parse(TEST_KEY), "the key")

            assertEquals(listOf("ApiKey(redacted)", "GifsSettings(enabled=true, rating=g, hourlyBudget=90)"),
                listOf(key.toString(), GifsSettings(key).toString()), "printed forms")
            assertEquals(TEST_KEY, key.reveal(), "reveal is the one way to the text")
        }

        @Test
        fun `when parsing a missing key then null, a wrong one throws without the value`() {
            assertEquals(listOf(null, null, null), listOf(ApiKey.parse(null), ApiKey.parse(""), ApiKey.parse(" \n ")), "no key")
            val error = assertFailsWith<IllegalArgumentException>("shape") { ApiKey.parse("secret-with-dash-123") }
            assertTrue("secret" !in error.message.orEmpty(), "message: ${error.message}")
        }

        @Test
        fun `when parsing the rating then g is the default and r is not offered`() {
            assertEquals(listOf(Rating.G, Rating.G, Rating.PG, Rating.PG_13), listOf(null, " ", "PG", "pg-13").map { Rating.parse(it) },
                "ratings")
            assertFailsWith<IllegalArgumentException>("r") { Rating.parse("r") }
        }
    }
}
