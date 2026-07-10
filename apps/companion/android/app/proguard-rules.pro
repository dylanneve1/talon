# Talon reaches Shizuku's hidden `newProcess` reflectively (see
# ShizukuBridge.kt). R8 — enabled by default for release builds under AGP 9 —
# doesn't account for reflective use, so without these rules it strips or
# renames the private `Shizuku.newProcess` method (and can rename the classes
# it returns/depends on). At runtime the reflection then throws
# NoSuchMethodException and every elevated exec silently downgrades to app UID
# — exactly the failure seen in `adb logcat -s TalonShizuku`.
#
# Keep the whole Shizuku client + AIDL surface intact (names preserved, not
# shrunk) so the reflective elevated-exec path survives minification.
-keep class rikka.shizuku.** { *; }
-keep interface rikka.shizuku.** { *; }
-keep class moe.shizuku.** { *; }
-keep interface moe.shizuku.** { *; }
-keep class dev.rikka.** { *; }
-dontwarn rikka.shizuku.**
-dontwarn moe.shizuku.**
-dontwarn dev.rikka.**
