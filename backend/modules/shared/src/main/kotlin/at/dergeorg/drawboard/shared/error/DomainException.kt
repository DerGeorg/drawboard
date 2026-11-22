package at.dergeorg.drawboard.shared.error

/**
 * The only exception domain code throws on purpose. It carries an [ErrorCode] and named [params]; the REST layer
 * turns it into the contract's ErrorModel. The params end up in the response body - never put secrets or personal
 * data into them.
 */
open class DomainException(
    val errorCode: ErrorCode,
    val params: Map<String, String> = emptyMap(),
    cause: Throwable? = null,
) : RuntimeException(render(errorCode, params), cause) {

    private companion object {
        fun render(code: ErrorCode, params: Map<String, String>): String =
            params.entries.fold(code.defaultMessage) { message, (name, value) -> message.replace("{$name}", value) }
    }
}

/**
 * A domain exception that carries one violation per rejected field in the response (`violations` of the ErrorModel).
 * [ValidationFailedException] is the general case; a module may use its own code (`PLUGINS_MANIFEST_INVALID`).
 */
open class FieldViolationsException(errorCode: ErrorCode, val invalidFields: List<InvalidField>) : DomainException(errorCode) {
    init {
        require(invalidFields.isNotEmpty()) { "a violation needs at least one invalid field" }
    }
}

/**
 * A domain rule rejected input that passed the contract's validation (e.g. a title consisting of blanks only).
 * Rendered like a bean-validation failure: [ErrorCode.VALIDATION_FAILED] with one violation per [InvalidField].
 */
class ValidationFailedException(invalidFields: List<InvalidField>) : FieldViolationsException(ErrorCode.VALIDATION_FAILED, invalidFields)

/** One rejected input field. [constraint] uses the bean-validation names (NotBlank, Size, ...); the value is never echoed. */
data class InvalidField(val field: String, val constraint: String, val message: String)

/**
 * A rate limit of the caller is used up: [ErrorCode.TOO_MANY_REQUESTS]. The REST layer answers 429 with the header
 * `Retry-After: [retryAfterSeconds]`.
 */
class RateLimitedException(val retryAfterSeconds: Long) :
    DomainException(ErrorCode.TOO_MANY_REQUESTS, mapOf("retryAfterSeconds" to retryAfterSeconds.toString()))

/** A body or upload is larger than the operation accepts: [ErrorCode.PAYLOAD_TOO_LARGE] (413) with the limit in bytes. */
class PayloadTooLargeException(limitBytes: Long) :
    DomainException(ErrorCode.PAYLOAD_TOO_LARGE, mapOf("limit" to limitBytes.toString()))

/**
 * A domain exception the caller may retry after [retryAfterSeconds] (the `Retry-After` header of the answer): the hourly budget of
 * an instance for an upstream service is used up, or the upstream service is down. [RateLimitedException] is the same for the
 * limits of one caller, with its own code.
 */
class RetryAfterException(errorCode: ErrorCode, val retryAfterSeconds: Long) : DomainException(errorCode) {
    init {
        require(retryAfterSeconds >= 1) { "a retry needs a positive delay" }
    }
}
