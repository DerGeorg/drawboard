package at.dergeorg.drawboard.library.domain.sharing.model

import at.dergeorg.drawboard.shared.auditing.AuditDetails
import at.dergeorg.drawboard.shared.auditing.DomainEventDetails

/**
 * A grant on a board or folder was set or removed (S7.1 "ACL change"): [principalKind] USER/GROUP, [principal] the
 * user id or group name, [role] the new role or null when the grant was removed.
 */
@AuditDetails(type = "library.acl-changed")
data class AclChanged(val principalKind: String, val principal: String, val role: String?) : DomainEventDetails
