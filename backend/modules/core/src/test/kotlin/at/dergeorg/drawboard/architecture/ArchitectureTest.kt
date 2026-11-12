package at.dergeorg.drawboard.architecture

import com.tngtech.archunit.base.DescribedPredicate.alwaysTrue
import com.tngtech.archunit.base.DescribedPredicate.not
import com.tngtech.archunit.core.domain.JavaCall.Predicates.target
import com.tngtech.archunit.core.domain.JavaClass.Predicates.assignableTo
import com.tngtech.archunit.core.domain.JavaClass.Predicates.resideInAPackage
import com.tngtech.archunit.core.domain.JavaClass.Predicates.resideInAnyPackage
import com.tngtech.archunit.core.domain.JavaClass.Predicates.simpleNameEndingWith
import com.tngtech.archunit.core.domain.JavaClasses
import com.tngtech.archunit.core.domain.JavaModifier
import com.tngtech.archunit.core.importer.ClassFileImporter
import com.tngtech.archunit.core.domain.properties.HasName.Predicates.nameMatching
import com.tngtech.archunit.core.domain.properties.HasName.Predicates.nameStartingWith
import com.tngtech.archunit.core.domain.properties.HasOwner.Predicates.With.owner
import com.tngtech.archunit.core.importer.ImportOption
import com.tngtech.archunit.lang.syntax.ArchRuleDefinition.classes
import com.tngtech.archunit.lang.syntax.ArchRuleDefinition.methods
import com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses
import com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noFields
import com.tngtech.archunit.library.dependencies.SlicesRuleDefinition.slices
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.data.r2dbc.core.R2dbcEntityTemplate
import org.springframework.data.repository.CrudRepository
import org.springframework.data.repository.kotlin.CoroutineCrudRepository
import org.springframework.data.repository.reactive.ReactiveCrudRepository
import org.springframework.web.bind.annotation.RestController

/**
 * The architecture rules the compiler cannot check. Gradle (build-logic/ModuleRules.kt) guards the module graph and
 * Kotlin `internal` hides implementations across modules; these rules also cover what happens INSIDE a module.
 * Runs in core because only core has every module on its (test) classpath. Rules are written per package - Kotlin
 * generates classes such as `BoardService$createTask$1` for coroutines.
 */
class ArchitectureTest {

    @Nested
    inner class Modules {

        @Test
        fun `when checking dependencies then shared and the domain modules never depend on each other`() {
            slices().matching("$ROOT.(*)..").namingSlices("module $1")
                .should().notDependOnEachOther()
                .ignoreDependency(resideInAnyPackage("$ROOT.api..", "$ROOT.core..", "$ROOT.contract.."), alwaysTrue())
                .ignoreDependency(alwaysTrue(), resideInAPackage("$ROOT.shared.."))
                .because("domain modules only share code through :shared - library never knows users and vice versa")
                .check(productionClasses)
        }

        @Test
        fun `when checking dependencies then api never depends on core or auditing`() {
            noClasses().that().resideInAPackage("$ROOT.api..")
                .should().dependOnClassesThat().resideInAnyPackage("$ROOT.core..", "$ROOT.auditing..")
                .because("api reads and writes audit events through the ports in shared")
                .check(productionClasses)
        }

        @Test
        fun `when checking dependencies then core only wires modules and never uses their classes`() {
            noClasses().that().resideInAPackage("$ROOT.core..")
                .should().dependOnClassesThat().resideInAnyPackage(*MODULES.map { "$ROOT.$it.." }.toTypedArray())
                .because("core has the modules only as runtimeOnly dependencies; it knows shared and Spring")
                .check(productionClasses)
        }

        @Test
        fun `when checking dependencies then api uses other modules only through their provides and model packages`() {
            noClasses().that().resideInAPackage("$ROOT.api..")
                .should().dependOnClassesThat(
                    resideInAnyPackage("$ROOT.library..", "$ROOT.users..", "$ROOT.collab..", "$ROOT.files..", "$ROOT.plugins..",
                        "$ROOT.planning..")
                        .and(
                            not(
                                resideInAnyPackage(
                                    "$ROOT.*.domain.*.provides",
                                    "$ROOT.*.domain.*.model",
                                    // The ports collab requires from outside (board access, board activity): collab and library
                                    // never know each other, so api implements them. Only this package, only collab.
                                    "$ROOT.collab.domain.rooms.requires",
                                    // The same for planning: which guest links are gone (GuestShares), implemented on library by api.
                                    "$ROOT.planning.domain.rounds.requires",
                                ),
                            ),
                        ),
                )
                .because("a module's use cases and models are its public API; services and repositories are not")
                .check(productionClasses)
        }
    }

