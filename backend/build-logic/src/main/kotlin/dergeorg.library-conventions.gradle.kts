// Every module except core: a plain jar plus test fixtures (src/testFixtures) that other modules' tests may use.
import org.springframework.boot.gradle.plugin.SpringBootPlugin

plugins {
    id("dergeorg.kotlin-conventions")
    `java-library`
    `java-test-fixtures`
}

dependencies {
    // The testFixtures configurations do not extend implementation, so they need the BOM themselves.
    testFixturesApi(platform(SpringBootPlugin.BOM_COORDINATES))
}
