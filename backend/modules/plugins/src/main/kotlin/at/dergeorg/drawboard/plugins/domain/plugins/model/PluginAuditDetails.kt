package at.dergeorg.drawboard.plugins.domain.plugins.model

import at.dergeorg.drawboard.shared.auditing.AuditDetails
import at.dergeorg.drawboard.shared.auditing.DomainEventDetails

// Typed details of the plugin events (S7.1: installed, enabled, disabled, removed - with the hash). Who did it is added by auditing.
// Rules: the logical name never changes; a new field needs a default; a change of meaning gets a new name (.v2).

/** A plugin was installed ([previousVersion] null) or upgraded. [sha256] / [sha384] are hashes of the uploaded ZIP (the checksum to compare with the publisher's). */
@AuditDetails(type = "plugins.plugin-installed")
data class PluginInstalled(
    val version: String,
    val previousVersion: String?,
    val sha256: String,
    val sha384: String,
    val requestedCapabilities: List<String>,
    val keptGrants: List<String> = emptyList(),
) : DomainEventDetails

/** A plugin was enabled or disabled. */
@AuditDetails(type = "plugins.plugin-switched")
data class PluginSwitched(val version: String, val enabled: Boolean, val sha384: String) : DomainEventDetails

/** The capabilities granted to a plugin changed. */
@AuditDetails(type = "plugins.plugin-grants-changed")
data class PluginGrantsChanged(val version: String, val before: List<String>, val after: List<String>) : DomainEventDetails

/** A plugin was removed together with its files and its storage on every board. */
@AuditDetails(type = "plugins.plugin-removed")
data class PluginRemoved(val version: String, val sha384: String) : DomainEventDetails
