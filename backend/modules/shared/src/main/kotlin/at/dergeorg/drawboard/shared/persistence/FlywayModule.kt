package at.dergeorg.drawboard.shared.persistence

/**
 * A module's database migrations: its own schema, its own scripts, its own history table
 * (`<schema>.flyway_schema_history`). Each module with tables declares one as a bean in its `infra` package;
 * core migrates them all at startup, before the web server accepts requests.
 *
 * Scripts use unqualified table names - Flyway runs them with the module's schema as default schema.
 * No foreign keys across schemas: modules do not know each other.
 */
data class FlywayModule(
    val schema: String,
    val location: String = "classpath:db/migration/$schema",
    /** Lower runs first. No cross-schema dependencies exist, the order only makes startup deterministic. */
    val order: Int = 0,
)
