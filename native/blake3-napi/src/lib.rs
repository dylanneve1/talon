//! blake3-napi — BLAKE3 media hashing as an in-process napi-rs addon.
//!
//! The wasm twin (native/blake3-wasm) stays as the portable fallback,
//! but it pays three taxes the napi addon doesn't:
//!
//!   1. No SIMD: the wasm32 build runs the portable scalar kernel.
//!      Native blake3 dispatches AVX-512/AVX2/SSE/NEON at runtime and
//!      adds rayon work-stealing across cores for large inputs.
//!   2. Copy-in/copy-out: every chunk is staged into wasm linear
//!      memory. The addon hashes JS buffers in place and memory-maps
//!      files (zero copies at all).
//!   3. Event-loop time: wasm `hasher_update` calls run synchronously
//!      on the main thread — hashing a 50 MB video stalls every
//!      frontend. `hash_file_hex` here runs on the libuv thread pool;
//!      the event loop only sees the promise settle.
//!
//! Surface (camelCased by napi-derive on the JS side):
//!
//!   version(): string                      — addon crate version
//!   hashHex(data: Buffer): string          — one-shot, in place
//!   hashFileHex(path: string): Promise<string> — mmap + rayon, off-loop
//!
//! The TS boundary (src/native/blake3.ts) verifies a known digest at
//! load time and silently falls back to wasm if the addon is missing
//! or broken — same optional-binary contract as talon-warden.

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Below this size rayon's split/join overhead outweighs the
/// parallelism (the blake3 crate documents ~128 KiB as the crossover).
const RAYON_THRESHOLD: usize = 128 * 1024;

fn hash_bytes(data: &[u8]) -> blake3::Hash {
    if data.len() >= RAYON_THRESHOLD {
        let mut hasher = blake3::Hasher::new();
        hasher.update_rayon(data);
        hasher.finalize()
    } else {
        blake3::hash(data)
    }
}

/// Addon crate version, surfaced by doctor.
#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// One-shot hash of a JS buffer, in place (no staging copy). Runs on
/// the calling thread: cheap for small inputs, SIMD+rayon for large
/// ones — still ~ms-scale at tens of MB, far below the wasm path's
/// chunk-copy loop.
#[napi]
pub fn hash_hex(data: Buffer) -> String {
    hash_bytes(&data).to_hex().to_string()
}

pub struct HashFile {
    path: String,
}

impl Task for HashFile {
    type Output = String;
    type JsValue = String;

    /// Runs on the libuv thread pool. `update_mmap_rayon` memory-maps
    /// the file and hashes across cores; small files fall back to a
    /// plain read inside the blake3 crate.
    fn compute(&mut self) -> Result<Self::Output> {
        let mut hasher = blake3::Hasher::new();
        hasher
            .update_mmap_rayon(&self.path)
            .map_err(|err| Error::from_reason(format!("blake3 {}: {err}", self.path)))?;
        Ok(hasher.finalize().to_hex().to_string())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Hash a file's contents off the event loop. Rejects (rather than
/// returning a sentinel) on fs errors so the JS caller's try/catch
/// semantics match the wasm streaming path it replaces.
#[napi(ts_return_type = "Promise<string>")]
pub fn hash_file_hex(path: String) -> AsyncTask<HashFile> {
    AsyncTask::new(HashFile { path })
}

// ── Tests ────────────────────────────────────────────────────────────────────
// Pure hashing only — the N-API surface (Buffer marshalling, promise
// settlement, load-time self-verify) is exercised against the real
// .node artifact in src/__tests__/blake3-napi.test.ts.

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const EMPTY_DIGEST: &str =
        "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262";

    #[test]
    fn empty_input_matches_known_vector() {
        assert_eq!(hash_bytes(b"").to_hex().to_string(), EMPTY_DIGEST);
    }

    #[test]
    fn rayon_path_agrees_with_serial_path() {
        // 300 KiB crosses RAYON_THRESHOLD; the parallel and serial
        // kernels must produce the same digest.
        let big: Vec<u8> = (0..300 * 1024).map(|i| (i % 251) as u8).collect();
        assert_eq!(hash_bytes(&big), blake3::hash(&big));
        let small = &big[..1024];
        assert_eq!(hash_bytes(small), blake3::hash(small));
    }

    #[test]
    fn file_hash_agrees_with_buffer_hash() {
        let path = std::env::temp_dir().join(format!(
            "blake3-napi-test-{}.bin",
            std::process::id()
        ));
        let payload: Vec<u8> = (0..200 * 1024).map(|i| (i % 241) as u8).collect();
        std::fs::File::create(&path)
            .and_then(|mut f| f.write_all(&payload))
            .expect("write temp file");

        let mut task = HashFile {
            path: path.to_string_lossy().into_owned(),
        };
        let digest = task.compute().expect("hash file");
        std::fs::remove_file(&path).ok();
        assert_eq!(digest, hash_bytes(&payload).to_hex().to_string());
    }

    #[test]
    fn missing_file_is_an_error_not_a_digest() {
        let mut task = HashFile {
            path: "/nonexistent/never-a-file".into(),
        };
        assert!(task.compute().is_err());
    }
}
