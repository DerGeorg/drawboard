package at.dergeorg.drawboard.planning.domain.sessions

import at.dergeorg.drawboard.planning.domain.sessions.model.EstimationMode
import at.dergeorg.drawboard.planning.domain.sessions.model.ItemRef
import at.dergeorg.drawboard.planning.domain.sessions.model.ItemRefKind
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionSettings
import at.dergeorg.drawboard.planning.domain.sessions.provides.NewItemSpec
import at.dergeorg.drawboard.shared.error.InvalidField
import at.dergeorg.drawboard.shared.error.ValidationFailedException
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlin.uuid.Uuid

class SessionRulesTest {

    @Nested
    inner class Texts {

        @Test
        fun `when a title has blanks around it, also no-break spaces, then they are trimmed`() {
            assertEquals("Sprint 42", SessionRules.line("  Sprint 42  ", "title", SessionRules.TITLE_MAX), "trimmed Unicode-aware")
        }

        @Test
        fun `when a text is decomposed then it is stored in NFC`() {
            assertEquals("é", SessionRules.line("é", "title", SessionRules.TITLE_MAX), "NFC")
        }

        @ParameterizedTest
        @ValueSource(strings = ["a\u0000b", "a\nb", "trailing\n", "a​b", "a‮b", "a b", "a b", " ", "x\u0085"])
        fun `when a text holds a control or format character or a line or paragraph separator then 400 VALIDATION_FAILED`(text: String) {
            val failure = assertFailsWith<ValidationFailedException>("refused") {
                SessionRules.line(text, "reason", SessionRules.REASON_MAX)
            }

            assertEquals(listOf("reason" to "Pattern"), failure.invalidFields.map { it.field to it.constraint }, "one violation")
        }

        @ParameterizedTest
        @ValueSource(strings = ["", "   ", " 　"])
        fun `when a text is blank, Unicode-aware, then 400 NotBlank`(text: String) {
            val failure = assertFailsWith<ValidationFailedException>("blank") { SessionRules.line(text, "title", SessionRules.TITLE_MAX) }

            assertEquals("NotBlank", failure.invalidFields.single().constraint, "constraint")
        }

        @Test
        fun `when a reason has 280 characters then it is taken, with 281 it is refused`() {
            assertEquals(280, SessionRules.line("x".repeat(280), "reason", SessionRules.REASON_MAX).length, "at the limit")
            assertFailsWith<ValidationFailedException>("one more") { SessionRules.line("x".repeat(281), "reason", SessionRules.REASON_MAX) }
        }

        @Test
        fun `when a very long text with many blanks is checked then it is quick - the rules are linear (C1)`() {
            val started = System.nanoTime()

            assertFailsWith<ValidationFailedException>("too long") { SessionRules.line("x" + " ".repeat(250_000) + "x", "title", 200) }

            assertTrue(System.nanoTime() - started < 2_000_000_000L, "well under two seconds")
        }
    }

    @Nested
    inner class Settings {

        @Test
        fun `when a magic session names its times then the mark threshold defaults to 3 and nothing of rotation is set`() {
            val violations = mutableListOf<InvalidField>()

            val settings = SessionRules.settings(
                EstimationMode.MAGIC,
                SessionSettings(placingSeconds = 30, movingSeconds = 1800),
                violations,
            )

            assertEquals(emptyList(), violations, "valid")
            assertEquals(SessionSettings(placingSeconds = 30, movingSeconds = 1800, markThreshold = 3), settings, "defaults filled in")
        }

        @Test
        fun `when a rotation session leaves advanceWhenDone out then it is true`() {
            val violations = mutableListOf<InvalidField>()

            val settings = SessionRules.settings(EstimationMode.ROTATION, SessionSettings(rounds = 10, roundSeconds = 900), violations)

            assertEquals(SessionSettings(rounds = 10, roundSeconds = 900, advanceWhenDone = true), settings, "default true")
        }

        @Test
        fun `when fields are missing, out of range or of the other mode then every one is a violation of its own`() {
            val violations = mutableListOf<InvalidField>()

            SessionRules.settings(EstimationMode.MAGIC, SessionSettings(movingSeconds = 1801, markThreshold = 2, rounds = 3), violations)

            assertEquals(
                setOf("settings.placingSeconds", "settings.movingSeconds", "settings.markThreshold", "settings.rounds"),
                violations.map { it.field }.toSet(),
                "missing placing, moving too long, mark below 3 (one seat could mark alone), rounds forbidden",
            )
        }

        @Test
        fun `when rotation gets magic fields or 11 rounds then they are violations`() {
            val violations = mutableListOf<InvalidField>()

            SessionRules.settings(EstimationMode.ROTATION, SessionSettings(rounds = 11, roundSeconds = 29, placingSeconds = 60), violations)

            assertEquals(
                setOf("settings.rounds", "settings.roundSeconds", "settings.placingSeconds"),
                violations.map { it.field }.toSet(),
                "rounds 1-10, 30-900 s, no magic field",
            )
        }
    }

    @Nested
    inner class Items {

        private val block = Uuid.random().toString()
        private val card = Uuid.random().toString()

        @Test
        fun `when cards are valid then they come back with their titles cleaned`() {
            val violations = mutableListOf<InvalidField>()

            val items = SessionRules.items(
                listOf(
                    NewItemSpec(ItemRef(ItemRefKind.STORY, block, null), " Login "),
                    NewItemSpec(ItemRef(ItemRefKind.KANBAN_CARD, block, card), "Card"),
                ),
                violations,
            )

            assertEquals(emptyList(), violations, "valid")
            assertEquals(listOf("Login", "Card"), items.map { it.title }, "trimmed")
        }

        @Test
        fun `when a ref is used twice, a story has a card id or a kanban card has none then each is a violation`() {
            val violations = mutableListOf<InvalidField>()

            SessionRules.items(
                listOf(
                    NewItemSpec(ItemRef(ItemRefKind.STORY, block, null), "A"),
                    NewItemSpec(ItemRef(ItemRefKind.STORY, block, null), "B"),
                    NewItemSpec(ItemRef(ItemRefKind.STORY, block, card), "C"),
                    NewItemSpec(ItemRef(ItemRefKind.KANBAN_CARD, block, null), "D"),
                    NewItemSpec(ItemRef(ItemRefKind.STORY, "NOT-A-UUID", null), "E"),
                ),
                violations,
            )

            assertEquals(
                listOf("items[1].ref", "items[2].ref.cardId", "items[3].ref.cardId", "items[4].ref.blockId"),
                violations.map { it.field },
                "duplicate, card id on a story, no card id on a kanban card, a block id of the wrong form",
            )
        }

        @Test
        fun `when there are no cards or 51 then the list is refused`() {
            val none = mutableListOf<InvalidField>()
            val many = mutableListOf<InvalidField>()

            SessionRules.items(emptyList(), none)
            SessionRules.items(List(51) { NewItemSpec(ItemRef(ItemRefKind.STORY, Uuid.random().toString(), null), "S") }, many)

            assertEquals(listOf("items"), none.map { it.field }, "at least one")
            assertEquals(listOf("items"), many.map { it.field }, "at most 50")
        }

        @Test
        fun `when the same block is a story and holds a kanban card then the two refs differ`() {
            assertTrue(
                SessionRules.key(ItemRef(ItemRefKind.STORY, block, null)) !=
                    SessionRules.key(ItemRef(ItemRefKind.KANBAN_CARD, block, card)),
                "different keys",
            )
        }
    }
}
