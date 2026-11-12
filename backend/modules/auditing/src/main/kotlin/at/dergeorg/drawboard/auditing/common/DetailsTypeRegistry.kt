package at.dergeorg.drawboard.auditing.common

import at.dergeorg.drawboard.shared.auditing.AuditDetails
import at.dergeorg.drawboard.shared.auditing.DomainEventDetails
import org.springframework.context.annotation.ClassPathScanningCandidateComponentProvider
import org.springframework.core.type.filter.AnnotationTypeFilter
import org.springframework.util.ClassUtils

/**
 * Logical details names -> classes. Built once at startup by scanning for [AuditDetails], so a domain module only
 * annotates its details classes: no registration code, no dependency on this module.
 *
 * Fails fast (the application does not start) on duplicate names, on annotated classes that do not implement
 * [DomainEventDetails], and on malformed names.
 */
internal class DetailsTypeRegistry(basePackages: Collection<String>) {

    val types: Map<String, Class<out DomainEventDetails>> = scan(basePackages)

    fun nameOf(type: Class<*>): String {
        val name = requireNotNull(type.getAnnotation(AuditDetails::class.java)?.type) {
            "${type.name} implements DomainEventDetails but has no @AuditDetails(type = ...)"
        }
        require(types[name] == type) { "Details type '$name' (${type.name}) is not registered - is it outside $types?" }
        return name
    }

    private fun scan(basePackages: Collection<String>): Map<String, Class<out DomainEventDetails>> {
        val scanner = ClassPathScanningCandidateComponentProvider(false)
        scanner.addIncludeFilter(AnnotationTypeFilter(AuditDetails::class.java))
        val result = mutableMapOf<String, Class<out DomainEventDetails>>()
        basePackages.flatMap { scanner.findCandidateComponents(it) }.forEach { definition ->
            val type = ClassUtils.forName(requireNotNull(definition.beanClassName), javaClass.classLoader)
            check(DomainEventDetails::class.java.isAssignableFrom(type)) {
                "${type.name} has @AuditDetails but does not implement DomainEventDetails"
            }
            val name = type.getAnnotation(AuditDetails::class.java).type
            check(NAME.matches(name)) { "Details type '$name' (${type.name}) must match $NAME" }
            val previous = result.putIfAbsent(name, type.asSubclass(DomainEventDetails::class.java))
            check(previous == null || previous == type) {
                "Details type '$name' is used by both ${previous?.name} and ${type.name}"
            }
        }
        return result.toMap()
    }

    companion object {
        /** `<module>.<name>` in kebab case, optionally versioned: `board.task-completed`, `board.task-completed.v2`. */
        val NAME = Regex("[a-z][a-z0-9-]*(\\.[a-z0-9][a-z0-9-]*)+")
    }
}
