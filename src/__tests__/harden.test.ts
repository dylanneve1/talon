import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const POSIX = process.platform !== "win32";
const ORIGINAL_TALON_HOME = process.env.TALON_HOME;

// paths.ts resolves TALON_HOME at import time, so each test points the env
// at a fresh tree and re-imports the module graph.
async function importHardenFor(root: string) {
  process.env.TALON_HOME = root;
  vi.resetModules();
  return import("../util/harden.js");
}

afterEach(() => {
  if (ORIGINAL_TALON_HOME === undefined) delete process.env.TALON_HOME;
  else process.env.TALON_HOME = ORIGINAL_TALON_HOME;
  vi.resetModules();
});

describe("hardenTalonPermissions", () => {
  it.skipIf(!POSIX)(
    "clamps sensitive dirs to 0700 and files to 0600",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "talon-harden-"));
      await chmod(root, 0o755);
      await mkdir(join(root, "data"), { mode: 0o755 });
      await mkdir(join(root, "keys"), { mode: 0o755 });
      await writeFile(join(root, "config.json"), "{}\n", { mode: 0o644 });
      await writeFile(join(root, "talon.log"), "", { mode: 0o644 });
      await writeFile(join(root, ".user-session"), "session", {
        mode: 0o644,
      });
      await writeFile(join(root, "data", "talon.db"), "", { mode: 0o644 });

      const { hardenTalonPermissions } = await importHardenFor(root);
      hardenTalonPermissions();

      const mode = async (...parts: string[]) =>
        (await stat(join(root, ...parts))).mode & 0o777;
      expect(await mode()).toBe(0o700);
      expect(await mode("data")).toBe(0o700);
      expect(await mode("keys")).toBe(0o700);
      expect(await mode("config.json")).toBe(0o600);
      expect(await mode("talon.log")).toBe(0o600);
      expect(await mode(".user-session")).toBe(0o600);
      expect(await mode("data", "talon.db")).toBe(0o600);
    },
  );

  it("is a silent no-op when nothing exists yet", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "talon-harden-")), "ghost");
    const { hardenTalonPermissions } = await importHardenFor(root);
    expect(() => hardenTalonPermissions()).not.toThrow();
  });
});
