package at.dergeorg.drawboard.api.infra.web.plugins

import at.dergeorg.drawboard.plugins.domain.plugins.provides.PluginsUseCase
import at.dergeorg.drawboard.plugins.domain.plugins.provides.ServedAsset
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.server.ServerWebExchange

/**
 * The static files of installed plugins (S3.5): `/plugin-assets/<id>/<version>/<sha256>/<path>` - outside `/api`, no
 * token, GET only (route table). Not an operation of the contract: a path of arbitrary depth can not be one OpenAPI path
 * (`Plugin.assetBase` describes it).
 *
 * * The path is looked up in the entry list stored at install - an EXACT match; nothing is joined onto a directory, so
 *   there is no `..` to follow, and an unknown path is a plain 404.
 * * Files are `immutable` for a year (the sha256 of the bundle is in the URL), `nosniff`, and the ONE place in the
 *   backend with `Access-Control-Allow-Origin: *` - without credentials: the sandboxed frame has an opaque origin and
 *   loads its module with CORS and an `integrity` hash. The wildcard is harmless because everything here is public: a
 *   bundle holds no secrets (S3.5).
 * * `__drawboard/frame.html` is NOT a file of the bundle: the server generates it with the CSP of S3.3. It depends on the
 *   grants, so it is never cached.
 */
@RestController
internal class PluginAssetsController(private val plugins: PluginsUseCase) {

    @WithSpan
    @GetMapping("/plugin-assets/{pluginId}/{version}/{sha256}/**")
    suspend fun asset(
        @PathVariable @SpanAttribute("plugin.id") pluginId: String,
        @PathVariable version: String,
        @PathVariable sha256: String,
        exchange: ServerWebExchange,
    ): ResponseEntity<ByteArray> {
        if (!PLUGIN_ID.matches(pluginId) || !VERSION.matches(version) || !SHA256.matches(sha256)) throw notFound()
        // the path is taken as it was sent (not decoded): the stored names have no character that needs encoding, so an
        // encoded one matches nothing - there is no way to say `..` that survives as a different string
        val raw = exchange.request.path.pathWithinApplication().value()
        val prefix = "/plugin-assets/$pluginId/$version/$sha256/"
        if (!raw.startsWith(prefix) || raw.length == prefix.length) throw notFound()
        val path = raw.substring(prefix.length)
        return when (val served = plugins.serve(pluginId, version, sha256, path)) {
            null -> throw notFound()
            is ServedAsset.File -> ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(served.asset.mediaType))
                .header("X-Content-Type-Options", "nosniff")
                .header(HttpHeaders.CACHE_CONTROL, "public, max-age=31536000, immutable")
                .header(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN, "*") // no credentials, no Allow-Credentials: ever
                .body(served.asset.data)
            is ServedAsset.Frame -> ResponseEntity.ok()
                .contentType(MediaType.parseMediaType("text/html; charset=utf-8"))
                .header("X-Content-Type-Options", "nosniff")
                .header("Content-Security-Policy", served.document.contentSecurityPolicy)
                .header("Referrer-Policy", "no-referrer")
                .header(HttpHeaders.CACHE_CONTROL, "no-cache") // the CSP carries the CURRENT grants
                .body(served.document.html.toByteArray(Charsets.UTF_8))
        }
    }

    private fun notFound() = DomainException(ErrorCode.NOT_FOUND)

    private companion object {
        val PLUGIN_ID = Regex("^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+$")
        val VERSION = Regex("^[0-9A-Za-z.+-]{1,64}$")
        val SHA256 = Regex("^[0-9a-f]{64}$")
    }
}
