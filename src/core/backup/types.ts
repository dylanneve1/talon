/**
 * The backup vocabulary — the shapes every other module in this subsystem
 * and every surface above it speaks.
 *
 * `Manifest` is the contract with the future: it is written next to the
 * parts on disk, uploaded last to every remote target (its presence is
 * what marks a remote snapshot complete), and it is the source of truth
 * for a restore. The SQLite index is a cache over these files, never the
 * other way round — a snapshot whose row was lost is still restorable,
 * a row whose directory is gone is not.
 *
 * `BackupSettings` is declared structurally rather than derived from the
 * zod schema in core/config: the config layer imports this subsystem for
 * its defaults, so the type may not travel back the other way.
 */

/** Scheduled and pruned, or deliberate and kept. */
export type SnapshotKind = "backup" | "checkpoint";

/** One compressed file inside a snapshot directory. */
export type SnapshotPart = {
  /** File name within the snapshot directory (also the remote object name). */
  name: string;
  bytes: number;
  sha256: string;
  /**
   * The part's name encodes its content hash, so an identical part in an
   * older snapshot is the same bytes: the local store hard-links it and
   * targets may skip the upload entirely.
   */
  contentAddressed?: boolean;
  /** Written through archive/crypt.ts (name ends in `.enc`). */
  encrypted?: boolean;
};

/** Per-target upload state, mirrored into the `backup_remotes` table. */
export type RemoteState = {
  status: "pending" | "uploaded" | "failed";
  remoteId?: string;
  uploadedAt?: number;
  error?: string;
};

/** Where an `extra/<n>/…` subtree came from, so restore can put it back. */
type ExtraMapping = { n: number; source: string };

export type Manifest = {
  schema: 1;
  id: string;
  kind: SnapshotKind;
  label?: string;
  pinned: boolean;
  /** Epoch ms. */
  createdAt: number;
  host: string;
  talonVersion: string;
  gitHead?: string;
  parts: SnapshotPart[];
  /** Archive-relative roots this snapshot covers — what a restore replaces. */
  includes: string[];
  /** Human-readable exclusion rules, recorded so an old snapshot explains itself. */
  excludes: string[];
  /** `extra/<n>` → absolute source path. */
  extras?: ExtraMapping[];
  /** Tree fingerprint of the palace part, for content-addressed reuse. */
  palaceHash?: string;
  /** Total bytes of all parts. */
  sizeBytes: number;
  remote: Record<string, RemoteState>;
};

/** A snapshot as the listing surfaces show it. */
export type SnapshotSummary = {
  id: string;
  kind: SnapshotKind;
  label?: string;
  pinned: boolean;
  createdAt: number;
  sizeBytes: number;
  /** False when the index has a row but the directory is gone (remote-only). */
  local: boolean;
  remote: Record<string, RemoteState>;
};

/** `config.backup`, with every default already applied. */
export type BackupSettings = {
  enabled: boolean;
  intervalHours: number;
  keepLocal: number;
  keepRemote: number;
  includePalace: boolean;
  workspaceInclude: readonly string[];
  extraPaths: readonly string[];
  /** Unset = every registered target; `[]` = local only. */
  targets?: readonly string[];
  checkpointBeforeUpdate: boolean;
  notifyChatId?: string;
  /** Present = snapshots must be encrypted (see passphrase.ts). */
  encryption?: { passphraseFile?: string };
};