    @Nested
    inner class Layers {

        @Test
        fun `when checking a module then its domain never depends on its infra`() {
            noClasses().that().resideInAPackage("$ROOT.*.domain..")
                .should().dependOnClassesThat().resideInAPackage("$ROOT.*.infra..")
                .check(productionClasses)
        }

        @Test
        fun `when checking requires impl then only requires impl uses it - everything else goes through the port`() {
            classes().that().resideInAPackage("$ROOT..requires.impl..")
                .should().onlyHaveDependentClassesThat().resideInAPackage("$ROOT..requires.impl..")
                .because("adapters are wired by Spring; the domain only sees the requires interfaces")
                .check(productionClasses)
        }

        @Test
        fun `when checking persistence then Spring Data and R2DBC are only used in requires impl`() {
            noClasses().that().resideOutsideOfPackages("$ROOT..requires.impl..", "$ROOT.core..")
                .should().dependOnClassesThat()
                .resideInAnyPackage("org.springframework.data..", "org.springframework.r2dbc..", "io.r2dbc..")
                .check(productionClasses)
        }

        @Test
        fun `when checking domain models then they are free of frameworks`() {
            noClasses().that().resideInAPackage("$ROOT..domain.*.model..")
                .should().dependOnClassesThat().resideInAnyPackage("org.springframework..", "io.r2dbc..", "tools.jackson..")
                .check(productionClasses)
        }

        @Test
        fun `when checking shared then its models and ports are free of frameworks`() {
            noClasses().that().resideInAnyPackage(*SHARED_KERNEL.map { "$ROOT.shared.$it.." }.toTypedArray())
                .should().dependOnClassesThat().resideInAnyPackage("org.springframework..", "io.r2dbc..", "tools.jackson..")
                .because("every module uses them in its domain; only the Spring glue in shared (observability, types) knows frameworks")
                .check(productionClasses)
        }

        @Test
        fun `when checking shared then it has topic packages only - no common, domain, infra, provides or requires`() {
            noClasses().should().resideInAnyPackage(
                "$ROOT.shared.common..",
                "$ROOT.shared.domain..",
                "$ROOT.shared.infra..",
                "$ROOT.shared..provides..",
                "$ROOT.shared..requires..",
            )
                .because("shared is a box of helpers, not a domain: one flat package per topic (auditing, context, error, ...)")
                .check(productionClasses)
        }

        @Test
        fun `when checking implementations of the contract then they are controllers in api domain provides impl`() {
            classes().that().implement(resideInAPackage("$ROOT.contract.api.."))
                .and().resideOutsideOfPackage("$ROOT.contract..")
                .should().beAnnotatedWith(RestController::class.java)
                .andShould().haveSimpleNameEndingWith("Controller")
                .andShould().resideInAPackage("$ROOT.api.domain.*.*.provides.impl")
                .because("the generated contract interface (BoardsApi) is what the api module provides; the controller implements it")
                .check(productionClasses)
        }

        @Test
        fun `when checking controllers then they live in api provides impl or as technical endpoints in api infra web`() {
            classes().that().areAnnotatedWith(RestController::class.java).and().resideOutsideOfPackage("$ROOT.contract..")
                .should().resideInAnyPackage("$ROOT.api.domain..provides.impl..", "$ROOT.api.infra.web..")
                .because("infra/web keeps what serves no contract operation: the spec document, the error handlers")
                .check(productionClasses)
        }
    }

    @Nested
    inner class Persistence {

        @Test
        fun `when checking repositories then nobody writes SQL by hand - derived queries only`() {
            noClasses().that().doNotHaveFullyQualifiedName("$ROOT.collab.domain.storage.requires.impl.UpdateR2dbcRepository")
                .and().doNotHaveFullyQualifiedName("$ROOT.collab.domain.storage.requires.impl.SnapshotR2dbcRepository")
                .and().doNotHaveFullyQualifiedName("$ROOT.files.domain.files.requires.impl.FileR2dbcRepository")
                .should().dependOnClassesThat().haveFullyQualifiedName("org.springframework.data.r2dbc.repository.Query")
                .orShould().dependOnClassesThat().haveFullyQualifiedName("org.springframework.data.r2dbc.repository.Modifying")
                .orShould().dependOnClassesThat().resideInAPackage("org.springframework.jdbc..")
                .because(
                "Spring Data derived queries, save() with @Version and @Lock instead of SQL strings - except the sums of the " +
                    "stored bytes in the two collab repositories and the sums of the quotas in the files repository, which a derived " +
                    "query cannot express",
            )
                .check(productionClasses)
        }

        @Test
        fun `when checking native SQL then only the audit store uses it, for DISTINCT ON`() {
            noClasses().that().doNotHaveFullyQualifiedName("$ROOT.auditing.domain.events.requires.impl.R2dbcAuditEventStore")
                .should().dependOnClassesThat().haveFullyQualifiedName("org.springframework.r2dbc.core.DatabaseClient")
                .because("native SQL needs a written reason; the one exception is documented in R2dbcAuditEventStore")
                .check(productionClasses)
        }
    }

