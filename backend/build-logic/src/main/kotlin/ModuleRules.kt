import org.gradle.api.GradleException
import org.gradle.api.Project
import org.gradle.api.artifacts.Configuration
import org.gradle.api.artifacts.ProjectDependency
import org.gradle.kotlin.dsl.withType

/*
 * Gradle-level guard for the module graph. It fails the build while the dependency is being DECLARED
 * (configuration time), long before anything compiles, with a message that names the rule.
 *
 * Test code is allowed to import "wildly": test and integrationTest configurations may use the test
 * fixtures of any other module. Test FIXTURES themselves follow the production rule, so they never
 * become a back door between domain modules.
 */

/** Fails the build as soon as a module declares a project dependency outside [allowed] (itself is always allowed). */
fun Project.allowOnlyProjectDependencies(vararg allowed: String) {
    val allowedPaths = allowed.toSet() + path
    guardProjectDependencies { dependencyPath, configurationName ->
        if (dependencyPath !in allowedPaths) {
            throw GradleException(
                "Module '$path' must not depend on '$dependencyPath' (configuration '$configurationName'). " +
                    "Allowed: ${allowed.toList()}",
            )
        }
    }
}

/** Fails the build as soon as a module declares a project dependency on one of [forbidden]. */
fun Project.forbidProjectDependencies(vararg forbidden: String) {
    val forbiddenPaths = forbidden.toSet()
    guardProjectDependencies { dependencyPath, configurationName ->
        if (dependencyPath in forbiddenPaths) {
            throw GradleException(
                "Module '$path' must not depend on '$dependencyPath' (configuration '$configurationName'). " +
                    "Forbidden: ${forbidden.toList()}",
            )
        }
    }
}

private fun Project.guardProjectDependencies(check: (dependencyPath: String, configurationName: String) -> Unit) {
    configurations.configureEach {
        if (isTestOnly()) return@configureEach
        val configurationName = name
        dependencies.withType<ProjectDependency>().configureEach { check(path, configurationName) }
    }
}

private fun Configuration.isTestOnly(): Boolean =
    (name.startsWith("test") && !name.startsWith("testFixtures")) || name.startsWith("integrationTest")
