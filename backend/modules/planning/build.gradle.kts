plugins {
    id("dergeorg.domain-module")
}

dependencies {
    implementation(libs.spring.tx) // the transactions of the rounds
    implementation(libs.micrometer.core) // planning metrics
}
