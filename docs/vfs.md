# VFS — the `~/.talon/ns` namespace

> Status: **implemented** (`src/core/vfs/`). One rooted, mountable
> namespace over everything the daemon owns — real file stores and
> synthetic views of live state answer the same four operations, in the
> Plan 9 "everything is a file" tradition. The namespace is a real
> filesystem location: `~/.talon/ns/`.

## The model

A **mount** is one store exposed under a single-segment name. The resolver
owns the path discipline (scheme stripping, `/` separators on every
platform, traversal rejection, routing by first segment); mounts only ever
see clean mount-relative paths and answer `stat / list / read / write?`.
Every operation returns a result with an errno-style code (`not-found`,
`is-a-directory`, `not-writable`, `too-large`, `binary-file`, …) — no
throws across the seam.

| Mount      | Backing                                   | Writable |
| ---------- | ----------------------------------------- | -------- |
| `home/`    | the workspace (agent's home directory)    | yes      |
| `skills/`  | SKILL.md bundles (`workspace/skills/`)    | yes      |
| `scripts/` | agent script bodies                       | yes      |
| `logs/`    | daily interaction logs                    | no — daemon-written |
| `proc/`    | task table (`proc/tasks/<id>`) + event bus ring (`proc/events`) | no — synthetic |
| `plugins/` | plugin registry view, one JSON file each  | no — synthetic |

The synthetic mounts are the point: `proc/` is the only way to read live
daemon state as plain files (`proc/tasks/17` is one task record as pretty
JSON; `proc/events` is the bus ring as JSON Lines). Content-free by the
same contract as the task table and bus — ids, kinds, labels, never
message text.

The namespace unifies access; it does not move data. Stores keep their
formats and their richer dedicated tools (`save_skill` validates, a raw
`write` doesn't). `home/` deliberately overlaps `skills/`/`scripts/`/`logs/`
(they live inside the workspace) — same files, two names, as on any
filesystem with the tree mounted twice.

**Not a permission layer.** Mounts declare what is mechanically writable
(a registry view has nothing meaningful to write); nothing here restricts
the agent, and nothing should be added that does.

## The namespace on disk — `~/.talon/ns/`

The namespace is not an API you query; it is a place on the filesystem.

- **Symlink farm** (`core/vfs/nsdir.ts`, always): one symlink per
  file-backed mount — `~/.talon/ns/home → ~/.talon/workspace`, etc. Synced
  at daemon boot; idempotent; owns only symlinks (foreign entries are
  reported, never touched).
- **FUSE layer** (`core/vfs/fusefs.ts` + `native/talon-fusefs`, while the
  daemon runs): mounts over `~/.talon/ns` and adds the live views. File
  mounts are served as symlinks — the kernel follows them, so heavy file
  I/O never crosses FUSE. Synthetic subtrees are answered live from the
  JS `Vfs` over a threadsafe callback bridge. Read-only, `direct_io` (live
  content has no stable size). A daemon that dies uncleanly leaves a stale
  mount; the next boot detects it (ENOTCONN) and lazy-unmounts first.

Like `/proc`, the live views exist only while the daemon (with FUSE) is
up. Config: `fuse: "auto" | "off"` (default auto). `"auto"` degrades —
non-Linux host, missing `/dev/fuse`, missing addon, a failing mount or a
failed post-mount sanity check all land fuseless with a logged reason and
the symlink farm intact. There is no half-mounted state.

**Deadlock rule**: the daemon process must never do *synchronous* fs I/O
under `~/.talon/ns` — sync blocks the one JS thread that answers the FUSE
bridge. Async fs and child processes are always safe; tools resolve
addresses accordingly.

## Addressing — real paths, no scheme

The namespace is reached by its **real path**: `~/.talon/ns/<mount>/…`.
That path is real in every configuration — a symlink into the store when
fuseless, a FUSE view when mounted — so it works everywhere a path works:
the native tools, a bare shell, another backend's built-in shell (e.g.
Codex), your own terminal, any spawned child process. There is **no
tool-facing address scheme and nothing to translate** — the real path is
the address.

- `bash` — `ls ~/.talon/ns/home`, `cat ~/.talon/ns/proc/events | jq .`.
- `read` / `write` / `edit` / `glob` / `search` — the path parameter is an
  ordinary real path (`~` expands, as the shell would).
- Your own terminal — `ls ~/.talon/ns/proc/tasks` works in any shell on
  the host while the daemon runs with FUSE.

Internally the `Vfs` resolver (`Vfs.#parse`) still understands two
spellings, so the FUSE layer and OS→namespace routing have a grammar to
work in — but these are **implementation details, never tool inputs**:

| Spelling    | Example                 | Interpretation |
| ----------- | ----------------------- | -------------- |
| scheme      | `talon://home/notes.md` | namespace-interpreted — internal to the resolver / FUSE bridge only |
| OS-absolute | `<workspace>/notes.md`  | routed through the mount table by containment (longest disk root wins), exactly like a kernel resolving through its mounts |

File-backed mounts carry their disk root (`VfsMount.osRoot`), which is
what lets an absolute path inside a mounted directory resolve to the same
node (the OS→namespace direction, used by the FUSE layer). Outside every
mount the resolver refuses (`not-found`) and names the mounted disk roots.

Live views (`proc/`, `plugins/`) exist only while FUSE is mounted;
fuseless, those paths simply don't exist (ENOENT), exactly like `/proc`
before it is mounted. Writes to live views fail with the kernel's own
`EROFS` — honest errno, no hand-rolled refusal. Teleported chats address
the device's own filesystem by its real paths.

> **History:** a `talon://` URI scheme was once a first-class tool input,
> translated to real paths by a `core/vfs/rewrite.ts` seam. Once the
> symlink farm made `~/.talon/ns/<mount>` a real path in *every* config,
> that translation became redundant with the real path — and it only ever
> worked inside Talon's own native tools (it broke in other backends'
> shells and any spawned process). The scheme was removed as a consumer
> address; it survives only as the resolver's internal grammar.

## Reads are bounded (namespace API only)

`Vfs.read` serves UTF-8 text up to 256 KB and refuses binaries (null-byte
sniff) — a namespace read is a context payload, not a file transfer. This
cap applies to the `Vfs` API (and thus the FUSE bridge's synthetic
content); real files reached through their real paths read at native
speed with no cap.

## Growing the namespace

A mount is ~50 lines against `VfsMount`; the resolver, the symlink farm,
FUSE serving, and every tool come for free. Planned next: read-only
sqlite views (`chats/<id>/history`, `media/`) and a `plugins/` upgrade to
config-aware entries once the plugin manager lands. Synthetic mounts take
injected providers (see `createProcMount`) so they stay testable with
fixtures.
