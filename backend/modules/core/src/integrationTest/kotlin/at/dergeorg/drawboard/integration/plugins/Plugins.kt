package at.dergeorg.drawboard.integration.plugins

import at.dergeorg.drawboard.integration.multipartForm
import org.springframework.test.web.reactive.server.EntityExchangeResult
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import java.io.ByteArrayOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** Plugin packages for the integration tests. */
object Plugins {

    fun manifest(
        id: String = "org.example.timer",
        version: String = "1.0.0",
        capabilities: String = """[{"name":"storage"},{"name":"block.props"},{"name":"network","value":"time.example.org"}]""",
        blockTypes: String = """[{"type":"$id.countdown","label":"Countdown","defaultWidth":240,"defaultHeight":120}]""",
    ) = """{"manifestVersion":1,"id":"$id","name":"Timer","version":"$version","entry":"dist/index.js","minHostVersion":"1.0.0",""" +
        """"blockTypes":$blockTypes,"capabilities":$capabilities}"""

    fun zip(vararg entries: Pair<String, ByteArray>): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zip ->
            entries.forEach { (name, data) ->
                zip.putNextEntry(ZipEntry(name))
                zip.write(data)
                zip.closeEntry()
            }
        }
        return out.toByteArray()
    }

    /** A valid plugin; [code] is the content of its entry module. */
    fun plugin(
        manifest: String = manifest(),
        code: String = "export default { render() {} };",
        vararg more: Pair<String,
        ByteArray>,
    ): ByteArray =
        zip(
            "drawboard-plugin.json" to manifest.toByteArray(),
            "dist/index.js" to code.toByteArray(),
            "style.css" to "body{}".toByteArray(),
            *more,
        )
}

/** `POST /api/admin/plugins` with [zip] as the part `file`, as the user with [token]. */
fun WebTestClient.installAs(token: String?, zip: ByteArray): EntityExchangeResult<String> {
    val request = post().uri("/api/admin/plugins")
    if (token != null) request.header("Authorization", "Bearer $token")
    return request.multipartForm("file", zip, "plugin.zip").exchange().expectBody<String>().returnResult()
}
