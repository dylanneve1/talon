/**
 * `talon chat` — terminal chat mode. Boots a terminal-only frontend wired to
 * a fresh gateway/backend, regardless of the configured frontend.
 */

export async function startChat(): Promise<void> {
  process.env.TALON_QUIET = "1";

  const { bootstrap, initBackendAndDispatcher } =
    await import("../bootstrap.js");
  const { flushDatabase } = await import("../storage/db.js");
  const { createTerminalFrontend } =
    await import("../frontend/terminal/index.js");
  const { Gateway } = await import("../core/engine/gateway.js");

  const { config } = await bootstrap({ frontendNames: ["terminal"] });

  // Override frontend for the backend — talon chat always uses terminal,
  // regardless of what the config file says. This prevents the backend from
  // spawning telegram-tools or teams-tools MCP servers and ensures the
  // system prompt loads terminal.md instead of teams.md/telegram.md.
  (config as Record<string, unknown>).frontend = "terminal";
  const { rebuildSystemPrompt } = await import("../util/config.js");
  const { getPluginPromptAdditions } = await import("../core/plugin/index.js");
  rebuildSystemPrompt(config, getPluginPromptAdditions());

  const gateway = new Gateway("chat");
  const frontend = createTerminalFrontend(config, gateway);
  await frontend.init();
  const { backend } = await initBackendAndDispatcher(config, frontend);
  gateway.backend = backend;

  // Mirror the index.ts wiring: keep the gateway's cached backend
  // reference in sync with chat-role rebinds.
  const { onBackendChange, roleHolder } =
    await import("../core/engine/backend-controller/index.js");
  const CHAT_ROLE_HOLDER = roleHolder("chat");
  onBackendChange((holder, newBackend) => {
    if (holder !== CHAT_ROLE_HOLDER) return;
    gateway.backend = newBackend;
  });

  process.on("SIGINT", () => {
    flushDatabase();
    frontend.stop();
    process.exit(0);
  });
  await frontend.start();
}
