// The fake GIPHY is a com.sun.net.httpserver (like the fake Gotenberg and the JWKS server); it speaks java.net.
@file:Suppress("ForbiddenImport")

package at.dergeorg.drawboard.integration.gifs

import at.dergeorg.drawboard.gifs.domain.search.requires.UpstreamEndpoint
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.context.ApplicationListener
import org.springframework.context.annotation.Bean
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.URLDecoder
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/** A key that exists only in these tests; the leak tests look for exactly this text. */
const val GIPHY_TEST_KEY = "IntegrationKey0123456789"

/** What reached the fake GIPHY. */
data class GiphyRequest(val path: String, val rawQuery: String?, val headers: Map<String, List<String>>) {
    val query: Map<String, String> = rawQuery.orEmpty().split('&').filter { it.isNotEmpty() }.associate {
        val parts = it.split('=', limit = 2)
        URLDecoder.decode(parts[0], Charsets.UTF_8) to URLDecoder.decode(parts.getOrElse(1) { "" }, Charsets.UTF_8)
    }
}

/** A GIPHY on a port of its own: what it answers is the test's business ([handler]), what it was asked is in [requests]. */
class FakeGiphyServer : AutoCloseable {
    private val server = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)

    val requests = CopyOnWriteArrayList<GiphyRequest>()

    /** How many calls had reached GIPHY when the application was ready: G1 says none. -1 until then. */
    @Volatile
    var requestsAtStart = -1

    @Volatile
    var handler: (HttpExchange) -> Unit = { respond(it, 200, page()) }

    val baseUrl: String get() = "http://127.0.0.1:${server.address.port}/v1/gifs/"

    init {
        server.executor = Executors.newCachedThreadPool()
        server.createContext("/") { exchange ->
            requests += GiphyRequest(
                exchange.requestURI.rawPath, exchange.requestURI.rawQuery,
                exchange.requestHeaders.entries.associate { it.key.lowercase() to it.value.toList() },
            )
            try {
                handler(exchange)
            } finally {
                exchange.close()
            }
        }
        server.start()
    }

    fun reset() {
        requests.clear()
        handler = { respond(it, 200, page()) }
    }

    override fun close() = server.stop(0)

    companion object {
        /** A page as GIPHY writes it: sizes are strings, there is much more than the module reads. */
        fun page(vararg entries: String, total: Int = entries.size) =
            """{"data":[${entries.joinToString(",")}],""" +
                """"pagination":{"total_count":$total,"count":${entries.size},"offset":0},"meta":{"status":200,"msg":"OK"}}"""

        fun gif(id: String, title: String = "Title of $id", width: String = "480", height: String = "270") =
            """{"type":"gif","id":"$id","url":"https://giphy.com/gifs/$id","title":${quote(title)},""" +
                """"images":{"original":{"width":"$width","height":"$height","url":"https://media.giphy.com/media/$id/giphy.gif"}},""" +
                """"user":{"username":"someone"}}"""

        private const val HEX = 16
        private const val HEX_DIGITS = 4

        /** A JSON string; control characters are written as escapes, as GIPHY does. */
        private fun quote(text: String) = buildString {
            append('"')
            text.forEach { c ->
                when {
                    c == '"' || c == '\\' -> append('\\').append(c)
                    c < ' ' -> append("\\u").append(c.code.toString(HEX).padStart(HEX_DIGITS, '0'))
                    else -> append(c)
                }
            }
            append('"')
        }

        fun respond(exchange: HttpExchange, status: Int, body: String, vararg headers: Pair<String, String>) {
            val bytes = body.toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json")
            headers.forEach { (name, value) -> exchange.responseHeaders.add(name, value) }
            exchange.sendResponseHeaders(status, if (bytes.isEmpty()) -1 else bytes.size.toLong())
            if (bytes.isNotEmpty()) exchange.responseBody.write(bytes)
        }
    }
}

/** The fake GIPHY and the one bean that points the adapter at it - the only way to change the address of GIPHY (G4). */
@TestConfiguration(proxyBeanMethods = false)
class FakeGiphyConfiguration {

    @Bean(destroyMethod = "close")
    fun fakeGiphyServer() = FakeGiphyServer()

    @Bean
    fun upstreamEndpoint(fake: FakeGiphyServer) = UpstreamEndpoint(fake.baseUrl)

    @Bean
    fun giphyStartSnapshot(fake: FakeGiphyServer): ApplicationListener<ApplicationReadyEvent> =
        ApplicationListener { fake.requestsAtStart = fake.requests.size }
}
