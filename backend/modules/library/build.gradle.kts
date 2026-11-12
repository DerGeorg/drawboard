plugins {
    id("dergeorg.domain-module")
}

dependencies {
    implementation(libs.micrometer.core) // the gauge drawboard.boards and the share metrics
    implementation(libs.spring.security.crypto) // Argon2PasswordEncoder for link passwords (S1.11)
    implementation(libs.bouncycastle.bcprov) // ...which needs BouncyCastle
}
