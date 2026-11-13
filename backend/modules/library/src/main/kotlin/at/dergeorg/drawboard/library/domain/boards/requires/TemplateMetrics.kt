package at.dergeorg.drawboard.library.domain.boards.requires

/** Port for the template metrics (no personal data in any label). Implemented in infra with Micrometer. */
internal interface TemplateMetrics {

    /** A listTemplates call was refused because the user used up the rate limit. Counted, never audited. */
    fun listRefused()
}
