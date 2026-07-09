/**
 * TransferStore — one-time tokens for streaming device file transfers.
 *
 * The chunked command channel moves file bytes at 256KB–1MB per full mesh
 * round trip (SSE command out, HTTP result back) — fine for small text,
 * hopeless for real files. The streaming path costs ONE command round trip
 * to arrange the transfer, then the file body flows as a single raw HTTP
 * stream between the companion and the bridge at full TCP throughput:
 *
 *   pull (device → daemon):
 *     daemon: token = createPull(deviceId, destPath)
 *     daemon → device (command): upload_file { token, path }
 *     device → daemon (HTTP):    POST /devices/file?transfer=token  (raw body)
 *     bridge route:              acceptUpload(token, stream) → tmp+rename
 *     device → daemon (command result): ok + bytes — the command round trip
 *     doubles as the completion signal.
 *
 *   push (daemon → device):
 *     daemon: token = createPush(deviceId, sourcePath)
 *     daemon → device (command): download_file { token, path }
 *     device → daemon (HTTP):    GET /devices/file?transfer=token
 *     bridge route:              openDownload(token) → stream the source
 *     device writes to its path, answers the command with ok + bytes.
 *
 * Tokens are single-use, bound to one device + one path, and expire unused.
 * The registry never trusts the HTTP caller with a path — the token IS the
 * authorization, and it only reaches the device over the authed mesh
 * channel (the HTTP routes additionally sit behind the bridge bearer token).
 */

import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

/** Unused tokens die after this long (transfer not started). */
const TOKEN_TTL_MS = 10 * 60 * 1000;

type Transfer = {
  token: string;
  direction: "pull" | "push";
  deviceId: string;
  /** pull: destination on the daemon host; push: source on the daemon host. */
  localPath: string;
  createdAt: number;
  /** Set once the HTTP leg has started (single-use latch). */
  consumed: boolean;
  /** pull only — resolved by acceptUpload with the byte count. */
  uploadDone?: {
    promise: Promise<number>;
    resolve: (bytes: number) => void;
    reject: (err: Error) => void;
  };
};

export class TransferStore {
  private readonly transfers = new Map<string, Transfer>();

  /** Arrange a device→daemon transfer. Returns the token to send to the
   *  device and a promise that resolves (bytes) when the upload lands. */
  createPull(
    deviceId: string,
    destPath: string,
  ): { token: string; done: Promise<number> } {
    this.sweep();
    const token = randomBytes(24).toString("base64url");
    let resolve!: (bytes: number) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<number>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A pull whose upload never arrives must not leave an eternally-pending
    // promise; callers race it with the command result, which times out.
    promise.catch(() => {});
    this.transfers.set(token, {
      token,
      direction: "pull",
      deviceId,
      localPath: destPath,
      createdAt: Date.now(),
      consumed: false,
      uploadDone: { promise, resolve, reject },
    });
    return { token, done: promise };
  }

  /** Arrange a daemon→device transfer of `sourcePath`. */
  createPush(deviceId: string, sourcePath: string): { token: string } {
    this.sweep();
    const token = randomBytes(24).toString("base64url");
    this.transfers.set(token, {
      token,
      direction: "push",
      deviceId,
      localPath: sourcePath,
      createdAt: Date.now(),
      consumed: false,
    });
    return { token };
  }

  /** Drop a token (transfer arrangement failed before the HTTP leg). */
  cancel(token: string): void {
    const t = this.transfers.get(token);
    if (t?.uploadDone && !t.consumed) {
      t.uploadDone.reject(new Error("transfer cancelled"));
    }
    this.transfers.delete(token);
  }

  /**
   * Bridge route: a device is streaming a pull's file body up. Writes to a
   * temp file and renames into place, so a dropped connection can't leave a
   * half-written destination. Resolves the pull's `done` promise.
   */
  async acceptUpload(
    token: string,
    body: Readable,
  ): Promise<{ ok: true; bytes: number } | { ok: false; error: string }> {
    const t = this.take(token, "pull");
    if (!t)
      return { ok: false, error: "Unknown or already-used transfer token." };
    const tmp = `${t.localPath}.part-${randomBytes(4).toString("hex")}`;
    try {
      await mkdir(dirname(t.localPath), { recursive: true });
      let bytes = 0;
      body.on("data", (d: Buffer) => (bytes += d.length));
      await pipeline(body, createWriteStream(tmp, { mode: 0o600 }));
      await rename(tmp, t.localPath);
      this.transfers.delete(token);
      t.uploadDone?.resolve(bytes);
      return { ok: true, bytes };
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      this.transfers.delete(token);
      const error = `Upload for ${t.localPath} failed mid-stream: ${(err as Error).message}`;
      t.uploadDone?.reject(new Error(error));
      return { ok: false, error };
    }
  }

  /**
   * Bridge route: a device wants a push's file body. Returns the source
   * path to stream (single use) or null for unknown/used tokens.
   */
  async openDownload(
    token: string,
  ): Promise<{ path: string; size: number } | null> {
    const t = this.take(token, "push");
    if (!t) return null;
    try {
      const s = await stat(t.localPath);
      if (!s.isFile()) throw new Error("not a file");
      return { path: t.localPath, size: s.size };
    } catch {
      this.transfers.delete(token);
      return null;
    } finally {
      // Single-use either way; the device retries by re-arranging.
      this.transfers.delete(token);
    }
  }

  /** Validate + latch a token for its HTTP leg. */
  private take(token: string, direction: Transfer["direction"]) {
    this.sweep();
    const t = this.transfers.get(token);
    if (!t || t.direction !== direction || t.consumed) return null;
    if (Date.now() - t.createdAt > TOKEN_TTL_MS) {
      this.cancel(token);
      return null;
    }
    t.consumed = true;
    return t;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, t] of this.transfers) {
      if (!t.consumed && now - t.createdAt > TOKEN_TTL_MS) this.cancel(token);
    }
  }
}
