// The application: the only module with the Spring Boot plugin and a bootJar.
import org.springframework.boot.gradle.tasks.bundling.BootJar
import org.springframework.boot.gradle.tasks.run.BootRun

plugins {
    id("dergeorg.kotlin-conventions")
}

// The Boot plugin is a dependency of build-logic (version from the catalog), so it is already on this script's
// classpath. A plugins { id("org.springframework.boot") } line would look it up on the plugin portal and
// need a second version, therefore it is applied by id here.
apply(plugin = "org.springframework.boot")

dependencies {
    implementation(project(":shared"))
    // runtimeOnly: core code cannot import module classes, the component scan still finds them.
    runtimeOnly(project(":api"))
    runtimeOnly(project(":auditing"))
    runtimeOnly(project(":library"))
    runtimeOnly(project(":collab"))
    runtimeOnly(project(":users"))
    runtimeOnly(project(":files"))
    runtimeOnly(project(":plugins"))
    runtimeOnly(project(":planning"))
    runtimeOnly(project(":gifs"))

    implementation(libs.spring.boot.starter.webflux)
    implementation(libs.spring.boot.starter.actuator)
    implementation(libs.spring.boot.starter.security.oauth2.resource.server)
    implementation(libs.spring.boot.starter.data.r2dbc)
    implementation(libs.spring.boot.starter.opentelemetry)
    implementation(libs.spring.boot.starter.aspectj) // for the @WithSpan aspect
    implementation(libs.jackson.module.kotlin)
    implementation(libs.kotlinx.coroutines.reactor)
    implementation(libs.springdoc.openapi.webflux.ui)

    // Flyway without a connection pool: an R2DBC app needs JDBC only for the migrations (spring.flyway.url).
    implementation(libs.spring.boot.flyway)
    implementation(libs.bouncycastle.bcprov) // guest signing keys: the public key is derived from the private one
    runtimeOnly(libs.flyway.database.postgresql)
    runtimeOnly(libs.postgresql)
    runtimeOnly(libs.r2dbc.postgresql)
    runtimeOnly(libs.r2dbc.proxy) // DB spans for R2DBC queries

    testImplementation(libs.archunit.junit5)
    testImplementation(testFixtures(project(":shared")))
}

testing {
    suites {
        named<JvmTestSuite>("integrationTest") {
            dependencies {
                // project() exposes core's own classes only - everything the tests touch is listed here.
                implementation(project(":shared"))
                implementation(project(":library"))
                implementation(project(":collab"))
                implementation(project(":users"))
                implementation(project(":files"))
                implementation(project(":plugins"))
                implementation(project(":planning"))
                implementation(project(":gifs"))
                implementation(testFixtures(project(":shared")))
                implementation(testFixtures(project(":library")))
                implementation(testFixtures(project(":users")))
                implementation(libs.drawboard.api.kotlin)
                implementation(libs.spring.boot.starter.webflux.test)
                implementation(libs.spring.boot.starter.security.oauth2.resource.server.test)
                implementation(libs.spring.boot.starter.opentelemetry.test)
                implementation(libs.spring.boot.starter.data.r2dbc)
                implementation(libs.spring.boot.flyway) // PersistenceIntegrationTest reads the history per schema
                implementation(libs.nimbus.jose.jwt)
                implementation(libs.opentelemetry.sdk.testing)
                implementation(libs.kotlinx.coroutines.reactor)
            }
        }
    }
}

tasks.named<Jar>("jar") {
    // No "-plain.jar": it is not runnable and would confuse the image build.
    enabled = false
}

tasks.named<BootJar>("bootJar") {
    // The deployable is the application, not the module: drawboard-backend-1.2.3.jar.
    archiveBaseName = rootProject.name
}

tasks.named<BootRun>("bootRun") {
    // `./gradlew bootRun` = local development against compose.yaml (profile dev, port 18081, see README).
    systemProperty("spring.profiles.active", providers.environmentVariable("SPRING_PROFILES_ACTIVE").getOrElse("dev"))
}
