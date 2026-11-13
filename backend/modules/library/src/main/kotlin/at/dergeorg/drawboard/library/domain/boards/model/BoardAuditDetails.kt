package at.dergeorg.drawboard.library.domain.boards.model

import at.dergeorg.drawboard.shared.auditing.AuditDetails
import at.dergeorg.drawboard.shared.auditing.DomainEventDetails
import kotlin.time.Duration

// Typed details of the board events. They add what the field-level changes cannot show.
// Rules: the logical name never changes; a new field needs a default; a change of meaning gets a new name (.v2).

/** The title exactly as submitted - the stored one is trimmed. */
@AuditDetails(type = "library.board-created")
data class BoardCreated(val submittedTitle: String) : DomainEventDetails

/** The title exactly as submitted and the version the change was based on. */
@AuditDetails(type = "library.board-renamed")
data class BoardRenamed(val submittedTitle: String, val basedOnVersion: Long) : DomainEventDetails

/** The board became a template or stopped being one ([template] = the new state), based on [basedOnVersion]. */
@AuditDetails(type = "library.board-template-changed")
data class BoardTemplateChanged(val template: Boolean, val basedOnVersion: Long) : DomainEventDetails

/** How long the board existed. */
@AuditDetails(type = "library.board-deleted")
data class BoardDeleted(val age: Duration) : DomainEventDetails

/** The board moved to another folder ([folderId] null = the root) based on [basedOnVersion]. */
@AuditDetails(type = "library.board-moved")
data class BoardMoved(val folderId: String?, val basedOnVersion: Long) : DomainEventDetails

/** A board left the trash ([restoredToRoot]: its folder was gone or in the trash) or was purged for good. */
@AuditDetails(type = "library.board-restored")
data class BoardRestored(val restoredToRoot: Boolean) : DomainEventDetails

/** How long the board had been in the trash when it was purged, and whether the cleanup job did it. */
@AuditDetails(type = "library.board-purged")
data class BoardPurged(val automatic: Boolean) : DomainEventDetails
