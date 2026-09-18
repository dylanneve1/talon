/**
 * Streamed mesh transfers must be bounded by the size of what is moving,
 * not by a flat hour.
 *
 * A device that accepts a transfer command and then goes silent (a stalled
 * body stream on a mobile link — no bytes, no FIN) never answers. The
 * dispatch timeout is the only thing that ends that wait, and because turns
 * serialize per chat, the wait blocks every later message in that chat. An
 * 87 KB push inheriting an hour-long budget is what took a chat offline for
 * an hour in practice.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeviceFiles,
  streamTransferTimeoutMs,
  type DeviceFilesHost,
} from "../core/mesh/transfers/device-files.js";
import type { DeviceInfo } from "../core/mesh/types.js";

const HOUR_MS = 60 * 60 * 1000;

const device: DeviceInfo = {
  id: "phone",
  name: "Pixel 9",
  platform: "android",
  appVersion: "1.0.0",
  capabilities: ["download_file", "upload_file"],
} as DeviceInfo;

/** Records the timeout each dispatch is given; answers nothing useful. */
function recordingHost(): {
  host: DeviceFilesHost;
  timeouts: { name: string; timeoutMs?: number }[];
} {
  const timeouts: { name: string; timeoutMs?: number }[] = [];
  const host: DeviceFilesHost = {
    load: async () => {},
    resolveDevice: () => ({ target: device }),
    dispatchCommand: async (_query, name, _params, timeoutMs) => {
      timeouts.push({ name, timeoutMs });
      return {
        target: device,
        result: {
          commandId: "c1",
          deviceId: device.id,
          ok: true,
          data: { bytesWritten: 1 },
        },
      };
    },
    commandTimeoutMs: 30_000,
    resolveNode: (async () => {
      throw new Error("not used");
    }) as unknown as DeviceFilesHost["resolveNode"],
  };
  return { host, timeouts };
}

describe("streamTransferTimeoutMs", () => {
  it("gives a small transfer a budget in seconds, not an hour", () => {
    const small = streamTransferTimeoutMs(87 * 1024);
    expect(small).toBeLessThan(2 * 60 * 1000);
    expect(small).toBeLessThan(HOUR_MS);
    // Still generous enough that a device which is merely slow can answer.
    expect(small).toBeGreaterThanOrEqual(60_000);
  });

  it("scales with the payload", () => {
    const small = streamTransferTimeoutMs(1024);
    const medium = streamTransferTimeoutMs(16 * 1024 * 1024);
    const large = streamTransferTimeoutMs(256 * 1024 * 1024);
    expect(medium).toBeGreaterThan(small);
    expect(large).toBeGreaterThan(medium);
  });

  it("caps even an enormous payload, and never exceeds the old flat hour", () => {
    const enormous = streamTransferTimeoutMs(50 * 1024 * 1024 * 1024);
    expect(enormous).toBe(streamTransferTimeoutMs(Number.MAX_SAFE_INTEGER));
    expect(enormous).toBeLessThan(HOUR_MS);
  });

  it("falls back to the cap when the size is unknown", () => {
    expect(streamTransferTimeoutMs(undefined)).toBeLessThan(HOUR_MS);
    expect(streamTransferTimeoutMs(undefined)).toBeGreaterThan(
      streamTransferTimeoutMs(0),
    );
  });

  it("treats a nonsense size as unknown rather than as zero", () => {
    expect(streamTransferTimeoutMs(Number.NaN)).toBe(
      streamTransferTimeoutMs(undefined),
    );
  });
});

describe("streamed push budget wiring", () => {
  it("dispatches download_file with a budget sized to the local file", async () => {
    const { host, timeouts } = recordingHost();
    const files = new DeviceFiles(host);
    const dir = await mkdtemp(join(tmpdir(), "talon-xfer-budget-"));
    const src = join(dir, "small.bin");
    await writeFile(src, Buffer.alloc(87 * 1024, 7));

    const res = await files.pushFileToDevice("phone", src, "/sdcard/small.bin");

    expect(res.ok).toBe(true);
    const push = timeouts.find((t) => t.name === "download_file");
    expect(push).toBeDefined();
    // The property that matters: the chat cannot be blocked for an hour by
    // an 87 KB push that the device never answers.
    expect(push?.timeoutMs).toBe(streamTransferTimeoutMs(87 * 1024));
    expect(push?.timeoutMs).toBeLessThan(2 * 60 * 1000);
  });
});
