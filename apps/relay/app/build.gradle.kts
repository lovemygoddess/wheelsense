plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "io.github.lovemygoddess.wheelsense.relay"
  compileSdk = 35

  defaultConfig {
    applicationId = "io.github.lovemygoddess.wheelsense.relay"
    // The dedicated relay targets Android 8 (API 26) and newer.
    // The remote-control process APIs already require 26, so declare reality.
    minSdk = 26
    targetSdk = 35
    versionCode = 43
    versionName = "1.1.41"
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      // Replace this with your own release key before distributing builds.
      signingConfig = signingConfigs.getByName("debug")
    }
  }
  compileOptions {
    isCoreLibraryDesugaringEnabled = true
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  buildFeatures { buildConfig = true }
  kotlinOptions { jvmTarget = "17" }
}

dependencies {
  coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.0.4")
  implementation("androidx.core:core-ktx:1.15.0")
  implementation("androidx.appcompat:appcompat:1.7.0")
  testImplementation("junit:junit:4.13.2")
}
