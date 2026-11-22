package at.dergeorg.drawboard.plugins.domain

import at.dergeorg.drawboard.plugins.domain.archive.ArchiveUnpacker
import at.dergeorg.drawboard.plugins.domain.archive.PluginArchive
import at.dergeorg.drawboard.plugins.domain.archive.UnpackedPlugin
import at.dergeorg.drawboard.plugins.domain.plugins.PluginSettings
import at.dergeorg.drawboard.plugins.domain.plugins.UserPseudonyms
import at.dergeorg.drawboard.plugins.domain.plugins.model.Capability
import at.dergeorg.drawboard.plugins.domain.plugins.model.PluginGrantsChanged
import at.dergeorg.drawboard.plugins.domain.plugins.model.PluginInstalled
import at.dergeorg.drawboard.plugins.domain.plugins.model.PluginRemoved
import at.dergeorg.drawboard.plugins.domain.plugins.model.PluginSwitched
import at.dergeorg.drawboard.plugins.domain.plugins.provides.InstallPluginCommand
import at.dergeorg.drawboard.plugins.domain.plugins.provides.ServedAsset
import at.dergeorg.drawboard.plugins.domain.plugins.provides.UpdatePluginCommand
import at.dergeorg.drawboard.plugins.domain.plugins.provides.WriteStorageCommand
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.FieldViolationsException
import at.dergeorg.drawboard.shared.error.PayloadTooLargeException
import at.dergeorg.drawboard.shared.error.RateLimitedException
import at.dergeorg.drawboard.shared.testing.MutableClock
import at.dergeorg.drawboard.shared.testing.RecordingAuditTrail
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import tools.jackson.databind.json.JsonMapper
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlin.uuid.Uuid

class PluginsServiceTest {

    private val clock = MutableClock()
    private val repository = InMemoryPluginRepository()
    private val files = InMemoryPluginFiles()
    private val storage = InMemoryPluginStorage()
    private val audit = RecordingAuditTrail()
    private val admin = Uuid.generateV7()
    private val writer = Uuid.generateV7()
    private val key = ByteArray(32) { 9 }

    private fun service(
        pluginOrigin: String? = null,
        installsPerMinute: Int = 100,
        storageWritesPerMinute: Int = 1000,
        archive: ArchiveUnpacker = PluginArchive(),
    ) = PluginsService(
        repository, files, storage, DirectTransactions,
        PluginSettings("https://draw.example.org", pluginOrigin, key, installsPerMinute, storageWritesPerMinute),
        JsonMapper(), audit, clock, archive,
    )

    private suspend fun PluginsService.installed(zip: ByteArray = Zips.plugin()) = install(InstallPluginCommand(admin, zip))

    private inline fun failure(block: () -> Unit): DomainException = assertFailsWith<DomainException>("must be rejected") { block() }

    private fun grant(vararg names: String) = names.map { Capability(it) }

