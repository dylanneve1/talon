/**
 * Remote targets — the core half of the backup plugin protocol.
 *
 * A target is any loaded plugin that answers `backup.target.describe`.
 * Core never learns what a target is made of: it hands over an absolute
 * path and a manifest and gets an opaque remote id back, so Drive, an
 * S3 bucket or an rclone remote are the same object here. The wire
 * vocabulary (see docs/backups.md) is fixed and shared with the plugins
 * that implement it:
 *
 *   backup.target.describe         → { id, name, ready, detail? }
 *   backup.target.upload           → { remoteId, deduplicated? }
 *   backup.target.upload_manifest  → { remoteId }        (always last)
 *   backup.target.list             → { snapshots: [...] }
 *   backup.target.delete           → ok
 *   backup.target.download         → ok
 *
 * `chatId` is the string `"system"`: these calls belong to the daemon,
 * not to a conversation. The manifest is uploaded last on purpose — its
 * presence on the remote is what marks a snapshot complete, so an upload
 * interrupted halfway can never be mistaken for a restorable backup.
 */

import { handlePluginActionIn, pluginsWithActions } from "../plugin/index.js";
import { logWarn } from "../../util/log.js";
import { TalonError } from "../errors.js";
import type { ActionResult } from "../types.js";
import type { Manifest, SnapshotPart } from "./types.js";

/** The daemon's chat id for plugin actions that belong to no conversation. */
const SYSTEM_CHAT = "system";

/** A part as the upload call describes it: metadata plus where to read it. */
type UploadPart = SnapshotPart & { path: string };

/** One snapshot as a target reports it. */
type RemoteSnapshot = {
  snapshotId: string;
  manifest: Manifest;
  parts: Array<{ name: string; remoteId?: string; bytes: number }>;
};

export interface BackupTarget {
  readonly id: string;
  readonly name: string;
  /** False when the target is configured but cannot accept uploads yet. */
  readonly ready: boolean;
  /** Why it is not ready, in the target's own words. */
  readonly detail?: string;
  upload(
    snapshotId: string,
    part: UploadPart,
    manifest: Manifest,
  ): Promise<{ remoteId: string; deduplicated?: boolean }>;
  uploadManifest(
    snapshotId: string,
    manifest: Manifest,
  ): Promise<{ remoteId: string }>;
  list(): Promise<RemoteSnapshot[]>;
  remove(snapshotId: string): Promise<void>;
  download(
    snapshotId: string,
    partName: string,
    destPath: string,
  ): Promise<void>;
}

/** Sends one protocol body to one plugin. Replaced wholesale in tests. */
type TargetDispatch = (
  plugin: string,
  body: Record<string, unknown>,
) => Promise<ActionResult | null>;

export type TargetDeps = {
  /** Plugins to ask, in load order. */
  plugins: () => string[];
  dispatch: TargetDispatch;
};

/**
 * Both members are wrapped rather than referenced directly, so the plugin
 * module's exports are read when a target is actually used and not while
 * this module is being evaluated. Backup reaches a lot of the tree — via
 * the scheduler, the gateway imports it transitively — so a module-scope
 * read here means every test that partially mocks `core/plugin` has to
 * know to include these two exports or fail at import time, nowhere near
 * anything it was testing.
 */
const defaultDeps: TargetDeps = {
  plugins: () => pluginsWithActions(),
  dispatch: (plugin, body) => handlePluginActionIn(plugin, body, SYSTEM_CHAT),
};

function targetError(
  target: string,
  action: string,
  detail: string,
): TalonError {
  return new TalonError(`${target}: ${action} failed — ${detail}`, {
    reason: "unknown",
  });
}

/** Unwrap `{ ok, data }`, turning every failure shape into one error. */
function dataOf(
  result: ActionResult | null,
  target: string,
  action: string,
): Record<string, unknown> {
  if (!result) throw targetError(target, action, "plugin did not answer");
  if (!result.ok) {
    throw targetError(target, action, String(result.error ?? "unknown error"));
  }
  const data = result.data;
  return typeof data === "object" && data !== null
    ? (data as Record<string, unknown>)
    : {};
}

