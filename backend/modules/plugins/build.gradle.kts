plugins {
    id("dergeorg.domain-module")
}

dependencies {
    implementation(libs.spring.tx) // the transactions of the plugin registry
    implementation(libs.jackson.databind) // manifest and storage JSON (Boot 4 = Jackson 3)
    implementation(libs.jackson.module.kotlin)
}