    @Nested
    inner class Installing {

        @Test
        fun `when a new plugin is uploaded then it is installed disabled, nothing granted, and audited with the hash`() = runTest {
            val zip = Zips.plugin()

            val plugin = service().installed(zip)

            assertEquals(false to emptyList(), plugin.enabled to plugin.grantedCapabilities, "disabled, no grants (S3.8)")
            assertEquals(
                listOf("block.props", "storage", "network:time.example.org"),
                plugin.requestedCapabilities.map { it.label },
                "requested",
            )
            assertEquals(admin, plugin.installedBy, "installer")
            assertEquals(
                MessageDigest.getInstance("SHA-256").digest(zip).joinToString("") { "%02x".format(it) },
                plugin.bundleSha256,
                "sha-256 in the path",
            )
            assertEquals(
                MessageDigest.getInstance("SHA-384").digest(zip).joinToString("") { "%02x".format(it) },
                plugin.bundleSha384,
                "sha-384 of the ZIP",
            )
            val entry = MessageDigest.getInstance("SHA-384").digest("export default {};".toByteArray())
            assertEquals("sha384-" + Base64.getEncoder().encodeToString(entry), plugin.integrity, "SRI value of the ENTRY module (S3.6)")
            assertEquals("/plugin-assets/org.example.timer/1.0.0/${plugin.bundleSha256}/", plugin.assetPath, "immutable asset path")
            val details = assertIs<PluginInstalled>(audit.events.single().details, "audit details")
            assertEquals(plugin.bundleSha384 to null, details.sha384 to details.previousVersion, "hash and first install in the event")
        }

        @Test
        fun `when the manifest is invalid then PLUGINS_MANIFEST_INVALID lists the violations`() = runTest {
            val error = failure {
                service().installed(
                    Zips.plugin(
                        Zips.manifest(blockTypes = """[{"type":"org.evil.x","label":"X","defaultWidth":100,"defaultHeight":100}]"""),
                    ),
                )
            }

            assertEquals(ErrorCode.PLUGINS_MANIFEST_INVALID, error.errorCode, "code")
            assertTrue(repository.rows.isEmpty() && files.files.isEmpty(), "nothing is installed")
        }

        @Test
        fun `when the new id is a dot-prefix of an installed id then PLUGINS_MANIFEST_INVALID on id`() = runTest {
            val service = service()
            service.installed(Zips.plugin(Zips.manifest(id = "org.example.deep")))

            val error = failure { service.installed(Zips.plugin(Zips.manifest(id = "org.example"))) }

            assertEquals(ErrorCode.PLUGINS_MANIFEST_INVALID, error.errorCode, "code")
            assertEquals(listOf("id"), (error as FieldViolationsException).invalidFields.map { it.field }, "field")
            assertEquals(listOf("org.example.deep"), repository.rows.keys.toList(), "only the first plugin")
        }

        @Test
        fun `when an installed id is a dot-prefix of the new id then PLUGINS_MANIFEST_INVALID on id`() = runTest {
            val service = service()
            service.installed(Zips.plugin(Zips.manifest(id = "org.example")))

            val error = failure { service.installed(Zips.plugin(Zips.manifest(id = "org.example.deep"))) }

            assertEquals(ErrorCode.PLUGINS_MANIFEST_INVALID, error.errorCode, "code")
            assertEquals(listOf("id"), (error as FieldViolationsException).invalidFields.map { it.field }, "field")
            assertEquals(listOf("org.example"), repository.rows.keys.toList(), "only the first plugin")
        }

        @Test
        fun `when an id only shares letters with an installed id but not a dot-prefix then it is installed`() = runTest {
            val service = service()
            service.installed(Zips.plugin(Zips.manifest(id = "org.example.time")))

            service.installed(Zips.plugin(Zips.manifest(id = "org.example.timer")))

            assertEquals(2, repository.rows.size, "both installed")
        }

        @Test
        fun `when a block type is another installed plugin's then PLUGINS_MANIFEST_INVALID on it`() = runTest {
            val service = service()
            service.installed(Zips.plugin(Zips.manifest(id = "org.example.deep")))
            // the validator lets this pass (the type starts with the own id), the service sees it is the other plugin's type
            val foreign = Zips.manifest(
                id = "org.example.deep.x",
                blockTypes = """[{"type":"org.example.deep.x.a","label":"A","defaultWidth":10,"defaultHeight":10},""" +
                    """{"type":"org.example.deep.countdown","label":"C","defaultWidth":10,"defaultHeight":10}]""",
            )

            val error = failure { service.installed(Zips.plugin(foreign)) }

            assertEquals(ErrorCode.PLUGINS_MANIFEST_INVALID, error.errorCode, "code")
            val fields = (error as FieldViolationsException).invalidFields.map { it.field }
            assertTrue("blockTypes[1].type" in fields, "the foreign type is named")
            assertEquals(1, repository.rows.size, "nothing new")
        }

        @Test
        fun `when the manifest is not JSON then PLUGINS_MANIFEST_INVALID`() = runTest {
            val error = failure { service().installed(Zips.plugin(manifest = "{ nope")) }

            assertEquals(ErrorCode.PLUGINS_MANIFEST_INVALID, error.errorCode, "syntax")
        }

        @Test
        fun `when the manifest or the entry file is missing then PLUGINS_ARCHIVE_INVALID says which`() = runTest {
            val noManifest = failure { service().installed(Zips.zip("dist/index.js" to byteArrayOf(1))) }
            val noEntry = failure { service().installed(
                Zips.zip("drawboard-plugin.json" to Zips.manifest().toByteArray(), "other.js" to byteArrayOf(1)),
            ) }

            assertEquals(
                ErrorCode.PLUGINS_ARCHIVE_INVALID to "MANIFEST_MISSING",
                noManifest.errorCode to noManifest.params["reason"],
                "no manifest",
            )
            assertEquals("ENTRY_MISSING" to "dist/index.js", noEntry.params["reason"] to noEntry.params["path"], "no entry")
        }

        @Test
        fun `when a bundle holds an html file then it is refused before anything is stored`() = runTest {
            val error = failure { service().installed(Zips.plugin(more = arrayOf("index.html" to byteArrayOf(1)))) }

            assertEquals("FILE_TYPE_NOT_ALLOWED", error.params["reason"], "no html")
            assertTrue(repository.rows.isEmpty(), "nothing")
        }

        @Test
        fun `when an admin installs too often then 429`() = runTest {
            val service = service(installsPerMinute = 1)
            service.installed()

            assertFailsWith<RateLimitedException>("second upload within a minute") { service.installed() }
            clock.advanceBy(61.seconds)
            service.installed(Zips.plugin(Zips.manifest(version = "1.0.1")))
        }

        @Test
        fun `when two uploads arrive at once then their archives are unpacked one after the other`() = runTest {
            val archive = WatchedArchive(overlapWait = 500.milliseconds)
            val service = service(archive = archive)

            withContext(Dispatchers.Default) {
                listOf("org.example.one", "org.example.two")
                    .map { id -> async { service.installed(Zips.plugin(Zips.manifest(id = id))) } }
                    .awaitAll()
            }

            assertEquals(2, archive.calls.get(), "both archives unpacked")
            assertEquals(1, archive.mostAtOnce.get(), "never two unpacked archives in memory at once (S3)")
            assertEquals(setOf("org.example.one", "org.example.two"), repository.rows.keys, "both installed")
        }

        @Test
        fun `when an upload is installed then its archive is unpacked off the caller's thread`() = runTest {
            val archive = WatchedArchive(overlapWait = Duration.ZERO)

            service(archive = archive).installed()

            val thread = archive.threads.single()
            assertTrue(thread.startsWith("DefaultDispatcher-worker"), "unpacked on Dispatchers.Default, not the event loop: $thread")
        }

        @Test
        fun `when an archive is refused then the next upload still gets the install lock`() = runTest {
            val service = service()
            failure { service.installed(Zips.zip("drawboard-plugin.json" to Zips.manifest().toByteArray())) }

            service.installed()

            assertEquals(listOf("org.example.timer"), repository.rows.keys.toList(), "the second upload is installed")
        }
    }

