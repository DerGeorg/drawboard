plugins {
    id("dergeorg.domain-module")
}

dependencies {
    implementation(libs.micrometer.core) // the gauge drawboard.users.active
}
