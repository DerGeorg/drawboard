package at.dergeorg.drawboard.shared.error

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import at.dergeorg.drawboard.contract.model.ErrorCode as ContractErrorCode

class ErrorCodeContractTest {

    @Test
    fun `when comparing with the contract then both list exactly the same error codes`() {
        val contractCodes = ContractErrorCode.entries.map { it.value }

        assertEquals(
            contractCodes.toSet(),
            ErrorCode.entries.map { it.name }.toSet(),
            "shared ErrorCode must mirror ErrorCode of the API contract 1:1 - add or remove codes in the " +
                "API repository first (common/common.yaml), then here",
        )
    }

    @Test
    fun `when looking at domain codes then each is prefixed with module and subdomain`() {
        val platformCodes = setOf(
            ErrorCode.VALIDATION_FAILED, ErrorCode.MALFORMED_REQUEST, ErrorCode.UNAUTHORIZED, ErrorCode.FORBIDDEN,
            ErrorCode.NOT_FOUND, ErrorCode.METHOD_NOT_ALLOWED, ErrorCode.NOT_ACCEPTABLE, ErrorCode.CONFLICT,
            ErrorCode.UNSUPPORTED_MEDIA_TYPE, ErrorCode.INTERNAL_ERROR, ErrorCode.BAD_GATEWAY,
            ErrorCode.GATEWAY_TIMEOUT, ErrorCode.PAYLOAD_TOO_LARGE, ErrorCode.TOO_MANY_REQUESTS,
        )

        val badlyNamed = ErrorCode.entries.filterNot { it in platformCodes }.map { it.name }
            .filterNot { it.matches(Regex("[A-Z]+_[A-Z]+_[A-Z_]+")) }

        assertEquals(emptyList(), badlyNamed, "domain codes follow <MODULE>_<SUBDOMAIN>_<PROBLEM>")
    }

    @Test
    fun `when looking at the proxy codes then they carry the gateway statuses`() {
        assertEquals(
            listOf(502, 504),
            listOf(ErrorCode.BAD_GATEWAY.status, ErrorCode.GATEWAY_TIMEOUT.status),
            "BAD_GATEWAY is 502 and GATEWAY_TIMEOUT is 504, as documented in the contract",
        )
    }
}
