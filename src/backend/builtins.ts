/**
 * Register every built-in backend with the registry.
 *
 * Each backend's `factory.ts` calls `registerBackend` as a side effect of
 * being imported, so "loading" is importing. One list, used by the
 * daemon's bootstrap, by `talon doctor` (which runs standalone and needs
 * the factories' doctor checks), and by tests that exercise the registry.
 * Adding a backend is adding a line here.
 */
export async function loadBuiltinBackends(): Promise<void> {
  await import("./claude-sdk/factory.js");
  await import("./opencode/factory.js");
  await import("./kilo/factory.js");
  await import("./codex/factory.js");
  await import("./openai-agents/factory.js");
}
