import { mkdir, rename, rm, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { log, logError } from "../../util/log.js";
import { files } from "../../util/paths.js";
import { BRIDGE_PROTOCOL_VERSION } from "./protocol.js";

export type BridgeDiscoveryInfo = {
  port: number;
  token?: string;
  scheme?: string;
  /** Certificate SHA-256 (hex) when the bridge serves HTTPS. */
  fingerprint?: string;
  startedAt?: number;
};

export async function writeBridgeDiscovery(
  info: BridgeDiscoveryInfo,
): Promise<void> {
  try {
    const dir = dirname(files.nativeBridge);
    await mkdir(dir, { recursive: true });
    const now = Date.now();
    const payload = {
      host: "127.0.0.1",
      port: info.port,
      token: info.token ?? null,
      scheme: info.scheme ?? "http",
      fingerprint: info.fingerprint ?? null,
      pid: process.pid,
      protocol: BRIDGE_PROTOCOL_VERSION,
      startedAt: info.startedAt ?? now,
      updatedAt: now,
    };
    const tmp = join(dir, `.native-bridge.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(tmp, 0o600);
    await rename(tmp, files.nativeBridge);
    log("native", `Wrote bridge discovery file at ${files.nativeBridge}`);
  } catch (err) {
    logError("native", "Failed to write bridge discovery file", err);
  }
}

export async function removeBridgeDiscovery(): Promise<void> {
  try {
    await rm(files.nativeBridge, { force: true });
  } catch {
    // Best-effort cleanup only.
  }
}
