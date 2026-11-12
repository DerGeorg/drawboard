package at.dergeorg.drawboard.core.infra.web

import org.springframework.core.Ordered
import org.springframework.core.annotation.Order
import org.springframework.stereotype.Component
import org.springframework.web.server.ServerWebExchange
import org.springframework.web.server.WebFilter
import org.springframework.web.server.WebFilterChain
import reactor.core.publisher.Mono

/**
 * `X-Frame-Options: DENY` on every response except the generated frame document of a plugin, which the app embeds on
 * purpose and which says by whom in its CSP (`frame-ancestors <app origin>`, S3.3). That is exactly
 * `/plugin-assets/<id>/<version>/<sha256>/__drawboard/frame.html`: the bundle's own files under `/plugin-assets/` (scripts,
 * styles, images) get DENY like everything else, as do the API and the files - none of them may be framed (M3 backend
 * review, SHOULD 8). (Spring Security would add DENY itself, but only for all paths or none.)
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
internal class FrameOptionsWebFilter : WebFilter {

    override fun filter(exchange: ServerWebExchange, chain: WebFilterChain): Mono<Void> {
        if (!isFrameDocument(exchange.request.path.pathWithinApplication().value())) {
            exchange.response.beforeCommit {
                exchange.response.headers.putIfAbsent(HEADER, listOf("DENY"))
                Mono.empty()
            }
        }
        return chain.filter(exchange)
    }

    internal companion object {
        const val HEADER = "X-Frame-Options"
        private val FRAME_DOCUMENT = Regex("^/plugin-assets/[^/]+/[^/]+/[^/]+/__drawboard/frame\\.html$")

        /** Whether [path] (as sent, not decoded) is the generated frame document of a plugin - the one response that may be framed. */
        fun isFrameDocument(path: String): Boolean = FRAME_DOCUMENT.matches(path)
    }
}
