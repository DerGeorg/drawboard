package at.dergeorg.drawboard.auditing.common.samples.badname

import at.dergeorg.drawboard.shared.auditing.AuditDetails
import at.dergeorg.drawboard.shared.auditing.DomainEventDetails

@AuditDetails(type = "NoModulePrefix")
data class BadName(val value: Int) : DomainEventDetails
