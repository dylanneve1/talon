# Mesh v2 — native tools + teleport + exec/fs + Shizuku

Branch: `feat/native-tools-teleport`. One PR, all phases.

## What shipped

**Phase 0 — reliability (daemon):**
- Clock-skew fix: locate freshness judged by server-side receipt time, not the
  device-reported `loc.ts`.
- Atomic + serialized persistence (`core/mesh/persist.ts`): tmp+rename, per-path
  write queue. No more truncation-to-`[]` on crash / interleaved writes.
- Offline short-circuit: locate/commands don't wait out the timeout for a device
  past the presence window.
- Presence margin 90s → 180s.

**Phase 1 — history guardrail removed** (blessed; already implemented).

**Phase 2 — exec/filesystem command channel:**
- `MeshService`: `execOnDevice`, `readFileFromDevice`, `writeFileToDevice`,
  `listDirOnDevice`, `statOnDevice`, `pullFileFromDevice`, `pushFileToDevice`,
  shared `dispatchCommand`. Streamed transfers (one command round trip + one raw HTTP stream, disk-to-disk, no size cap); 1MB chunked base64 fallback for old app builds; per-command
  timeout override.
- Tools: `device_exec`, `device_list_dir`, `device_stat`, `device_read_file`,
  `device_write_file`, `device_pull_file`, `device_push_file`.

**Phase 3+4 — native tools + teleport:**
- Native MCP tools (`core/tools/native.ts`): `bash`, `read`, `write`, `edit`,
  `glob`, `search` (ripgrep) + `teleport` / `teleport_back`.
- `core/engine/gateway-actions/native.ts`: local execution (spawn/fs/rg) OR
  routing to the active teleport device via the mesh exec/fs channel. Teleported
  bash tracks cwd across calls (persistent shell-session feel).
- `core/mesh/teleport.ts`: active-node state sidecar.
- Config flag `nativeTools` (default **false** = safe merge). When on: drops the
  SDK built-in Read/Write/Edit/Bash/Glob/Grep/NotebookEdit + Agent from the
  whitelist; the hub surfaces the native set. Flip back to false = instant
  rollback.

**Phase 5 — companion (Flutter/Android):**
- `DeviceExec` (`lib/src/services/device_exec.dart`): answers exec/read_file/
  write_file/list_dir/stat/delete/mkdir/move at app-UID; prefers Shizuku when
  ready. Advertised as mesh capabilities.
- Settings toggle "Device control" (default on).
- Shizuku: gradle deps + `ShizukuBridge.kt` MethodChannel + manifest provider +
  MANAGE_EXTERNAL_STORAGE. `docs/companion-shizuku.md`.

## Files created
- `src/core/mesh/persist.ts`, `src/core/mesh/teleport.ts`
- `src/core/tools/native.ts`, `src/core/engine/gateway-actions/native.ts`
- `src/__tests__/native-tools.test.ts`
- `apps/companion/lib/src/services/device_exec.dart`
- `apps/companion/android/app/src/main/kotlin/org/talon/companion/ShizukuBridge.kt`
- `apps/companion/test/device_exec_test.dart`
- `docs/companion-shizuku.md`, `docs/mesh-improvement-audit-2026-07-09.md`,
  `docs/mesh-teleport-plan-2026-07-09.md`

## Files changed (key)
- `src/core/mesh/{service,registry,index}.ts`, `src/core/engine/gateway-actions/{mesh,index}.ts`
- `src/core/tools/{index,types,mesh}.ts`, `src/core/mcp-hub/{index,talon-server}.ts`
- `src/backend/claude-sdk/options.ts`, `src/util/config.ts`, `src/bootstrap.ts`
- `apps/companion/lib/src/services/{mesh_service,prefs}.dart`,
  `apps/companion/lib/src/state/app_state.dart`,
  `apps/companion/lib/src/ui/settings_screen.dart`
- `apps/companion/android/app/{build.gradle.kts, .../MainActivity.kt}`,
  `apps/companion/android/app/src/main/AndroidManifest.xml`

## Verification
- `npx tsc --noEmit` — clean.
- `npx vitest run` — green except two live-network backend bootstraps
  (`kilo-real-bootstrap`, `opencode-real-bootstrap`) that require live model
  APIs and fail in any offline sandbox. New/updated suites all pass:
  `mesh-service` (exec/fs, clock-skew, offline, concurrency), `native-tools`
  (gating, local shell/fs/search, teleport routing + cwd), `native-frontend`,
  `compose-tools`, `skill-actions`.
- `flutter analyze` (apps/companion) — No issues found.
- `flutter test` (apps/companion) — 73 passed (incl. new `device_exec_test`).

## Not verifiable here / device-pending
- Android **Gradle + Kotlin (Shizuku)** build — no Android SDK build in this
  environment; needs `flutter build apk` on a real toolchain. App-UID tier works
  regardless; Shizuku elevation needs on-device verification.
- End-to-end teleport onto the physical Pixel (install APK, grant All-files
  access, `teleport(Pixel 10)` → operate).

## Cutover
Set `nativeTools: true` in `~/.talon/config.json` and restart — do it while
watching, since it swaps the model's own shell/file tools. Flip back to `false`
for an instant rollback (no code revert needed).