    @Nested
    inner class Auditing {

        @Test
        fun `when checking the audit store then it can only insert and read - append-only in code, not by trigger`() {
            noClasses().that().resideInAPackage("$ROOT.auditing..")
                .should().callMethodWhere(
                    target(owner(assignableTo(R2dbcEntityTemplate::class.java)))
                        .and(target(nameMatching("update|delete"))),
                )
                .orShould().dependOnClassesThat().areAssignableTo(CrudRepository::class.java)
                .orShould().dependOnClassesThat().areAssignableTo(ReactiveCrudRepository::class.java)
                .orShould().dependOnClassesThat().areAssignableTo(CoroutineCrudRepository::class.java)
                .because("audit rows are never changed or removed; retention drops whole partitions")
                .check(productionClasses)
        }

        @Test
        fun `when checking the audit entity then only the store of auditing uses it`() {
            classes().that().haveSimpleName("AuditEventEntity")
                .should().onlyHaveDependentClassesThat().resideInAPackage("$ROOT.auditing.domain.events.requires.impl..")
                .because("no other module or layer may reach the audit table")
                .check(productionClasses)
        }
    }

    @Nested
    inner class Types {

        @Test
        fun `when checking time and ids then java time and java util UUID appear only in the converters of core`() {
            noClasses().that().resideOutsideOfPackage("$ROOT.core.infra.types..")
                // Bucket4j's API takes java.time.Duration: UserRateLimiter (the per-user rate limit of tickets and snapshot uploads) is
                // the one exception.
                .and(not(nameStartingWith("$ROOT.collab.domain.ratelimit.UserRateLimiter")))
                .should().dependOnClassesThat().resideInAPackage("java.time..")
                .orShould().dependOnClassesThat().haveFullyQualifiedName("java.util.UUID")
                .because("the application speaks kotlin.time and kotlin.uuid (Uuid.generateV7()) everywhere")
                .check(productionClasses)
        }
    }

    @Nested
    inner class Security {

        @Test
        fun `when checking permissions then nothing uses method security - the route table is the one place`() {
            noClasses().should().dependOnClassesThat().resideInAnyPackage(
                "org.springframework.security.access.prepost..",
                "org.springframework.security.config.annotation.method..",
            )
                .because("permissions are enforced in one place: the route table in core (SecurityConfig)")
                .check(productionClasses)
        }
    }

    @Nested
    inner class Logging {

        @Test
        fun `when checking logging then only the AppLogger implementation and the MDC bridge in core use SLF4J`() {
            noClasses().that().resideOutsideOfPackage("$ROOT.core.infra.observability..")
                .should().dependOnClassesThat().resideInAnyPackage("org.slf4j..", "io.github.oshai..", "java.util.logging..")
                .because("every class gets its AppLogger through the constructor - no static logger lookups")
                .check(productionClasses)
        }
    }

    @Nested
    inner class Naming {

        @Test
        fun `when checking use cases then they are interfaces in a provides package`() {
            classes().that().haveSimpleNameEndingWith("UseCase")
                .should().beInterfaces().andShould().resideInAPackage("$ROOT..provides")
                .check(productionClasses)
        }

        @Test
        fun `when checking use case implementations then they are Services in the domain root or in provides impl`() {
            classes().that().implement(simpleNameEndingWith("UseCase"))
                .should().haveSimpleNameEndingWith("Service")
                .andShould().resideInAnyPackage("$ROOT.*.domain", "$ROOT.api.domain.*", "$ROOT..provides.impl..")
                .check(productionClasses)
        }

        @Test
        fun `when checking dependency injection then no field is injected`() {
            noFields().should().beAnnotatedWith(Autowired::class.java)
                .because("constructor injection only - dependencies are visible and final")
                .check(productionClasses)
        }
    }

    @Nested
    inner class Observability {

        @Test
        fun `when checking controllers and services then every public function has WithSpan`() {
            methods()
                .that().areDeclaredInClassesThat().haveSimpleNameEndingWith("Controller")
                .or().areDeclaredInClassesThat().haveSimpleNameEndingWith("Service")
                .and().areDeclaredInClassesThat().resideOutsideOfPackage("$ROOT.contract..")
                .and().arePublic()
                .and().doNotHaveModifier(JavaModifier.SYNTHETIC) // Kotlin: $default, access$...
                .and().doNotHaveModifier(JavaModifier.BRIDGE)
                .and().areNotStatic() // Kotlin: foo$suspendImpl of open suspend functions
                .should().beAnnotatedWith(WithSpan::class.java)
                .because("every API route and every use case must produce a span")
                .check(productionClasses)
        }
    }

    private companion object {
        const val ROOT = "at.dergeorg.drawboard"
        val MODULES = listOf("api", "auditing", "users", "library", "collab", "files", "plugins", "planning")

        /** The topic packages of shared that hold models, ports and values - everything but the Spring glue (observability, types). */
        val SHARED_KERNEL = listOf("auditing", "context", "error", "logging", "paging", "persistence", "security")

        val productionClasses: JavaClasses by lazy {
            ClassFileImporter()
                .withImportOption(ImportOption.DoNotIncludeTests())
                .withImportOption { location -> !location.contains("drawboard-api-kotlin") } // the generated contract
                .importPackages(ROOT)
        }
    }
}
