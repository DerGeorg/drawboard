package at.dergeorg.drawboard.library.domain.folders.model

import at.dergeorg.drawboard.shared.auditing.AuditDetails
import at.dergeorg.drawboard.shared.auditing.DomainEventDetails

// Typed details of the folder events (rules as for the board events).

/** The name exactly as submitted - the stored one is trimmed. */
@AuditDetails(type = "library.folder-created")
data class FolderCreated(val submittedName: String) : DomainEventDetails

/** The name as submitted, the new parent and the version the change was based on. */
@AuditDetails(type = "library.folder-updated")
data class FolderUpdated(val submittedName: String, val parentId: String?, val basedOnVersion: Long) : DomainEventDetails

/** [boards] and [folders] moved to the trash together with it (the folder itself not counted). */
@AuditDetails(type = "library.folder-deleted")
data class FolderDeleted(val folders: Int, val boards: Int) : DomainEventDetails

/** A folder left the trash with [folders] and [boards] below it. */
@AuditDetails(type = "library.folder-restored")
data class FolderRestored(val folders: Int, val boards: Int, val restoredToRoot: Boolean) : DomainEventDetails

/** A folder was purged for good with [folders] and [boards] below it. */
@AuditDetails(type = "library.folder-purged")
data class FolderPurged(val folders: Int, val boards: Int, val automatic: Boolean) : DomainEventDetails
