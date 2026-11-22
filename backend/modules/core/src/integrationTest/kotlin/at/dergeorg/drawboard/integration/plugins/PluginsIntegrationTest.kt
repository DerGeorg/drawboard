package at.dergeorg.drawboard.integration.plugins

import at.dergeorg.drawboard.contract.model.Board
import at.dergeorg.drawboard.contract.model.CreatedShareLink
import at.dergeorg.drawboard.contract.model.EnabledPluginList
import at.dergeorg.drawboard.contract.model.ErrorCode
import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.contract.model.GrantRole
import at.dergeorg.drawboard.contract.model.GuestSession
import at.dergeorg.drawboard.contract.model.NewShareLink
import at.dergeorg.drawboard.contract.model.Plugin
import at.dergeorg.drawboard.contract.model.PluginCapability
import at.dergeorg.drawboard.contract.model.PluginCapabilityName
import at.dergeorg.drawboard.contract.model.PluginList
import at.dergeorg.drawboard.contract.model.PluginStorage
import at.dergeorg.drawboard.contract.model.PluginStorageUpdate
import at.dergeorg.drawboard.contract.model.PluginUpdate
import at.dergeorg.drawboard.contract.model.ShareAccess
import at.dergeorg.drawboard.contract.model.ShareAudience
import at.dergeorg.drawboard.contract.model.ShareExchange
import at.dergeorg.drawboard.integration.collab.COLLAB_ISSUER
import at.dergeorg.drawboard.integration.collab.GuestIntegrationTest
import at.dergeorg.drawboard.integration.collab.PUBLIC_URL
import at.dergeorg.drawboard.integration.collab.SharingUser
import at.dergeorg.drawboard.integration.collab.SignedTokens
import at.dergeorg.drawboard.plugins.domain.plugins.model.PluginInstalled
import at.dergeorg.drawboard.plugins.domain.plugins.provides.PluginsUseCase
import at.dergeorg.drawboard.shared.auditing.AuditLog
import at.dergeorg.drawboard.shared.testing.PostgresTestcontainerInitializer
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.boot.micrometer.tracing.test.autoconfigure.AutoConfigureTracing
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.boot.webtestclient.autoconfigure.AutoConfigureWebTestClient
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.test.context.ContextConfiguration
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import tools.jackson.databind.json.JsonMapper
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.uuid.Uuid

