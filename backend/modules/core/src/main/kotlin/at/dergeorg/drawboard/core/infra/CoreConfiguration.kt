package at.dergeorg.drawboard.core.infra

import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.i18n.LocaleContextHolder
import java.util.Locale
import kotlin.time.Clock

@Configuration(proxyBeanMethods = false)
internal class CoreConfiguration {

    init {
        // Texts the API derives from Spring (bean-validation messages in `violations`) are English - never the
        // locale of the machine the service happens to run on (a German Mac said "muss größer-gleich 1 sein").
        // WebFlux binds no per-request locale, so this default is what LocaleContextHolder hands the validator.
        LocaleContextHolder.setDefaultLocale(Locale.ENGLISH)
    }

    /**
     * The one clock of the application: kotlin.time.Clock, ticking in microseconds ([MicrosecondClock]). Modules
     * inject it instead of calling Clock.System.now(), so tests control time.
     */
    @Bean
    fun clock(): Clock = MicrosecondClock
}
