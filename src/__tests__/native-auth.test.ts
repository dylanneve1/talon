import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  bridgeTokenPath,
  loadOrCreateBridgeToken,
} from "../frontend/native/auth.js";

const POSIX = process.platform !== "win32";

describe("bridge auth token", () => {
  async function freshDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "talon-auth-"));
  }

  it("mints a url-safe high-entropy token and keeps it stable", async () => {
    const dir = await freshDir();
    const first = loadOrCreateBridgeToken(dir);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url
    expect(loadOrCreateBridgeToken(dir)).toBe(first); // persisted, not re-rolled
    const onDisk = await readFile(bridgeTokenPath(dir), "utf-8");
    expect(onDisk.trim()).toBe(first);
  });

  it("mints distinct tokens per identity dir", async () => {
    const [a, b] = [await freshDir(), await freshDir()];
    expect(loadOrCreateBridgeToken(a)).not.toBe(loadOrCreateBridgeToken(b));
  });

  it.skipIf(!POSIX)("persists owner-only", async () => {
    const dir = await freshDir();
    loadOrCreateBridgeToken(dir);
    expect((await stat(bridgeTokenPath(dir))).mode & 0o777).toBe(0o600);
  });

  it("honours an operator-seeded token file", async () => {
    const dir = await freshDir();
    await writeFile(bridgeTokenPath(dir), "operator-chosen-secret\n");
    expect(loadOrCreateBridgeToken(dir)).toBe("operator-chosen-secret");
  });

  it("re-mints over an empty token file", async () => {
    const dir = await freshDir();
    await writeFile(bridgeTokenPath(dir), "\n");
    expect(loadOrCreateBridgeToken(dir)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
