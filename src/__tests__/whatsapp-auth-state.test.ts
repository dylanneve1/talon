/**
 * Atomic auth state — the drop-in for Baileys' useMultiFileAuthState.
 * The properties that matter: disk-format compatibility (same names,
 * same BufferJSON encoding), read-your-writes under concurrency, and a
 * drainable write queue (shutdown must not strand half a signal key).
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  useAtomicAuthState,
  flushAuthWrites,
} from "../frontend/whatsapp/auth-state.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wa-auth-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("useAtomicAuthState", () => {
  it("initializes fresh creds and persists them via saveCreds", async () => {
    const { state, saveCreds } = await useAtomicAuthState(dir);
    expect(state.creds.registered).toBe(false);
    await saveCreds();
    await flushAuthWrites();
    const onDisk = JSON.parse(readFileSync(join(dir, "creds.json"), "utf-8"));
    expect(onDisk.noiseKey).toBeDefined();
  });

  it("round-trips creds including Buffers across a reload", async () => {
    const first = await useAtomicAuthState(dir);
    await first.saveCreds();
    await flushAuthWrites();

    const second = await useAtomicAuthState(dir);
    // Same identity key material — Buffers revived, not stringified husks.
    expect(Buffer.isBuffer(second.state.creds.noiseKey.private)).toBe(true);
    expect(
      Buffer.from(second.state.creds.noiseKey.private).equals(
        Buffer.from(first.state.creds.noiseKey.private),
      ),
    ).toBe(true);
  });

  it("stores and retrieves signal keys with Baileys' file naming", async () => {
    const { state } = await useAtomicAuthState(dir);
    const key = Buffer.from("super-secret-session");
    await state.keys.set({
      session: { "1234:5@s.whatsapp.net": key },
    } as never);
    await flushAuthWrites();

    // ':' mangled to '-' exactly like upstream, so existing dirs load.
    expect(readdirSync(dir)).toContain("session-1234-5@s.whatsapp.net.json");

    const got = await state.keys.get("session" as never, [
      "1234:5@s.whatsapp.net",
    ]);
    expect(Buffer.isBuffer(got["1234:5@s.whatsapp.net"])).toBe(true);
  });

  it("deletes a key when set to null", async () => {
    const { state } = await useAtomicAuthState(dir);
    await state.keys.set({ session: { abc: Buffer.from("x") } } as never);
    await state.keys.set({ session: { abc: null } } as never);
    await flushAuthWrites();
    const got = await state.keys.get("session" as never, ["abc"]);
    expect(got.abc).toBeNull();
  });

  it("serializes rapid writes to one file — last write wins, file stays valid JSON", async () => {
    const { state } = await useAtomicAuthState(dir);
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        state.keys.set({ session: { hot: Buffer.from(`v${i}`) } } as never),
      ),
    );
    await flushAuthWrites();
    const raw = readFileSync(join(dir, "session-hot.json"), "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow(); // never torn
    const got = await state.keys.get("session" as never, ["hot"]);
    expect((got.hot as Buffer).toString()).toBe("v24");
  });
});
