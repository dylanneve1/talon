/**
 * Atomic multi-file auth state for Baileys — a drop-in replacement for
 * `useMultiFileAuthState` with two hardening changes ported from how
 * OpenClaw persists WhatsApp credentials:
 *
 *   1. Every write is ATOMIC (tmp + rename via write-file-atomic). The
 *      upstream helper uses a bare `writeFile`, so a daemon restart or
 *      crash mid-write tears creds.json or a signal-key file. A torn
 *      signal key is invisible until the server starts rejecting stanzas
 *      ("smax-invalid: stanza rejected — likely stale device"), which is
 *      the documented prelude to WhatsApp unlinking the device — the
 *      exact sequence the live deployment logged before its
 *      `device_removed` conflict.
 *   2. Writes to the same file are serialized through a promise chain,
 *      and `flushAuthWrites()` lets shutdown drain the queue before the
 *      process exits, so `talon stop` can't strand a half-persisted key.
 *
 * The on-disk format is byte-compatible with upstream: same folder, same
 * file names, same BufferJSON encoding — existing auth dirs just work.
 */

import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { BufferJSON, initAuthCreds, proto } from "baileys";
import type { AuthenticationState, SignalDataTypeMap } from "baileys";

/** file path → tail of its write chain. Module-level: one dir per process. */
const writeTails = new Map<string, Promise<void>>();

function enqueueWrite(
  filePath: string,
  task: () => Promise<void>,
): Promise<void> {
  const tail = (writeTails.get(filePath) ?? Promise.resolve())
    .catch(() => {})
    .then(task);
  writeTails.set(
    filePath,
    tail.catch(() => {}),
  );
  return tail;
}

/** Resolve when every queued auth write has settled. Call before exit. */
export async function flushAuthWrites(): Promise<void> {
  await Promise.allSettled(writeTails.values());
}

/** Baileys' name mangling, kept identical for on-disk compatibility. */
function fixFileName(file: string): string {
  return file.replace(/\//g, "__").replace(/:/g, "-");
}

export async function useAtomicAuthState(folder: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  const info = await stat(folder).catch(() => undefined);
  if (info && !info.isDirectory()) {
    throw new Error(`not a directory: ${folder}`);
  }
  if (!info) await mkdir(folder, { recursive: true });

  const writeData = (data: unknown, file: string): Promise<void> => {
    const filePath = join(folder, fixFileName(file));
    return enqueueWrite(filePath, () =>
      writeFileAtomic(filePath, JSON.stringify(data, BufferJSON.replacer)),
    );
  };

  const readData = async (file: string): Promise<unknown> => {
    const filePath = join(folder, fixFileName(file));
    // Reads wait for any pending write to that file, so a get() racing a
    // set() sees the new value rather than the old file.
    await (writeTails.get(filePath) ?? Promise.resolve()).catch(() => {});
    try {
      const raw = await readFile(filePath, "utf-8");
      return JSON.parse(raw, BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  const removeData = (file: string): Promise<void> => {
    const filePath = join(folder, fixFileName(file));
    return enqueueWrite(filePath, async () => {
      await unlink(filePath).catch(() => {});
    });
  };

  const creds =
    ((await readData("creds.json")) as ReturnType<
      typeof initAuthCreds
    > | null) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(
          type: T,
          ids: string[],
        ) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}.json`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value as SignalDataTypeMap[T];
            }),
          );
          return data;
        },
        set: async (data) => {
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            const entries = data[category as keyof SignalDataTypeMap];
            for (const id in entries) {
              const value = entries[id];
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, "creds.json"),
  };
}
