// "shared": code every module may use (error codes, ports, observability, ids). Depends on no other module.
plugins {
    id("dergeorg.library-conventions")
}

allowOnlyProjectDependencies()

dependencies {
    // Part of every module's API: @WithSpan/@SpanAttribute and coroutines in port signatures.
    api(libs.opentelemetry.instrumentation.annotations)
    api(libs.kotlinx.coroutines.core)

    // WithSpanAspect (the aspect class lives here, core registers it as a bean)
    implementation(libs.spring.core)
    implementation(libs.aspectjweaver)
    implementation(libs.micrometer.observation)
    implementation(libs.micrometer.context.propagation)
    implementation(libs.reactor.core)
    // KotlinTypesJacksonModule (Uuid, Instant, Duration as JSON strings) - registered by core, used by api's slices
    implementation(libs.jackson.databind)

    // Drift test: shared ErrorCode <-> ErrorCode of the contract
    testImplementation(libs.drawboard.api.kotlin)
    testImplementation(libs.spring.aop) // proxies for the WithSpanAspect test
    testImplementation(libs.spring.tx) // ...with a real TransactionInterceptor inside the span
    testImplementation(libs.kotlinx.coroutines.reactor)
    testImplementation(libs.jackson.module.kotlin) // KotlinTypesJacksonModuleTest: the same mapper setup as Boot

    // Fixtures for every module's tests: fakes of the shared ports, test users, the Postgres container
    testFixturesApi(libs.spring.boot.test)
    // One PostgreSQL container per test JVM, wired by PostgresTestcontainerInitializer (no @ServiceConnection)
    testFixturesApi(libs.testcontainers.postgresql)
}
