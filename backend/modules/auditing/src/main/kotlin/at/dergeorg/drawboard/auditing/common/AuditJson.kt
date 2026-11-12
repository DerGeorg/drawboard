package at.dergeorg.drawboard.auditing.common

import at.dergeorg.drawboard.shared.auditing.DomainEventDetails
import at.dergeorg.drawboard.shared.auditing.FieldChange
import at.dergeorg.drawboard.shared.auditing.UnknownDetails
import com.fasterxml.jackson.annotation.JsonTypeInfo
import org.springframework.stereotype.Component
import tools.jackson.databind.DeserializationFeature
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import tools.jackson.databind.jsontype.NamedType
import tools.jackson.databind.node.ObjectNode

/**
 * JSON of the `details` and `changes` columns.
 *
 * A private copy of Boot's [JsonMapper] (same modules: Kotlin, the Kotlin types of shared) with the details types registered
 * under their logical names; the mapper used for HTTP stays untouched. Polymorphic reading only ever resolves
 * registered names - never class names from the database.
 */
@Component
internal class AuditJson(bootMapper: JsonMapper, private val registry: DetailsTypeRegistry) {

    private val mapper: JsonMapper = bootMapper.rebuild()
        .addMixIn(DomainEventDetails::class.java, DetailsTypeInfo::class.java)
        .apply { registry.types.forEach { (name, type) -> registerSubtypes(NamedType(type, name)) } }
        // A field removed from a details class must not break reading old rows. Jackson 3 defaults to false
        // already; explicit so that an application-wide Boot property cannot flip it.
        .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
        .build()

    private val detailsWriter = mapper.writerFor(DomainEventDetails::class.java)

    fun detailsTypeOf(details: DomainEventDetails): String = registry.nameOf(details.javaClass)

    fun writeDetails(details: DomainEventDetails): String = detailsWriter.writeValueAsString(details)

    fun readDetails(json: String): DomainEventDetails {
        val node = mapper.readTree(json)
        val type = node.get(TYPE_PROPERTY)?.takeIf { it.isString }?.asString()
        if (type == null || type !in registry.types) return UnknownDetails(type, json)
        return mapper.treeToValue(node, DomainEventDetails::class.java)
    }

    /**
     * Field-level difference of two snapshots; nested objects become dotted paths. Values of fields whose name
     * looks like a secret are replaced by `***` - the audit log must not become a copy of credentials.
     */
    fun diff(before: Any?, after: Any?): List<FieldChange> {
        val left = flatten(before?.let { mapper.valueToTree<JsonNode>(it) })
        val right = flatten(after?.let { mapper.valueToTree<JsonNode>(it) })
        return (left.keys + right.keys).sorted().mapNotNull { path ->
            val old = left[path]
            val new = right[path]
            when {
                old == new -> null
                SENSITIVE.containsMatchIn(path.substringAfterLast('.')) -> FieldChange(path, old?.let { REDACTED }, new?.let { REDACTED })
                else -> FieldChange(path, old?.let(::plain), new?.let(::plain))
            }
        }
    }

    fun writeChanges(changes: List<FieldChange>): String = mapper.writeValueAsString(changes)

    fun readChanges(json: String): List<FieldChange> =
        mapper.readValue(json, mapper.typeFactory.constructCollectionType(List::class.java, FieldChange::class.java))

    private fun plain(node: JsonNode): Any? = mapper.treeToValue(node, Any::class.java)

    private fun flatten(
        node: JsonNode?,
        prefix: String = "",
        into: MutableMap<String, JsonNode> = linkedMapOf(),
    ): Map<String, JsonNode> {
        when {
            node == null -> Unit
            node is ObjectNode && !node.isEmpty -> node.properties().forEach { (name, child) ->
                flatten(child, if (prefix.isEmpty()) name else "$prefix.$name", into)
            }
            prefix.isEmpty() -> into[ROOT] = node
            else -> into[prefix] = node
        }
        return into
    }

    @JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = TYPE_PROPERTY)
    private interface DetailsTypeInfo

    companion object {
        const val TYPE_PROPERTY = "@type"
        private const val ROOT = "$"
        private const val REDACTED = "***"
        private val SENSITIVE = Regex("(?i)password|secret|token|iban|credential")
    }
}
