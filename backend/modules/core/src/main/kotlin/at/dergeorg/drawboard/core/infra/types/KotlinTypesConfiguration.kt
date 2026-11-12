package at.dergeorg.drawboard.core.infra.types

import at.dergeorg.drawboard.shared.types.KotlinTypesJacksonModule
import at.dergeorg.drawboard.shared.types.StringToInstantConverter
import at.dergeorg.drawboard.shared.types.StringToUuidConverter
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.data.r2dbc.convert.R2dbcCustomConversions
import org.springframework.data.r2dbc.dialect.PostgresDialect

/**
 * Every boundary where kotlin.uuid.Uuid and kotlin.time.Instant meet a Java library, wired in one place:
 *  - JSON (Jackson 3): [KotlinTypesJacksonModule] - Boot adds every JacksonModule bean to its JsonMapper
 *  - path and query parameters (WebFlux): the two Converter beans - Boot adds them to the web conversion service
 *  - database (R2DBC): one [R2dbcCustomConversions] with the converters of R2dbcKotlinTypeConverters.kt
 */
@Configuration(proxyBeanMethods = false)
internal class KotlinTypesConfiguration {

    @Bean
    fun kotlinTypesJacksonModule() = KotlinTypesJacksonModule()

    @Bean
    fun stringToUuidConverter() = StringToUuidConverter()

    @Bean
    fun stringToInstantConverter() = StringToInstantConverter()

    /** Replaces Boot's default (same dialect converters) - there must be exactly one R2dbcCustomConversions. */
    @Bean
    fun r2dbcCustomConversions(): R2dbcCustomConversions = R2dbcCustomConversions.of(
        PostgresDialect.INSTANCE,
        listOf(
            UuidToJavaUuidConverter,
            JavaUuidToUuidConverter,
            InstantToUtcDateTimeConverter,
            UtcDateTimeToInstantConverter,
        ),
    )
}
