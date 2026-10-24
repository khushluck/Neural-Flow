plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Signing is optional: CI passes these env vars when the keystore secrets exist.
val ksPath: String? = System.getenv("KEYSTORE_FILE")

android {
    namespace = "com.neuralsyntax.neuralflow"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.neuralsyntax.neuralflow"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    flavorDimensions += "edition"
    productFlavors {
        create("full") {   // dictation + AI cleanup
            dimension = "edition"
            buildConfigField("boolean", "CLEANUP", "true")
            resValue("string", "app_name", "Neural Flow")
        }
        create("lite") {   // dictation only
            dimension = "edition"
            applicationIdSuffix = ".lite"
            buildConfigField("boolean", "CLEANUP", "false")
            resValue("string", "app_name", "Neural Flow Lite")
        }
    }

    signingConfigs {
        if (ksPath != null && File(ksPath).exists()) {
            create("release") {
                storeFile = File(ksPath)
                storePassword = System.getenv("KEYSTORE_PASSWORD")
                keyAlias = System.getenv("KEY_ALIAS")
                keyPassword = System.getenv("KEY_PASSWORD") ?: System.getenv("KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") // null => unsigned (CI signs it)
        }
    }

    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}
