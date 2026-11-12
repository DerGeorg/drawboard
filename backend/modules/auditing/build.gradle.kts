plugins {
    id("dergeorg.domain-module")
}

dependencies {
    // Private copy of Boot's JsonMapper for the jsonb columns (details, changes)
    implementation(libs.spring.boot.starter.jackson)
    implementation(libs.jackson.module.kotlin)
    // io.r2dbc.postgresql.codec.Json <-> jsonb, used in requires/impl only
    implementation(libs.r2dbc.postgresql)
}
