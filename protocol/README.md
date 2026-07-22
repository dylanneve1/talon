# Bridge Protocol conformance

The Talon Client Bridge Protocol has **one definition and three independent
implementations**:

| Implementation | Language | Role | Source |
| --- | --- | --- | --- |
| Daemon | TypeScript | serves the protocol | `src/frontend/native/protocol.ts` (types), `src/frontend/native/server.ts` (routes) |
| Companion app | Dart | GUI client + mesh device | `apps/companion/lib/src/models/bridge_models.dart`, `state/app_state.dart`, `services/mesh_service.dart` |
| talon-node | Go | headless mesh device | `apps/node/bridge.go`, `apps/node/commands.go` |

`src/frontend/native/protocol.ts` stays the **source of truth** for wire
types. This directory holds the shared **fixtures** — canonical wire samples
each implementation replays through its *real* parsing/serving/execution
paths in its own test suite. A shape drift on any side fails that side's CI
instead of shipping a silent misrender or a device command that times out.

## Fixtures

| File | Contents |
| --- | --- |
| `fixtures/protocol_v1.json` | Static REST shapes: message, chat, status, search result, log entry |
| `fixtures/events_v1.json` | The SSE stream: one sample per `BridgeEvent` kind (a coherent session, in order), plus forward-compat frames that clients must tolerate |
| `fixtures/mesh_v1.json` | The device mesh: registration bodies, device/location shapes, capability lists, one canonical `device_command` per command (with `dataKeys` = the result keys both device kinds must produce), and command-result shapes |

## Where each side asserts them

- **Daemon** — `src/__tests__/native-protocol-fixture.test.ts` and
  `src/__tests__/protocol-conformance.test.ts` (vitest, main CI). The events
  fixture is checked for exhaustiveness against the `BridgeEvent` union — a
  new event kind fails compile until a sample is added here. Registrations
  and locations run through the real `MeshRegistry` normalizers.
- **Companion** — `apps/companion/test/protocol_fixture_test.dart` and
  `apps/companion/test/protocol_conformance_test.dart` (flutter test,
  companion CI). The event session is streamed over a live SSE connection
  into `AppState`; mesh capability lists are asserted against
  `MeshService.capabilitiesFor`, and the exec/fs commands run through the
  real `DeviceExec` in a sandbox.
- **talon-node** — `apps/node/protocol_conformance_test.go` (go test, node
  CI). Capability parity with `nodeCapabilities`, SSE `device_command` frame
  decoding, registration body keys, and real `dispatch()` execution of every
  `run: true` command in a sandbox.

## Evolving the protocol

1. Change `src/frontend/native/protocol.ts` (bump
   `BRIDGE_PROTOCOL_VERSION` only on a breaking change — prefer additive).
2. Update the fixture(s) here with a canonical sample of the new shape.
3. Run all three suites; fix what fails. New `BridgeEvent` kinds and new
   device commands are *forced* through this step by the exhaustiveness
   checks; new optional fields should be added to the samples by hand.
4. Clients must keep tolerating unknown kinds/fields (`forwardCompat` in
   `events_v1.json` pins that behavior).

Changes under `protocol/` trigger all three CI suites (see path filters in
`.github/workflows/node.yml` and `companion.yml`; main CI always runs).
