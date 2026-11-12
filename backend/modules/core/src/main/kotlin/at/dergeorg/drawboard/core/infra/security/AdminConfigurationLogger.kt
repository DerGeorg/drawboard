package at.dergeorg.drawboard.core.infra.security

import at.dergeorg.drawboard.shared.logging.AppLogger
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.event.EventListener
import org.springframework.stereotype.Component

/** Logs once at startup who counts as admin and which provider is bound, so a misconfiguration is visible in the first log lines. */
@Component
internal class AdminConfigurationLogger(private val properties: OidcProperties, private val log: AppLogger) {

    @EventListener(ApplicationReadyEvent::class)
    fun logEffectiveConfiguration() {
        val adminGroup = properties.adminGroupOrNull
        log.info(
            if (adminGroup == null) "instance admin disabled: no admin group configured" else "instance admin group configured",
            "oidc.issuer" to properties.issuerUri,
            "oidc.audience" to properties.audience,
            "oidc.claim.groups" to properties.claimGroups,
            "oidc.admin_group" to adminGroup,
        )
    }
}
