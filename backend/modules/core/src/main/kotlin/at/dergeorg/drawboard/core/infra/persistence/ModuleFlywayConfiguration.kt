package at.dergeorg.drawboard.core.infra.persistence

import at.dergeorg.drawboard.shared.logging.AppLogger
import at.dergeorg.drawboard.shared.persistence.FlywayModule
import org.flywaydb.core.Flyway
import org.springframework.beans.factory.ObjectProvider
import org.springframework.boot.flyway.autoconfigure.FlywayMigrationStrategy
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

/**
 * One PostgreSQL database, one schema per module, one Flyway history per schema.
 *
 * Boot still builds a single Flyway from `spring.flyway.*` (URL, user, validation flags) and runs it before the web
 * server starts. This strategy replaces "migrate that Flyway" with "migrate a copy of it per [FlywayModule]", each
 * with its own schema, script location and history table (`<schema>.flyway_schema_history`). Therefore
 * `spring.flyway.schemas/default-schema/locations` must not be set - they would be ignored.
 */
@Configuration(proxyBeanMethods = false)
internal class ModuleFlywayConfiguration {

    @Bean
    fun moduleFlywayMigrationStrategy(modules: ObjectProvider<FlywayModule>, log: AppLogger) = FlywayMigrationStrategy { base ->
        val ordered = modules.orderedStream().toList().sortedWith(compareBy({ it.order }, { it.schema }))
        check(ordered.distinctBy { it.schema }.size == ordered.size) { "Two modules claim the same schema: $ordered" }
        ordered.forEach { module ->
            val result = Flyway.configure()
                .configuration(base.configuration)
                .schemas(module.schema)
                .defaultSchema(module.schema)
                .locations(module.location)
                .failOnMissingLocations(true) // a typo in the location fails the start instead of "0 migrations"
                .load()
                .migrate()
            log.info(
                "schema migrated",
                "db.namespace" to module.schema,
                "flyway.migrations_executed" to result.migrationsExecuted,
                "flyway.target_version" to result.targetSchemaVersion,
            )
        }
    }
}
