plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "org.talon.companion"
    // Pinned to 36 (not flutter.compileSdkVersion, currently 34) because
    // file_picker's transitive flutter_plugin_android_lifecycle requires
    // compiling against API 36+. compileSdk only governs which APIs are
    // available at compile time; minSdk/targetSdk are unchanged.
    compileSdk = 36
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "org.talon.companion"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // Stable release signing so an APK from one release installs OVER the
    // previous one. CI decodes the ANDROID_KEYSTORE_BASE64 secret and points
    // these env vars at it; without them (local dev, forks without the
    // secret) the build falls back to debug signing, where every machine's
    // throwaway key makes upgrades require an uninstall.
    val releaseKeystore = System.getenv("TALON_ANDROID_KEYSTORE_FILE")
        ?.let { file(it) }
        ?.takeIf { it.exists() }
    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = releaseKeystore
                storeType = "PKCS12"
                storePassword = System.getenv("TALON_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("TALON_ANDROID_KEY_ALIAS") ?: "talon"
                keyPassword = System.getenv("TALON_ANDROID_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = if (releaseKeystore != null) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
            // AGP 9 shrinks release builds with R8. Shizuku's `newProcess` is
            // reached only via reflection (a runtime string), which R8 can't
            // see — so it strips/renames the method and elevated exec fails
            // with NoSuchMethodException, silently downgrading to app UID.
            // proguard-rules.pro keeps the Shizuku surface so that path works.
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

dependencies {
    // Shizuku (optional elevated privilege for the mesh exec channel). The
    // client binds to the Shizuku app when it's installed and running; absent
    // that, the Dart layer falls back to app-UID execution, so these deps are
    // safe to ship unconditionally. See docs/companion-shizuku.md.
    implementation("dev.rikka.shizuku:api:13.1.5")
    implementation("dev.rikka.shizuku:provider:13.1.5")
}

flutter {
    source = "../.."
}
