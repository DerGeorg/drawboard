package at.dergeorg.drawboard.core.infra.web

import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

/**
 * @param trustedProxies `DRAWBOARD_TRUSTED_PROXIES`: IP addresses or CIDR blocks of the reverse proxies in front of the
 *   backend. Empty (default): no proxy is trusted, `X-Forwarded-For` is ignored. Set it to the network of the frontend
 *   container (compose: its Docker network, e.g. `172.18.0.0/16`) or of the ingress (Helm: the ingress controller's
 *   pod CIDR), otherwise every client looks like the proxy and rate limits count all users together.
 */
@ConfigurationProperties("app.web")
internal data class WebProperties(val trustedProxies: List<String> = emptyList())

@Configuration(proxyBeanMethods = false)
internal class WebConfiguration {

    @Bean
    fun trustedProxies(properties: WebProperties) = TrustedProxies(properties.trustedProxies)
}
