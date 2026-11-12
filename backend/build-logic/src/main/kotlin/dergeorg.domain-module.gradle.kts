// A domain module (board, user, ...) - and auditing, which is built the same way.
// Knows only :shared, never another domain module. Reactive stack: Spring Data R2DBC + coroutines.
// (MVC variant: spring-boot-starter-data-jpa plus kotlin("plugin.jpa") and allOpen for @Entity/@Embeddable/
// @MappedSuperclass instead of the two R2DBC/coroutine lines, see README.)
import org.gradle.accessors.dm.LibrariesForLibs

plugins {
    id("dergeorg.library-conventions")
}

allowOnlyProjectDependencies(":shared")

val libs = the<LibrariesForLibs>()

dependencies {
    api(project(":shared"))
    implementation(libs.spring.boot.starter.data.r2dbc)
    implementation(libs.kotlinx.coroutines.reactor)

    // Fixtures of this module expose its public types (models, commands) and the shared fixtures.
    testFixturesApi(project(":shared"))
    testFixturesApi(testFixtures(project(":shared")))
    testImplementation(testFixtures(project(":shared")))
}
