// Real-time collaboration: tickets, rooms (sessions of an open board), the update log and snapshots. Relays Yjs
// updates as opaque bytes; the WebSocket itself lives in api. Knows only :shared (and reaches the board access
// rules of library through the port BoardAccess, which api implements).
plugins {
    id("dergeorg.domain-module")
}

dependencies {
    implementation(libs.bucket4j.core)
    implementation(libs.micrometer.core) // the metrics of the sessions and the storage
    implementation(libs.jackson.databind) // the sender JSON of awareness frames and the WELCOME message
}
