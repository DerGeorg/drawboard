package at.dergeorg.drawboard.shared.testing

import org.springframework.boot.test.util.TestPropertyValues
import org.springframework.context.ApplicationContextInitializer
import org.springframework.context.ConfigurableApplicationContext
import org.testcontainers.postgresql.PostgreSQLContainer

/**
 * ONE PostgreSQL 18 (the same major version as compose.yaml and production) for every test of a test JVM: started on
 * first use, stopped when the JVM ends - never one container per test class or per application context.
 *
 * Why not a `@Bean @ServiceConnection` container: Spring caches test contexts across classes, and a container that
 * belongs to one context can already be stopped while a cached context still points at its port ("Connection to
 * 172.17.0.1:<port> refused" for whole classes - Ryuk is off on the runners, so nothing restarts it). A singleton
 * outlives every context. Contexts get the connection through [PostgresTestcontainerInitializer].
 */
object PostgresTestcontainer {
    const val IMAGE = "postgres:18"

    val postgres: PostgreSQLContainer by lazy {
        PostgreSQLContainer(IMAGE).apply {
            // Every cached application context keeps a connection pool; with the files and plugins contexts the 100 connections
            // of the default are used up ("sorry, too many clients already").
            withCommand("postgres", "-c", "max_connections=400")
            start()
            Runtime.getRuntime().addShutdownHook(Thread { stop() })
        }
    }
}

/**
 * Points a test context at the [PostgresTestcontainer] singleton: the application over R2DBC (`spring.r2dbc.*`) and
 * Flyway over its own JDBC connection (`spring.flyway.*`) - both, because a reactive application has no DataSource
 * that Flyway could share. Use it as `@ContextConfiguration(initializers = [PostgresTestcontainerInitializer::class])`.
 */
class PostgresTestcontainerInitializer : ApplicationContextInitializer<ConfigurableApplicationContext> {
    override fun initialize(context: ConfigurableApplicationContext) {
        val postgres = PostgresTestcontainer.postgres
        TestPropertyValues.of(
            "spring.r2dbc.url=r2dbc:postgresql://${postgres.host}:${postgres.firstMappedPort}/${postgres.databaseName}",
            "spring.r2dbc.username=${postgres.username}",
            "spring.r2dbc.password=${postgres.password}",
            "spring.flyway.url=${postgres.jdbcUrl}",
            "spring.flyway.user=${postgres.username}",
            "spring.flyway.password=${postgres.password}",
        ).applyTo(context.environment)
    }
}
