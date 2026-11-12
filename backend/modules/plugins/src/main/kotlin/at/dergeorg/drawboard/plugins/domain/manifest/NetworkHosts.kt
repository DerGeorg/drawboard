package at.dergeorg.drawboard.plugins.domain.manifest

/**
 * The value of the `network` capability (S3.8): a space separated list of at most 10 host names, each `host` or
 * `host:port`. https only (so no scheme in the list), port 443 unless given, at least two labels, the last label not
 * `local`, `lan`, `internal`, `localhost`, `home` or `arpa`, no wildcards, no IP literals. They become the `connect-src`
 * of the plugin's frame as `https://host[:port]`, and the admin sees them before granting.
 */
internal object NetworkHosts {

    const val MAX_HOSTS = 10
    private val FORBIDDEN_TOP_LEVEL = setOf("local", "lan", "internal", "localhost", "home", "arpa")
    private val LABEL = Regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
    private const val MAX_HOST_LENGTH = 253
    private const val MAX_PORT = 65_535

    sealed interface Result {
        /** The hosts as `host` or `host:port`, lower case, in the order given. */
        data class Valid(val hosts: List<String>) : Result

        data class Invalid(val reason: String) : Result
    }

    fun parse(value: String): Result {
        val entries = value.trim().split(' ').filter { it.isNotEmpty() }
        val problem = when {
            entries.isEmpty() -> "must name at least one host"
            entries.size > MAX_HOSTS -> "names more than $MAX_HOSTS hosts"
            else -> entries.firstNotNullOfOrNull { entry -> problemWith(entry)?.let { "'${entry.take(MAX_SHOWN)}' $it" } }
        }
        return if (problem != null) Result.Invalid(problem) else Result.Valid(entries.map { it.lowercase() })
    }

    /** The CSP source expressions for the granted [hosts]: `https://host[:port]`. */
    fun connectSources(hosts: List<String>): List<String> = hosts.map { "https://$it" }

    private fun problemWith(entry: String): String? = syntaxProblem(entry) ?: portProblem(entry) ?: nameProblem(entry.substringBefore(':'))

    private fun syntaxProblem(entry: String): String? = when {
        "://" in entry || entry.any { it in URL_CHARACTERS } -> "must be a bare host name (https is implied)"
        '*' in entry -> "must not use wildcards"
        '[' in entry || entry.count { it == ':' } > 1 -> "must not be an IP literal"
        else -> null
    }

    private fun portProblem(entry: String): String? {
        if (':' !in entry) return null
        val port = entry.substringAfter(':')
        val valid = port.isNotEmpty() && port.length <= PORT_DIGITS && port.all { it in '0'..'9' } && port.toInt() in 1..MAX_PORT
        return if (valid) null else "has an invalid port"
    }

    private fun nameProblem(host: String): String? {
        val labels = host.lowercase().split('.')
        return when {
            host.length > MAX_HOST_LENGTH || labels.any { !LABEL.matches(it) } -> "is not a valid host name"
            labels.size < 2 -> "needs at least two labels"
            labels.last().all { it in '0'..'9' } -> "must not be an IP address"
            labels.last() in FORBIDDEN_TOP_LEVEL -> "ends in a name that is not public (${labels.last()})"
            else -> null
        }
    }

    private val URL_CHARACTERS = setOf('/', '?', '#', '@')
    private const val PORT_DIGITS = 5
    private const val MAX_SHOWN = 60
}
