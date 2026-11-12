package at.dergeorg.drawboard.api.infra.web

import at.dergeorg.drawboard.api.infra.web.error.ProblemFactory
import at.dergeorg.drawboard.shared.observability.WithSpanAspect
import at.dergeorg.drawboard.shared.testing.FIXED_NOW
import at.dergeorg.drawboard.shared.testing.FixedClock
import at.dergeorg.drawboard.shared.testing.RecordingAppLogger
import at.dergeorg.drawboard.shared.types.KotlinTypesJacksonModule
import at.dergeorg.drawboard.shared.types.StringToUuidConverter
import io.micrometer.observation.ObservationRegistry
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.EnableAspectJAutoProxy
import org.springframework.context.annotation.Import
import org.springframework.security.config.annotation.web.reactive.EnableWebFluxSecurity
import org.springframework.security.config.web.server.ServerHttpSecurity
import org.springframework.security.config.web.server.invoke
import org.springframework.security.web.server.SecurityWebFilterChain
import kotlin.time.Clock

/**
 * What a controller slice test needs besides the controller: the error rendering, a clock, a logger and the @WithSpan
 * aspect - the same proxies around the controller as in the application.
 *
 * Permissions are not part of a slice: they live only in the route table (core's SecurityConfig), and
 * RouteTableIntegrationTest checks every operation end to end. Here every exchange passes the filter chain.
 *
 * Class-based (CGLIB) proxies as in the application (Boot's AOP auto-configuration is not part of a slice): a JDK
 * proxy of a controller that implements the generated interface loses the `ResponseEntity` return type of its
 * suspend functions, and the whole ResponseEntity would be rendered as JSON body with status 200.
 */
@TestConfiguration(proxyBeanMethods = false)
@EnableWebFluxSecurity
@EnableAspectJAutoProxy(proxyTargetClass = true)
@Import(ProblemFactory::class)
class WebSliceTestConfiguration {

    @Bean
    fun clock(): Clock = FixedClock(FIXED_NOW)

    /** The Kotlin types in JSON and in path parameters, as core registers them in the application. */
    @Bean
    fun kotlinTypesJacksonModule() = KotlinTypesJacksonModule()

    @Bean
    fun stringToUuidConverter() = StringToUuidConverter()

    /** A prototype bean in the application (one logger per class); one recording logger is enough for a slice. */
    @Bean
    fun appLogger() = RecordingAppLogger()

    @Bean
    fun withSpanAspect() = WithSpanAspect(ObservationRegistry.create())

    @Bean
    fun sliceSecurityWebFilterChain(http: ServerHttpSecurity): SecurityWebFilterChain = http {
        authorizeExchange { authorize(anyExchange, permitAll) }
        csrf { disable() }
    }
}
