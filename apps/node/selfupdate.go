package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// cmdUpdateNode is the headless analogue of the companion's install_apk: a
// remote self-update. The daemon has already streamed the replacement binary
// to `path` (via download_file) and passes its SHA-256; this verifies the
// bytes, atomically swaps the binary in place, and arms an in-place restart
// that fires only AFTER the command result is delivered (see handleCommand).
//
// Robustness mirrors the APK path:
//   - The pushed file is re-hashed here; a mismatch aborts before anything
//     is swapped, so a truncated transfer can never be installed.
//   - The swap is a rename over the running executable — on Unix the live
//     process keeps its open inode, so replacing the file is safe; the new
//     inode is only loaded on the subsequent execve.
//   - The staging copy lands next to the executable, guaranteeing a
//     same-filesystem (atomic) rename regardless of where the daemon pushed.
func cmdUpdateNode(n *Node, params map[string]any) commandResult {
	path, _ := params["path"].(string)
	if path == "" {
		return fail("update_node needs the path of the pushed binary.")
	}
	wantSha, _ := params["sha256"].(string)

	exe, err := ownExecutable()
	if err != nil {
		return fail("update_node: cannot locate own binary: %v", err)
	}
	if err := installUpdate(exe, path, wantSha); err != nil {
		return fail("update_node: %v", err)
	}
	// Best effort: drop the original pushed copy now it's installed.
	if path != exe {
		os.Remove(path)
	}

	n.pendingReexec.Store(true)
	return commandResult{
		OK: true,
		Message: fmt.Sprintf(
			"Update staged at %s — restarting into the new binary now; "+
				"confirm with get_device_status once appVersion changes.", exe,
		),
		Data: map[string]any{"installedTo": exe, "restarting": true},
	}
}

// ownExecutable resolves this process's binary path (symlinks followed).
func ownExecutable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return exe, nil
}

// installUpdate verifies a replacement binary at srcPath against wantSha
// (when given), then atomically swaps it in for the binary at exe. It never
// touches exe until the bytes are staged and verified, so a truncated or
// mismatched payload leaves the running binary untouched. Split out from
// cmdUpdateNode so the swap/verify mechanics are unit-testable without a
// live mesh. Returns nil on success.
func installUpdate(exe, srcPath, wantSha string) error {
	src, err := os.Open(srcPath)
	if err != nil {
		return fmt.Errorf("cannot open %s: %w", srcPath, err)
	}
	defer src.Close()

	// Stage next to the executable so the final rename is same-filesystem.
	staged := filepath.Join(filepath.Dir(exe), ".talon-node-update")
	dst, err := os.OpenFile(staged, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
	if err != nil {
		return fmt.Errorf("cannot stage next to binary: %w", err)
	}
	hasher := sha256.New()
	if _, err := io.Copy(io.MultiWriter(dst, hasher), src); err != nil {
		dst.Close()
		os.Remove(staged)
		return fmt.Errorf("staging copy failed: %w", err)
	}
	if err := dst.Close(); err != nil {
		os.Remove(staged)
		return fmt.Errorf("staging copy failed: %w", err)
	}

	// Integrity gate BEFORE the swap — never install unverified bytes.
	if wantSha != "" {
		got := hex.EncodeToString(hasher.Sum(nil))
		if !strings.EqualFold(got, wantSha) {
			os.Remove(staged)
			return fmt.Errorf(
				"integrity check failed (expected %s, got %s) — aborting",
				wantSha, got,
			)
		}
	}

	// Sanity: refuse an empty payload.
	if info, err := os.Stat(staged); err != nil || info.Size() == 0 {
		os.Remove(staged)
		return fmt.Errorf("staged binary is empty")
	}

	if err := os.Chmod(staged, 0o755); err != nil {
		os.Remove(staged)
		return fmt.Errorf("chmod failed: %w", err)
	}
	if err := swapBinary(staged, exe); err != nil {
		os.Remove(staged)
		return fmt.Errorf("could not replace running binary: %w", err)
	}
	return nil
}
