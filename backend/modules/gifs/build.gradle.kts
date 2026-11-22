plugins {
    id("dergeorg.domain-module")
}

dependencies {
    implementation(libs.spring.boot.starter.webflux) // WebClient: the GIPHY adapter
    implementation(libs.jackson.databind) // the GIPHY answer is read as a tree and mapped by hand (Boot 4 = Jackson 3)
    implementation(libs.micrometer.core) // drawboard.gifs.requests
}