/**
 * Plugins end to end (S3): install by upload, the rules of the archive and the manifest, grants and upgrades, the list a
 * board host loads (also for guests), the storage with its roles, the asset server and the generated frame document.
 * Real signed tokens: the admin is a member of the admin group of the test configuration.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "OIDC_ISSUER_URI=$COLLAB_ISSUER",
        "OIDC_AUDIENCE=drawboard-api",
        "DRAWBOARD_PUBLIC_URL=$PUBLIC_URL",
        "DRAWBOARD_ADMIN_GROUP=drawboard-admins",
        "DRAWBOARD_GUESTS_ENABLED=true",
        "DRAWBOARD_TRUSTED_PROXIES=127.0.0.0/8,::1",
        "DRAWBOARD_FILES_DIR=build/files-plugins-integration",
        "management.otlp.metrics.export.enabled=false",
    ],
)
// 2 min: the UNPACKED_TOO_LARGE case unpacks 51 MiB before it is refused, which took over 30 s
// on a busy runner (timeout on blocking read)
@AutoConfigureWebTestClient(timeout = "PT2M")
@AutoConfigureTracing
@ContextConfiguration(initializers = [PostgresTestcontainerInitializer::class])
class PluginsIntegrationTest(
    private val client: WebTestClient,
    @LocalServerPort private val port: Int,
    private val json: JsonMapper,
    private val auditLog: AuditLog,
    private val plugins: PluginsUseCase,
) {

    private fun admin() = SharingUser(client, port, "Ada", listOf("drawboard-admins"))

    private fun user(name: String = "Uma") = SharingUser(client, port, name)

    /** A plugin id of its own per test: all tests share one database. */
    private fun freshId(): String {
        val letters = Uuid.random().toString().filter { it != '-' }.take(ID_LETTERS).map { 'a' + Character.digit(it, HEX) }
        return "org.example.p${letters.joinToString("")}"
    }

    private fun install(
        admin: SharingUser,
        id: String = freshId(),
        version: String = "1.0.0",
        capabilities: String? = null,
        code: String = "export default { render() {} };",
    ): Plugin {
        val manifest = if (capabilities == null) Plugins.manifest(
            id = id,
            version = version,
        ) else Plugins.manifest(id = id, version = version, capabilities = capabilities)
        val result = client.installAs(admin.token, Plugins.plugin(manifest, code))
        assertEquals(HttpStatus.CREATED, result.status, "install: ${result.responseBody}")
        return json.readValue(checkNotNull(result.responseBody), Plugin::class.java)
    }

    private fun update(admin: SharingUser, plugin: Plugin, enabled: Boolean, vararg grants: PluginCapability): Plugin {
        val result = admin.http().put().uri("/api/admin/plugins/{id}", plugin.id)
            .bodyValue(PluginUpdate(enabled, grants.toList(), plugin.revision)).exchange().expectBody<Plugin>().returnResult()
        assertEquals(HttpStatus.OK, result.status, "update")
        return checkNotNull(result.responseBody)
    }

    private fun cap(name: PluginCapabilityName, value: String? = null) = PluginCapability(name, value)

    private fun error(result: org.springframework.test.web.reactive.server.EntityExchangeResult<String>): ErrorModel =
        json.readValue(checkNotNull(result.responseBody), ErrorModel::class.java)

    private fun guestOf(owner: SharingUser, board: Board, role: GrantRole = GrantRole.VIEWER): WebTestClient {
        val created = owner.http().post().uri("/api/boards/${board.id}/links")
            .bodyValue(NewShareLink(role, ShareAudience.GUESTS, null, null)).exchange().expectBody<CreatedShareLink>().returnResult()
        val access = client.post().uri("/api/shares/exchange").header("X-Forwarded-For", "10.9.8.7")
            .bodyValue(ShareExchange(checkNotNull(created.responseBody).url.substringAfter('#'), null, "Gus")).exchange()
            .expectBody<ShareAccess>().returnResult().responseBody
        val session: GuestSession = checkNotNull(checkNotNull(access).guestSession)
        return client.mutate().defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer ${session.accessToken}").build()
    }

    @Nested
    inner class Installing {

        @Test
        fun `when an admin uploads a plugin then 201, disabled, nothing granted, listed and audited with its hash`() = runBlocking {
            val admin = admin()
            val id = freshId()
            val zip = Plugins.plugin(Plugins.manifest(id = id))

            val result = client.installAs(admin.token, zip)

            assertEquals(HttpStatus.CREATED, result.status, "created: ${result.responseBody}")
            val plugin = json.readValue(checkNotNull(result.responseBody), Plugin::class.java)
            assertEquals("/api/admin/plugins/$id", result.responseHeaders.location?.path, "Location")
            assertEquals(false to emptyList(), plugin.enabled to plugin.grantedCapabilities, "disabled, no grants (S3.8)")
            assertEquals(admin.id, plugin.installedBy, "installer")
            assertEquals(96, plugin.bundleSha384.length, "sha-384 of the ZIP")
            assertEquals(
                "/plugin-assets/$id/1.0.0/",
                plugin.assetBase.substringBeforeLast('/').substringBeforeLast('/') + "/",
                "immutable asset base: ${plugin.assetBase}",
            )
            assertEquals(listOf("storage", "block.props", "network"), plugin.requestedCapabilities.map { it.name.value }, "requested")
            assertEquals("time.example.org", plugin.requestedCapabilities.last().value, "the host list is shown for granting")
            val listed = admin.http().get().uri("/api/admin/plugins").exchange().expectBody<PluginList>().returnResult().responseBody
            assertTrue(listed?.items?.any { it.id == id } == true, "listed")
            val event = auditLog.history("plugin", id).single()
            assertEquals("plugins.plugin.created", event.eventType, "audit")
            assertEquals(plugin.bundleSha384, event.detailsAs<PluginInstalled>()?.sha384, "the hash is in the event (S3.6, S7.1)")
            assertEquals(SignedTokensSubject.of(admin), event.actor.id, "the installer is the actor")
        }

        @Test
        fun `when the archive breaks a rule then 400 PLUGINS_ARCHIVE_INVALID with the reason and the path`() {
            val admin = admin()
            val manifest = Plugins.manifest(id = freshId()).toByteArray()
            val cases = mapOf(
                "UNSAFE_PATH" to Plugins.zip("drawboard-plugin.json" to manifest, "../evil.js" to byteArrayOf(1)),
                "FILE_TYPE_NOT_ALLOWED" to Plugins.zip(
                    "drawboard-plugin.json" to manifest,
                    "dist/index.js" to byteArrayOf(1),
                    "index.html" to byteArrayOf(1),
                ),
                "MANIFEST_MISSING" to Plugins.zip("dist/index.js" to byteArrayOf(1)),
                "ENTRY_MISSING" to Plugins.zip("drawboard-plugin.json" to manifest, "other.js" to byteArrayOf(1)),
                "NOT_A_ZIP" to "this is not a zip".toByteArray(),
                "TOO_MANY_ENTRIES" to Plugins.zip(*(1..201).map { "f$it.js" to byteArrayOf(1) }.toTypedArray()),
                "UNPACKED_TOO_LARGE" to Plugins.zip("drawboard-plugin.json" to manifest, "dist/index.js" to ByteArray(51 * 1024 * 1024)),
            )

            cases.forEach { (reason, zip) ->
                val result = client.installAs(admin.token, zip)
                val body = error(result)
                assertEquals(HttpStatus.BAD_REQUEST, result.status, "$reason: status")
                assertEquals(
                    ErrorCode.PLUGINS_ARCHIVE_INVALID to reason,
                    body.code to body.params?.get("reason"),
                    "$reason: code and reason",
                )
            }
        }

        @Test
        fun `when the manifest is invalid then 400 PLUGINS_MANIFEST_INVALID with a violation per problem`() {
            val admin = admin()
            val manifest = Plugins.manifest(
                id = freshId(),
                blockTypes = """[{"type":"org.other.x","label":"X","defaultWidth":10,"defaultHeight":100}]""",
            )

            val result = client.installAs(admin.token, Plugins.plugin(manifest))

            val body = error(result)
            assertEquals(HttpStatus.BAD_REQUEST to ErrorCode.PLUGINS_MANIFEST_INVALID, result.status to body.code, "manifest")
            assertEquals(
                setOf("blockTypes[0].type", "blockTypes[0].defaultWidth"),
                body.violations?.map { it.field }?.toSet(),
                "JSON paths",
            )
        }

        @Test
        fun `when an id is a dot-prefix of an installed one then 400 PLUGINS_MANIFEST_INVALID, an upgrade passes`() {
            val admin = admin()
            val parent = freshId()
            val child = "$parent.sub"
            install(admin, child, "1.0.0")

            val shorter = client.installAs(admin.token, Plugins.plugin(Plugins.manifest(id = parent)))
            val longer = client.installAs(admin.token, Plugins.plugin(Plugins.manifest(id = "$child.deeper")))
            val upgraded = install(admin, child, "1.1.0")

            assertEquals(HttpStatus.BAD_REQUEST to ErrorCode.PLUGINS_MANIFEST_INVALID, shorter.status to error(shorter).code, "prefix")
            assertEquals(listOf("id"), error(shorter).violations?.map { it.field }, "field of the prefix")
            assertEquals(HttpStatus.BAD_REQUEST to ErrorCode.PLUGINS_MANIFEST_INVALID, longer.status to error(longer).code, "extension")
            assertEquals("1.1.0", upgraded.version, "upgrade of the same id")
        }

        @Test
        fun `when the upload is larger than 20 MB then 413 PAYLOAD_TOO_LARGE with the limit`() {
            val admin = admin()

            val result = client.installAs(admin.token, ByteArray(21 * 1024 * 1024))

            val body = error(result)
            assertEquals(HttpStatus.CONTENT_TOO_LARGE to ErrorCode.PAYLOAD_TOO_LARGE, result.status to body.code, "cap")
            assertEquals("20971520", body.params?.get("limit"), "the 20 MB of S3.9")
        }

        @Test
        fun `when the same or a lower version is uploaded then 409 PLUGINS_VERSION_EXISTS, and a higher one upgrades`() {
            val admin = admin()
            val id = freshId()
            install(admin, id, "1.2.0")

            val same = client.installAs(admin.token, Plugins.plugin(Plugins.manifest(id = id, version = "1.2.0")))
            val lower = client.installAs(admin.token, Plugins.plugin(Plugins.manifest(id = id, version = "1.0.0")))
            val higher = install(admin, id, "1.3.0")

            assertEquals(HttpStatus.CONFLICT to ErrorCode.PLUGINS_VERSION_EXISTS, same.status to error(same).code, "same")
            assertEquals("1.2.0", error(lower).params?.get("installedVersion"), "lower")
            assertEquals("1.3.0", higher.version, "upgrade")
        }

        @Test
        fun `when a plugin is upgraded then it keeps enabled and the grants that still match, new requests wait`() {
            val admin = admin()
            val id = freshId()
            val first = install(admin, id, "1.0.0")
            val granted = update(
                admin,
                first,
                true,
                cap(PluginCapabilityName.STORAGE),
                cap(PluginCapabilityName.NETWORK, "time.example.org"),
            )

            val upgraded = install(
                admin,
                id,
                "2.0.0",
                capabilities = """[{"name":"storage"},{"name":"network","value":"other.example.org"},{"name":"ui.toast"}]""",
            )

            assertEquals(true, upgraded.enabled, "still enabled")
            assertEquals(
                listOf(PluginCapabilityName.STORAGE),
                upgraded.grantedCapabilities.map { it.name },
                "the changed host and the new toast are not granted",
            )
            assertTrue(upgraded.revision > granted.revision, "a stale admin screen gets a 409")
            assertTrue(upgraded.assetBase != granted.assetBase, "new asset base")
        }
    }

    @Nested
    inner class Access {

        private val adminOperations = listOf(
            "GET" to "/api/admin/plugins",
            "GET" to "/api/admin/plugins/org.example.x",
            "DELETE" to "/api/admin/plugins/org.example.x",
        )

        @Test
        fun `when a user who is no instance admin calls an admin route then 403 FORBIDDEN, also for install`() {
            val user = user()

            adminOperations.forEach { (method, uri) ->
                assertEquals(HttpStatus.FORBIDDEN, user.status(method, uri), "$method $uri")
            }
            val install = client.installAs(user.token, Plugins.plugin())
            assertEquals(HttpStatus.FORBIDDEN to ErrorCode.FORBIDDEN, install.status to error(install).code, "install")
            assertEquals(
                HttpStatus.FORBIDDEN,
                user.status("PUT", "/api/admin/plugins/org.example.x", PluginUpdate(true, emptyList(), 0)),
                "update",
            )
        }

        @Test
        fun `when nobody is signed in then admin routes are 401, and a guest gets 403`() {
            val owner = user("Olga")
            val board = owner.createBoard()
            val guest = guestOf(owner, board)

            assertEquals(
                HttpStatus.UNAUTHORIZED,
                client.get().uri("/api/admin/plugins").exchange().expectBody<String>().returnResult().status,
                "anonymous",
            )
            assertEquals(
                HttpStatus.FORBIDDEN,
                guest.get().uri("/api/admin/plugins").exchange().expectBody<String>().returnResult().status,
                "guest",
            )
            assertEquals(
                HttpStatus.FORBIDDEN,
                guest.delete().uri("/api/admin/plugins/org.example.x").exchange().expectBody<String>().returnResult().status,
                "guest delete",
            )
        }

        @Test
        fun `when granting a capability the plugin did not request then 400, and with a stale revision 409`() {
            val admin = admin()
            val plugin = install(admin)

            val notRequested = admin.http().put().uri("/api/admin/plugins/{id}", plugin.id)
                .bodyValue(
                    PluginUpdate(true, listOf(cap(PluginCapabilityName.BOARD_PERIOD_READ)), plugin.revision),
                ).exchange().expectBody<ErrorModel>().returnResult()
            val wrongHost = admin.http().put().uri("/api/admin/plugins/{id}", plugin.id)
                .bodyValue(
                    PluginUpdate(true, listOf(cap(PluginCapabilityName.NETWORK, "evil.example.org")), plugin.revision),
                ).exchange().expectBody<ErrorModel>().returnResult()
            update(admin, plugin, true)
            val stale = admin.http().put().uri("/api/admin/plugins/{id}", plugin.id)
                .bodyValue(PluginUpdate(false, emptyList(), plugin.revision)).exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(
                HttpStatus.BAD_REQUEST to ErrorCode.PLUGINS_CAPABILITY_NOT_REQUESTED,
                notRequested.status to notRequested.responseBody?.code,
                "not requested",
            )
            assertEquals(
                "network:evil.example.org",
                wrongHost.responseBody?.params?.get("capability"),
                "a grant equals a request in name and value",
            )
            assertEquals(HttpStatus.CONFLICT to ErrorCode.CONFLICT, stale.status to stale.responseBody?.code, "stale revision")
        }

        @Test
        fun `when enabling, granting, disabling and removing then each step is audited`() = runBlocking {
            val admin = admin()
            val plugin = install(admin)

            val enabled = update(admin, plugin, true, cap(PluginCapabilityName.STORAGE))
            val disabled = update(admin, enabled, false, cap(PluginCapabilityName.STORAGE))
            assertEquals(HttpStatus.NO_CONTENT, admin.status("DELETE", "/api/admin/plugins/${plugin.id}"), "removed")

            val types = auditLog.history("plugin", plugin.id).map { it.eventType }
            assertEquals(
                listOf(
                    "plugins.plugin.created",
                    "plugins.plugin.enabled",
                    "plugins.plugin.grants-changed",
                    "plugins.plugin.disabled",
                    "plugins.plugin.deleted",
                ),
                types, "installed, enabled, grants, disabled, removed (S7.1)",
            )
            assertEquals(false, disabled.enabled, "disabled")
            assertEquals(HttpStatus.NOT_FOUND, admin.status("GET", "/api/admin/plugins/${plugin.id}"), "gone")
        }
    }

    @Nested
    inner class Listing {

        @Test
        fun `when a user lists the enabled plugins then only enabled ones come, with a pseudonym instead of the user id`() {
            val admin = admin()
            val on = update(admin, install(admin), true, cap(PluginCapabilityName.STORAGE))
            val off = install(admin)
            val alice = user("Alice")
            val bob = user("Bob")

            val forAlice = alice.http().get().uri(
                "/api/plugins",
            ).exchange().expectBody<EnabledPluginList>().returnResult().responseBody!!.items
            val forBob = bob.http().get().uri("/api/plugins").exchange().expectBody<EnabledPluginList>().returnResult().responseBody!!.items

            assertTrue(forAlice.any { it.id == on.id } && forAlice.none { it.id == off.id }, "only enabled")
            val mine = forAlice.single { it.id == on.id }
            assertTrue(mine.integrity.startsWith("sha384-") && mine.entry == "dist/index.js", "what the host needs to load it")
            assertEquals(43, mine.userPseudonym.length, "pseudonym")
            assertTrue(alice.id.toString() !in mine.userPseudonym, "never the real id")
            assertTrue(mine.userPseudonym != forBob.single { it.id == on.id }.userPseudonym, "another user, another pseudonym")
            assertEquals(
                mine.userPseudonym,
                alice.http().get().uri(
                    "/api/plugins",
                ).exchange().expectBody<EnabledPluginList>().returnResult().responseBody!!.items.single { it.id == on.id }.userPseudonym,
                "stable",
            )
        }

        @Test
        fun `when a guest lists the enabled plugins then it works - the host of a guest needs them`() {
            val admin = admin()
            val on = update(admin, install(admin), true)
            val owner = user("Olga")
            val guest = guestOf(owner, owner.createBoard())

            val result = guest.get().uri("/api/plugins").exchange().expectBody<EnabledPluginList>().returnResult()

            assertEquals(HttpStatus.OK, result.status, "guests may list")
            assertTrue(result.responseBody!!.items.any { it.id == on.id }, "and see the enabled plugins")
        }
    }

    @Nested
    inner class Storage {

        private fun enabledWithStorage(): Plugin {
            val admin = admin()
            return update(admin, install(admin), true, cap(PluginCapabilityName.STORAGE))
        }

        @Test
        fun `when an editor writes and a viewer reads then the object is stored with a version`() {
            val plugin = enabledWithStorage()
            val owner = user("Olga")
            val viewer = user("Vera")
            val board = owner.createBoard()
            owner.grantUser("boards", board.id, viewer, GrantRole.VIEWER)

            val empty = viewer.http().get().uri(
                "/api/boards/{b}/plugin-storage/{p}",
                board.id,
                plugin.id,
            ).exchange().expectBody<PluginStorage>().returnResult().responseBody
            val first = owner.http().put().uri("/api/boards/{b}/plugin-storage/{p}", board.id, plugin.id)
                .bodyValue(
                    PluginStorageUpdate(mapOf("startedAt" to 1234, "nested" to mapOf("a" to listOf(1, 2))), 0),
                ).exchange().expectBody<PluginStorage>().returnResult()
            val read = viewer.http().get().uri(
                "/api/boards/{b}/plugin-storage/{p}",
                board.id,
                plugin.id,
            ).exchange().expectBody<PluginStorage>().returnResult().responseBody

            assertEquals(emptyMap(), empty?.data, "nothing stored yet")
            assertEquals(0L, empty?.version, "version 0")
            assertEquals(HttpStatus.OK to 1L, first.status to first.responseBody?.version, "first write")
            assertEquals(1234, read?.data?.get("startedAt"), "a viewer reads what the editor wrote")
            assertEquals(1L, read?.version, "version")
        }

        @Test
        fun `when a viewer or a guest writes then 403, and a guest may read`() {
            val plugin = enabledWithStorage()
            val owner = user("Olga")
            val viewer = user("Vera")
            val board = owner.createBoard()
            owner.grantUser("boards", board.id, viewer, GrantRole.VIEWER)
            val guest = guestOf(owner, board, GrantRole.EDITOR)
            val body = PluginStorageUpdate(mapOf("x" to 1), 0)

            val asViewer = viewer.http().put().uri(
                "/api/boards/{b}/plugin-storage/{p}",
                board.id,
                plugin.id,
            ).bodyValue(body).exchange().expectBody<ErrorModel>().returnResult()
            val asGuest = guest.put().uri(
                "/api/boards/{b}/plugin-storage/{p}",
                board.id,
                plugin.id,
            ).bodyValue(body).exchange().expectBody<ErrorModel>().returnResult()
            val guestRead = guest.get().uri(
                "/api/boards/{b}/plugin-storage/{p}",
                board.id,
                plugin.id,
            ).exchange().expectBody<PluginStorage>().returnResult()

            assertEquals(
                HttpStatus.FORBIDDEN to ErrorCode.LIBRARY_BOARD_ACCESS_DENIED,
                asViewer.status to asViewer.responseBody?.code,
                "viewer",
            )
            assertEquals(HttpStatus.FORBIDDEN, asGuest.status, "a guest never writes, even with an EDITOR link")
            assertEquals(HttpStatus.OK, guestRead.status, "a guest reads")
        }

        @Test
        fun `when the board is not visible then 404, when the version is stale then 409, when the object is above 1 MB then 413`() {
            val plugin = enabledWithStorage()
            val owner = user("Olga")
            val stranger = user("Sam")
            val board = owner.createBoard()
            owner.http().put().uri(
                "/api/boards/{b}/plugin-storage/{p}",
                board.id,
                plugin.id,
            ).bodyValue(PluginStorageUpdate(mapOf("n" to 1), 0)).exchange().expectBody<String>().returnResult()

            val hidden = stranger.http().get().uri(
                "/api/boards/{b}/plugin-storage/{p}",
                board.id,
                plugin.id,
            ).exchange().expectBody<ErrorModel>().returnResult()
            val stale = owner.http().put().uri(
                "/api/boards/{b}/plugin-storage/{p}",
                board.id,
                plugin.id,
            ).bodyValue(PluginStorageUpdate(mapOf("n" to 2), 0)).exchange().expectBody<ErrorModel>().returnResult()
            val big = owner.http().put().uri("/api/boards/{b}/plugin-storage/{p}", board.id, plugin.id)
                .bodyValue(PluginStorageUpdate(mapOf("x" to "a".repeat(1_100_000)), 1)).exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(ErrorCode.LIBRARY_BOARD_NOT_FOUND, hidden.responseBody?.code, "stranger")
            assertEquals(HttpStatus.CONFLICT to ErrorCode.CONFLICT, stale.status to stale.responseBody?.code, "stale version")
            assertEquals(HttpStatus.CONTENT_TOO_LARGE to ErrorCode.PAYLOAD_TOO_LARGE, big.status to big.responseBody?.code, "above 1 MB")
            assertEquals("1048576", big.responseBody?.params?.get("limit"), "limit")
        }

        @Test
        fun `when the plugin is disabled or has no storage grant then 404 and 403`() {
            val admin = admin()
            val plugin = install(admin)
            val owner = user("Olga")
            val board = owner.createBoard()
            val uri = "/api/boards/{b}/plugin-storage/{p}"

            val disabled = owner.http().get().uri(uri, board.id, plugin.id).exchange().expectBody<ErrorModel>().returnResult()
            update(admin, plugin, true, cap(PluginCapabilityName.BLOCK_PERIOD_PROPS))
            val ungranted = owner.http().get().uri(uri, board.id, plugin.id).exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(
                HttpStatus.NOT_FOUND to ErrorCode.PLUGINS_PLUGIN_NOT_FOUND,
                disabled.status to disabled.responseBody?.code,
                "disabled",
            )
            assertEquals(HttpStatus.FORBIDDEN, ungranted.status, "storage not granted")
        }

        @Test
        fun `when the plugin is removed or the board is purged then the storage is gone`() = runBlocking {
            val admin = admin()
            val plugin = update(admin, install(admin), true, cap(PluginCapabilityName.STORAGE))
            val owner = user("Olga")
            val board = owner.createBoard()
            owner.http().put().uri(
                "/api/boards/{b}/plugin-storage/{p}",
                board.id,
                plugin.id,
            ).bodyValue(PluginStorageUpdate(mapOf("n" to 1), 0)).exchange().expectBody<String>().returnResult()
            assertEquals(1L, plugins.readStorage(board.id, plugin.id).version, "stored")

            owner.status("DELETE", "/api/boards/${board.id}")
            assertEquals(1L, plugins.readStorage(board.id, plugin.id).version, "the trash keeps it (the board can come back)")
            owner.status("DELETE", "/api/trash/boards/${board.id}")

            assertEquals(0L, plugins.readStorage(board.id, plugin.id).version, "purged with the board (S7.7)")
            val other = owner.createBoard()
            owner.http().put().uri(
                "/api/boards/{b}/plugin-storage/{p}",
                other.id,
                plugin.id,
            ).bodyValue(PluginStorageUpdate(mapOf("n" to 1), 0)).exchange().expectBody<String>().returnResult()
            admin.status("DELETE", "/api/admin/plugins/${plugin.id}")
            val reinstalled = update(admin, install(admin, plugin.id), true, cap(PluginCapabilityName.STORAGE))
            assertEquals(0L, plugins.readStorage(other.id, reinstalled.id).version, "removing a plugin deletes its storage on every board")
        }
    }

    @Nested
    inner class Assets {

        private fun served(
            plugin: Plugin,
            path: String,
        ) = client.get().uri("${plugin.assetBase}$path").exchange().expectBody<ByteArray>().returnResult()

        @Test
        fun `when an enabled plugin's file is fetched without any token then 200 with immutable, nosniff, CORS-star and DENY`() {
            val admin = admin()
            val code = "export default { render(el) { el.textContent = 'hi'; } };"
            val plugin = update(admin, install(admin, code = code), true)

            val result = served(plugin, "dist/index.js")

            assertEquals(HttpStatus.OK, result.status, "served")
            assertContentEquals(code.toByteArray(), result.responseBody, "exactly the bytes of the ZIP")
            val headers = result.responseHeaders
            assertEquals("text/javascript;charset=utf-8", headers.contentType?.toString()?.replace(" ", ""), "media type of the extension")
            assertEquals("public, max-age=31536000, immutable", headers.getFirst(HttpHeaders.CACHE_CONTROL), "immutable (S3.5)")
            assertEquals("nosniff", headers.getFirst("X-Content-Type-Options"), "nosniff")
            assertEquals("*", headers.getFirst(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN), "CORS star on this path")
            assertNull(headers.getFirst(HttpHeaders.ACCESS_CONTROL_ALLOW_CREDENTIALS), "never with credentials")
            assertEquals("DENY", headers.getFirst("X-Frame-Options"), "a script of a bundle is never framed; only the frame is")
        }

        @Test
        fun `when the path is not in the entry list or tries to leave the bundle then 404`() {
            val admin = admin()
            val plugin = update(admin, install(admin), true)
            val base = plugin.assetBase

            listOf(
                "nope.js",
                "dist/",
                "dist",
                "../index.js",
                "dist/../drawboard-plugin.json",
                "%2e%2e/dist/index.js",
                "dist/%2e%2e/style.css",
                "dist%2Findex.js",
                "DIST/index.js",
                "__drawboard/other.html",
                "drawboard-plugin.json/",
            )
                .forEach {
                    val result = client.get().uri("$base$it").exchange().expectBody<String>().returnResult()
                    assertTrue(
                        result.status == HttpStatus.NOT_FOUND || result.status == HttpStatus.BAD_REQUEST,
                        "path '$it' answered ${result.status}",
                    )
                }
            assertEquals(
                HttpStatus.OK,
                served(plugin, "drawboard-plugin.json").status,
                "the manifest is a file of the bundle like any other (public: no secrets)",
            )
        }

        @Test
        fun `when the hash, the version or the plugin does not match, or the plugin is disabled, then 404`() {
            val admin = admin()
            val plugin = update(admin, install(admin), true)
            val wrongSha = plugin.assetBase.replace(Regex("[0-9a-f]{64}"), "0".repeat(64))
            val wrongVersion = plugin.assetBase.replace("/1.0.0/", "/9.9.9/")

            assertEquals(
                HttpStatus.NOT_FOUND,
                client.get().uri("${wrongSha}dist/index.js").exchange().expectBody<String>().returnResult().status,
                "sha",
            )
            assertEquals(
                HttpStatus.NOT_FOUND,
                client.get().uri("${wrongVersion}dist/index.js").exchange().expectBody<String>().returnResult().status,
                "version",
            )
            update(
                admin,
                plugin.copy(
                    revision = admin.http().get().uri(
                        "/api/admin/plugins/{id}",
                        plugin.id,
                    ).exchange().expectBody<Plugin>().returnResult().responseBody!!.revision,
                ),
                false,
            )
            assertEquals(HttpStatus.NOT_FOUND, served(plugin, "dist/index.js").status, "disabled: its files are not served any more")
        }

        @Test
        fun `when the frame document is fetched then it is generated with the CSP of S3_3 and the integrity hash, and may be framed`() {
            val admin = admin()
            val plugin = update(
                admin,
                install(admin),
                true,
                cap(PluginCapabilityName.NETWORK, "time.example.org"),
                cap(PluginCapabilityName.STORAGE),
            )

            val result = client.get().uri("${plugin.assetBase}__drawboard/frame.html").exchange().expectBody<String>().returnResult()

            assertEquals(HttpStatus.OK, result.status, "frame")
            val base = "http://localhost:4200${plugin.assetBase}"
            assertEquals(
                "sandbox allow-scripts; default-src 'none'; script-src $base; style-src $base 'unsafe-inline'; " +
                    "img-src $base data: blob:; font-src $base; connect-src https://time.example.org; base-uri 'none'; " +
                    "form-action 'none'; frame-ancestors http://localhost:4200",
                result.responseHeaders.getFirst("Content-Security-Policy"), "the CSP of the protocol document, path-scoped",
            )
            assertEquals("nosniff", result.responseHeaders.getFirst("X-Content-Type-Options"), "nosniff")
            assertEquals(
                "no-cache",
                result.responseHeaders.getFirst(HttpHeaders.CACHE_CONTROL),
                "it carries the current grants: never immutable",
            )
            assertNull(result.responseHeaders.getFirst("X-Frame-Options"), "the app embeds it; frame-ancestors says who")
            val html = checkNotNull(result.responseBody)
            val enabled = admin.http().get().uri("/api/plugins").exchange().expectBody<EnabledPluginList>().returnResult().responseBody
            val integrity = checkNotNull(enabled?.items?.single { it.id == plugin.id }).integrity
            assertTrue("integrity=\"$integrity\"" in html, "SRI hash: $html")
            assertTrue("src=\"${plugin.assetBase}dist/index.js\"" in html, "the entry module by its absolute path: $html")
        }

        @Test
        fun `when a changed grant is fetched again then the frame carries the new connect-src - it is never cached`() {
            val admin = admin()
            val plugin = update(admin, install(admin), true)
            val before = client.get().uri("${plugin.assetBase}__drawboard/frame.html").exchange().expectBody<String>().returnResult()
            val current = admin.http().get().uri(
                "/api/admin/plugins/{id}",
                plugin.id,
            ).exchange().expectBody<Plugin>().returnResult().responseBody!!
            update(admin, current, true, cap(PluginCapabilityName.NETWORK, "time.example.org"))

            val after = client.get().uri("${plugin.assetBase}__drawboard/frame.html").exchange().expectBody<String>().returnResult()

            assertTrue("connect-src 'none'" in checkNotNull(before.responseHeaders.getFirst("Content-Security-Policy")), "before")
            assertTrue(
                "connect-src https://time.example.org;" in checkNotNull(after.responseHeaders.getFirst("Content-Security-Policy")),
                "after",
            )
        }

        @Test
        fun `when something other than GET is sent to the asset path then it is not open`() {
            val admin = admin()
            val plugin = update(admin, install(admin), true)

            val post = client.post().uri("${plugin.assetBase}dist/index.js").exchange().expectBody<String>().returnResult()
            val put = client.put().uri("${plugin.assetBase}dist/index.js").exchange().expectBody<String>().returnResult()

            assertEquals(listOf(HttpStatus.UNAUTHORIZED, HttpStatus.UNAUTHORIZED), listOf(post.status, put.status), "denyAll")
        }

        @Test
        fun `when an ordinary API response is sent then X-Frame-Options DENY is still there`() {
            val result = user().http().get().uri("/api/users/me").exchange().expectBody<String>().returnResult()

            assertEquals("DENY", result.responseHeaders.getFirst("X-Frame-Options"), "only the plugin assets may be framed")
        }
    }

    companion object {
        private const val ID_LETTERS = 12
        private const val HEX = 16

        @JvmStatic
        @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) {
            registry.add("OIDC_JWK_SET_URI") { SignedTokens.jwkSetUri }
            registry.add("DRAWBOARD_GUEST_SIGNING_KEYS") { GuestIntegrationTest.generatedKey() }
        }
    }
}

/** The `sub` claim of the token of a [SharingUser] - the actor id the audit events carry. */
private object SignedTokensSubject {
    fun of(user: SharingUser): String? = com.nimbusds.jwt.SignedJWT.parse(user.token).jwtClaimsSet.subject
}
