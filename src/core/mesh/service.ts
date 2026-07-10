/**
 * MeshService — the daemon-wide device-mesh facade.
 *
 * One instance serves every consumer in the process:
 *
 *   - Transports (the native bridge server) feed it registrations, location
 *     reports, and command results, and plug in a MeshTransport so locate
 *     requests and device commands reach connected companion apps. The
 *     service never imports a transport — dependencies point inward.
 *   - The model reads and drives it through the shared mesh gateway actions
 *     (list_devices, get_device_location, get_device_history, ring_device,
 *     get_device_status), so full mesh access works identically from
 *     Telegram, Discord, Teams, terminal, and native chats — the mesh is
 *     daemon state, not a native-frontend feature.
 *
 * Two request/response flows ride the same SSE-out / HTTP-POST-back loop:
 *
 *   locate   → `locate` event   → device POSTs /location            (legacy,
 *              kept verbatim so pre-command app builds keep working)
 *   command  → `device_command` → device POSTs /devices/command-result with
 *              the command's correlation id; sendCommand resolves the
 *              pending promise or times out.
 *
 * With no transport registered (daemon running without the native bridge),
 * everything degrades gracefully: locate answers from the last persisted
 * fix immediately, and commands fail fast with a clear explanation.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { clampExecOutput } from "../../util/exec-output.js";
import { dirs } from "../../util/paths.js";
import { MeshRegistry } from "./registry.js";
import { TransferStore } from "./transfers.js";
import type {
  DeviceCommand,
  DeviceCommandResult,
  DeviceInfo,
  DeviceLocation,
} from "./types.js";

/** How a transport pushes mesh traffic to connected companion devices. */
export type MeshTransport = {
  /** Ask one device (or all, when undefined) for a fresh location fix. */
  locate(deviceId?: string): void;
  /** Deliver an on-demand command to its target device. */
  command(command: DeviceCommand): void;
};

export type MeshToolResult = { ok: boolean; text: string };

export type MeshServiceOptions = {
  /** How long a locate waits for a fresh fix before last-known fallback. */
  freshFixTimeoutMs?: number;
  /** Upper bound between staleness re-checks while waiting. */
  pollIntervalMs?: number;
  /** How long a device command waits for its result before timing out. */
  commandTimeoutMs?: number;
};

const DEFAULT_FRESH_FIX_TIMEOUT_MS = 8_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 12_000;
const MOBILE_PLATFORMS = new Set(["android", "ios"]);
const DEFAULT_HISTORY_HOURS = 24;
const MAX_HISTORY_LINES = 24;

// ── Exec / filesystem channel ───────────────────────────────────────────────
/** Default wall-clock budget for a remote shell command. */
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
/** Hard ceiling on a caller-requested exec timeout. */
const MAX_EXEC_TIMEOUT_MS = 300_000;
/** Timeout for a single filesystem command (list/stat/one chunk/etc.). */
const FS_COMMAND_TIMEOUT_MS = 30_000;
/**
 * Bytes of file payload per FALLBACK transfer chunk (base64 on the wire).
 * The chunked command channel costs one full mesh round trip per chunk, so
 * it's only used for app builds that don't advertise the streaming commands
 * (`upload_file`/`download_file`) — modern builds move file bodies as a
 * single raw HTTP stream instead (see TransferStore). 1MB keeps even the
 * fallback tolerable without bloating a single SSE frame too far.
 */
const FILE_CHUNK_BYTES = 1024 * 1024;
/** Wall-clock budget for one streamed transfer (command dispatch → done). */
const STREAM_TRANSFER_TIMEOUT_MS = 60 * 60 * 1000;
/** readFileBytes switches to the streaming path above this size. */
const STREAM_READ_THRESHOLD_BYTES = 4 * 1024 * 1024;
/**
 * Hard ceiling on a chunked (command-channel) transfer. The chunked path
 * assembles the whole file in daemon memory one mesh round trip at a time —
 * past this size it's both a memory hazard and unusably slow, so fail with
 * a pointer to the streaming path instead of grinding on.
 */
const MAX_CHUNKED_TRANSFER_BYTES = 64 * 1024 * 1024;
/**
 * No policy size cap on transfers — a transfer is attempted whatever the
 * size and fails with a concrete error when a real limit bites (device read
 * error, stream timeout, disk). The streamed paths are disk-to-disk and
 * never hold the file in daemon memory; only the chunked FALLBACK and
 * readFileBytes (whose callers need a Buffer) are memory-bound.
 */
/**
 * Where pulled device files land on the daemon host when no dest is given.
 * Resolved lazily (not at module load) so a test that mocks `util/paths`
 * doesn't hit its workspace binding before initialization.
 */
function pullDir(): string {
  return resolve(dirs.workspace, "mesh-pull");
}

