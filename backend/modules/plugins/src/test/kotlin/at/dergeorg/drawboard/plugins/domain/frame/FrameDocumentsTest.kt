package at.dergeorg.drawboard.plugins.domain.frame

import at.dergeorg.drawboard.plugins.domain.plugins.model.BlockTypeDef
import at.dergeorg.drawboard.plugins.domain.plugins.model.Capability
import at.dergeorg.drawboard.plugins.domain.plugins.model.InstalledPlugin
import at.dergeorg.drawboard.shared.testing.FIXED_NOW
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.uuid.Uuid

class FrameDocumentsTest {

    private val sha = "a".repeat(64)

    private fun plugin(granted: List<Capability> = emptyList()) = InstalledPlugin(
        id = "org.example.timer", name = "Timer", version = "1.2.0", description = null, enabled = true, installedAt = FIXED_NOW,
        installedBy = Uuid.generateV7(), bundleSha256 = sha, bundleSha384 = "b".repeat(96), entry = "dist/index.js",
        integrity = "sha384-abc+/=", blockTypes = listOf(BlockTypeDef("org.example.timer.x", "X", 100, 100)),
        requestedCapabilities = granted, grantedCapabilities = granted, revision = 0,
    )

    private fun directives(csp: String) = csp.split("; ").associate { it.substringBefore(' ') to it.substringAfter(' ', "") }

    @Test
    fun `when the frame is made then the CSP names the plugin's own asset path and never self`() {
        val base = "/plugin-assets/org.example.timer/1.2.0/$sha/"

        val csp = FrameDocuments.create(plugin(), "https://draw.example.org", base, "https://draw.example.org").contentSecurityPolicy
        val d = directives(csp)

        assertEquals("allow-scripts", d["sandbox"], "sandbox allow-scripts, nothing else")
        assertEquals("'none'", d["default-src"], "default-src none")
        assertEquals("https://draw.example.org$base", d["script-src"], "script-src is path-scoped to this plugin")
        assertEquals("https://draw.example.org$base 'unsafe-inline'", d["style-src"], "style-src")
        assertEquals("https://draw.example.org$base data: blob:", d["img-src"], "img-src")
        assertEquals("https://draw.example.org$base", d["font-src"], "font-src")
        assertEquals("'none'", d["connect-src"], "no network granted")
        assertEquals("'none'", d["base-uri"], "base-uri")
        assertEquals("'none'", d["form-action"], "form-action")
        assertEquals("https://draw.example.org", d["frame-ancestors"], "only the app embeds it")
        assertFalse("'self'" in csp, "an opaque origin: 'self' would match nothing (M3 contract review)")
        assertFalse("wasm" in csp, "WebAssembly is not part of plugin API 1")
    }

    @Test
    fun `when hosts are granted then they become connect-src as https hosts, and only the granted ones`() {
        val granted = listOf(Capability("network", "api.example.org tiles.example.org:8443"), Capability("storage"))

        val csp = FrameDocuments.create(
            plugin(granted),
            "https://draw.example.org",
            "/x/",
            "https://draw.example.org",
        ).contentSecurityPolicy

        assertEquals("https://api.example.org https://tiles.example.org:8443", directives(csp)["connect-src"], "granted hosts")
    }

    @Test
    fun `when the plugin has an own origin then the sources and the module url are there, and frame-ancestors stays the app`() {
        val base = "https://plugins.example.org/plugin-assets/org.example.timer/1.2.0/$sha/"

        val frame = FrameDocuments.create(plugin(), "https://plugins.example.org", base, "https://draw.example.org")

        assertEquals(base, directives(frame.contentSecurityPolicy)["script-src"], "plugin origin")
        assertEquals("https://draw.example.org", directives(frame.contentSecurityPolicy)["frame-ancestors"], "app origin")
        assertTrue("src=\"${base}dist/index.js\"" in frame.html, "the module url is absolute")
    }

    @Test
    fun `when the frame is made then it holds nothing but the entry module with its integrity hash`() {
        val frame = FrameDocuments.create(plugin(), "https://draw.example.org", "/b/", "https://draw.example.org")

        assertEquals(
            "<!doctype html><meta charset=\"utf-8\"><script type=\"module\" src=\"/b/dist/index.js\" " +
                "integrity=\"sha384-abc+/=\" crossorigin=\"anonymous\"></script>",
            frame.html, "S3.6",
        )
    }
}
