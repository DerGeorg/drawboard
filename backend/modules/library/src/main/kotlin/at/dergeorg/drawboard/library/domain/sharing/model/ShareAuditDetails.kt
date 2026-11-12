package at.dergeorg.drawboard.library.domain.sharing.model

import at.dergeorg.drawboard.shared.auditing.AuditDetails
import at.dergeorg.drawboard.shared.auditing.DomainEventDetails

// Typed details of the share events (S7.1). They never contain a token or a password - not even a hash.

/** A link was created; [passwordSet] says whether it asks for a password (S7.1 "password set"). */
@AuditDetails(type = "library.share-created")
data class ShareCreated(
    val resourceKind: String,
    val resourceId: String,
    val role: String,
    val audience: String,
    val expiresAt: String?,
    val passwordSet: Boolean,
) : DomainEventDetails

/** A link was revoked. */
@AuditDetails(type = "library.share-revoked")
data class ShareRevoked(val resourceKind: String, val resourceId: String) : DomainEventDetails

/** A link was opened (S7.1 "exchange success"): [ip] of the caller, [guest] true when a guest session started. */
@AuditDetails(type = "library.share-exchanged")
data class ShareExchanged(val ip: String, val guest: Boolean, val role: String) : DomainEventDetails

/** An exchange failed (S7.1 "exchange failure"): [reason] is the [ExchangeFailure], [shareId] null for an unknown token. */
@AuditDetails(type = "library.share-exchange-failed")
data class ShareExchangeFailed(val reason: String, val ip: String, val shareId: String?) : DomainEventDetails