    /**
     * The real archive, watched: how often and on which threads it unpacks, and how many unpacks ran at the same time. Each
     * call waits up to [overlapWait] for a second one to come in, so two that are not serialised always overlap.
     */
    private class WatchedArchive(private val overlapWait: Duration) : ArchiveUnpacker {
        private val real = PluginArchive()
        private val active = AtomicInteger()
        private val entered = CountDownLatch(2)
        val calls = AtomicInteger()
        val mostAtOnce = AtomicInteger()
        val threads: MutableSet<String> = ConcurrentHashMap.newKeySet()

        override fun unpack(zip: ByteArray): UnpackedPlugin {
            calls.incrementAndGet()
            threads += Thread.currentThread().name
            mostAtOnce.accumulateAndGet(active.incrementAndGet(), ::maxOf)
            try {
                entered.countDown()
                entered.await(overlapWait.inWholeMilliseconds, TimeUnit.MILLISECONDS)
                return real.unpack(zip)
            } finally {
                active.decrementAndGet()
            }
        }
    }

    @Nested
    inner class Upgrading {

        @Test
        fun `when the same or a lower version is uploaded then 409 PLUGINS_VERSION_EXISTS names the installed one`() = runTest {
            val service = service()
            service.installed(Zips.plugin(Zips.manifest(version = "1.2.0")))

            val same = failure { service.installed(Zips.plugin(Zips.manifest(version = "1.2.0"))) }
            val lower = failure { service.installed(Zips.plugin(Zips.manifest(version = "1.1.9"))) }
            val prerelease = failure { service.installed(Zips.plugin(Zips.manifest(version = "1.2.0-rc.1"))) }

            listOf(same, lower, prerelease).forEach {
                assertEquals(ErrorCode.PLUGINS_VERSION_EXISTS to "1.2.0", it.errorCode to it.params["installedVersion"], "version rule")
            }
        }

        @Test
        fun `when the same id is upgraded then its own namespace and block types are no conflict`() = runTest {
            val service = service()
            service.installed(Zips.plugin(Zips.manifest(version = "1.0.0")))

            val upgraded = service.installed(Zips.plugin(Zips.manifest(version = "1.1.0")))

            assertEquals("1.1.0", upgraded.version, "upgrade passes")
            assertEquals(1, repository.rows.size, "still one plugin")
        }

        @Test
        fun `when a higher version is uploaded then enabled and the grants equal in name and value are kept`() = runTest {
            val service = service()
            val first = service.installed(Zips.plugin(Zips.manifest(version = "1.0.0")))
            service.update(
                UpdatePluginCommand(
                    first.id, enabled = true, revision = first.revision!!,
                    grantedCapabilities = listOf(
                        Capability("block.props"),
                        Capability("storage"),
                        Capability("network", "time.example.org"),
                    ),
                ),
            )
            val current = service.get(first.id)
            val upgradeManifest = Zips.manifest(
                version = "2.0.0",
                capabilities = """[{"name":"block.props"},{"name":"network","value":"other.example.org"},{"name":"ui.toast"}]""",
            )

            val upgraded = service.install(InstallPluginCommand(admin, Zips.plugin(upgradeManifest)))

            assertEquals(true, upgraded.enabled, "keeps its enabled state")
            assertEquals(
                listOf("block.props"),
                upgraded.grantedCapabilities.map { it.label },
                "network changed its value, ui.toast is new, storage is gone",
            )
            assertTrue(
                upgraded.bundleSha256 != current.bundleSha256 && upgraded.assetPath != current.assetPath,
                "the files go to a new asset base",
            )
            assertEquals(
                current.revision!! + 1,
                upgraded.revision,
                "the revision is raised, so an admin working on the old state gets a 409",
            )
            val details = assertIs<PluginInstalled>(audit.events.last().details, "audit")
            assertEquals("1.0.0", details.previousVersion, "upgrade from")
        }

        @Test
        fun `when upgrading then the files of the old version are removed and the new ones are there`() = runTest {
            val service = service()
            val first = service.installed(Zips.plugin(Zips.manifest(version = "1.0.0")))

            val second = service.install(InstallPluginCommand(admin, Zips.plugin(Zips.manifest(version = "1.1.0"))))

            assertTrue(files.files.keys.none { it.second == first.bundleSha256 }, "old bundle gone")
            assertTrue(files.files.keys.any { it.second == second.bundleSha256 && it.third == "dist/index.js" }, "new bundle stored")
        }

        @Test
        fun `when an upgrade is installed then a disabled plugin stays disabled`() = runTest {
            val service = service()
            service.installed(Zips.plugin(Zips.manifest(version = "1.0.0")))

            val upgraded = service.install(InstallPluginCommand(admin, Zips.plugin(Zips.manifest(version = "1.0.1"))))

            assertEquals(false, upgraded.enabled, "no automatic enabling")
        }
    }

