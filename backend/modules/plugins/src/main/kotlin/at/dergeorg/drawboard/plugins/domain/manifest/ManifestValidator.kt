package at.dergeorg.drawboard.plugins.domain.manifest

import at.dergeorg.drawboard.plugins.common.PluginsModule
import at.dergeorg.drawboard.plugins.domain.plugins.model.BlockTypeDef
import at.dergeorg.drawboard.plugins.domain.plugins.model.Capability
import at.dergeorg.drawboard.shared.error.InvalidField
import tools.jackson.databind.JsonNode

/** A valid `drawboard-plugin.json` (docs/plugin-protocol.md). */
internal data class Manifest(
    val id: String,
    val name: String,
    val version: String,
    val description: String?,
    val entry: String,
    val minHostVersion: String,
    val blockTypes: List<BlockTypeDef>,
    val capabilities: List<Capability>,
)

/** The result of [ManifestValidator.validate]: the manifest, or one violation per problem (field = JSON path). */
internal sealed interface ManifestResult {
    data class Valid(val manifest: Manifest) : ManifestResult

    data class Invalid(val violations: List<InvalidField>) : ManifestResult
}

/**
 * Validates a parsed `drawboard-plugin.json` against the schema of the plugin protocol AND the rules the schema cannot
 * express: every block type lies in the namespace of the plugin id (`<id>.<name>`), `value` is present exactly for
 * `import.register` and `network` and well-formed for them, no duplicate capabilities or block types, `minHostVersion`
 * not above the plugin API version this instance implements. All problems are collected, not just the first.
 */
internal object ManifestValidator {

    private const val ID_PATTERN = "^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+$"
    private val ID = Regex(ID_PATTERN)
    private val ENTRY = Regex("^(?!/)(?!.*(^|/)\\.\\.(/|$))[A-Za-z0-9._/-]+\\.m?js$")
    private val MEDIA_TYPE = Regex("^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$")
    private val RESERVED_NAMESPACES = setOf("core", "drawboard")
    private val ROOT_FIELDS = setOf(
        "manifestVersion",
        "id",
        "name",
        "version",
        "description",
        "entry",
        "minHostVersion",
        "blockTypes",
        "capabilities",
    )
    private val BLOCK_FIELDS = setOf("type", "label", "defaultWidth", "defaultHeight")
    private val CAPABILITY_FIELDS = setOf("name", "value")
    val CAPABILITIES = setOf(
        "block.props", "block.resize", "board.read", "export.register", "import.register", "ui.toast", "ui.openLink", "storage", "network",
    )
    private const val MAX_ID = 100
    private const val MIN_ID = 3
    private const val MAX_NAME = 100
    private const val MAX_DESCRIPTION = 1000
    private const val MAX_ENTRY = 255
    private const val MAX_BLOCK_TYPES = 50
    private const val MAX_BLOCK_TYPE = 150
    private const val MAX_CAPABILITIES = 30
    private const val MAX_VALUE = 1000
    private const val MAX_MEDIA_TYPE = 100
    private const val MIN_SIZE = 16
    private const val MAX_SIZE = 4096

    /** Collects the violations; [field] is the JSON path inside the manifest. */
    private class Problems {
        val found = ArrayList<InvalidField>()

        fun add(field: String, constraint: String, message: String) {
            found += InvalidField(field, constraint, message)
        }
    }

    /** Problems of one element of an array: every field is reported with the path of the element in front. */
    private class NestedProblems(private val parent: Problems, private val path: String) {
        fun add(field: String, constraint: String, message: String) =
            parent.add(if (field.isEmpty()) path else "$path.$field", constraint, message)
    }

    fun validate(root: JsonNode): ManifestResult {
        if (!root.isObject) return ManifestResult.Invalid(listOf(InvalidField("$", "Type", "must be a JSON object")))
        val problems = Problems()
        val unknown = root.propertyNames().filter { it !in ROOT_FIELDS }
        unknown.forEach { problems.add(it, "AdditionalProperties", "is not a field of the manifest") }
        if (!(root.path("manifestVersion").isIntegralNumber && root.path("manifestVersion").intValue() == 1)) {
            problems.add("manifestVersion", "Const", "must be 1")
        }
        val id = text(root, "id", problems::add, required = true)?.also { validateId(it, problems::add) }
        val name = text(root, "name", problems::add, required = true)?.also { validateName(it, problems::add) }
        val version = text(root, "version", problems::add, required = true)?.also { validateVersion(it, problems::add) }
        val description = text(root, "description", problems::add, required = false)?.also { validateDescription(it, problems::add) }
        val entry = text(root, "entry", problems::add, required = true)?.also { validateEntry(it, problems::add) }
        val minHost = text(root, "minHostVersion", problems::add, required = true)?.also { validateMinHost(it, problems::add) }
        val blockTypes = validateBlockTypes(root.path("blockTypes"), id, problems)
        val capabilities = validateCapabilities(root.path("capabilities"), problems)
        if (problems.found.isNotEmpty()) return ManifestResult.Invalid(problems.found)
        return ManifestResult.Valid(
            Manifest(
                id = checkNotNull(id),
                name = checkNotNull(name),
                version = checkNotNull(version),
                description = description,
                entry = checkNotNull(entry),
                minHostVersion = checkNotNull(minHost),
                blockTypes = blockTypes,
                capabilities = capabilities,
            ),
        )
    }

