package at.dergeorg.drawboard.auditing.common.samples.valid

import at.dergeorg.drawboard.shared.auditing.AuditDetails
import at.dergeorg.drawboard.shared.auditing.DomainEventDetails
import kotlin.time.Duration

@AuditDetails(type = "sample.stock-adjusted")
data class StockAdjusted(val delta: Int, val reason: String, val comment: String? = null) : DomainEventDetails

@AuditDetails(type = "sample.task-completed")
data class TaskCompleted(val openFor: Duration) : DomainEventDetails