    @Nested
    inner class Managing {

        @Test
        fun `when granting a capability the plugin did not request then 400 PLUGINS_CAPABILITY_NOT_REQUESTED`() = runTest {
            val service = service()
            val plugin = service.installed()

            val unknown = failure { service.update(UpdatePluginCommand(plugin.id, true, grant("board.read"), plugin.revision!!)) }
            val otherValue = failure {
                service.update(UpdatePluginCommand(plugin.id, true, listOf(Capability("network", "evil.example.org")), plugin.revision!!))
            }

            assertEquals(
                ErrorCode.PLUGINS_CAPABILITY_NOT_REQUESTED to "board.read",
                unknown.errorCode to unknown.params["capability"],
                "not requested",
            )
            assertEquals("network:evil.example.org", otherValue.params["capability"], "a grant equals a request in name and value")
            assertEquals(false, repository.rows.getValue(plugin.id).enabled, "nothing changed")
        }

        @Test
        fun `when enabling and granting then the changes are audited as enabled and grants-changed`() = runTest {
            val service = service()
            val plugin = service.installed()

            val updated = service.update(UpdatePluginCommand(plugin.id, true, grant("storage", "block.props"), plugin.revision!!))

            assertEquals(
                true to listOf("block.props", "storage"),
                updated.enabled to updated.grantedCapabilities.map { it.name },
                "the order of the manifest",
            )
            val events = audit.events.drop(1)
            assertEquals(listOf("plugins.plugin.enabled", "plugins.plugin.grants-changed"), events.map { it.eventType }, "events")
            assertIs<PluginSwitched>(events[0].details, "switched")
            assertEquals(emptyList(), assertIs<PluginGrantsChanged>(events[1].details, "grants").before, "before")
        }

        @Test
        fun `when disabling then the plugin is audited as disabled and leaves the list of enabled plugins`() = runTest {
            val service = service()
            val plugin = service.installed()
            val enabled = service.update(UpdatePluginCommand(plugin.id, true, emptyList(), plugin.revision!!))
            assertEquals(1, service.listEnabled(Uuid.generateV7()).size, "enabled")

            service.update(UpdatePluginCommand(plugin.id, false, emptyList(), enabled.revision!!))

            assertEquals(emptyList(), service.listEnabled(Uuid.generateV7()), "disabled plugins are not loaded by boards")
            assertEquals("plugins.plugin.disabled", audit.events.last().eventType, "audit")
        }

        @Test
        fun `when the revision is stale then CONFLICT and nothing changes`() = runTest {
            val service = service()
            val plugin = service.installed()
            service.update(UpdatePluginCommand(plugin.id, true, emptyList(), plugin.revision!!))

            val error = failure { service.update(UpdatePluginCommand(plugin.id, false, emptyList(), plugin.revision!!)) }

            assertEquals(ErrorCode.CONFLICT, error.errorCode, "another admin was first")
            assertEquals(true, repository.rows.getValue(plugin.id).enabled, "unchanged")
        }

        @Test
        fun `when nothing changes then nothing is written or audited`() = runTest {
            val service = service()
            val plugin = service.installed()

            val same = service.update(UpdatePluginCommand(plugin.id, false, emptyList(), plugin.revision!!))

            assertEquals(plugin.revision, same.revision, "no new revision")
            assertEquals(1, audit.events.size, "only the install")
        }

        @Test
        fun `when an unknown plugin is addressed then PLUGINS_PLUGIN_NOT_FOUND`() = runTest {
            val service = service()

            assertEquals(ErrorCode.PLUGINS_PLUGIN_NOT_FOUND, failure { service.get("org.nope.x") }.errorCode, "get")
            assertEquals(ErrorCode.PLUGINS_PLUGIN_NOT_FOUND, failure { service.remove("org.nope.x") }.errorCode, "remove")
            assertEquals(
                ErrorCode.PLUGINS_PLUGIN_NOT_FOUND,
                failure { service.update(UpdatePluginCommand("org.nope.x", true, emptyList(), 0)) }.errorCode,
                "update",
            )
        }

        @Test
        fun `when a plugin is removed then its files and its storage on every board go, and it is audited with the hash`() = runTest {
            val service = service()
            val plugin = service.installed()
            service.update(UpdatePluginCommand(plugin.id, true, grant("storage"), plugin.revision!!))
            val boardA = Uuid.generateV7()
            val boardB = Uuid.generateV7()
            service.writeStorage(WriteStorageCommand(boardA, plugin.id, """{"a":1}""", 0, writer))
            service.writeStorage(WriteStorageCommand(boardB, plugin.id, """{"b":1}""", 0, writer))

            service.remove(plugin.id)

            assertTrue(repository.rows.isEmpty() && files.files.isEmpty() && storage.rows.isEmpty(), "everything of the plugin is gone")
            val details = assertIs<PluginRemoved>(audit.events.last().details, "removed")
            assertEquals(plugin.bundleSha384, details.sha384, "hash")
        }

        @Test
        fun `when a plugin is removed then the storage of other plugins stays`() = runTest {
            val service = service()
            val one = service.installed()
            val other = service.installed(Zips.plugin(Zips.manifest(id = "org.example.other", blockTypes = "[]")))
            service.update(UpdatePluginCommand(one.id, true, grant("storage"), one.revision!!))
            service.update(UpdatePluginCommand(other.id, true, grant("storage"), other.revision!!))
            val board = Uuid.generateV7()
            service.writeStorage(WriteStorageCommand(board, one.id, "{}", 0, writer))
            service.writeStorage(WriteStorageCommand(board, other.id, "{}", 0, writer))

            service.remove(one.id)

            assertEquals(setOf(board to other.id), storage.rows.keys, "only the removed plugin's storage")
        }
    }