    private fun text(node: JsonNode, field: String, problem: (String, String, String) -> Unit, required: Boolean): String? {
        val value = node.path(field)
        return when {
            value.isMissingNode -> null.also { if (required) problem(field, "NotNull", "is required") }
            value.isString -> value.stringValue()
            else -> null.also { problem(field, "Type", "must be a string") }
        }
    }

    private fun validateId(id: String, problem: (String, String, String) -> Unit) {
        when {
            id.length < MIN_ID || id.length > MAX_ID -> problem("id", "Size", "size must be between $MIN_ID and $MAX_ID")
            !ID.matches(id) -> problem("id", "Pattern", "must be reverse-DNS-like, lower case, at least two segments (org.example.timer)")
            id.substringBefore('.') in RESERVED_NAMESPACES -> problem("id", "Reserved", "the namespaces core and drawboard are reserved")
        }
    }

    private fun validateName(name: String, problem: (String, String, String) -> Unit) {
        if (name.isEmpty() || name.length > MAX_NAME) problem("name", "Size", "size must be between 1 and $MAX_NAME")
    }

    private fun validateVersion(version: String, problem: (String, String, String) -> Unit) {
        if (SemVer.parseOrNull(version) == null) problem("version", "Pattern", "must be a Semantic Version 2.0.0 (at most 64 characters)")
    }

    private fun validateDescription(description: String, problem: (String, String, String) -> Unit) {
        if (description.length > MAX_DESCRIPTION) problem("description", "Size", "size must be at most $MAX_DESCRIPTION")
    }

    private fun validateEntry(entry: String, problem: (String, String, String) -> Unit) {
        if (entry.length > MAX_ENTRY || !ENTRY.matches(entry)) {
            problem("entry", "Pattern", "must be a relative path to an ES module (.js or .mjs) of at most $MAX_ENTRY characters")
        }
    }

    private fun validateMinHost(minHost: String, problem: (String, String, String) -> Unit) {
        val required = SemVer.parseOrNull(minHost)
        val implemented = checkNotNull(SemVer.parseOrNull(PluginsModule.PLUGIN_API_VERSION))
        when {
            required == null -> problem("minHostVersion", "Pattern", "must be a Semantic Version 2.0.0")
            required > implemented -> problem(
                "minHostVersion",
                "Unsupported",
                "this instance implements plugin API ${PluginsModule.PLUGIN_API_VERSION}, the plugin needs $minHost",
            )
        }
    }

    private fun validateBlockTypes(node: JsonNode, id: String?, problems: Problems): List<BlockTypeDef> {
        if (node.isMissingNode) return emptyList()
        if (!node.isArray) return emptyList<BlockTypeDef>().also { problems.add("blockTypes", "Type", "must be an array") }
        if (node.size() > MAX_BLOCK_TYPES) problems.add("blockTypes", "Size", "size must be at most $MAX_BLOCK_TYPES")
        val seen = HashSet<String>()
        return node.values().mapIndexedNotNull { index, item ->
            validateBlockType(item, id, seen, NestedProblems(problems, "blockTypes[$index]"))
        }
    }

    /** One block type: the manifest's `type` must lie in the namespace of the plugin id and be used once. */
    private fun validateBlockType(item: JsonNode, id: String?, seen: MutableSet<String>, p: NestedProblems): BlockTypeDef? {
        if (!item.isObject) return null.also { p.add("", "Type", "must be an object") }
        item.propertyNames().filter { it !in BLOCK_FIELDS }.forEach { p.add(it, "AdditionalProperties", "is not a field of a block type") }
        val type = text(item, "type", { f, c, m -> p.add(f, c, m) }, required = true)
        if (type != null) validateTypeName(type, id, seen, p)
        val label = text(item, "label", { f, c, m -> p.add(f, c, m) }, required = true)
        if (label != null && (label.isEmpty() || label.length > MAX_NAME)) p.add("label", "Size", "size must be between 1 and $MAX_NAME")
        val width = size(item, "defaultWidth", p)
        val height = size(item, "defaultHeight", p)
        val complete = listOf(type, label, width, height).none { it == null }
        return if (complete) BlockTypeDef(checkNotNull(type), checkNotNull(label), checkNotNull(width), checkNotNull(height)) else null
    }

