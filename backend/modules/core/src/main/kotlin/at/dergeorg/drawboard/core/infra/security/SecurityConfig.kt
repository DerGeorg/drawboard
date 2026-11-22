package at.dergeorg.drawboard.core.infra.security

import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.security.autoconfigure.actuate.web.reactive.EndpointRequest
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.http.HttpMethod.DELETE
import org.springframework.http.HttpMethod.GET
import org.springframework.http.HttpMethod.POST
import org.springframework.http.HttpMethod.PUT
import org.springframework.security.authentication.AnonymousAuthenticationToken
import org.springframework.security.authorization.AuthorizationDecision
import org.springframework.security.authorization.AuthorizationResult
import org.springframework.security.authorization.ReactiveAuthorizationManager
import org.springframework.security.authentication.ReactiveAuthenticationManagerResolver
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken
import org.springframework.security.config.annotation.web.reactive.EnableWebFluxSecurity
import org.springframework.security.config.web.server.ServerHttpSecurity
import org.springframework.security.config.web.server.invoke
import org.springframework.security.web.server.SecurityWebFilterChain
import org.springframework.security.web.server.ServerAuthenticationEntryPoint
import org.springframework.security.web.server.authorization.ServerAccessDeniedHandler
import org.springframework.security.web.server.authorization.AuthorizationContext
import org.springframework.web.server.ServerWebExchange
import org.springframework.security.web.server.context.NoOpServerSecurityContextRepository
import org.springframework.security.web.server.util.matcher.ServerWebExchangeMatchers.pathMatchers

/**
 * THE route table: which route is reachable - the ONLY place where access is decided (no @PreAuthorize, no method
 * security). Resource server for the access tokens of one OpenID Connect provider (issuer, audience and keys from
 * [OidcProperties]).
 *
 * Every operation of the contract needs a signed-in user, and nothing more (except the link exchange, open to
 * anonymous visitors, and the WebSocket, authenticated by its ticket, see below): what a user may do with a board comes
 * from the sharing rules of the library module, not from roles in the token (any provider can be bound, and not
 * every one has roles). GUESTS (S1.8) have an allowlist: only the routes marked `signedInOrGuest` (read a board or the
 * boards of a shared folder, collab ticket, plus the guest-only refresh); every other line is `signedIn` and
 * answers a guest 403, and what is not listed at all is `denyAll` as before. One line per operation (operationId as comment). First
  * match wins, most specific first, and
 * the last rule denies everything that is not listed - a new route is unreachable until it is added here (fail
 * closed). RouteTableIntegrationTest checks every operation of the contract: signed in (not 401/403) and anonymous (401).
 */
@Configuration(proxyBeanMethods = false)
@EnableWebFluxSecurity
internal class SecurityConfig {

