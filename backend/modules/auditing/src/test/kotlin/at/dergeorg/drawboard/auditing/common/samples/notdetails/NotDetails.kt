package at.dergeorg.drawboard.auditing.common.samples.notdetails

import at.dergeorg.drawboard.shared.auditing.AuditDetails

@AuditDetails(type = "sample.not-details")
data class NotDetails(val value: Int)
