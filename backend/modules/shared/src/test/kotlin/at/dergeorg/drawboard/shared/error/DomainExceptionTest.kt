package at.dergeorg.drawboard.shared.error

import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class DomainExceptionTest {

    @Nested
    inner class Message {

        @Test
        fun `when params match the placeholders then the message contains their values`() {
            val exception = DomainException(ErrorCode.LIBRARY_BOARD_NOT_FOUND, mapOf("boardId" to "0192f5e0"))

            assertEquals("Board 0192f5e0 not found.", exception.message, "the {boardId} placeholder is replaced by the param")
        }

        @Test
        fun `when no params are given then the default message is used unchanged`() {
            val exception = DomainException(ErrorCode.UNAUTHORIZED)

            assertEquals(ErrorCode.UNAUTHORIZED.defaultMessage, exception.message, "message of a code without placeholders")
        }
    }

    @Nested
    inner class ValidationFailed {

        @Test
        fun `when created with invalid fields then the code is VALIDATION_FAILED`() {
            val exception = ValidationFailedException(listOf(InvalidField("title", "NotBlank", "must not be blank")))

            assertEquals(ErrorCode.VALIDATION_FAILED, exception.errorCode, "error code of a domain validation failure")
        }

        @Test
        fun `when created without invalid fields then it is rejected`() {
            assertFailsWith<IllegalArgumentException>("a validation failure must name at least one field") {
                ValidationFailedException(emptyList())
            }
        }
    }
}
