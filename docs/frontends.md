# Frontend SDK — capability contract + registry

> Status: **implemented**. The contract and registry landed as a
> behavior-preserving refactor; every built-in frontend registers through
> it. Plugin-loaded frontends use the same API (see "External frontends"
> below for what still gates them).

## Why

Backends have had a real SDK shape for a while: one `Backend` capability
interface (`core/agent-runtime/capabilities.ts`) and a self-registration
registry (`core/agent-runtime/backend-registry.ts`) — adding a backend is
one `factory.ts`, no bootstrap churn.

Frontends had the interface (the `Frontend` type, formerly in
`bootstrap.ts`) but not the registry. Frontend *identity* was smeared
across four hand-maintained copies of the same if/else chain:

| Concern | Lived in |
| --- | --- |
| Creation switch | `app.ts` (`switch (name)` over dynamic imports) |
| Dispatch routing (chat id → live frontend) | `bootstrap.ts` `resolveFrontendName` |
| Gateway action routing | `core/engine/gateway.ts` `resolveOwnedFrontendName` |
| MCP tool scoping | `backend/shared/frontends.ts` `frontendForChatId` + literal `"terminal"` filters |

Adding a frontend meant touching all four, and they could silently drift.

## The model

`core/frontend-runtime/` is the frontend counterpart of
`core/agent-runtime`:

```
capabilities.ts   Frontend (runtime contract: init/start/stop, context,
                  sendMessage/sendTyping, getBridgePort) and
                  FrontendCreate ((config, gateway) → Frontend)
registry.ts       id → FrontendDescriptor map + chat-id resolution.
                  Self-contained: create functions are stored opaquely
                  so routing-only consumers never import engine types.
builtins.ts       The five built-in descriptors (identity only — no
                  frontend implementation is imported from core).
create.ts         The typed create seam: attachFrontendCreate,
                  registerFrontend (plugin path), createFrontendById.
routing.ts        Import surface for routing-only consumers (gateway,
                  backend MCP scoping) — guarantees builtins are
                  registered without pulling in the create seam.
index.ts          Everything, for composition roots and factories.
```

A **descriptor** is cheap, static identity:

```ts
{
  id: "discord",                    // matches config.frontend entries
  label: "Discord",                 // logs / status output
  ownsChatId: isDiscordChatId,      // chat-id shape convention
  routePriority: 40,                // lower checks first; broad matchers last
  messaging: true,                  // gets a per-frontend MCP tool server
  sharesStdin: false,               // start() blocks on stdin (terminal only)
}
```

The **create** half is attached separately by
`src/frontend/<id>/factory.ts`, which dynamically imports the
implementation — an unconfigured frontend costs nothing at boot:

```ts
attachFrontendCreate("discord", async (config, gateway) => {
  const { createDiscordFrontend } = await import("./index.js");
  return createDiscordFrontend(config, gateway);
});
```

`src/frontend/factories.ts` is the side-effect barrel the composition
roots import once.

The split exists for layering: `core/` never imports `frontend/`, so
descriptors register from core while create functions attach from the
frontend layer. Everything that only needs "whose chat id is this?"
works from descriptors alone.

## Routing semantics (preserved from the old chains)

- `resolveOwnerFrontendId(chatId)` — the messaging frontend owning a
  chat id by shape, else null (heartbeat sentinel, one-shots, terminal).
  This is the MCP-scoping flavour (`frontendForChatId`).
- `resolveOwnerFrontendId(chatId, { includeNonMessaging: true })` — full
  routing, terminal included (gateway flavour).
- `resolveFrontendIdAmong(chatId, candidates)` — pick the live frontend
  that serves a chat: single candidate wins; else the owner if
  live; else the first messaging candidate, else the first (bootstrap
  flavour).

Two historical tie-breaks are encoded in `routePriority`: telegram's
numeric matcher accepts almost anything so it runs last (90), and the
terminal claims the legacy chat id `"1"` ahead of telegram (10).

## Adding a built-in frontend

1. Implement `createMyFrontend(config, gateway): Frontend` under
   `src/frontend/my/`.
2. Register the descriptor in `core/frontend-runtime/builtins.ts` (id,
   label, chat-id matcher — add the predicate to `util/chat-id.ts`).
3. Drop a `factory.ts` beside the implementation and list it in
   `src/frontend/factories.ts`.
4. Add the id to the config `frontendEnum` in `util/config.ts`.

No changes to `app.ts`, `bootstrap.ts`, the gateway, or backend scoping.

## External frontends

`registerFrontend({ ...descriptor, create })` registers a complete
frontend at runtime — the intended path for plugin frontends (Slack,
Matrix, …). The registry, routing, creation, MCP tool scoping, and
gateway all handle unknown ids already (the registry tests pin this
with a synthetic `slack` frontend). What still gates a real frontend
plugin:

- the config schema's `frontendEnum` only admits built-in ids;
- the plugin loader has no lifecycle step that imports frontend modules
  before frontends are created;
- per-frontend prompt flavours (`prompts/system/<id>.md`) and the
  `FrontendScope` tool tags are still built-in-only vocabularies.

Those are deliberate follow-ups — the seam they plug into is now one
registry instead of four switch statements.