    @Nested
    inner class Listing {

        @Test
        fun `when listing enabled plugins then each user gets a stable pseudonym, different per plugin and per user`() = runTest {
            val service = service()
            val timer = service.installed()
            val poll = service.installed(Zips.plugin(Zips.manifest(id = "org.example.poll", blockTypes = "[]")))
            listOf(timer, poll).forEach { service.update(UpdatePluginCommand(it.id, true, emptyList(), it.revision!!)) }
            val alice = Uuid.generateV7()
            val bob = Uuid.generateV7()

            val forAlice = service.listEnabled(alice).associate { it.id to it.userPseudonym }
            val again = service.listEnabled(alice).associate { it.id to it.userPseudonym }
            val forBob = service.listEnabled(bob).associate { it.id to it.userPseudonym }

            assertEquals(forAlice, again, "stable")
            assertEquals(4, (forAlice.values + forBob.values).toSet().size, "one value per user and plugin")
            assertTrue(forAlice.values.all { it.length == 43 && alice.toString() !in it }, "43 characters, not the user id")
            assertEquals(
                UserPseudonyms(key).of(alice, "org.example.timer"),
                forAlice["org.example.timer"],
                "base64url(HMAC-SHA256(key, userId|pluginId))",
            )
        }

        @Test
        fun `when another key is used then every pseudonym changes`() {
            val id = Uuid.generateV7()

            assertTrue(
                UserPseudonyms(key).of(id, "org.example.a") != UserPseudonyms(ByteArray(32) { 1 }).of(id, "org.example.a"),
                "rotation gives new ids",
            )
        }

        @Test
        fun `when the assets are served from a plugin origin then assetBase is a URL there, else a path`() = runTest {
            val plugin = service().installed()
            service().update(UpdatePluginCommand(plugin.id, true, emptyList(), plugin.revision!!))

            assertEquals(plugin.assetPath, service().listEnabled(Uuid.generateV7()).single().assetBase, "same origin: a path")
            assertEquals(
                "https://plugins.example.org${plugin.assetPath}",
                service("https://plugins.example.org").listEnabled(Uuid.generateV7()).single().assetBase,
                "own origin",
            )
        }

        @Test
        fun `when the pseudonym key is short or not base64 then the start fails without printing it`() {
            assertFailsWith<IllegalArgumentException>(
                "short",
            ) { UserPseudonyms.parseKey(Base64.getEncoder().encodeToString(ByteArray(8)), "K") }
            assertFailsWith<IllegalArgumentException>("not base64") { UserPseudonyms.parseKey("%%%", "K") }
            assertFailsWith<IllegalArgumentException>("empty") { UserPseudonyms.parseKey(" ", "K") }
        }
    }