    @Bean
    fun securityWebFilterChain(
        http: ServerHttpSecurity,
        // implemented in api (ErrorModel bodies for 401/403) - wired by interface, core does not know the class
        authenticationEntryPoint: ServerAuthenticationEntryPoint,
        accessDeniedHandler: ServerAccessDeniedHandler,
        // the OIDC provider and, with guests switched on, the application itself (IssuerConfiguration)
        issuers: ReactiveAuthenticationManagerResolver<ServerWebExchange>,
        @Value("\${springdoc.swagger-ui.enabled:false}") swaggerUiEnabled: Boolean,
        oidc: OidcProperties,
    ): SecurityWebFilterChain = http {
        val admin = instanceAdmin(oidc)
        authorizeExchange {
            // --- operations: health and info, served on the management port only ---
            authorize(EndpointRequest.to("health", "info"), permitAll)
            // --- API documentation: only where Swagger UI is switched on (profile dev), it logs in itself ---
            if (swaggerUiEnabled) authorize(API_DOCUMENTATION, permitAll)
            // --- users ---
            authorize(pathMatchers(GET, "/api/users/me"), signedIn) // getCurrentUser
            authorize(pathMatchers(PUT, "/api/users/me/preferences"), signedIn) // updateUserPreferences
            authorize(pathMatchers(GET, "/api/users/search"), signedIn) // searchUsers
            // --- boards (listed before the one-segment patterns: "shared" must not be read as a board id) ---
            authorize(pathMatchers(GET, "/api/boards/shared"), signedIn) // listSharedWithMe
            authorize(pathMatchers(GET, "/api/boards"), signedInOrGuest) // listBoards
            authorize(pathMatchers(POST, "/api/boards"), signedIn) // createBoard
            authorize(pathMatchers(GET, "/api/boards/*"), signedInOrGuest) // getBoard
            authorize(pathMatchers(PUT, "/api/boards/*"), signedIn) // updateBoard
            authorize(pathMatchers(DELETE, "/api/boards/*"), signedIn) // deleteBoard
            authorize(pathMatchers(PUT, "/api/boards/*/folder"), signedIn) // moveBoard
            authorize(pathMatchers(GET, "/api/templates"), signedIn) // listTemplates
            authorize(pathMatchers(GET, "/api/trash"), signedIn) // listTrash
            authorize(pathMatchers(POST, "/api/trash/boards/*/restore"), signedIn) // restoreBoard
            authorize(pathMatchers(DELETE, "/api/trash/boards/*"), signedIn) // purgeBoard
            // --- folders ---
            authorize(pathMatchers(GET, "/api/folders"), signedIn) // listFolders
            authorize(pathMatchers(POST, "/api/folders"), signedIn) // createFolder
            authorize(pathMatchers(GET, "/api/folders/*"), signedIn) // getFolder
            authorize(pathMatchers(PUT, "/api/folders/*"), signedIn) // updateFolder
            authorize(pathMatchers(DELETE, "/api/folders/*"), signedIn) // deleteFolder
            authorize(pathMatchers(POST, "/api/trash/folders/*/restore"), signedIn) // restoreFolder
            authorize(pathMatchers(DELETE, "/api/trash/folders/*"), signedIn) // purgeFolder
            // --- sharing: members ---
            authorize(pathMatchers(GET, "/api/boards/*/members"), signedIn) // listBoardMembers
            authorize(pathMatchers(PUT, "/api/boards/*/members/users/*"), signedIn) // setBoardUserMember
            authorize(pathMatchers(DELETE, "/api/boards/*/members/users/*"), signedIn) // removeBoardUserMember
            authorize(pathMatchers(PUT, "/api/boards/*/members/groups/*"), signedIn) // setBoardGroupMember
            authorize(pathMatchers(DELETE, "/api/boards/*/members/groups/*"), signedIn) // removeBoardGroupMember
            authorize(pathMatchers(GET, "/api/folders/*/members"), signedIn) // listFolderMembers
            authorize(pathMatchers(PUT, "/api/folders/*/members/users/*"), signedIn) // setFolderUserMember
            authorize(pathMatchers(DELETE, "/api/folders/*/members/users/*"), signedIn) // removeFolderUserMember
            authorize(pathMatchers(PUT, "/api/folders/*/members/groups/*"), signedIn) // setFolderGroupMember
            authorize(pathMatchers(DELETE, "/api/folders/*/members/groups/*"), signedIn) // removeFolderGroupMember
            // --- sharing: links ---
            authorize(pathMatchers(GET, "/api/boards/*/links"), signedIn) // listBoardShareLinks
            authorize(pathMatchers(POST, "/api/boards/*/links"), signedIn) // createBoardShareLink
            authorize(pathMatchers(GET, "/api/folders/*/links"), signedIn) // listFolderShareLinks
            authorize(pathMatchers(POST, "/api/folders/*/links"), signedIn) // createFolderShareLink
            authorize(pathMatchers(DELETE, "/api/links/*"), signedIn) // revokeShareLink
            // Anonymous callers may exchange a link (S1): without a token the service answers 401 itself where a login is needed.
            authorize(pathMatchers(POST, "/api/shares/exchange"), notGuest) // exchangeShareToken
            authorize(pathMatchers(POST, "/api/shares/refresh"), guestOnly) // refreshGuestSession
            // --- collab ---
            authorize(pathMatchers(POST, "/api/boards/*/collab-ticket"), signedInOrGuest) // createCollabTicket
            authorize(pathMatchers(PUT, "/api/boards/*/snapshot"), signedIn) // uploadBoardSnapshot
            authorize(pathMatchers(GET, "/api/boards/*/versions"), signedIn) // listBoardVersions
            authorize(pathMatchers(POST, "/api/boards/*/versions/*/restore"), signedIn) // restoreBoardVersion
            // The WebSocket (not an OpenAPI operation): a browser cannot send an Authorization header on it. The
            // one-time ticket in the subprotocol header authenticates the handshake - redeemed, checked against the
            // Origin and the user's role BEFORE the upgrade (api, CollabHandshake). Without a valid ticket: 400/401/403.
            authorize(pathMatchers(GET, "/api/boards/*/collab"), permitAll)
            // --- files (S4): metadata and signed URLs; guests may read (S1.8, M3 review), never upload or delete ---
            authorize(pathMatchers(GET, "/api/boards/*/files"), signedInOrGuest) // listFiles
            authorize(pathMatchers(POST, "/api/boards/*/files"), signedIn) // uploadFile
            authorize(pathMatchers(GET, "/api/boards/*/files/urls"), signedInOrGuest) // getFileUrls
            authorize(pathMatchers(GET, "/api/boards/*/files/*"), signedInOrGuest) // getFile
            authorize(pathMatchers(DELETE, "/api/boards/*/files/*"), signedIn) // deleteFile
            // The bytes (not an /api route): no token is read, the signature in the query authorises (S4.4) - the only route
            // besides the WebSocket that is open without one. GET only: any other method falls through to denyAll.
            authorize(pathMatchers(GET, "/files/*"), permitAll) // downloadFile
            // --- plugins (S3): management is for instance admins only (S6.6, decided HERE by the groups claim of the current
            // token, not only in the service); the list a board host loads and the storage are open to guests (read) ---
            authorize(pathMatchers(GET, "/api/admin/plugins"), admin) // listPlugins
            authorize(pathMatchers(POST, "/api/admin/plugins"), admin) // installPlugin
            authorize(pathMatchers(GET, "/api/admin/plugins/*"), admin) // getPlugin
            authorize(pathMatchers(PUT, "/api/admin/plugins/*"), admin) // updatePlugin
            authorize(pathMatchers(DELETE, "/api/admin/plugins/*"), admin) // removePlugin
            authorize(pathMatchers(GET, "/api/plugins"), signedInOrGuest) // listEnabledPlugins
            authorize(pathMatchers(GET, "/api/boards/*/plugin-storage/*"), signedInOrGuest) // getPluginStorage
            authorize(pathMatchers(PUT, "/api/boards/*/plugin-storage/*"), signedIn) // putPluginStorage
            // The assets of installed plugins (S3.5): static, public (a bundle holds no secrets), GET only. The server resolves
            // the path against the stored entry list - there is nothing to traverse.
            authorize(pathMatchers(GET, "/plugin-assets/**"), permitAll)
            // --- planning (S7.6, M4 review): guests with a COMMENTER or EDITOR link may list (OPEN only), read and vote; the service
            // turns VIEWER-link guests away (403). Start, reveal and cancel are for signed-in editors and owners ---
            authorize(pathMatchers(GET, "/api/boards/*/poker-rounds"), signedInOrGuest) // listPokerRounds
            authorize(pathMatchers(POST, "/api/boards/*/poker-rounds"), signedIn) // createPokerRound
            authorize(pathMatchers(GET, "/api/boards/*/poker-rounds/*"), signedInOrGuest) // getPokerRound
            authorize(pathMatchers(PUT, "/api/boards/*/poker-rounds/*/vote"), signedInOrGuest) // castPokerVote
            authorize(pathMatchers(POST, "/api/boards/*/poker-rounds/*/reveal"), signedIn) // revealPokerRound
            authorize(pathMatchers(POST, "/api/boards/*/poker-rounds/*/cancel"), signedIn) // cancelPokerRound
            // --- planning, estimation sessions (3.15, E8): guests with a COMMENTER or EDITOR link may list (ACTIVE only), read, join,
            // leave, place and estimate; the service turns VIEWER-link guests away (403) and applies E9. Create and every moderator
            // operation (start, advance, decide, finish, cancel) are for signed-in editors and owners, never for guests ---
            authorize(pathMatchers(GET, "/api/boards/*/estimation-sessions"), signedInOrGuest) // listEstimationSessions
            authorize(pathMatchers(POST, "/api/boards/*/estimation-sessions"), signedIn) // createEstimationSession
            authorize(pathMatchers(GET, "/api/boards/*/estimation-sessions/*"), signedInOrGuest) // getEstimationSession
            authorize(pathMatchers(PUT, "/api/boards/*/estimation-sessions/*/seats/me"), signedInOrGuest) // joinEstimationSession
            authorize(pathMatchers(DELETE, "/api/boards/*/estimation-sessions/*/seats/me"), signedInOrGuest) // leaveEstimationSession
            authorize(pathMatchers(POST, "/api/boards/*/estimation-sessions/*/start"), signedIn) // startEstimationSession
            authorize(pathMatchers(POST, "/api/boards/*/estimation-sessions/*/advance"), signedIn) // advanceEstimationSession
            authorize(pathMatchers(POST, "/api/boards/*/estimation-sessions/*/finish"), signedIn) // finishEstimationSession
            authorize(pathMatchers(POST, "/api/boards/*/estimation-sessions/*/cancel"), signedIn) // cancelEstimationSession
            authorize(pathMatchers(PUT, "/api/boards/*/estimation-sessions/*/items/*/placement"), signedInOrGuest) // placeEstimationItem
            authorize(pathMatchers(PUT, "/api/boards/*/estimation-sessions/*/items/*/estimate"), signedInOrGuest) // setRotationEstimate
            authorize(pathMatchers(PUT, "/api/boards/*/estimation-sessions/*/items/*/decision"), signedIn) // decideEstimationItem
            // --- gifs (3.14, G5): signed-in users only; a guest is 403 even with an EDITOR link (S1.8 unchanged) ---
            authorize(pathMatchers(POST, "/api/gifs/search"), signedIn) // searchGifs
            authorize(pathMatchers(GET, "/api/gifs/trending"), signedIn) // listTrendingGifs
            // --- fail closed: everything not listed above ---
            authorize(anyExchange, denyAll)
        }
        oauth2ResourceServer {
            authenticationManagerResolver = issuers
            this.authenticationEntryPoint = authenticationEntryPoint // broken or expired token
            this.accessDeniedHandler = accessDeniedHandler
        }
        exceptionHandling {
            this.authenticationEntryPoint = authenticationEntryPoint // no token at all
            this.accessDeniedHandler = accessDeniedHandler // signed in, but the route is not listed (denyAll)
        }
        // A pure bearer API: browsers never attach the token by themselves (no cookie session), so a forged
        // cross-site request carries no credentials - CSRF protection would protect nothing. Stateless on purpose.
        // X-Frame-Options: DENY is Spring Security's default for every response. A plugin frame (/plugin-assets/.../frame.html)
        // MUST be embeddable by the app - its CSP `frame-ancestors` says by whom, and that is stricter and more precise than
        // XFO - so the default is off here and FrameOptionsWebFilter sets DENY on everything else.
        headers { frameOptions { disable() } }
        csrf { disable() }
        // No CORS for /api: the frontend calls it same-origin through its proxy. Never `Access-Control-Allow-Origin: *`.
        cors { disable() }
        securityContextRepository = NoOpServerSecurityContextRepository.getInstance()
        httpBasic { disable() }
        formLogin { disable() }
        logout { disable() }
    }

