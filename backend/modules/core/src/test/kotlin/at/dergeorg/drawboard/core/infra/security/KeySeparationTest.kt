package at.dergeorg.drawboard.core.infra.security

import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.runner.ApplicationContextRunner
import java.nio.file.Files
import java.util.Base64
import kotlin.io.path.writeText
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class KeySeparationTest {

    private fun key(seed: Int) = ByteArray(32) { (seed + it).toByte() }

    private fun base64(bytes: ByteArray) = Base64.getEncoder().encodeToString(bytes)

    @Nested
    inner class Check {

        @Test
        fun `when the pseudonym key differs from every file url key then it passes`() {
            KeySeparation.check(listOf(key(1), key(2)), key(3))
        }

        @Test
        fun `when the pseudonym key is one of the file url keys then it fails without naming the key`() {
            val error = assertFailsWith<IllegalStateException>("same secret twice") { KeySeparation.check(listOf(key(1), key(2)), key(2)) }

            assertTrue("DRAWBOARD_PLUGIN_PSEUDONYM_KEY" in checkNotNull(error.message), "names the setting")
            assertTrue(base64(key(2)) !in checkNotNull(error.message), "never the key")
        }

        @Test
        fun `when keys are written as base64url or separated by lines and commas then they are compared by their bytes`() {
            val urlSafe = base64(key(5)).replace('+', '-').replace('/', '_')

            val parsed = KeySeparation.keys("${base64(key(1))}, \n$urlSafe\n  !!not-base64!!  ")

            assertEquals(listOf(key(1).toList(), key(5).toList()), parsed.map { it.toList() }, "two keys, the invalid text is left out")
        }
    }

    @Nested
    inner class AtStartup {

        private val runner = ApplicationContextRunner().withUserConfiguration(KeySeparationConfiguration::class.java)

        @Test
        fun `when the pseudonym key equals a file url key then the context does not start`() {
            runner.withPropertyValues(
                "files.url-keys=${base64(key(1))},${base64(key(2))}",
                "plugins.pseudonym-key=${base64(key(2))}",
            ).run { context ->
                val failure = assertNotNull(context.startupFailure, "the application must not start")
                val causes = generateSequence<Throwable>(failure) { it.cause }
                val because = causes.any { it is IllegalStateException && "must not be one of" in it.message.orEmpty() }
                assertTrue(because, "because of the keys: $failure")
            }
        }

        @Test
        fun `when the keys differ then the context starts`() {
            runner.withPropertyValues("files.url-keys=${base64(key(1))}", "plugins.pseudonym-key=${base64(key(9))}").run { context ->
                assertNull(context.startupFailure, "different secrets")
            }
        }

        @Test
        fun `when the keys come from secret files then they are compared too, and the file wins over the variable`() {
            val dir = Files.createTempDirectory("keys")
            val fileKeys = dir.resolve("file_url_keys").also { it.writeText("${base64(key(1))}\n${base64(key(2))}\n") }
            val pseudonym = dir.resolve("plugin_pseudonym_key").also { it.writeText(base64(key(2))) }

            runner.withPropertyValues(
                "files.url-keys-file=$fileKeys",
                "plugins.pseudonym-key-file=$pseudonym",
                "plugins.pseudonym-key=${base64(key(8))}", // ignored: the file wins
            ).run { context ->
                assertNotNull(context.startupFailure, "the same key in both files")
            }
        }

        @Test
        fun `when no keys are configured here then the check has nothing to compare and leaves the complaint to the modules`() {
            runner.run { context -> assertNull(context.startupFailure, "the modules fail on missing keys themselves") }
        }
    }
}
