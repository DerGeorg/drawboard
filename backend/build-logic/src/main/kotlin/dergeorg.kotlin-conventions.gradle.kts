// Base of every module: Kotlin/JVM with Spring all-open, JDK 25, the Spring Boot BOM, and the test setup
// (unit tests in src/test, Docker-based integration tests in src/integrationTest).
import org.gradle.accessors.dm.LibrariesForLibs
import org.springframework.boot.gradle.plugin.SpringBootPlugin

plugins {
    id("org.jetbrains.kotlin.jvm")
    id("org.jetbrains.kotlin.plugin.spring")
    `jvm-test-suite`
}

// The version catalog (gradle/libs.versions.toml), type-safe - see build-logic/build.gradle.kts.
val libs = the<LibrariesForLibs>()

// Maven group = root package of the app (gradle.properties), e.g. at.dergeorg.drawboard.
group = providers.gradleProperty("app.group").get()
// "drawboard-backend-board-1.2.3.jar" instead of "board-1.2.3.jar": unambiguous in BOOT-INF/lib and in SBOMs.
base.archivesName = "${rootProject.name}-${project.name}"
// Never maintained in the repository: the pipeline passes -Pversion=1.2.3.
version = findProperty("version")?.takeIf { it != "unspecified" } ?: "0.0.1-SNAPSHOT"

kotlin {
    // Toolchain instead of sourceCompatibility: Gradle provides the JDK of the catalog (java = "25") no matter
    // which JDK runs Gradle.
    jvmToolchain(libs.versions.java.get().toInt())
    compilerOptions {
        freeCompilerArgs.addAll(
            // Take Spring's nullability annotations seriously; otherwise Java return values are
            // "platform types" and the null check silently disappears.
            "-Xjsr305=strict",
            // Kotlin 2.2+: annotations on constructor parameters go to parameter AND property.
            "-Xannotation-default-target=param-property",
            // kotlin.uuid.Uuid is still @ExperimentalUuidApi in Kotlin 2.3: opted in once here, never per file.
            "-opt-in=kotlin.uuid.ExperimentalUuidApi",
        )
    }
}

// Gradle-native BOM import (no io.spring.dependency-management plugin): every library version below
// comes from Spring Boot's BOM.
val springBootBom = dependencies.platform(SpringBootPlugin.BOM_COORDINATES)

dependencies {
    implementation(springBootBom)
    implementation(libs.kotlin.reflect)

    testImplementation(springBootBom)
    testImplementation(libs.spring.boot.starter.test) // JUnit 6
    testImplementation(libs.kotlin.test.junit5) // kotlin.test: every assertion carries a message
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.mockk)
    testRuntimeOnly(libs.junit.platform.launcher)
}

testing {
    suites {
        // src/test: fast, no Docker - unit tests and web slice tests. `./gradlew test` (part of `build`).
        named<JvmTestSuite>("test") {
            useJUnitJupiter()
        }
        // src/integrationTest: the full application against a real Postgres (Testcontainers).
        // `./gradlew integrationTest` - deliberately NOT part of `build`/`check`, it needs Docker.
        register<JvmTestSuite>("integrationTest") {
            useJUnitJupiter()
            dependencies {
                implementation(project())
                implementation(springBootBom)
                implementation(libs.spring.boot.starter.test)
                implementation(libs.kotlin.test.junit5)
                implementation(libs.kotlinx.coroutines.test)
                runtimeOnly(libs.junit.platform.launcher)
            }
            targets.configureEach {
                testTask.configure { shouldRunAfter(tasks.named("test")) }
            }
        }
    }
}

// Integration tests may use the module's `internal` types, like unit tests do.
kotlin.target.compilations.named("integrationTest") {
    associateWith(kotlin.target.compilations.getByName("main"))
}

// MockK (and Mockito) attach ByteBuddy's agent at runtime; JDK 21+ warns and a future JDK refuses.
// Loading byte-buddy-agent as a real -javaagent fixes that for both.
val mockAgent = configurations.create("mockAgent")
dependencies {
    mockAgent(springBootBom)
    mockAgent(libs.byte.buddy.agent)
}

tasks.withType<Test>().configureEach {
    val agent = mockAgent.incoming.files
    jvmArgumentProviders.add(CommandLineArgumentProvider { listOf("-javaagent:${agent.singleFile}") })
    jvmArgs(
        "-Xshare:off", // silences the CDS warning caused by the agent
        "--enable-native-access=ALL-UNNAMED", // Netty loads its native transport (JDK 24+ warns otherwise)
    )
}
