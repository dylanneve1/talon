//! talon-fusefs — the talon:// namespace as a real FUSE filesystem.
//!
//! Mounted over ~/.talon/ns while the daemon runs, so the namespace is
//! one place on disk for every process on the host. The design keeps
//! FUSE off the hot path entirely:
//!
//!   - File-backed mounts (home/, skills/, …) are served as SYMLINKS
//!     to their disk roots. The kernel follows them; file I/O runs at
//!     native speed and never enters this filesystem.
//!   - Synthetic mounts (proc/, plugins/) are answered live from the
//!     JS `Vfs` over a threadsafe-function bridge: the FUSE thread
//!     posts `(id, op, path)` to JS and blocks on a channel until
//!     `reply(id, json)` lands or the timeout fires (EIO). Content is
//!     small, in-memory state — bridge latency is the whole cost.
//!
//! The mount is read-only (`MountOption::RO` — the kernel answers
//! mutation with EROFS before we ever see it) and serves synthetic
//! files with FOPEN_DIRECT_IO: live content has no stable size, and
//! direct I/O makes readers read to EOF instead of trusting a stat
//! that can go stale between getattr and read.
//!
//! Surface (camelCased by napi-derive on the JS side):
//!
//!   version(): string
//!   mount(mountpoint, symlinks, synthetic, onRequest): void  — throws on failure
//!   reply(id: number, json: string): void  — unknown/expired ids ignored
//!   unmount(): void — idempotent
//!
//! The JS boundary (src/native/fusefs.ts) treats a missing or broken
//! addon as "FUSE layer off" — same contract as blake3-napi.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use fuser::{
    consts::FOPEN_DIRECT_IO, BackgroundSession, FileAttr, FileType, Filesystem, MountOption,
    ReplyAttr, ReplyData, ReplyDirectory, ReplyEntry, ReplyOpen, Request, FUSE_ROOT_ID,
};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{
    ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use napi::{Env, JsFunction};
use napi_derive::napi;
use serde::Deserialize;

/// How long one bridge round-trip may take before the kernel caller
/// gets EIO. Long enough for a busy event loop, short enough that a
/// wedged daemon doesn't hang `ls` for its users.
const BRIDGE_TIMEOUT: Duration = Duration::from_secs(5);

/// Kernel cache TTL for entries/attrs. Synthetic state is live, so
/// keep it short; the static root/symlinks tolerate it trivially.
const TTL: Duration = Duration::from_secs(1);

// ── Bridge plumbing ──────────────────────────────────────────────────────────

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

fn pending() -> &'static Mutex<HashMap<u32, mpsc::Sender<String>>> {
    static PENDING: OnceLock<Mutex<HashMap<u32, mpsc::Sender<String>>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn session() -> &'static Mutex<Option<BackgroundSession>> {
    static SESSION: OnceLock<Mutex<Option<BackgroundSession>>> = OnceLock::new();
    SESSION.get_or_init(|| Mutex::new(None))
}

struct BridgeReq {
    id: u32,
    op: &'static str,
    path: String,
}

type Bridge = ThreadsafeFunction<BridgeReq, ErrorStrategy::Fatal>;

/// One synchronous round-trip to JS from the FUSE thread. `None` means
/// the bridge is gone or timed out — callers answer EIO.
fn bridge_call(tsfn: &Bridge, op: &'static str, path: &str) -> Option<serde_json::Value> {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    pending().lock().unwrap().insert(id, tx);
    let status = tsfn.call(
        BridgeReq {
            id,
            op,
            path: path.to_string(),
        },
        ThreadsafeFunctionCallMode::NonBlocking,
    );
    if status != Status::Ok {
        pending().lock().unwrap().remove(&id);
        return None;
    }
    match rx.recv_timeout(BRIDGE_TIMEOUT) {
        Ok(json) => serde_json::from_str(&json).ok(),
        Err(_) => {
            pending().lock().unwrap().remove(&id);
            None
        }
    }
}

#[derive(Deserialize)]
struct StatReply {
    ok: bool,
    #[serde(default)]
    errno: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    size: u64,
    #[serde(default, rename = "mtimeMs")]
    mtime_ms: u64,
}

fn errno_code(name: &Option<String>) -> i32 {
    match name.as_deref() {
        Some("ENOENT") | None => libc::ENOENT,
        Some("EISDIR") => libc::EISDIR,
        Some("ENOTDIR") => libc::ENOTDIR,
        Some("EROFS") => libc::EROFS,
        Some("EFBIG") => libc::EFBIG,
        _ => libc::EIO,
    }
}

// ── The filesystem ───────────────────────────────────────────────────────────

