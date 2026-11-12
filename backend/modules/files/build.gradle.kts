plugins {
    id("dergeorg.domain-module")
}

dependencies {
    implementation(libs.spring.boot.starter.webflux) // WebClient: the Gotenberg adapter
    implementation(libs.spring.tx) // the transactions of the file catalog
    implementation(libs.tika.core) // Apache-2.0: magic-byte detection of uploads (S4.2), no parsers
    implementation(libs.micrometer.core) // conversion and upload metrics
}
