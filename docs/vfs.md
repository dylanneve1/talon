# VFS — the `talon://` namespace

> Status: **implemented** (`src/core/vfs/`). One rooted, mountable
> namespace over everything the daemon owns — real file stores and
> synthetic views of live state answer the same four operations, in the
> Plan 9 "everything is a file" tradition.

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
formats and their richer dedicated tools (`save_skill` validates, the VFS
write is raw). `home/` deliberately overlaps `skills/`/`scripts/`/`logs/`
(they live inside the workspace) — same files, two names, as on any
filesystem with the tree mounted twice.

**Not a permission layer.** Mounts declare what is mechanically writable
(a registry view has nothing meaningful to write); nothing here restricts
the agent, and nothing should be added that does.

## The address grammar

An address reaches the namespace in one of three spellings, resolved by
one grammar (`Vfs.#parse`) — the grammar is total, so a spelling can never
silently route to the wrong tree:

| Spelling       | Example                       | Interpretation |
| -------------- | ----------------------------- | -------------- |
| scheme         | `talon://home/notes.md`       | always namespace |
| mount-relative | `home/notes.md`               | namespace, routed by first segment |
| OS-absolute    | `<workspace>/notes.md`        | routed through the mount table by containment (longest disk root wins), exactly like a kernel resolving through its mounts |

File-backed mounts carry their disk root (`VfsMount.osRoot`) — the single
fact that makes addresses bidirectional:

- **OS → namespace**: an absolute path inside a mounted directory is the
  same node as its `talon://` spelling and resolves to it. Outside every
  mount, the resolver refuses (`not-found`) and names the mounted disk
  roots — it never guesses.
- **Namespace → OS**: `Vfs.locate(address)` answers where an address
  lives on disk (`undefined` for synthetic nodes). The native
  `read`/`write`/`edit`/`glob`/`search` tools use it, so they accept
  `talon://` addresses: disk-backed nodes operate on the real file,
  synthetic reads are served from the namespace, synthetic mutation
  refuses honestly. Stats carry `osPath`, and the root listing shows each
  mount's disk location.

The one genuine boundary is the shell: `bash` hands paths to the OS, which
has no `talon://`. The mapping is data, not tribal knowledge — the root
listing (`talon ls`, `vfs_list ""`) prints `mount → disk root`, and a
`too-large` read names the disk path to fall back to. Teleported chats
refuse `talon://` addresses outright: the namespace names daemon state,
and a teleported tool's paths belong to the device.

## Reads are bounded

`read` serves UTF-8 text up to 256 KB and refuses binaries (null-byte
sniff) — a namespace read is a context payload, not a file transfer.
Media stays with the media tools.

## Surfaces

- **Tools (gateway actions)** — `vfs_list`, `vfs_read`, `vfs_write`
  (tag `vfs`), available to every backend through the shared action path.
- **HTTP (gateway, 127.0.0.1)** — `GET /vfs/list?path=` and
  `GET /vfs/read?path=`; same trust boundary as `/action`.
- **CLI** — `talon ls [path]` and `talon cat <path>`. A running daemon
  answers with live `proc/`/`plugins/` state; with the daemon down the CLI
  serves the namespace in-process, so file mounts always work.

## Growing the namespace

A mount is ~50 lines against `VfsMount`; the resolver, tools, endpoints,
and CLI come for free. Planned next: read-only sqlite views
(`chats/<id>/history`, `media/`) and a `plugins/` upgrade to config-aware
entries once the plugin manager lands. Synthetic mounts take injected
providers (see `createProcMount`) so they stay testable with fixtures.