struct TalonFs {
    bridge: Bridge,
    /// Root symlinks: mount name → disk target, plus a stable sorted order.
    symlinks: HashMap<String, String>,
    symlink_names: Vec<String>,
    /// Synthetic mount names (sorted) — everything under them bridges to JS.
    synthetic: Vec<String>,
    /// Path ↔ inode table. Paths are namespace-relative; "" is the root
    /// (FUSE_ROOT_ID). Grows with the synthetic tree, which is small and
    /// bounded by the task table / plugin registry.
    inos: HashMap<String, u64>,
    paths: Vec<String>,
    uid: u32,
    gid: u32,
}

impl TalonFs {
    fn new(
        bridge: Bridge,
        symlinks: Vec<SymlinkSpec>,
        mut synthetic: Vec<String>,
    ) -> Self {
        let mut names: Vec<String> = symlinks.iter().map(|s| s.name.clone()).collect();
        names.sort();
        synthetic.sort();
        TalonFs {
            bridge,
            symlinks: symlinks.into_iter().map(|s| (s.name, s.target)).collect(),
            symlink_names: names,
            synthetic,
            inos: HashMap::new(),
            paths: Vec::new(),
            uid: unsafe { libc::getuid() },
            gid: unsafe { libc::getgid() },
        }
    }

    fn ino_for(&mut self, path: &str) -> u64 {
        if path.is_empty() {
            return FUSE_ROOT_ID;
        }
        if let Some(ino) = self.inos.get(path) {
            return *ino;
        }
        self.paths.push(path.to_string());
        let ino = FUSE_ROOT_ID + self.paths.len() as u64;
        self.inos.insert(path.to_string(), ino);
        ino
    }

    fn path_of(&self, ino: u64) -> Option<&str> {
        if ino == FUSE_ROOT_ID {
            return Some("");
        }
        self.paths
            .get((ino - FUSE_ROOT_ID - 1) as usize)
            .map(String::as_str)
    }

    fn attr(&self, ino: u64, kind: FileType, size: u64, mtime_ms: u64) -> FileAttr {
        let mtime = if mtime_ms > 0 {
            UNIX_EPOCH + Duration::from_millis(mtime_ms)
        } else {
            SystemTime::now()
        };
        FileAttr {
            ino,
            size,
            blocks: size.div_ceil(512),
            atime: mtime,
            mtime,
            ctime: mtime,
            crtime: mtime,
            kind,
            perm: match kind {
                FileType::Directory => 0o555,
                FileType::Symlink => 0o777,
                _ => 0o444,
            },
            nlink: 1,
            uid: self.uid,
            gid: self.gid,
            rdev: 0,
            blksize: 4096,
            flags: 0,
        }
    }

    /// Attr for a path the bridge owns (anything not root / symlink).
    fn bridged_attr(&mut self, path: &str) -> std::result::Result<FileAttr, i32> {
        let value = bridge_call(&self.bridge, "stat", path).ok_or(libc::EIO)?;
        let stat: StatReply = serde_json::from_value(value).map_err(|_| libc::EIO)?;
        if !stat.ok {
            return Err(errno_code(&stat.errno));
        }
        let kind = if stat.kind.as_deref() == Some("dir") {
            FileType::Directory
        } else {
            FileType::RegularFile
        };
        let ino = self.ino_for(path);
        Ok(self.attr(ino, kind, stat.size, stat.mtime_ms))
    }

    fn node_attr(&mut self, path: &str) -> std::result::Result<FileAttr, i32> {
        if path.is_empty() {
            return Ok(self.attr(FUSE_ROOT_ID, FileType::Directory, 0, 0));
        }
        if let Some(target) = self.symlinks.get(path) {
            let size = target.len() as u64;
            let ino = self.ino_for(path);
            return Ok(self.attr(ino, FileType::Symlink, size, 0));
        }
        self.bridged_attr(path)
    }
}

impl Filesystem for TalonFs {
    fn lookup(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, reply: ReplyEntry) {
        let Some(parent_path) = self.path_of(parent).map(str::to_string) else {
            reply.error(libc::ENOENT);
            return;
        };
        let Some(name) = name.to_str() else {
            reply.error(libc::ENOENT);
            return;
        };
        let path = if parent_path.is_empty() {
            name.to_string()
        } else {
            format!("{parent_path}/{name}")
        };
        // Root children that aren't mounts don't exist; below the root
        // only synthetic subtrees reach us (symlinks are kernel-followed).
        if parent == FUSE_ROOT_ID
            && !self.symlinks.contains_key(name)
            && !self.synthetic.iter().any(|s| s == name)
        {
            reply.error(libc::ENOENT);
            return;
        }
        match self.node_attr(&path) {
            Ok(attr) => reply.entry(&TTL, &attr, 0),
            Err(code) => reply.error(code),
        }
    }

