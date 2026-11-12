plugins {
    `kotlin-dsl`
}

dependencies {
    // The plugins as libraries: the precompiled script plugins in src/main/kotlin apply them by id,
    // without a version, and every module gets exactly these versions (gradle/libs.versions.toml).
    implementation(libs.spring.boot.gradle.plugin)
    implementation(libs.kotlin.gradle.plugin)
    implementation(libs.kotlin.allopen) // provides org.jetbrains.kotlin.plugin.spring

    // Makes the generated, type-safe catalog accessors usable inside the convention plugins:
    // `val libs = the<LibrariesForLibs>()`, then libs.mockk instead of "io.mockk:mockk" (gradle/gradle#15383).
    implementation(files(libs.javaClass.superclass.protectionDomain.codeSource.location))
}
