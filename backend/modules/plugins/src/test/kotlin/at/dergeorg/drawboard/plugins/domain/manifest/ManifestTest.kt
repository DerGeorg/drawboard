package at.dergeorg.drawboard.plugins.domain.manifest

import at.dergeorg.drawboard.plugins.domain.Zips
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.CsvSource
import org.junit.jupiter.params.provider.ValueSource
import tools.jackson.databind.json.JsonMapper
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

class ManifestTest {

    private val json = JsonMapper()

    private fun validate(manifest: String) = ManifestValidator.validate(json.readTree(manifest))

    private fun violations(manifest: String): Map<String, String> {
        val result = assertIs<ManifestResult.Invalid>(validate(manifest), "must be refused")
        return result.violations.associate { it.field to it.constraint }
    }

    @Nested
    inner class Valid {

        @Test
        fun `when the manifest follows the schema then it is accepted with its block types and capabilities`() {
            val manifest = assertIs<ManifestResult.Valid>(validate(Zips.manifest()), "valid").manifest

            assertEquals("org.example.timer", manifest.id, "id")
            assertEquals(listOf("org.example.timer.countdown"), manifest.blockTypes.map { it.type }, "block types")
            assertEquals(
                listOf("block.props", "storage", "network:time.example.org"),
                manifest.capabilities.map { it.label },
                "capabilities",
            )
        }

        @Test
        fun `when optional fields are left out then they default to nothing`() {
            val minimal = """{"manifestVersion":1,"id":"org.example.a","name":"A","version":"0.1.0","entry":"a.mjs",""" +
                """"minHostVersion":"1.0.0"}"""

            val manifest = assertIs<ManifestResult.Valid>(validate(minimal), "valid").manifest

            assertEquals(
                emptyList(),
                manifest.blockTypes + manifest.capabilities.map { null }.filterNotNull(),
                "no block types, no capabilities",
            )
        }

        @Test
        fun `when a network capability lists hosts then they are normalised to lower case with single blanks`() {
            val raw = """[{"name":"network","value":"  API.Example.org   tiles.example.org:8443 "}]"""
            val manifest = assertIs<ManifestResult.Valid>(validate(Zips.manifest(capabilities = raw)), "valid").manifest

            assertEquals("api.example.org tiles.example.org:8443", manifest.capabilities.single().value, "normal form")
        }
    }

