package at.dergeorg.drawboard.shared.error

/**
 * Application-wide error codes. Mirrors `ErrorCode` in the API contract (common/common.yaml) 1:1 -
 * `ErrorCodeContractTest` fails as soon as the two drift apart.
 *
 * Naming: platform codes have no prefix; domain codes are `<MODULE>_<SUBDOMAIN>_<PROBLEM>`. A published code is
 * never renamed or removed. A module only throws codes with its own prefix (or platform codes).
 *
 * [status] is the plain HTTP status number, so `shared` stays free of Spring Web. [defaultMessage] is English,
 * for developers and logs; `{name}` placeholders are filled from [DomainException.params]. The UI localises via
 * the code and the params, never by parsing the message.
 */
enum class ErrorCode(val status: Int, val defaultMessage: String) {
    // --- platform: the same in every application ---
    VALIDATION_FAILED(400, "The request contains invalid fields."),
    MALFORMED_REQUEST(400, "The request body or a parameter could not be read."),
    UNAUTHORIZED(401, "A valid access token is required."),
    FORBIDDEN(403, "You may not do this."),
    NOT_FOUND(404, "No such route."),
    METHOD_NOT_ALLOWED(405, "The HTTP method is not supported on this route."),
    NOT_ACCEPTABLE(406, "None of the media types in the Accept header can be produced."),
    CONFLICT(409, "The resource was modified concurrently - read it again and retry."),
    UNSUPPORTED_MEDIA_TYPE(415, "The content type is not supported."),
    INTERNAL_ERROR(500, "An unexpected error occurred."),
    PAYLOAD_TOO_LARGE(413, "The request body is larger than {limit} bytes."),
    TOO_MANY_REQUESTS(429, "Too many requests - retry after {retryAfterSeconds} seconds."),

    // Written by the proxy in front of the backend (the frontend's nginx/Node server forwarding /api, a gateway)
    // when the backend is unreachable or too slow. The backend itself never answers with them; they are here
    // because the enum mirrors the contract 1:1.
    BAD_GATEWAY(502, "The backend could not be reached."),
    GATEWAY_TIMEOUT(504, "The backend did not answer in time."),

    // --- module library, subdomain boards ---
    // Also answered when the user may not see the board, so its existence is not revealed.
    LIBRARY_BOARD_NOT_FOUND(404, "Board {boardId} not found."),
    LIBRARY_BOARD_ACCESS_DENIED(403, "Your role on board {boardId} does not allow this; required: {required}."),

    // --- module library, subdomains folders and sharing ---
    // Also answered when the user may not see the folder, so its existence is not revealed.
    LIBRARY_FOLDER_NOT_FOUND(404, "Folder {folderId} not found."),
    LIBRARY_FOLDER_CYCLE(409, "Folder {folderId} cannot be moved into itself or into a folder below it."),
    LIBRARY_USER_NOT_FOUND(404, "No such user: nobody with this id has signed in."),
    // The same answer for an unknown, a revoked and an expired link (S1.12): it must not tell which one it is.
    LIBRARY_SHARE_NOT_FOUND(404, "This link does not work."),
    LIBRARY_SHARE_LOGIN_REQUIRED(401, "Sign in to open this link."),
    LIBRARY_SHARE_PASSWORD_REQUIRED(403, "This link needs a password."),
    LIBRARY_SHARE_PASSWORD_INVALID(403, "The password is wrong."),

    // --- module collab ---
    COLLAB_SNAPSHOT_NOT_REQUESTED(409, "No open snapshot request for you on board {boardId} up to sequence {upToSeq}."),
    COLLAB_VERSION_NOT_FOUND(404, "Version {versionId} of board {boardId} not found."),

    // --- module files ---
    // A file of another board is "not found" too: a board's files are only visible through that board.
    FILES_FILE_NOT_FOUND(404, "File {fileId} not found."),
    FILES_TYPE_NOT_ALLOWED(415, "This kind of file is not allowed."),
    FILES_QUOTA_EXCEEDED(413, "The upload would exceed the storage quota of the {scope} ({limit} bytes)."),
    // The same body for every reason (wrong signature, expired, retired key): it must not tell which one it is (S4.4).
    FILES_URL_INVALID(403, "This file link is not valid."),
    FILES_RANGE_NOT_SATISFIABLE(416, "The requested byte range cannot be served."),

    // --- module plugins ---
    PLUGINS_PLUGIN_NOT_FOUND(404, "Plugin {pluginId} not found."),
    PLUGINS_ARCHIVE_INVALID(400, "The plugin archive is not acceptable: {reason}."),
    PLUGINS_MANIFEST_INVALID(400, "The plugin manifest is invalid."),
    PLUGINS_VERSION_EXISTS(409, "Plugin {pluginId} is installed in version {installedVersion}; upload a higher version."),
    PLUGINS_CAPABILITY_NOT_REQUESTED(400, "The installed version of the plugin does not request the capability {capability}."),

    // --- module planning ---
    // A round of another board is "not found" too, and so is a closed round to a guest who did not take part in it.
    PLANNING_ROUND_NOT_FOUND(404, "Round {roundId} not found."),
    PLANNING_ROUND_ALREADY_OPEN(409, "Story card {storyBlockId} already has an open round: {roundId}."),
    PLANNING_ROUND_LIMIT_REACHED(409, "The board already has {limit} open rounds."),
    PLANNING_ROUND_CLOSED(409, "Round {roundId} is {state}."),
    PLANNING_ROUND_FULL(409, "Round {roundId} is full: at most {limit} participants of this kind."),
    // The value of the vote is never echoed, not here and not in a log: it is the caller's secret until the reveal.
    PLANNING_VALUE_INVALID(400, "The vote is not a card of the deck of round {roundId}."),
}