    @Nested
    inner class Assets {

        private suspend fun enabled(service: PluginsService, capabilities: List<Capability> = emptyList()) = service.installed().let {
            service.update(UpdatePluginCommand(it.id, true, capabilities, it.revision!!))
        }

        @Test
        fun `when a path is in the entry list then it is served with the media type of its extension`() = runTest {
            val service = service()
            val plugin = enabled(service)

            val js = assertIs<ServedAsset.File>(service.serve(plugin.id, plugin.version, plugin.bundleSha256, "dist/index.js"), "js").asset
            val css = assertIs<ServedAsset.File>(service.serve(plugin.id, plugin.version, plugin.bundleSha256, "style.css"), "css").asset

            assertEquals("text/javascript; charset=utf-8", js.mediaType, "js")
            assertEquals("text/css; charset=utf-8", css.mediaType, "css")
            assertEquals("export default {};", String(js.data), "bytes")
        }

        @Test
        fun `when a path is not in the entry list then nothing is served - no directory is ever joined`() = runTest {
            val service = service()
            val plugin = enabled(service)

            listOf(
                "../drawboard-plugin.json/../x",
                "dist/",
                "dist",
                "nope.js",
                "DIST/INDEX.JS",
                "dist/index.js/",
                "/dist/index.js",
                "dist//index.js",
                "%2e%2e/x",
            ).forEach {
                assertNull(service.serve(plugin.id, plugin.version, plugin.bundleSha256, it), "path '$it'")
            }
        }

        @Test
        fun `when the version, the hash or the plugin is wrong, or the plugin is disabled, then nothing is served`() = runTest {
            val service = service()
            val plugin = enabled(service)

            assertNull(service.serve(plugin.id, "9.9.9", plugin.bundleSha256, "dist/index.js"), "another version")
            assertNull(service.serve(plugin.id, plugin.version, "0".repeat(64), "dist/index.js"), "another hash")
            assertNull(service.serve("org.other.x", plugin.version, plugin.bundleSha256, "dist/index.js"), "unknown plugin")
            val current = service.get(plugin.id)
            service.update(UpdatePluginCommand(plugin.id, false, emptyList(), current.revision!!))
            assertNull(
                service.serve(plugin.id, plugin.version, plugin.bundleSha256, "dist/index.js"),
                "a disabled plugin's assets are gone",
            )
        }

        @Test
        fun `when the frame document is asked for then the server generates it, nothing else below the prefix is a file`() = runTest {
            val service = service()
            val plugin = enabled(service)

            val served = service.serve(plugin.id, plugin.version, plugin.bundleSha256, "__drawboard/frame.html")
            val frame = assertIs<ServedAsset.Frame>(served, "the generated document")

            assertTrue("integrity=\"${plugin.integrity}\"" in frame.document.html, "SRI hash of the entry")
            assertNull(
                service.serve(plugin.id, plugin.version, plugin.bundleSha256, "__drawboard/other.html"),
                "nothing else under the prefix",
            )
            assertNotNull(frame.document.contentSecurityPolicy, "csp")
        }
    }

