// The REST layer: controllers implementing the generated contract interfaces. May use shared and the
// domain modules (only through their provides/model packages), never core and never auditing.
// Reactive stack: WebFlux + coroutines. (MVC variant: spring-boot-starter-webmvc, see README.)
plugins {
    id("dergeorg.library-conventions")
}

forbidProjectDependencies(":core", ":auditing")

dependencies {
    api(project(":shared"))
    implementation(project(":library"))
    implementation(project(":collab"))
    implementation(project(":users"))
    implementation(project(":files"))
    implementation(project(":plugins"))
    implementation(project(":planning"))
    implementation(project(":gifs"))
    implementation(libs.spring.boot.starter.webflux)
    implementation(libs.spring.boot.starter.validation)
    implementation(libs.jackson.module.kotlin) // Boot 4 = Jackson 3 (tools.jackson, not com.fasterxml)
    implementation(libs.kotlinx.coroutines.reactor)
    // The contract: generated BoardsApi/UsersApi interfaces and models (+ the bundled spec for Swagger UI)
    implementation(libs.drawboard.api.kotlin)
    // AccessDeniedException and the 401/403 handler interfaces (the route table itself lives in core)
    implementation(libs.spring.boot.starter.security)
    implementation(libs.spring.security.oauth2.core) // tells a bad token from a missing one
    // marks the HTTP server span as failed when a handler turns an exception into a 5xx (ProblemResponses.kt)
    implementation(libs.micrometer.tracing)
    // OptimisticLockingFailureException (409 CONFLICT) - Spring's exception hierarchy, not Spring Data
    implementation(libs.spring.tx)

    testImplementation(testFixtures(project(":shared")))
    testImplementation(libs.spring.boot.starter.webflux.test)
    testImplementation(libs.springmockk)
    // "Wild" import of the domain modules' fixtures - allowed in test scope only
    testImplementation(testFixtures(project(":library")))
    testImplementation(testFixtures(project(":users")))
}