    @Nested
    inner class Invalid {

        @Test
        fun `when fields are missing then every one is reported by its JSON path`() {
            val result = violations("""{"manifestVersion":1}""")

            assertEquals(setOf("id", "name", "version", "entry", "minHostVersion"), result.keys, "all required fields at once")
        }

        @Test
        fun `when a block type is outside the namespace of the id then the violation names the field`() {
            val result = violations(
                Zips.manifest(blockTypes = """[{"type":"org.other.thing","label":"X","defaultWidth":100,"defaultHeight":100}]"""),
            )

            assertEquals(mapOf("blockTypes[0].type" to "Namespace"), result, "block types must be <id>.<name>")
        }

        @Test
        fun `when block types are duplicated, too small or unknown fields are present then each problem has a path`() {
            val result = violations(
                Zips.manifest(
                    blockTypes = """[{"type":"org.example.timer.a","label":"A","defaultWidth":10,"defaultHeight":100},
                        {"type":"org.example.timer.a","label":"A","defaultWidth":100,"defaultHeight":5000,"icon":"x"}]""",
                ),
            )

            assertEquals(
                setOf("blockTypes[0].defaultWidth", "blockTypes[1].type", "blockTypes[1].defaultHeight", "blockTypes[1].icon"),
                result.keys, "sizes 16-4096, unique types, no extra fields",
            )
        }

        @ParameterizedTest(name = "{0}")
        @ValueSource(strings = ["core.thing", "drawboard.thing", "single", "Org.Example", "org.example.", "org..example", "-org.example"])
        fun `when the id is reserved or malformed then it is refused`(id: String) {
            assertTrue("id" in violations(Zips.manifest(id = id, blockTypes = "[]")), "id $id")
        }

        @ParameterizedTest(name = "{0}")
        @ValueSource(strings = ["1", "1.0", "01.0.0", "1.0.0-", "v1.0.0", "1.0.0+", "1.0.0-01"])
        fun `when the version is not Semantic Versioning then it is refused`(version: String) {
            assertTrue("version" in violations(Zips.manifest(version = version)), "version $version")
        }

        @Test
        fun `when the plugin needs a newer plugin API than this instance implements then minHostVersion is refused`() {
            val result = violations(Zips.manifest().replace(""""minHostVersion":"1.0.0"""", """"minHostVersion":"1.1.0""""))

            assertEquals(mapOf("minHostVersion" to "Unsupported"), result, "the server refuses to install a plugin from the future")
        }

        @ParameterizedTest(name = "{0}")
        @ValueSource(strings = ["/abs.js", "../x.js", "a/../b.js", "index.html", "index.js.map", "dir/", "a b.js", ""])
        fun `when the entry is not a relative js module path then it is refused`(entry: String) {
            assertTrue("entry" in violations(Zips.manifest(entry = entry)), "entry '$entry'")
        }

        @Test
        fun `when an unknown field or capability is present then it is refused`() {
            assertTrue("surprise" in violations(Zips.manifest(extra = ""","surprise":1""")), "no additional properties")
            assertTrue("capabilities[0].name" in violations(Zips.manifest(capabilities = """[{"name":"camera"}]""")), "unknown capability")
        }

        @Test
        fun `when a capability has a value it must not have, lacks one it needs, or repeats then each is refused`() {
            val result = violations(
                Zips.manifest(
                    capabilities = """[{"name":"storage","value":"x"},{"name":"network"},{"name":"import.register"},
                        {"name":"ui.toast"},{"name":"ui.toast"}]""",
                ),
            )

            assertEquals(
                setOf("capabilities[0].value", "capabilities[1].value", "capabilities[2].value", "capabilities[4]"),
                result.keys,
                "paths",
            )
        }

        @Test
        fun `when import register has a value that is not one media type then it is refused`() {
            assertTrue(
                "capabilities[0].value" in violations(Zips.manifest(capabilities = """[{"name":"import.register","value":"text"}]""")),
                "no subtype",
            )
            assertTrue(
                validate(Zips.manifest(capabilities = """[{"name":"import.register","value":"text/csv"}]""")) is ManifestResult.Valid,
                "a media type",
            )
        }

        @Test
        fun `when the manifest is not an object then there is one violation on the root`() {
            assertEquals(mapOf("$" to "Type"), violations("[]"), "root")
        }
    }

    @Nested
    inner class Hosts {

        private fun parse(value: String) = NetworkHosts.parse(value)

        @ParameterizedTest(name = "{0}")
        @ValueSource(
            strings = [
                "localhost", "example.local", "printer.lan", "db.internal", "router.home", "1.168.192.in-addr.arpa", "10.0.0.1",
                "192.168.1.5:8080", "[::1]", "::1", "*.example.org", "https://example.org", "example.org/path", "user@example.org",
                "example.org:0", "example.org:99999",
                "example.org:abc", "single", "-bad.example.org", "bad-.example.org", "exa mple", "", "  "],
        )
        fun `when a host is private, an IP, a wildcard or malformed then the list is refused`(value: String) {
            assertIs<NetworkHosts.Result.Invalid>(parse(value), "value '$value'")
        }

        @Test
        fun `when the list has more than ten hosts then it is refused`() {
            val eleven = (1..11).joinToString(" ") { "h$it.example.org" }

            assertIs<NetworkHosts.Result.Invalid>(parse(eleven), "eleven")
            assertIs<NetworkHosts.Result.Valid>(parse((1..10).joinToString(" ") { "h$it.example.org" }), "ten")
        }

        @Test
        fun `when hosts are valid then they become https connect sources`() {
            val hosts = assertIs<NetworkHosts.Result.Valid>(parse("api.example.org tiles.example.org:8443"), "valid").hosts

            assertEquals(
                listOf("https://api.example.org", "https://tiles.example.org:8443"),
                NetworkHosts.connectSources(hosts),
                "https only",
            )
        }
    }

    @Nested
    inner class Versions {

        @ParameterizedTest(name = "{0} < {1}")
        @CsvSource(
            "1.0.0,1.0.1", "1.0.9,1.1.0", "1.9.9,2.0.0", "1.0.0-alpha,1.0.0", "1.0.0-alpha,1.0.0-alpha.1", "1.0.0-alpha.1,1.0.0-alpha.beta",
            "1.0.0-beta,1.0.0-beta.2", "1.0.0-beta.2,1.0.0-beta.11", "1.0.0-rc.1,1.0.0", "2.0.0,10.0.0",
        )
        fun `when comparing versions then the precedence of semver 2 applies`(lower: String, higher: String) {
            assertTrue(SemVer.parseOrNull(lower)!! < SemVer.parseOrNull(higher)!!, "$lower < $higher")
            assertTrue(SemVer.parseOrNull(higher)!! > SemVer.parseOrNull(lower)!!, "$higher > $lower")
        }

        @Test
        fun `when only the build metadata differs then the versions are equal`() {
            assertEquals(SemVer.parseOrNull("1.0.0+a"), SemVer.parseOrNull("1.0.0+b"), "build metadata is ignored")
        }
    }
}
