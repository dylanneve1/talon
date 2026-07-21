package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func TestInstallUpdateSwapsBinary(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("swap-in-place semantics differ on windows")
	}
	dir := t.TempDir()
	exe := filepath.Join(dir, "talon-node")
	if err := os.WriteFile(exe, []byte("OLD-BINARY"), 0o755); err != nil {
		t.Fatal(err)
	}
	newBytes := []byte("NEW-BINARY-CONTENT")
	src := filepath.Join(dir, "pushed.bin")
	if err := os.WriteFile(src, newBytes, 0o644); err != nil {
		t.Fatal(err)
	}

	if err := installUpdate(exe, src, sha256Hex(newBytes)); err != nil {
		t.Fatalf("installUpdate: %v", err)
	}
	got, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(newBytes) {
		t.Fatalf("binary not swapped: %q", got)
	}
	// The staging file must not linger.
	if _, err := os.Stat(filepath.Join(dir, ".talon-node-update")); !os.IsNotExist(err) {
		t.Fatal("staging file left behind")
	}
}

func TestInstallUpdateRejectsBadHash(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "talon-node")
	if err := os.WriteFile(exe, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(dir, "pushed.bin")
	if err := os.WriteFile(src, []byte("NEW"), 0o644); err != nil {
		t.Fatal(err)
	}

	err := installUpdate(exe, src, sha256Hex([]byte("DIFFERENT")))
	if err == nil {
		t.Fatal("expected integrity failure")
	}
	// A rejected update must leave the running binary untouched.
	got, _ := os.ReadFile(exe)
	if string(got) != "OLD" {
		t.Fatalf("binary changed on failed update: %q", got)
	}
	if _, err := os.Stat(filepath.Join(dir, ".talon-node-update")); !os.IsNotExist(err) {
		t.Fatal("staging file left behind after rejection")
	}
}

func TestInstallUpdateNoHashAccepts(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("swap-in-place semantics differ on windows")
	}
	dir := t.TempDir()
	exe := filepath.Join(dir, "talon-node")
	os.WriteFile(exe, []byte("OLD"), 0o755) //nolint:errcheck
	src := filepath.Join(dir, "pushed.bin")
	os.WriteFile(src, []byte("NEWER"), 0o644) //nolint:errcheck

	if err := installUpdate(exe, src, ""); err != nil {
		t.Fatalf("installUpdate without hash: %v", err)
	}
	got, _ := os.ReadFile(exe)
	if string(got) != "NEWER" {
		t.Fatalf("binary not swapped: %q", got)
	}
}

func TestVersionResolution(t *testing.T) {
	// Embedded Talon version is the bare-build fallback identity.
	if resolveVersion() == "dev" {
		t.Fatal("version.txt should provide a non-dev fallback")
	}
}