    private fun validateTypeName(type: String, id: String?, seen: MutableSet<String>, p: NestedProblems) {
        when {
            type.length > MAX_BLOCK_TYPE || !ID.matches(type) -> p.add("type", "Pattern", "must be <plugin id>.<name>, lower case")
            id != null && !type.startsWith("$id.") -> p.add("type", "Namespace", "must start with the plugin id '$id' and a dot")
            !seen.add(type) -> p.add("type", "Unique", "is used twice")
        }
    }

    private fun size(item: JsonNode, field: String, p: NestedProblems): Int? {
        val value = item.path(field)
        val fits = value.isIntegralNumber && value.canConvertToInt() && value.intValue() in MIN_SIZE..MAX_SIZE
        return when {
            value.isMissingNode -> null.also { p.add(field, "NotNull", "is required") }
            !fits -> null.also { p.add(field, "Range", "must be an integer between $MIN_SIZE and $MAX_SIZE") }
            else -> value.intValue()
        }
    }

    private fun validateCapabilities(node: JsonNode, problems: Problems): List<Capability> {
        if (node.isMissingNode) return emptyList()
        if (!node.isArray) return emptyList<Capability>().also { problems.add("capabilities", "Type", "must be an array") }
        if (node.size() > MAX_CAPABILITIES) problems.add("capabilities", "Size", "size must be at most $MAX_CAPABILITIES")
        val seen = HashSet<Capability>()
        return node.values().mapIndexedNotNull { index, item ->
            validateCapability(item, seen, NestedProblems(problems, "capabilities[$index]"))
        }
    }

    private fun validateCapability(item: JsonNode, seen: MutableSet<Capability>, p: NestedProblems): Capability? {
        if (!item.isObject) return null.also { p.add("", "Type", "must be an object") }
        val unknown = item.propertyNames().filter { it !in CAPABILITY_FIELDS }
        unknown.forEach { p.add(it, "AdditionalProperties", "is not a field of a capability") }
        val name = text(item, "name", { f, c, m -> p.add(f, c, m) }, required = true)
        val api = PluginsModule.PLUGIN_API_VERSION
        if (name != null && name !in CAPABILITIES) p.add("name", "Enum", "is not a capability of plugin API $api")
        val value = text(item, "value", { f, c, m -> p.add(f, c, m) }, required = false)
        if (name == null || name !in CAPABILITIES) return null
        val normalized = normalizeValue(name, value, p)
        if (normalized == INVALID_VALUE) return null
        val capability = Capability(name, normalized)
        return capability.takeIf { seen.add(it) } ?: null.also { p.add("", "Unique", "${capability.label} is declared twice") }
    }

    private fun valueRequired(name: String) = name == "import.register" || name == "network"

    /**
     * The value of a capability in its normal form; null when it has none (and needs none); [INVALID_VALUE] after reporting
     * that it is missing, superfluous or malformed.
     */
    private fun normalizeValue(name: String, value: String?, p: NestedProblems): String? = when {
        !valueRequired(name) -> null.also { if (value != null) p.add("value", "Unexpected", "$name takes no value") }
        value == null || value.isEmpty() || value.length > MAX_VALUE ->
            invalid(p, "Size", "$name needs a value of 1 to $MAX_VALUE characters")
        name == "import.register" -> normalizeMediaType(value, p)
        else -> when (val hosts = NetworkHosts.parse(value)) {
            is NetworkHosts.Result.Valid -> hosts.hosts.joinToString(" ")
            is NetworkHosts.Result.Invalid -> invalid(p, "Hosts", hosts.reason)
        }
    }

    private fun normalizeMediaType(value: String, p: NestedProblems): String =
        if (value.length > MAX_MEDIA_TYPE || !MEDIA_TYPE.matches(value)) {
            invalid(p, "Pattern", "must be one media type (type/subtype, at most $MAX_MEDIA_TYPE characters)")
        } else {
            value
        }

    private fun invalid(p: NestedProblems, constraint: String, message: String): String {
        p.add("value", constraint, message)
        return INVALID_VALUE
    }

    /** Never a legal value (it has a control character): marks "reported, drop this capability". */
    private const val INVALID_VALUE = "\u0000invalid"
}
