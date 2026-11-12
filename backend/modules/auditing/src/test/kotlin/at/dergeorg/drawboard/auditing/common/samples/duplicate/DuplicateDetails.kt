package at.dergeorg.drawboard.auditing.common.samples.duplicate

import at.dergeorg.drawboard.shared.auditing.AuditDetails
import at.dergeorg.drawboard.shared.auditing.DomainEventDetails

@AuditDetails(type = "sample.same-name")
data class First(val value: Int) : DomainEventDetails

@AuditDetails(type = "sample.same-name")
data class Second(val value: Int) : DomainEventDetails
