# VFS — the `talon://` namespace

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

## The address grammar

An address is one of exactly **two** spellings, resolved by one grammar
(`Vfs.#parse`) — total, so a spelling can never silently route to the
wrong tree:

| Spelling    | Example                 | Interpretation |
| ----------- | ----------------------- | -------------- |
| scheme      | `talon://home/notes.md` | always namespace |
| OS-absolute | `<workspace>/notes.md`  | routed through the mount table by containment (longest disk root wins), exactly like a kernel resolving through its mounts |

Bare relative paths, the old mount-relative form, and near-miss schemes
(`talon:/x`) are refused with the correction, never guessed at.

File-backed mounts carry their disk root (`VfsMount.osRoot`) — the fact
that makes addresses bidirectional:

- **OS → namespace**: an absolute path inside a mounted directory is the
  same node as its `talon://` spelling and resolves to it. Outside every
  mount, the resolver refuses (`not-found`) and names the mounted disk
  roots — it never guesses.
- **Namespace → OS**: `core/vfs/rewrite.ts` translates addresses to real
  host paths. With FUSE mounted, `talon://` → `~/.talon/ns/` is one total
  prefix substitution (correct inside quotes, pipelines, anywhere);
  fuseless, file mounts map to their disk roots and live views are
  refused with the reason.

There are **no dedicated namespace tools**. The native tools speak
`talon://` natively and then run ordinary fs code on the translated path:

- `bash` — references in the command translate before the shell runs, so
  `ls talon://home` and `cat talon://proc/events | jq .` just work; the
  applied mapping is reported in the result (`↪ talon://home → …`).
- `read` / `write` / `edit` / `glob` / `search` — the path parameter
  translates the same way (`~` also expands, as the shell would).
- Your own terminal — `ls ~/.talon/ns/proc/tasks` works in any shell on
  the host while the daemon runs with FUSE.

Writes to live views fail with the kernel's own `EROFS` — honest errno,
no hand-rolled refusal. Teleported chats refuse `talon://` outright: the
namespace names daemon state, and a teleported tool's paths belong to the
device.

## Reads are bounded (namespace API only)

`Vfs.read` serves UTF-8 text up to 256 KB and refuses binaries (null-byte
sniff) — a namespace read is a context payload, not a file transfer. This
cap applies to the `Vfs` API (and thus the FUSE bridge's synthetic
content); real files reached through translated paths read at native
speed with no cap.

## Growing the namespace

A mount is ~50 lines against `VfsMount`; the resolver, the symlink farm,
FUSE serving, and every tool come for free. Planned next: read-only
sqlite views (`chats/<id>/history`, `media/`) and a `plugins/` upgrade to
config-aware entries once the plugin manager lands. Synthetic mounts take
injected providers (see `createProcMount`) so they stay testable with
fixtures.
