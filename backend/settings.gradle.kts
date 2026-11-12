// =============================================================================
// drawboard-backend: hexagonal Gradle multi-module build.
//
// Module graph (modules/<name>; enforced by build-logic/ModuleRules.kt and the ArchUnit tests in core):
//
//   core ──implementation──► shared
//     └──runtimeOnly──► api, auditing, users, library, collab, files, plugins, planning
//   api ──► users, library, collab, files, plugins, planning, shared   (never core, never auditing)
//   auditing, users, library, collab ──► shared  (domain modules never know each other)
//
// No version of the application anywhere: the pipeline passes -Pversion=1.2.3.
// =============================================================================

pluginManagement {
    // Convention plugins (dergeorg.*) come from the included build.
    includeBuild("build-logic")
}

plugins {
    // Lets Gradle download the JDK 25 toolchain when it is not installed locally.
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

dependencyResolutionManagement {
    // Repositories are declared exactly once, here. A module that declares its own fails the build.
    repositoriesMode = RepositoriesMode.FAIL_ON_PROJECT_REPOS
    repositories {
        mavenCentral()

        // The API contract (at.dergeorg.drawboard:drawboard-api-kotlin) is published by the API repository
        // into the package registry of the GitLab group apps/drawboard. Credentials:
        //   CI:    CI_JOB_TOKEN (the API project must allow this project in its job-token allowlist)
        //   local: gitlabPrivateToken=<personal access token, scope read_api> in ~/.gradle/gradle.properties
        val gitlab = maven {
            name = "gitlabDrawboardGroup"
            // Numeric group id (147 = apps/drawboard): Gradle decodes "apps%2Fdrawboard" to
            // "apps/drawboard", and GitLab answers the unencoded group path with 404.
            url = uri("https://gitlab.dergeorg.at/api/v4/groups/147/-/packages/maven")
            val jobToken = providers.environmentVariable("CI_JOB_TOKEN").orNull
            val privateToken = providers.gradleProperty("gitlabPrivateToken").orNull
            if (jobToken != null || privateToken != null) {
                credentials(HttpHeaderCredentials::class) {
                    name = if (jobToken != null) "Job-Token" else "Private-Token"
                    value = jobToken ?: privateToken
                }
                authentication { create<HttpHeaderAuthentication>("header") }
            }
        }

        // ~/.m2 only on request (-PuseMavenLocal=true, or useMavenLocal=true in ~/.gradle/gradle.properties):
        // for a contract built locally with `./gradlew publishToMavenLocal` in the API repository. Never in CI.
        val contractRepositories = buildList {
            if (providers.gradleProperty("useMavenLocal").orNull == "true") add(mavenLocal())
            add(gitlab)
        }

        // Our own artifacts come ONLY from these repositories and are never looked up on Maven Central.
        exclusiveContent {
            forRepositories(*contractRepositories.toTypedArray())
            filter { includeGroup("at.dergeorg.drawboard") }
        }
    }
}

rootProject.name = "drawboard-backend"

include("core", "api", "shared", "auditing", "users", "library", "collab", "files", "plugins", "planning")

// Every module lives in modules/<name>. The project paths stay short (:core, :api, …),
// so dependencies, ModuleRules and task names do not mention the folder.
rootProject.children.forEach { it.projectDir = file("modules/${it.name}") }
