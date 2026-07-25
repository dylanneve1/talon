package main

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestCappedOutputPassThrough(t *testing.T) {
	var c cappedOutput
	c.Write([]byte("hello "))
	c.Write([]byte("world"))
	if got := c.String(); got != "hello world" {
		t.Fatalf("got %q", got)
	}
}

func TestCappedOutputKeepsHeadAndTail(t *testing.T) {
	var c cappedOutput
	// Fill the head, then stream enough to overflow the tail.
	c.Write([]byte(strings.Repeat("H", execOutputHeadBytes)))
	c.Write([]byte(strings.Repeat("x", execOutputTailBytes)))
	c.Write([]byte(strings.Repeat("y", 10)))
	got := c.String()
	if !strings.HasPrefix(got, "H") {
		t.Fatal("head lost")
	}
	// The tail is load-bearing for teleport's cwd marker: the LAST bytes
	// written must survive truncation verbatim.
	if !strings.HasSuffix(got, strings.Repeat("y", 10)) {
		t.Fatal("tail lost")
	}
	if !strings.Contains(got, "chars truncated") {
		t.Fatal("missing truncation note")
	}
}

func TestExecRoundTrip(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix shell test")
	}
	res := cmdExec(context.Background(), map[string]any{
		"cmd": "echo out; echo err >&2; exit 3",
	})
	if res.OK {
		t.Fatal("exit 3 should not be ok")
	}
	if res.Data["exitCode"] != 3 {
		t.Fatalf("exitCode = %v", res.Data["exitCode"])
	}
	if got := res.Data["stdout"].(string); !strings.Contains(got, "out") {
		t.Fatalf("stdout = %q", got)
	}
	if got := res.Data["stderr"].(string); !strings.Contains(got, "err") {
		t.Fatalf("stderr = %q", got)
	}
}

func TestExecCwd(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix shell test")
	}
	dir := t.TempDir()
	res := cmdExec(context.Background(), map[string]any{
		"cmd": "pwd",
		"cwd": dir,
	})
	if !res.OK {
		t.Fatalf("not ok: %s", res.Message)
	}
	if got := strings.TrimSpace(res.Data["stdout"].(string)); got != dir {
		// macOS TempDir may resolve through /private symlinks.
		if resolved, err := filepath.EvalSymlinks(dir); err != nil || got != resolved {
			t.Fatalf("pwd = %q, want %q", got, dir)
		}
	}
}

// The exit code is read by cmd.Wait(), which must not be allowed to close
// the output pipes while they are still being drained. When it was, this
// round trip intermittently came back with an empty stdout or stderr —
// roughly 1 run in 500, which is exactly often enough to fail a release
// build and not often enough to catch in a single-shot test. Repeat it
// until that is no longer a coin flip.
func TestExecOutputSurvivesExit(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix shell test")
	}
	if testing.Short() {
		t.Skip("repetition test")
	}
	for i := range 400 {
		res := cmdExec(context.Background(), map[string]any{
			"cmd": "echo out; echo err >&2; exit 3",
		})
		if got := res.Data["stdout"].(string); !strings.Contains(got, "out") {
			t.Fatalf("iteration %d: stdout = %q", i, got)
		}
		if got := res.Data["stderr"].(string); !strings.Contains(got, "err") {
			t.Fatalf("iteration %d: stderr = %q", i, got)
		}
		if res.Data["exitCode"] != 3 {
			t.Fatalf("iteration %d: exitCode = %v", i, res.Data["exitCode"])
		}
	}
}

// A backgrounded child inherits the pipes and holds them open after the
// shell exits. The command must still answer — with the output that did
// arrive — rather than blocking on a writer that may outlive the node.
func TestExecReturnsDespiteLingeringWriter(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix shell test")
	}
	start := time.Now()
	res := cmdExec(context.Background(), map[string]any{
		"cmd": "echo immediate; sleep 30 &",
	})
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("blocked on the lingering writer for %s", elapsed)
	}
	if !res.OK {
		t.Fatalf("not ok: %s", res.Message)
	}
	if got := res.Data["stdout"].(string); !strings.Contains(got, "immediate") {
		t.Fatalf("stdout = %q", got)
	}
}

func TestExecTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix shell test")
	}
	res := cmdExec(context.Background(), map[string]any{
		"cmd":       "sleep 30",
		"timeoutMs": 1000,
	})
	if res.OK {
		t.Fatal("timed-out command should not be ok")
	}
	if !strings.Contains(res.Data["stderr"].(string), "[killed: timeout]") {
		t.Fatalf("stderr = %q", res.Data["stderr"])
	}
}

func TestReadWriteFileChunks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "f.bin")
	first := []byte("hello ")
	second := []byte("chunks")

	res := cmdWriteFile(map[string]any{
		"path":     path,
		"base64":   base64.StdEncoding.EncodeToString(first),
		"truncate": true,
	})
	if !res.OK {
		t.Fatalf("write 1: %s", res.Message)
	}
	res = cmdWriteFile(map[string]any{
		"path":   path,
		"base64": base64.StdEncoding.EncodeToString(second),
		"offset": float64(len(first)), // JSON numbers arrive as float64
	})
	if !res.OK {
		t.Fatalf("write 2: %s", res.Message)
	}

	// An out-of-order chunk must be refused, not appended.
	res = cmdWriteFile(map[string]any{
		"path":   path,
		"base64": base64.StdEncoding.EncodeToString([]byte("dup")),
		"offset": float64(len(first)),
	})
	if res.OK {
		t.Fatal("out-of-order chunk accepted")
	}

	res = cmdReadFile(map[string]any{"path": path})
	if !res.OK {
		t.Fatalf("read: %s", res.Message)
	}
	raw, err := base64.StdEncoding.DecodeString(res.Data["base64"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != "hello chunks" {
		t.Fatalf("content = %q", raw)
	}
	if res.Data["eof"] != true {
		t.Fatal("eof not reported")
	}
}

func TestListDirStatDeleteMove(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("abc"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}

	res := cmdListDir(map[string]any{"path": dir})
	if !res.OK {
		t.Fatalf("list: %s", res.Message)
	}
	entries := res.Data["entries"].([]map[string]any)
	if len(entries) != 2 || entries[0]["name"] != "a.txt" || entries[1]["type"] != "dir" {
		t.Fatalf("entries = %v", entries)
	}

	res = cmdStat(map[string]any{"path": filepath.Join(dir, "a.txt")})
	if !res.OK || res.Data["type"] != "file" || res.Data["size"] != int64(3) {
		t.Fatalf("stat = %+v", res)
	}

	res = cmdMove(map[string]any{
		"from": filepath.Join(dir, "a.txt"),
		"to":   filepath.Join(dir, "sub", "b.txt"),
	})
	if !res.OK {
		t.Fatalf("move: %s", res.Message)
	}

	res = cmdDelete(map[string]any{"path": filepath.Join(dir, "sub")})
	if !res.OK {
		t.Fatalf("delete: %s", res.Message)
	}
	if _, err := os.Stat(filepath.Join(dir, "sub")); !os.IsNotExist(err) {
		t.Fatal("sub still exists")
	}
}

func TestDispatchUnknownAlwaysAnswers(t *testing.T) {
	res := dispatch(context.Background(), nil, "install_apk", map[string]any{})
	if res.OK {
		t.Fatal("unknown command should fail cleanly")
	}
	if !strings.Contains(res.Message, "does not support") {
		t.Fatalf("message = %q", res.Message)
	}
}

func TestIntParam(t *testing.T) {
	params := map[string]any{"a": float64(7), "b": "12", "c": true}
	if intParam(params, "a", 0) != 7 ||
		intParam(params, "b", 0) != 12 ||
		intParam(params, "c", 5) != 5 ||
		intParam(params, "missing", 9) != 9 {
		t.Fatal("intParam coercion broken")
	}
}

func TestNormalizeFingerprint(t *testing.T) {
	got := normalizeFingerprint("AA:BB:cc dd")
	if got != "aabbccdd" {
		t.Fatalf("got %q", got)
	}
}