    fn getattr(&mut self, _req: &Request<'_>, ino: u64, _fh: Option<u64>, reply: ReplyAttr) {
        let Some(path) = self.path_of(ino).map(str::to_string) else {
            reply.error(libc::ENOENT);
            return;
        };
        match self.node_attr(&path) {
            Ok(attr) => reply.attr(&TTL, &attr),
            Err(code) => reply.error(code),
        }
    }

    fn readlink(&mut self, _req: &Request<'_>, ino: u64, reply: ReplyData) {
        let Some(path) = self.path_of(ino) else {
            reply.error(libc::ENOENT);
            return;
        };
        match self.symlinks.get(path) {
            Some(target) => reply.data(target.as_bytes()),
            None => reply.error(libc::EINVAL),
        }
    }

    fn open(&mut self, _req: &Request<'_>, _ino: u64, flags: i32, reply: ReplyOpen) {
        // Belt and braces — MountOption::RO already has the kernel
        // answering mutation with EROFS.
        if flags & (libc::O_WRONLY | libc::O_RDWR) != 0 {
            reply.error(libc::EROFS);
            return;
        }
        reply.opened(0, FOPEN_DIRECT_IO);
    }

    fn read(
        &mut self,
        _req: &Request<'_>,
        ino: u64,
        _fh: u64,
        offset: i64,
        size: u32,
        _flags: i32,
        _lock_owner: Option<u64>,
        reply: ReplyData,
    ) {
        let Some(path) = self.path_of(ino).map(str::to_string) else {
            reply.error(libc::ENOENT);
            return;
        };
        let Some(value) = bridge_call(&self.bridge, "read", &path) else {
            reply.error(libc::EIO);
            return;
        };
        #[derive(Deserialize)]
        struct ReadReply {
            ok: bool,
            #[serde(default)]
            errno: Option<String>,
            #[serde(default)]
            data: String,
        }
        let Ok(parsed) = serde_json::from_value::<ReadReply>(value) else {
            reply.error(libc::EIO);
            return;
        };
        if !parsed.ok {
            reply.error(errno_code(&parsed.errno));
            return;
        }
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(parsed.data) else {
            reply.error(libc::EIO);
            return;
        };
        let start = (offset.max(0) as usize).min(bytes.len());
        let end = (start + size as usize).min(bytes.len());
        reply.data(&bytes[start..end]);
    }

    fn readdir(
        &mut self,
        _req: &Request<'_>,
        ino: u64,
        _fh: u64,
        offset: i64,
        mut reply: ReplyDirectory,
    ) {
        let Some(path) = self.path_of(ino).map(str::to_string) else {
            reply.error(libc::ENOENT);
            return;
        };

        // (name, kind) for every child, in stable order.
        let children: Vec<(String, FileType)> = if path.is_empty() {
            let mut out: Vec<(String, FileType)> = Vec::new();
            for name in &self.symlink_names {
                out.push((name.clone(), FileType::Symlink));
            }
            for name in &self.synthetic {
                out.push((name.clone(), FileType::Directory));
            }
            out
        } else {
            let Some(value) = bridge_call(&self.bridge, "list", &path) else {
                reply.error(libc::EIO);
                return;
            };
            #[derive(Deserialize)]
            struct ListReply {
                ok: bool,
                #[serde(default)]
                errno: Option<String>,
                #[serde(default)]
                entries: Vec<ListEntry>,
            }
            #[derive(Deserialize)]
            struct ListEntry {
                name: String,
                kind: String,
            }
            let Ok(parsed) = serde_json::from_value::<ListReply>(value) else {
                reply.error(libc::EIO);
                return;
            };
            if !parsed.ok {
                reply.error(errno_code(&parsed.errno));
                return;
            }
            parsed
                .entries
                .into_iter()
                .map(|entry| {
                    let kind = if entry.kind == "dir" {
                        FileType::Directory
                    } else {
                        FileType::RegularFile
                    };
                    (entry.name, kind)
                })
                .collect()
        };

        let mut all: Vec<(u64, FileType, String)> = Vec::with_capacity(children.len() + 2);
        all.push((ino, FileType::Directory, ".".to_string()));
        all.push((FUSE_ROOT_ID, FileType::Directory, "..".to_string()));
        for (name, kind) in children {
            let child_path = if path.is_empty() {
                name.clone()
            } else {
                format!("{path}/{name}")
            };
            let child_ino = self.ino_for(&child_path);
            all.push((child_ino, kind, name));
        }

        for (index, (entry_ino, kind, name)) in
            all.into_iter().enumerate().skip(offset.max(0) as usize)
        {
            if reply.add(entry_ino, (index + 1) as i64, kind, name) {
                break; // buffer full — the kernel comes back with a new offset
            }
        }
        reply.ok();
    }
}