    private companion object {
        /** Whether a token's groups claim holds the admin group - the same rule as `CurrentUser.admin`, decided per request. */
        fun instanceAdmin(oidc: OidcProperties) = ReactiveAuthorizationManager<AuthorizationContext> { authentication, _ ->
            val mapper = JwtCurrentUserMapper(oidc)
            authentication.map<AuthorizationResult> {
                AuthorizationDecision(it is JwtAuthenticationToken && it.isAuthenticated && mapper.map(it.token)?.admin == true)
            }.defaultIfEmpty(AuthorizationDecision(false))
        }

        /** A signed-in user of the OIDC provider. NOT a guest (S1.8: the allowlist below says which routes guests have). */
        val signedIn = ReactiveAuthorizationManager<AuthorizationContext> { authentication, _ ->
            authentication.map<AuthorizationResult> { AuthorizationDecision(it.isAuthenticated && it !is AnonymousAuthenticationToken &&
                it !is GuestAuthenticationToken) }
                .defaultIfEmpty(AuthorizationDecision(false))
        }

        /** The routes guests may also call (S1.8): a signed-in user or a guest, but not an anonymous caller. */
        val signedInOrGuest = ReactiveAuthorizationManager<AuthorizationContext> { authentication, _ ->
            authentication.map<AuthorizationResult> { AuthorizationDecision(it.isAuthenticated && it !is AnonymousAuthenticationToken) }
                .defaultIfEmpty(AuthorizationDecision(false))
        }

        /** Anonymous callers and signed-in users - but not a guest (a guest opening another link drops its token first). */
        val notGuest = ReactiveAuthorizationManager<AuthorizationContext> { authentication, _ ->
            authentication.map<AuthorizationResult> { AuthorizationDecision(it !is GuestAuthenticationToken) }
                .defaultIfEmpty(AuthorizationDecision(true))
        }

        /** Guest sessions only. */
        val guestOnly = ReactiveAuthorizationManager<AuthorizationContext> { authentication, _ ->
            authentication.map<AuthorizationResult> { AuthorizationDecision(it is GuestAuthenticationToken) }
                .defaultIfEmpty(AuthorizationDecision(false))
        }

        val API_DOCUMENTATION = pathMatchers("/swagger-ui.html", "/swagger-ui/**", "/webjars/**", "/v3/api-docs/**", "/openapi/**")
    }
}
