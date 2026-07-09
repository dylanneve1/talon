# Companion device control (teleport) + Shizuku

The Talon companion answers remote **exec / filesystem** commands over the
mesh — the device half of `teleport`. Two privilege tiers:

## 1. App-UID (default, always available)

Shell commands run via `sh -c` as the app's own Linux user; file IO uses
`dart:io`. Reachable surface:

- The app's private storage — always.
- **Shared storage** (Downloads, DCIM, Documents, …) once the app holds
  **All files access** (`MANAGE_EXTERNAL_STORAGE`). Grant it manually:
  Settings → Apps → Talon → Permissions → *Allow management of all files*
  (the permission is declared in the manifest; there is no runtime dialog for
  it, it must be toggled in system settings). Not on the Play Store, so no
  policy justification is needed.
- **Not** other apps' private data or `/data` — that needs root or Shizuku.

This tier is enough for "clean up my Downloads folder", moving/reading/writing
files in shared storage, and running ordinary shell tools that ship with
Android (`ls`, `rm`, `mv`, `find`, `cat`, …).

Toggle in the app: **Settings → Mesh → Device control** (default ON). When
off, the device advertises no exec/fs capabilities and refuses those commands.

## 2. Shizuku (optional, elevated)

When the [Shizuku](https://shizuku.rikka.app/) app is installed and running
(started via wireless ADB or root), exec commands run at **shell (ADB) UID** —
far more of the system than the app UID, without rooting the device.

Wiring (already in this repo):

- `android/app/build.gradle.kts` — `dev.rikka.shizuku:api` + `:provider`.
- `AndroidManifest.xml` — the `rikka.shizuku.ShizukuProvider` and the
  `moe.shizuku.manager.permission.API_V23` permission.
- `ShizukuBridge.kt` — a `MethodChannel("talon/shizuku")` exposing
  `isReady` / `requestPermission` / `exec`. Exec uses the (stable, hidden)
  `Shizuku.newProcess` via reflection.
- Dart `DeviceExec` prefers Shizuku when `isReady()` and **falls back to
  app-UID on any failure**, so the app works with or without Shizuku.

To enable at runtime: install Shizuku, start its service, then let Talon
request permission (first elevated command triggers the grant dialog).

### Build note

The Dart layer + tests are verified locally (`flutter analyze` + `flutter
test`, all green). The **Android/Kotlin/Gradle build (Shizuku deps + native
bridge) is device-pending** — it needs a real `flutter build apk` on a machine
with the Android SDK to confirm the Shizuku artifacts resolve and the reflective
`newProcess` call links against the installed Shizuku version. If the Shizuku
deps ever fail to resolve, the app still builds and runs on the app-UID tier;
remove the two `dev.rikka.shizuku` lines + the manifest provider to drop
Shizuku entirely.