    @Nested
    inner class Storage {

        private suspend fun enabled(service: PluginsService, capabilities: List<Capability>) = service.installed().let {
            service.update(UpdatePluginCommand(it.id, true, capabilities, it.revision!!))
        }

        @Test
        fun `when nothing was stored then the object is empty with version 0, and a write raises the version`() = runTest {
            val service = service()
            val plugin = enabled(service, grant("storage"))
            val board = Uuid.generateV7()

            val empty = service.readStorage(board, plugin.id)
            val first = service.writeStorage(WriteStorageCommand(board, plugin.id, """{"n":1}""", 0, writer))
            val second = service.writeStorage(WriteStorageCommand(board, plugin.id, """{"n":2}""", first.version, writer))

            assertEquals("{}" to 0L, empty.json to empty.version, "empty")
            assertEquals(1L to 2L, first.version to second.version, "raised by every write")
            assertEquals("""{"n":2}""", service.readStorage(board, plugin.id).json, "stored")
        }

        @Test
        fun `when a write is based on an old version then CONFLICT with the current one`() = runTest {
            val service = service()
            val plugin = enabled(service, grant("storage"))
            val board = Uuid.generateV7()
            service.writeStorage(WriteStorageCommand(board, plugin.id, """{"n":1}""", 0, writer))

            val stale = failure { service.writeStorage(WriteStorageCommand(board, plugin.id, """{"n":9}""", 0, writer)) }
            val wrong = failure { service.writeStorage(WriteStorageCommand(board, plugin.id, """{"n":9}""", 7, writer)) }

            assertEquals(ErrorCode.CONFLICT to "1", stale.errorCode to stale.params["currentVersion"], "a second first write")
            assertEquals(ErrorCode.CONFLICT, wrong.errorCode, "wrong version")
            assertEquals("""{"n":1}""", service.readStorage(board, plugin.id).json, "unchanged")
        }

        @Test
        fun `when a user writes more than 60 times a minute to one board then 429 TOO_MANY_REQUESTS, per user and board`() = runTest {
            val service = service(storageWritesPerMinute = 60)
            val plugin = enabled(service, grant("storage"))
            val board = Uuid.generateV7()
            var version = 0L
            repeat(60) { version = service.writeStorage(WriteStorageCommand(board, plugin.id, """{"n":$it}""", version, writer)).version }

            val refused = assertFailsWith<RateLimitedException>("the 61st write") {
                service.writeStorage(WriteStorageCommand(board, plugin.id, """{"n":61}""", version, writer))
            }
            val otherBoard = service.writeStorage(WriteStorageCommand(Uuid.generateV7(), plugin.id, "{}", 0, writer))
            val otherUser = service.writeStorage(WriteStorageCommand(board, plugin.id, """{"n":62}""", version, Uuid.generateV7()))
            clock.advanceBy(61.seconds)
            val later = service.writeStorage(WriteStorageCommand(board, plugin.id, """{"n":63}""", otherUser.version, writer))

            assertEquals(ErrorCode.TOO_MANY_REQUESTS, refused.errorCode, "the existing rate-limit code")
            assertTrue(refused.retryAfterSeconds > 0, "Retry-After")
            assertEquals(1L, otherBoard.version, "another board of the same user is not limited")
            assertEquals(version + 1, otherUser.version, "another user of the same board is not limited")
            assertEquals(otherUser.version + 1, later.version, "the minute passed")
            assertEquals(otherUser.version + 1, service.readStorage(board, plugin.id).version, "the refused write stored nothing")
        }

        @Test
        fun `when the object is larger than 1 MB then 413 and nothing is stored`() = runTest {
            val service = service()
            val plugin = enabled(service, grant("storage"))
            val big = """{"x":"${"a".repeat(1_048_576)}"}"""

            val error = assertFailsWith<PayloadTooLargeException>(
                "above 1 MB",
            ) { service.writeStorage(WriteStorageCommand(Uuid.generateV7(), plugin.id, big, 0, writer)) }

            assertEquals("1048576", error.params["limit"], "limit")
            assertTrue(storage.rows.isEmpty(), "nothing")
            service.writeStorage(WriteStorageCommand(Uuid.generateV7(), plugin.id, """{"x":"${"a".repeat(1_048_000)}"}""", 0, writer))
        }

        @Test
        fun `when the plugin is not enabled then 404, and when storage is not granted then 403`() = runTest {
            val service = service()
            val plugin = service.installed()
            val board = Uuid.generateV7()
            assertEquals(ErrorCode.PLUGINS_PLUGIN_NOT_FOUND, failure { service.readStorage(board, plugin.id) }.errorCode, "disabled")
            assertEquals(ErrorCode.PLUGINS_PLUGIN_NOT_FOUND, failure { service.readStorage(board, "org.nope.x") }.errorCode, "unknown")

            val enabledWithoutStorage = service.update(UpdatePluginCommand(plugin.id, true, grant("block.props"), plugin.revision!!))

            assertEquals(
                ErrorCode.FORBIDDEN,
                failure { service.readStorage(board, enabledWithoutStorage.id) }.errorCode,
                "read without the capability",
            )
            assertEquals(
                ErrorCode.FORBIDDEN,
                failure { service.writeStorage(WriteStorageCommand(board, plugin.id, "{}", 0, writer)) }.errorCode,
                "write without it",
            )
        }

        @Test
        fun `when boards are purged then their plugin storage goes with them`() = runTest {
            val service = service()
            val plugin = enabled(service, grant("storage"))
            val gone = Uuid.generateV7()
            val stays = Uuid.generateV7()
            service.writeStorage(WriteStorageCommand(gone, plugin.id, "{}", 0, writer))
            service.writeStorage(WriteStorageCommand(stays, plugin.id, "{}", 0, writer))

            service.deleteBoardData(listOf(gone))

            assertEquals(setOf(stays to plugin.id), storage.rows.keys, "only the purged board's")
        }
    }
}
