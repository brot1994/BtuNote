plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val runNumber = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 1

android {
    namespace = "id.bram.btunote"
    compileSdk = 35

    defaultConfig {
        applicationId = "id.bram.btunote"
        minSdk = 29
        targetSdk = 34
        versionCode = runNumber
        versionName = "0.1.$runNumber"
    }

    signingConfigs {
        create("release") {
            storeFile = rootProject.file("btunote.jks")
            storePassword = System.getenv("KEYSTORE_PASSWORD")
            keyAlias = "btunote"
            keyPassword = System.getenv("KEYSTORE_PASSWORD")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
}