// ── N-API surface ────────────────────────────────────────────────────────────

/// Addon crate version, surfaced by doctor and the load-time check.
#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[napi(object)]
pub struct SymlinkSpec {
    pub name: String,
    pub target: String,
}

/// Mount the namespace. Returns once the kernel accepted the mount;
/// throws on any failure (no /dev/fuse, no fusermount, busy
/// mountpoint, double mount). The session then runs on its own thread
/// until `unmount`.
#[napi(
    ts_args_type = "mountpoint: string, symlinks: Array<SymlinkSpec>, synthetic: Array<string>, onRequest: (id: number, op: string, path: string) => void"
)]
pub fn mount(
    env: Env,
    mountpoint: String,
    symlinks: Vec<SymlinkSpec>,
    synthetic: Vec<String>,
    on_request: JsFunction,
) -> Result<()> {
    let mut slot = session().lock().unwrap();
    if slot.is_some() {
        return Err(Error::from_reason("talon-fusefs: already mounted"));
    }

    let mut tsfn: Bridge = on_request.create_threadsafe_function(0, |ctx| {
        let req: BridgeReq = ctx.value;
        Ok(vec![
            ctx.env.create_uint32(req.id)?.into_unknown(),
            ctx.env.create_string(req.op)?.into_unknown(),
            ctx.env.create_string(&req.path)?.into_unknown(),
        ])
    })?;
    // The bridge must not keep the event loop alive by itself — the
    // daemon owns the lifecycle and unmounts on shutdown.
    tsfn.unref(&env)?;

    let fs = TalonFs::new(tsfn, symlinks, synthetic);
    // No AutoUnmount: fuser implements it by adding allow_other, which
    // fusermount refuses unless /etc/fuse.conf opts in system-wide. A
    // daemon that dies uncleanly leaves a stale mount instead, and the
    // TS lifecycle detects (ENOTCONN) and lazy-unmounts it at next boot.
    let options = [MountOption::RO, MountOption::FSName("talon".to_string())];
    let background = fuser::spawn_mount2(fs, &mountpoint, &options)
        .map_err(|err| Error::from_reason(format!("talon-fusefs mount: {err}")))?;
    *slot = Some(background);
    Ok(())
}

/// Answer a bridge request. Unknown or expired ids are ignored — the
/// FUSE side already answered EIO for those.
#[napi]
pub fn reply(id: u32, json: String) {
    if let Some(tx) = pending().lock().unwrap().remove(&id) {
        let _ = tx.send(json);
    }
}

/// Tear the mount down. Idempotent; joins the session thread.
#[napi]
pub fn unmount() {
    let taken = session().lock().unwrap().take();
    drop(taken);
    // Wake anything still parked on the bridge so the session thread
    // can't be held hostage by a reply that will never come.
    pending().lock().unwrap().clear();
}

// ── Tests ────────────────────────────────────────────────────────────────────
// Pure logic only — the mounted behaviour (kernel round-trips, symlink
// following, direct-io reads, EROFS) is exercised against the real
// artifact in src/__tests__/fusefs-live.test.ts.

#[cfg(test)]
mod tests {
    use super::*;

    fn errno_of(name: &str) -> i32 {
        errno_code(&Some(name.to_string()))
    }

    #[test]
    fn errno_names_map_to_libc_codes() {
        assert_eq!(errno_of("ENOENT"), libc::ENOENT);
        assert_eq!(errno_of("EISDIR"), libc::EISDIR);
        assert_eq!(errno_of("ENOTDIR"), libc::ENOTDIR);
        assert_eq!(errno_of("EROFS"), libc::EROFS);
        assert_eq!(errno_of("EFBIG"), libc::EFBIG);
        assert_eq!(errno_of("EWHATEVER"), libc::EIO);
        assert_eq!(errno_code(&None), libc::ENOENT);
    }

    #[test]
    fn stat_reply_parses_with_defaults() {
        let stat: StatReply =
            serde_json::from_str(r#"{"ok":true,"kind":"file","size":12,"mtimeMs":3000}"#).unwrap();
        assert!(stat.ok);
        assert_eq!(stat.kind.as_deref(), Some("file"));
        assert_eq!(stat.size, 12);
        assert_eq!(stat.mtime_ms, 3000);

        let err: StatReply = serde_json::from_str(r#"{"ok":false,"errno":"ENOENT"}"#).unwrap();
        assert!(!err.ok);
        assert_eq!(errno_code(&err.errno), libc::ENOENT);
    }

    #[test]
    fn unknown_reply_ids_are_ignored() {
        reply(999_999, "{}".to_string());
    }
}