export class MeshService {
  private readonly waiters = new Set<() => void>();
  private readonly transports = new Set<MeshTransport>();
  private readonly pendingCommands = new Map<
    string,
    {
      deviceId: string;
      resolve: (result: DeviceCommandResult) => void;
    }
  >();
  /**
   * Server-side receipt time (this process's clock) of the last fix per
   * device. Freshness is judged against THIS, never the device-supplied
   * `loc.ts` — a companion whose clock runs behind would otherwise have
   * genuinely fresh fixes rejected (every locate burning the full timeout),
   * and one running ahead would have stale fixes accepted as fresh.
   */
  private readonly receivedAt = new Map<string, number>();
  /** One-time tokens arranging streamed (single-HTTP-request) transfers. */
  private readonly transfers = new TransferStore();
  private readonly freshFixTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly commandTimeoutMs: number;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly registry = new MeshRegistry(),
    options: MeshServiceOptions = {},
  ) {
    this.freshFixTimeoutMs =
      options.freshFixTimeoutMs ?? DEFAULT_FRESH_FIX_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.commandTimeoutMs =
      options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  /** Hydrate persisted devices/locations. Idempotent — safe to await from
   *  every entry point; the first caller does the read, the rest share it. */
  load(): Promise<void> {
    this.loading ??= this.registry.load();
    return this.loading;
  }

  /**
   * Plug a transport in. Returns an unsubscribe so the transport detaches
   * cleanly on shutdown (no stale broadcasts into a stopped server).
   */
  registerTransport(transport: MeshTransport): () => void {
    this.transports.add(transport);
    return () => this.transports.delete(transport);
  }

  /** Fan a locate request out to every transport. True when at least one
   *  transport is attached (i.e. waiting for a fresh fix can pay off). */
  requestLocate(deviceId?: string): boolean {
    for (const transport of this.transports) {
      try {
        transport.locate(deviceId);
      } catch {
        // One broken transport must not stop the others.
      }
    }
    return this.transports.size > 0;
  }

  async register(
    body: Record<string, unknown>,
    now?: number,
  ): Promise<DeviceInfo> {
    await this.load();
    return this.registry.register(body, now);
  }

  /** Store a reported fix and wake anyone waiting on a fresh location. */
  async storeLocation(body: Record<string, unknown>): Promise<DeviceLocation> {
    await this.load();
    const loc = await this.registry.storeLocation(body);
    // Stamp arrival against our own clock so waitForFreshLocation is immune
    // to device clock skew.
    this.receivedAt.set(loc.deviceId, Date.now());
    for (const notify of [...this.waiters]) notify();
    return loc;
  }

  async list(): Promise<{
    devices: DeviceInfo[];
    locations: DeviceLocation[];
  }> {
    await this.load();
    return this.registry.list();
  }

  async getLocation(deviceId: string): Promise<DeviceLocation | undefined> {
    await this.load();
    return this.registry.getLocation(deviceId);
  }

  // ── Command channel ────────────────────────────────────────────────────────

  /**
   * A device answered a command (bridge route POST /devices/command-result).
   * Resolves the pending sendCommand; false when nothing was waiting (late
   * or unknown correlation id — harmless, just ignored).
   *
   * The result must come from the device the command was sent to: a reply
   * whose deviceId names a DIFFERENT device is dropped (a confused or
   * misbehaving companion must not be able to answer for its peers). A
   * missing deviceId is tolerated for older app builds.
   */
  completeCommand(body: Record<string, unknown>): boolean {
    const commandId = typeof body.commandId === "string" ? body.commandId : "";
    const pending = this.pendingCommands.get(commandId);
    if (!pending) return false;
    const from = typeof body.deviceId === "string" ? body.deviceId : "";
    if (from && from !== pending.deviceId) return false;
    const { resolve } = pending;
    this.pendingCommands.delete(commandId);
    resolve({
      commandId,
      deviceId: typeof body.deviceId === "string" ? body.deviceId : "",
      ok: body.ok === true,
      ...(typeof body.message === "string" && body.message.trim()
        ? { message: body.message.trim().slice(0, 2_000) }
        : {}),
      ...(body.data &&
      typeof body.data === "object" &&
      !Array.isArray(body.data)
        ? { data: body.data as Record<string, unknown> }
        : {}),
    });
    return true;
  }

  /**
   * Push one command to a device and await its result (or time out). The
   * low-level primitive under every command tool; exposed for tests and
   * future tools.
   */
  sendCommand(
    device: DeviceInfo,
    name: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.commandTimeoutMs,
  ): Promise<DeviceCommandResult> {
    const command: DeviceCommand = {
      id: randomUUID(),
      deviceId: device.id,
      name,
      params,
    };
    return new Promise<DeviceCommandResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(command.id);
        resolve({
          commandId: command.id,
          deviceId: device.id,
          ok: false,
          message: `${device.name} did not answer within ${Math.round(timeoutMs / 1000)}s (device ${device.online ? "was online" : "appears offline"}).`,
        });
      }, timeoutMs);
      timer.unref?.();
      this.pendingCommands.set(command.id, {
        deviceId: device.id,
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
      });
      for (const transport of this.transports) {
        try {
          transport.command(command);
        } catch {
          // One broken transport must not stop the others.
        }
      }
    });
  }

  // ── Model-facing tool surface ──────────────────────────────────────────────

  /** `list_devices`: every mesh device with presence, battery, last-known
   *  position, and capabilities — the model's full view of the mesh. */
  async describeDevices(): Promise<MeshToolResult> {
    const { devices } = await this.list();
    if (devices.length === 0) {
      return { ok: true, text: "No mesh devices have registered yet." };
    }
    return {
      ok: true,
      text: devices.map((d) => this.deviceLine(d)).join("\n"),
    };
  }

  /**
   * `get_device_location`: resolve the target (id, name fragment, or the
   * most recent mobile device), push a locate to connected transports, wait
   * briefly for a fresh fix, then fall back to the last persisted location.
   */
  async locateDevice(query?: unknown): Promise<MeshToolResult> {
    await this.load();
    const resolved = this.resolveDevice(query);
    if ("error" in resolved) return { ok: false, text: resolved.error };
    const target = resolved.target;
    const requestedAt = Date.now();
    // Only wait out the fresh-fix window when a transport can actually
    // deliver the locate AND the device is currently present — pinging an
    // offline device just burns the whole timeout for a fix that won't come,
    // so answer from persistence immediately in that case.
    const dispatched = this.requestLocate(target.id);
    const fresh =
      dispatched && target.online
        ? await this.waitForFreshLocation(target.id, requestedAt)
        : undefined;
    const loc = fresh ?? this.registry.getLocation(target.id);
    if (!loc) {
      return {
        ok: false,
        text: !dispatched
          ? `No location is known for ${target.name}, and no companion transport is connected to request one.`
          : target.online
            ? `No location is known for ${target.name}. A locate request was sent, but no fix arrived within ${Math.round(this.freshFixTimeoutMs / 1000)}s.`
            : `No location is known for ${target.name}, and it appears offline (last seen ${age(Date.now() - target.lastSeen)}).`,
      };
    }
    return { ok: true, text: this.locationSummary(target, loc) };
  }

  /** `ring_device`: make the device sound/vibrate so it can be found. */
  ringDevice(query?: unknown, message?: unknown): Promise<MeshToolResult> {
    return this.commandTool(query, "ring", {
      ...(typeof message === "string" && message.trim()
        ? { message: message.trim().slice(0, 200) }
        : {}),
    });
  }

  /**
   * `get_device_history`: the device's movement + battery over a window,
   * computed from the fixes the daemon has been receiving all along —
   * timeline, distance traveled, and battery trend.
   */
  async deviceHistory(
    query?: unknown,
    hours?: unknown,
  ): Promise<MeshToolResult> {
    await this.load();
    const resolved = this.resolveDevice(query);
    if ("error" in resolved) return { ok: false, text: resolved.error };
    const target = resolved.target;
    const windowHours = clampHours(hours);
    const sinceTs = Date.now() - windowHours * 3_600_000;
    const fixes = this.registry.getHistory(target.id, sinceTs);
    if (fixes.length === 0) {
      return {
        ok: true,
        text: `No location reports from ${target.name} in the last ${windowHours}h. Enable periodic reporting in the companion app for a movement history.`,
      };
    }
    return { ok: true, text: this.historySummary(target, fixes, windowHours) };
  }

  /** `get_device_status`: live telemetry straight from the device. */
  getDeviceStatus(query?: unknown): Promise<MeshToolResult> {
    return this.commandTool(query, "status", {});
  }

  // ── Exec + filesystem tools (teleport substrate) ───────────────────────────

  /**
   * Run a shell command on a device and return its stdout/stderr/exit code.
   * The primitive under `device_exec` and the teleported native `bash` tool.
   */
  async execOnDevice(
    query: unknown,
    cmd: unknown,
    cwd?: unknown,
    timeoutSec?: unknown,
  ): Promise<MeshToolResult> {
    const command = typeof cmd === "string" ? cmd : "";
    if (!command.trim()) {
      return { ok: false, text: "No command given to run on the device." };
    }
    const budgetMs = clampExecTimeout(timeoutSec);
    const dispatched = await this.dispatchCommand(
      query,
      "exec",
      {
        cmd: command,
        ...(typeof cwd === "string" && cwd.trim() ? { cwd: cwd.trim() } : {}),
        timeoutMs: budgetMs,
      },
      budgetMs + 5_000, // let the device's own timeout fire first
    );
    if ("error" in dispatched) return { ok: false, text: dispatched.error };
    return {
      ok: dispatched.result.ok,
      text: formatExecResult(dispatched.target, dispatched.result),
    };
  }

  /** `device_list_dir`: list a directory on the device. */
  async listDirOnDevice(
    query: unknown,
    path: unknown,
  ): Promise<MeshToolResult> {
    const dir = requirePath(path);
    if (!dir) return { ok: false, text: "A directory path is required." };
    const dispatched = await this.dispatchCommand(
      query,
      "list_dir",
      { path: dir },
      FS_COMMAND_TIMEOUT_MS,
    );
    if ("error" in dispatched) return { ok: false, text: dispatched.error };
    const { target, result } = dispatched;
    if (!result.ok) {
      return { ok: false, text: result.message ?? `Could not list ${dir}.` };
    }
    const entries = Array.isArray(result.data?.entries)
      ? (result.data!.entries as Array<Record<string, unknown>>)
      : [];
    if (entries.length === 0) {
      return { ok: true, text: `${dir} on ${target.name} is empty.` };
    }
    const lines = entries.map((e) => {
      const name = String(e.name ?? "?");
      const type = e.type === "dir" ? "/" : "";
      const size =
        typeof e.size === "number" && e.type !== "dir"
          ? ` (${formatBytes(e.size)})`
          : "";
      return `- ${name}${type}${size}`;
    });
    return {
      ok: true,
      text: `${dir} on ${target.name} — ${entries.length} item(s):\n${lines.join("\n")}`,
    };
  }

  /** `device_stat`: metadata for one path on the device. */
  async statOnDevice(query: unknown, path: unknown): Promise<MeshToolResult> {
    const p = requirePath(path);
    if (!p) return { ok: false, text: "A path is required." };
    const dispatched = await this.dispatchCommand(
      query,
      "stat",
      { path: p },
      FS_COMMAND_TIMEOUT_MS,
    );
    if ("error" in dispatched) return { ok: false, text: dispatched.error };
    const { result } = dispatched;
    if (!result.ok) {
      return { ok: false, text: result.message ?? `Cannot stat ${p}.` };
    }
    const d = result.data ?? {};
    const fields = Object.entries(d)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `${k}: ${String(v)}`);
    return { ok: true, text: `${p} — ${fields.join(" · ")}` };
  }

  // ── Streaming transfer bridge surface ─────────────────────────────────────
  // The HTTP routes on the native bridge delegate here; the token is the
  // entire authorization (single-use, device- and path-bound).

  /** POST /devices/file — a device streams a pull's file body up. */
  acceptFileUpload(
    token: string,
    body: Readable,
  ): Promise<{ ok: true; bytes: number } | { ok: false; error: string }> {
    return this.transfers.acceptUpload(token, body);
  }

  /** GET /devices/file — a device asks for a push's file body. */
  openFileDownload(
    token: string,
  ): Promise<{ path: string; size: number } | null> {
    return this.transfers.openDownload(token);
  }

  /** Streaming is per-command capability — old app builds fall back. */
  private canStream(
    target: DeviceInfo,
    command: "upload_file" | "download_file",
  ): boolean {
    return target.capabilities?.includes(command) ?? false;
  }

  /**
   * Streamed device→daemon transfer: one command round trip to arrange it,
   * then the file body arrives as a single raw HTTP request, written
   * atomically to `dest`. Resolves with the byte count.
   */
  private async pullViaStream(
    target: DeviceInfo,
    remote: string,
    dest: string,
  ): Promise<{ bytes: number } | { error: string }> {
    const { token, done } = this.transfers.createPull(target.id, dest);
    const dispatched = await this.dispatchCommand(
      target.id,
      "upload_file",
      { token, path: remote },
      STREAM_TRANSFER_TIMEOUT_MS,
    );
    if ("error" in dispatched) {
      this.transfers.cancel(token);
      return { error: dispatched.error };
    }
    if (!dispatched.result.ok) {
      this.transfers.cancel(token);
      return {
        error:
          dispatched.result.message ??
          `${target.name} could not upload ${remote}.`,
      };
    }
    // The device answers the command AFTER its upload completes, so `done`
    // is normally already resolved — the grace window only catches a device
    // that claims success without having streamed anything.
    try {
      const bytes = await Promise.race([
        done,
        new Promise<never>((_, rej) =>
          setTimeout(
            () =>
              rej(
                new Error(
                  `${target.name} reported success but no upload arrived.`,
                ),
              ),
            15_000,
          ).unref?.(),
        ),
      ]);
      return { bytes };
    } catch (err) {
      this.transfers.cancel(token);
      return { error: (err as Error).message };
    }
  }

  /**
   * Raw file bytes off a device — the structured primitive under both the
   * human-readable tool below and the native read/edit path (which must not
   * have to parse a display envelope to recover the content).
   *
   * Small files ride the chunked command channel (one round trip). Files
   * over the streaming threshold are pulled via the streaming path into a
   * temp file first — the chunked channel pays a full mesh round trip per
   * chunk and is far too slow for big payloads.
   */
  async readFileBytes(
    query: unknown,
    path: unknown,
  ): Promise<{ data: Buffer; deviceName: string } | { error: string }> {
    const p = requirePath(path);
    if (!p) return { error: "A file path is required." };
    await this.load();
    const resolved = this.resolveDevice(query);
    if ("error" in resolved) return { error: resolved.error };
    const target = resolved.target;
    if (this.canStream(target, "upload_file")) {
      const size = await this.statSize(target.id, p);
      if (size !== undefined && size > STREAM_READ_THRESHOLD_BYTES) {
        const tmp = join(tmpdir(), `talon-pull-${randomUUID()}-${basename(p)}`);
        const pulled = await this.pullViaStream(target, p, tmp);
        if ("error" in pulled) return { error: pulled.error };
        try {
          const data = await readFile(tmp);
          return { data, deviceName: target.name };
        } catch (err) {
          return {
            error: `Pulled ${p} but could not read the temp copy: ${(err as Error).message}`,
          };
        } finally {
          await rm(tmp, { force: true }).catch(() => {});
        }
      }
    }
    return this.pullBytes(target.id, p);
  }

  /** Size of a device path via the `stat` command, if the device can. */
  private async statSize(
    deviceId: string,
    path: string,
  ): Promise<number | undefined> {
    const dispatched = await this.dispatchCommand(
      deviceId,
      "stat",
      { path },
      FS_COMMAND_TIMEOUT_MS,
    );
    if ("error" in dispatched || !dispatched.result.ok) return undefined;
    const size = dispatched.result.data?.size;
    return typeof size === "number" ? size : undefined;
  }

  /** `device_read_file`: read a (text) file off the device, chunked. */
  async readFileFromDevice(
    query: unknown,
    path: unknown,
  ): Promise<MeshToolResult> {
    const p = requirePath(path);
    if (!p) return { ok: false, text: "A file path is required." };
    const buf = await this.readFileBytes(query, p);
    if ("error" in buf) return { ok: false, text: buf.error };
    return {
      ok: true,
      text: `${p} on ${buf.deviceName} (${formatBytes(buf.data.length)}):\n\n${buf.data.toString("utf8")}`,
    };
  }

  /** `device_write_file`: write text content to a file on the device. */
  async writeFileToDevice(
    query: unknown,
    path: unknown,
    content: unknown,
  ): Promise<MeshToolResult> {
    const p = requirePath(path);
    if (!p) return { ok: false, text: "A file path is required." };
    // A non-string body must fail, not silently truncate the target to an
    // empty file (an empty string is a legitimate truncate-to-zero).
    if (typeof content !== "string") {
      return { ok: false, text: "File content must be a string." };
    }
    const written = await this.pushBytes(
      query,
      p,
      Buffer.from(content, "utf8"),
    );
    if ("error" in written) return { ok: false, text: written.error };
    return {
      ok: true,
      text: `Wrote ${formatBytes(written.bytes)} to ${p} on ${written.deviceName}.`,
    };
  }

  /** `device_pull_file`: copy a device file to the daemon host — streamed
   *  (single HTTP request, disk-to-disk) when the app supports it, chunked
   *  command-channel fallback otherwise. */
  async pullFileFromDevice(
    query: unknown,
    remotePath: unknown,
    localPath?: unknown,
  ): Promise<MeshToolResult> {
    const remote = requirePath(remotePath);
    if (!remote) return { ok: false, text: "A remote file path is required." };
    await this.load();
    const resolved = this.resolveDevice(query);
    if ("error" in resolved) return { ok: false, text: resolved.error };
    const target = resolved.target;
    const dest =
      typeof localPath === "string" && localPath.trim()
        ? resolve(dirs.workspace, localPath.trim())
        : resolve(
            pullDir(),
            `${target.name.replace(/\W+/g, "_")}-${basename(remote)}`,
          );
    if (this.canStream(target, "upload_file")) {
      const started = Date.now();
      const pulled = await this.pullViaStream(target, remote, dest);
      if ("error" in pulled) return { ok: false, text: pulled.error };
      return {
        ok: true,
        text: `Pulled ${formatBytes(pulled.bytes)} from ${remote} on ${target.name} → ${dest} (streamed, ${transferRate(pulled.bytes, started)})`,
      };
    }
    const buf = await this.pullBytes(target.id, remote);
    if ("error" in buf) return { ok: false, text: buf.error };
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, buf.data);
    return {
      ok: true,
      text: `Pulled ${formatBytes(buf.data.length)} from ${remote} on ${buf.deviceName} → ${dest} (chunked fallback — update the companion app for streamed transfers)`,
    };
  }

  /** `device_push_file`: copy a daemon-host file to the device — streamed
   *  when the app supports it (never buffers the file in daemon memory),
   *  chunked command-channel fallback otherwise. */
  async pushFileToDevice(
    query: unknown,
    localPath: unknown,
    remotePath: unknown,
  ): Promise<MeshToolResult> {
    const remote = requirePath(remotePath);
    if (!remote)
      return { ok: false, text: "A remote destination path is required." };
    const local =
      typeof localPath === "string" && localPath.trim()
        ? resolve(dirs.workspace, localPath.trim())
        : "";
    if (!local) return { ok: false, text: "A local source path is required." };
    await this.load();
    const resolved = this.resolveDevice(query);
    if ("error" in resolved) return { ok: false, text: resolved.error };
    const target = resolved.target;
    if (this.canStream(target, "download_file")) {
      const started = Date.now();
      const { token } = this.transfers.createPush(target.id, local);
      const dispatched = await this.dispatchCommand(
        target.id,
        "download_file",
        { token, path: remote },
        STREAM_TRANSFER_TIMEOUT_MS,
      );
      if ("error" in dispatched) {
        this.transfers.cancel(token);
        return { ok: false, text: dispatched.error };
      }
      if (!dispatched.result.ok) {
        this.transfers.cancel(token);
        return {
          ok: false,
          text:
            dispatched.result.message ??
            `${target.name} could not download ${local}.`,
        };
      }
      const bytes = dispatched.result.data?.bytesWritten;
      const size = typeof bytes === "number" ? bytes : 0;
      return {
        ok: true,
        text: `Pushed ${formatBytes(size)} to ${remote} on ${target.name} (streamed, ${transferRate(size, started)})`,
      };
    }
    let data: Buffer;
    try {
      data = await readFile(local);
    } catch (err) {
      // Includes Node's buffer-size ceiling (ERR_FS_FILE_TOO_LARGE) for
      // files too big to hold in memory — surface the real reason.
      return {
        ok: false,
        text: `Cannot read local file ${local}: ${(err as Error).message}`,
      };
    }
    const written = await this.pushBytes(target.id, remote, data);
    if ("error" in written) return { ok: false, text: written.error };
    return {
      ok: true,
      text: `Pushed ${formatBytes(written.bytes)} to ${remote} on ${written.deviceName} (chunked fallback — update the companion app for streamed transfers).`,
    };
  }

  /**
   * Chunked read of a remote file into a Buffer. Loops `read_file` with
   * increasing offsets until the device reports EOF.
   *
   * End-of-file is the DEVICE's call (`eof: true`), never inferred from a
   * short chunk: devices cap their chunk size (the companion serves at most
   * 256KB per read regardless of the requested length), so a chunk shorter
   * than the request is normal mid-file and treating it as EOF silently
   * truncated every chunked read past the device's cap. A zero-length chunk
   * without `eof` is a stuck transfer and fails loudly instead of looping.
   */
  private async pullBytes(
    query: unknown,
    path: string,
  ): Promise<{ data: Buffer; deviceName: string } | { error: string }> {
    const chunks: Buffer[] = [];
    let offset = 0;
    let deviceName = "device";
    for (;;) {
      const dispatched = await this.dispatchCommand(
        query,
        "read_file",
        { path, offset, len: FILE_CHUNK_BYTES },
        FS_COMMAND_TIMEOUT_MS,
      );
      if ("error" in dispatched) {
        return {
          error:
            offset > 0
              ? `${dispatched.error} (transfer of ${path} aborted after ${formatBytes(offset)})`
              : dispatched.error,
        };
      }
      deviceName = dispatched.target.name;
      const { result } = dispatched;
      if (!result.ok) {
        const reason = result.message ?? `Could not read ${path}.`;
        return {
          error:
            offset > 0
              ? `${reason} (transfer aborted after ${formatBytes(offset)})`
              : reason,
        };
      }
      const b64 =
        typeof result.data?.base64 === "string" ? result.data.base64 : "";
      const chunk = Buffer.from(b64, "base64");
      chunks.push(chunk);
      offset += chunk.length;
      if (result.data?.eof === true) break;
      if (chunk.length === 0) {
        return {
          error: `${path} transfer stalled: the device returned an empty chunk without reporting end-of-file (after ${formatBytes(offset)}).`,
        };
      }
      if (offset > MAX_CHUNKED_TRANSFER_BYTES) {
        return {
          error: `${path} exceeds the ${formatBytes(MAX_CHUNKED_TRANSFER_BYTES)} chunked-transfer limit (device never reported end-of-file after ${formatBytes(offset)}). Use device_pull_file with a streaming-capable companion build for large files.`,
        };
      }
    }
    try {
      return { data: Buffer.concat(chunks), deviceName };
    } catch (err) {
      // Node buffer ceiling / out of memory — the one real size limit left.
      return {
        error: `${path} transferred ${formatBytes(offset)} but is too large to assemble in daemon memory: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Chunked write of a Buffer to a remote file. The first chunk truncates the
   * target; subsequent chunks append at their offset.
   */
  private async pushBytes(
    query: unknown,
    path: string,
    data: Buffer,
  ): Promise<{ bytes: number; deviceName: string } | { error: string }> {
    let offset = 0;
    let deviceName = "device";
    // On a mid-transfer failure the device is left with a partial file —
    // say so, with how far the transfer got, so the state isn't a mystery.
    const partial = (reason: string): { error: string } => ({
      error:
        offset > 0
          ? `${reason} (upload aborted — ${path} on the device is a ${formatBytes(offset)} partial write of ${formatBytes(data.length)})`
          : reason,
    });
    // A zero-length write still needs one call to create/truncate the file.
    do {
      const chunk = data.subarray(offset, offset + FILE_CHUNK_BYTES);
      const dispatched = await this.dispatchCommand(
        query,
        "write_file",
        {
          path,
          base64: chunk.toString("base64"),
          offset,
          truncate: offset === 0,
        },
        FS_COMMAND_TIMEOUT_MS,
      );
      if ("error" in dispatched) return partial(dispatched.error);
      deviceName = dispatched.target.name;
      if (!dispatched.result.ok) {
        return partial(dispatched.result.message ?? `Could not write ${path}.`);
      }
      offset += chunk.length;
    } while (offset < data.length);
    return { bytes: data.length, deviceName };
  }

  /**
   * Shared command-tool flow: resolve the target, check its advertised
   * capabilities, require a transport, send, and render the device's answer.
   */
  private async commandTool(
    query: unknown,
    name: string,
    params: Record<string, unknown>,
  ): Promise<MeshToolResult> {
    const dispatched = await this.dispatchCommand(query, name, params);
    if ("error" in dispatched) return { ok: false, text: dispatched.error };
    return {
      ok: dispatched.result.ok,
      text: this.commandSummary(dispatched.target, name, dispatched.result),
    };
  }

  /**
   * Resolve a target, validate capability + reachability, then send the
   * command and return the raw result — the shared primitive under both the
   * human-summary command tools (ring/status) and the structured exec/fs
   * tools that format the payload themselves. Returns `{ error }` for the
   * pre-flight failures (no device, unsupported, offline, no transport).
   */
  async dispatchCommand(
    query: unknown,
    name: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<
    { target: DeviceInfo; result: DeviceCommandResult } | { error: string }
  > {
    await this.load();
    const resolved = this.resolveDevice(query);
    if ("error" in resolved) return { error: resolved.error };
    const target = resolved.target;
    // Devices advertise what they can do; an explicit list that lacks the
    // command is a clean "can't" — absent list means an older app build, so
    // attempt it and let the timeout speak.
    if (target.capabilities && !target.capabilities.includes(name)) {
      return {
        error: `${target.name} does not support "${name}" (supports: ${target.capabilities.join(", ")}).`,
      };
    }
    if (this.transports.size === 0) {
      return {
        error: `No companion transport is connected, so "${name}" cannot reach ${target.name}.`,
      };
    }
    // Don't wait out a full timeout for a device that's plainly gone.
    if (!target.online) {
      return {
        error: `${target.name} appears offline (last seen ${age(Date.now() - target.lastSeen)}), so "${name}" was not sent.`,
      };
    }
    const result = await this.sendCommand(target, name, params, timeoutMs);
    return { target, result };
  }

  /** Resolve a device by exact id, exact name, or unique name fragment;
   *  undefined when nothing (or more than one device) matches. */
  chooseDevice(query?: unknown): DeviceInfo | undefined {
    const resolved = this.resolveDevice(query);
    return "target" in resolved ? resolved.target : undefined;
  }

  /**
   * Device resolution with a caller-facing error. Matching order: exact id,
   * exact name (case-insensitive), then name fragment — with names and
   * queries compared separator-insensitively ("pixel 10" finds
   * "Google-Pixel10"). When several devices match, a sole ONLINE match wins
   * (a stale duplicate registration must not shadow the live device);
   * otherwise it's an explicit error, never a silent first pick — exec and
   * file commands aimed at "pixel" must not land on whichever Pixel
   * happened to register first. No query defaults to the most recently
   * seen mobile device, then the most recent device overall.
   */
  resolveDevice(query?: unknown): { target: DeviceInfo } | { error: string } {
    const devices = this.registry.list().devices;
    if (typeof query === "string" && query.trim()) {
      const raw = query.trim();
      const q = raw.toLowerCase();
      const byId = devices.find((d) => d.id.toLowerCase() === q);
      if (byId) return { target: byId };
      const fold = (s: string): string =>
        s.toLowerCase().replace(/[^a-z0-9]+/g, "");
      const folded = fold(raw);
      const pick = (
        candidates: DeviceInfo[],
      ): { target: DeviceInfo } | { error: string } | undefined => {
        if (candidates.length === 1) return { target: candidates[0]! };
        if (candidates.length > 1) {
          const online = candidates.filter((d) => d.online);
          if (online.length === 1) return { target: online[0]! };
          return {
            error: `"${raw}" matches ${candidates.length} devices: ${candidates
              .map(
                (d) =>
                  `${d.name} [id: ${d.id}, ${d.online ? "online" : "offline"}]`,
              )
              .join(", ")}. Use the device id or full name.`,
          };
        }
        return undefined;
      };
      return (
        pick(devices.filter((d) => fold(d.name) === folded)) ??
        (folded
          ? pick(devices.filter((d) => fold(d.name).includes(folded)))
          : undefined) ?? { error: this.noSuchDevice(query).text }
      );
    }
    const fallback =
      devices.find((d) => MOBILE_PLATFORMS.has(d.platform)) ?? devices[0];
    return fallback
      ? { target: fallback }
      : { error: this.noSuchDevice(query).text };
  }

  // ── Formatting ─────────────────────────────────────────────────────────────

  private noSuchDevice(query: unknown): MeshToolResult {
    const known = this.registry.list().devices;
    return {
      ok: false,
      text:
        typeof query === "string" && query.trim() && known.length > 0
          ? `No mesh device matches "${query.trim()}". Known devices:\n${known.map((d) => this.deviceLine(d)).join("\n")}`
          : "No mesh devices are registered.",
    };
  }

  private deviceLine(device: DeviceInfo): string {
    const parts = [
      `${device.name} [id: ${device.id}] (${device.platform})`,
      device.online ? "online" : "offline",
      `last seen ${age(Date.now() - device.lastSeen)}`,
    ];
    if (typeof device.battery === "number") {
      parts.push(`${device.battery}%${device.charging ? " charging" : ""}`);
    }
    const loc = this.registry.getLocation(device.id);
    if (loc) {
      parts.push(
        `at ${loc.lat.toFixed(6)},${loc.lon.toFixed(6)} (fix ${age(Date.now() - loc.ts)})`,
      );
    }
    if (device.capabilities?.length) {
      parts.push(`can: ${device.capabilities.join(", ")}`);
    }
    return `- ${parts.join(" · ")}`;
  }

  private locationSummary(device: DeviceInfo, loc: DeviceLocation): string {
    const ageText = age(Date.now() - loc.ts);
    const accuracy =
      typeof loc.accuracyM === "number"
        ? ` Accuracy ${Math.round(loc.accuracyM)}m.`
        : "";
    return [
      `${device.name} is at ${loc.lat.toFixed(6)}, ${loc.lon.toFixed(6)}.`,
      `${accuracy} Fix age ${ageText}.`,
      `Reverse-geocode pair: ${loc.lat},${loc.lon}`,
    ]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private commandSummary(
    device: DeviceInfo,
    name: string,
    result: DeviceCommandResult,
  ): string {
    if (!result.ok) {
      return result.message ?? `${device.name} rejected "${name}".`;
    }
    const detail = result.message ? ` ${result.message}` : "";
    switch (name) {
      case "ring":
        return `${device.name} is ringing.${detail}`;
      case "status": {
        const fields = Object.entries(result.data ?? {})
          .filter(([, v]) => v !== null && v !== undefined && v !== "")
          .map(([k, v]) => `${k}: ${String(v)}`);
        return fields.length
          ? `${device.name} status — ${fields.join(" · ")}`
          : `${device.name} answered but reported no status fields.${detail}`;
      }
      default:
        return (
          result.message ??
          (result.data
            ? `${device.name} answered: ${JSON.stringify(result.data)}`
            : `${device.name} completed "${name}".`)
        );
    }
  }

  /** Render a window of fixes: headline (count, span, distance, battery
   *  trend) plus a bounded, evenly-sampled timeline oldest-first. */
  private historySummary(
    device: DeviceInfo,
    fixes: DeviceLocation[],
    windowHours: number,
  ): string {
    let distanceM = 0;
    for (let i = 1; i < fixes.length; i++) {
      distanceM += haversineM(fixes[i - 1], fixes[i]);
    }
    const batteries = fixes
      .map((f) => f.batteryPct)
      .filter((b): b is number => typeof b === "number");
    const headline = [
      `${device.name}: ${fixes.length} fix${fixes.length === 1 ? "" : "es"} in the last ${windowHours}h`,
      `moved ~${formatDistance(distanceM)}`,
      ...(batteries.length >= 2
        ? [`battery ${batteries[0]}% → ${batteries[batteries.length - 1]}%`]
        : []),
    ].join(" · ");
    const lines = sampleEvenly(fixes, MAX_HISTORY_LINES).map((f) => {
      const parts = [
        `${formatWhen(f.ts)} — ${f.lat.toFixed(5)},${f.lon.toFixed(5)}`,
      ];
      if (typeof f.accuracyM === "number")
        parts.push(`±${Math.round(f.accuracyM)}m`);
      if (typeof f.batteryPct === "number") parts.push(`${f.batteryPct}%`);
      return `- ${parts.join(" · ")}`;
    });
    const omitted = fixes.length - Math.min(fixes.length, MAX_HISTORY_LINES);
    return [
      headline,
      ...lines,
      ...(omitted > 0
        ? [`(${omitted} more fixes omitted; timeline sampled evenly)`]
        : []),
    ].join("\n");
  }

  private async waitForFreshLocation(
    deviceId: string,
    requestedAt: number,
  ): Promise<DeviceLocation | undefined> {
    // Judge freshness by server-side arrival time, not the device-reported
    // `loc.ts` (which is subject to the companion's clock skew).
    if ((this.receivedAt.get(deviceId) ?? 0) >= requestedAt) {
      return this.registry.getLocation(deviceId);
    }
    const deadline = Date.now() + this.freshFixTimeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(
          done,
          Math.min(remaining, this.pollIntervalMs),
        );
        this.waiters.add(done);
      });
      if ((this.receivedAt.get(deviceId) ?? 0) >= requestedAt) {
        return this.registry.getLocation(deviceId);
      }
    }
    return undefined;
  }
}

/** Clamp the requested history window to 1..168 hours (default 24). */
function clampHours(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HISTORY_HOURS;
  return Math.min(168, Math.max(1, Math.round(n)));
}

/** Great-circle distance between two fixes in meters. */
function haversineM(a: DeviceLocation, b: DeviceLocation): number {
  const R = 6_371_000;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatDistance(meters: number): string {
  if (meters < 1_000) return `${Math.round(meters)}m`;
  return `${(meters / 1_000).toFixed(1)}km`;
}

/** Local wall-clock stamp for history lines (date + HH:MM). */
function formatWhen(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Up to `max` items spread evenly across the list, endpoints included. */
function sampleEvenly<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const out: T[] = [];
  for (let i = 0; i < max; i++) {
    out.push(items[Math.round((i * (items.length - 1)) / (max - 1))]);
  }
  return out;
}

function age(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.round(min / 60);
  return `${hrs}h ago`;
}

/** Clamp a caller-supplied exec timeout (seconds) to the allowed window. */
function clampExecTimeout(value: unknown): number {
  const sec = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(sec) || sec <= 0) return DEFAULT_EXEC_TIMEOUT_MS;
  return Math.min(
    MAX_EXEC_TIMEOUT_MS,
    Math.max(1_000, Math.round(sec * 1_000)),
  );
}

/** Trim a string path param, returning undefined when blank. */
function requirePath(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Render an exec result: exit code headline + stdout/stderr blocks. */
function formatExecResult(
  device: DeviceInfo,
  result: DeviceCommandResult,
): string {
  if (!result.ok && !result.data) {
    return result.message ?? `${device.name} could not run the command.`;
  }
  const d = result.data ?? {};
  const exit = typeof d.exitCode === "number" ? d.exitCode : "?";
  const stdout = typeof d.stdout === "string" ? d.stdout : "";
  const stderr = typeof d.stderr === "string" ? d.stderr : "";
  const via = typeof d.via === "string" && d.via ? ` via ${d.via}` : "";
  const parts = [`[${device.name}${via}] exit ${exit}`];
  if (stdout.trim())
    parts.push(
      `--- stdout ---\n${clampExecOutput(stdout.replace(/\s+$/, ""))}`,
    );
  if (stderr.trim())
    parts.push(
      `--- stderr ---\n${clampExecOutput(stderr.replace(/\s+$/, ""))}`,
    );
  if (!stdout.trim() && !stderr.trim()) parts.push("(no output)");
  return parts.join("\n");
}

/** "12.4 MB/s in 3.2s" — observability for streamed transfers. */
function transferRate(bytes: number, startedAtMs: number): string {
  const seconds = Math.max((Date.now() - startedAtMs) / 1000, 0.001);
  return `${formatBytes(bytes / seconds)}/s over ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Process-wide instance ─────────────────────────────────────────────────────

let instance: MeshService | null = null;

/** The daemon's shared mesh service (lazily created). */
export function getMeshService(): MeshService {
  instance ??= new MeshService();
  return instance;
}

/** Swap the shared instance — composition/test seam. Pass null to reset. */
export function setMeshService(service: MeshService | null): void {
  instance = service;
}