/** A target backed by one plugin. */
class PluginTarget implements BackupTarget {
  constructor(
    private readonly plugin: string,
    private readonly deps: TargetDeps,
    readonly id: string,
    readonly name: string,
    readonly ready: boolean,
    readonly detail?: string,
  ) {}

  private send(body: Record<string, unknown>): Promise<ActionResult | null> {
    return this.deps.dispatch(this.plugin, body);
  }

  async upload(
    snapshotId: string,
    part: UploadPart,
    manifest: Manifest,
  ): Promise<{ remoteId: string; deduplicated?: boolean }> {
    const data = dataOf(
      await this.send({
        action: "backup.target.upload",
        snapshotId,
        part,
        manifest,
      }),
      this.id,
      "upload",
    );
    const remoteId = typeof data.remoteId === "string" ? data.remoteId : "";
    if (!remoteId) throw targetError(this.id, "upload", "no remoteId returned");
    return { remoteId, deduplicated: data.deduplicated === true };
  }

  async uploadManifest(
    snapshotId: string,
    manifest: Manifest,
  ): Promise<{ remoteId: string }> {
    const data = dataOf(
      await this.send({
        action: "backup.target.upload_manifest",
        snapshotId,
        manifest,
      }),
      this.id,
      "upload_manifest",
    );
    const remoteId = typeof data.remoteId === "string" ? data.remoteId : "";
    if (!remoteId) {
      throw targetError(this.id, "upload_manifest", "no remoteId returned");
    }
    return { remoteId };
  }

  async list(): Promise<RemoteSnapshot[]> {
    const data = dataOf(
      await this.send({ action: "backup.target.list" }),
      this.id,
      "list",
    );
    const snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];
    return snapshots.flatMap((entry) => {
      const row = entry as Partial<RemoteSnapshot>;
      if (typeof row.snapshotId !== "string" || !row.manifest) return [];
      return [
        {
          snapshotId: row.snapshotId,
          manifest: row.manifest,
          parts: Array.isArray(row.parts) ? row.parts : [],
        },
      ];
    });
  }

  async remove(snapshotId: string): Promise<void> {
    dataOf(
      await this.send({ action: "backup.target.delete", snapshotId }),
      this.id,
      "delete",
    );
  }

  async download(
    snapshotId: string,
    partName: string,
    destPath: string,
  ): Promise<void> {
    dataOf(
      await this.send({
        action: "backup.target.download",
        snapshotId,
        part: { name: partName },
        destPath,
      }),
      this.id,
      "download",
    );
  }
}

/**
 * Ask every loaded plugin whether it is a backup target. A plugin that is
 * not one answers null and is skipped; one that answers badly is logged
 * and skipped, because a misbehaving plugin must not stop the backup that
 * the other targets (and the local store) can still complete.
 */
export async function discoverTargets(
  deps: TargetDeps = defaultDeps,
): Promise<BackupTarget[]> {
  const targets: BackupTarget[] = [];
  for (const plugin of deps.plugins()) {
    let result: ActionResult | null;
    try {
      result = await deps.dispatch(plugin, {
        action: "backup.target.describe",
      });
    } catch (err) {
      logWarn(
        "backup",
        `Plugin ${plugin} failed to describe itself: ${String(err)}`,
      );
      continue;
    }
    if (!result) continue; // not a backup target
    if (!result.ok) {
      logWarn(
        "backup",
        `Plugin ${plugin} describe error: ${String(result.error)}`,
      );
      continue;
    }
    const data = (result.data ?? {}) as Record<string, unknown>;
    const id = typeof data.id === "string" ? data.id : "";
    if (!id) {
      logWarn("backup", `Plugin ${plugin} answered describe without an id`);
      continue;
    }
    targets.push(
      new PluginTarget(
        plugin,
        deps,
        id,
        typeof data.name === "string" ? data.name : id,
        data.ready === true,
        typeof data.detail === "string" ? data.detail : undefined,
      ),
    );
  }
  return targets;
}

/** The targets this run should use: config order wins, unknown ids are dropped. */
export function selectTargets(
  available: readonly BackupTarget[],
  configured: readonly string[] | undefined,
): BackupTarget[] {
  if (configured === undefined) return [...available];
  return configured.flatMap((id) =>
    available.filter((target) => target.id === id),
  );
}
