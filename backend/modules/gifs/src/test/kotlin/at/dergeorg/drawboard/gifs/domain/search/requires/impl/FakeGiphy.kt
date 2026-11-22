// The fake GIPHY is a com.sun.net.httpserver (like the fake Gotenberg of the integration tests); it speaks java.net.
@file:Suppress("ForbiddenImport")

package at.dergeorg.drawboard.gifs.domain.search.requires.impl

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/** What reached the fake: the request line and the headers as the server read them. */
data class SeenRequest(val method: String, val path: String, val rawQuery: String?, val headers: Map<String, List<String>>) {
    val query: Map<String, String> by lazy {
        rawQuery.orEmpty().split('&').filter { it.isNotEmpty() }.associate {
            val (name, value) = it.split('=', limit = 2).let { parts -> parts[0] to parts.getOrElse(1) { "" } }
            java.net.URLDecoder.decode(name, Charsets.UTF_8) to java.net.URLDecoder.decode(value, Charsets.UTF_8)
        }
    }
}

/** A GIPHY that answers what the test says, on a port of its own. Close it after the test. */
class FakeGiphy : AutoCloseable {
    private val server = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)

    val requests = CopyOnWriteArrayList<SeenRequest>()

    /** Answers a request; the default is an empty page. */
    @Volatile
    var handler: (HttpExchange) -> Unit = { it.json(200, EMPTY) }

    val baseUrl: String get() = "http://127.0.0.1:${server.address.port}/v1/gifs/"

    init {
        server.executor = Executors.newCachedThreadPool()
        server.createContext("/") { exchange ->
            requests += SeenRequest(
                exchange.requestMethod, exchange.requestURI.rawPath, exchange.requestURI.rawQuery,
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

    override fun close() = server.stop(0)

    companion object {
        const val EMPTY = """{"data":[],"pagination":{"total_count":0,"count":0,"offset":0},"meta":{"status":200}}"""

        fun HttpExchange.json(status: Int, body: String, vararg headers: Pair<String, String>) {
            val bytes = body.toByteArray()
            responseHeaders.add("Content-Type", "application/json")
            headers.forEach { (name, value) -> responseHeaders.add(name, value) }
            sendResponseHeaders(status, if (bytes.isEmpty()) -1 else bytes.size.toLong())
            if (bytes.isNotEmpty()) responseBody.write(bytes)
        }
    }
}
