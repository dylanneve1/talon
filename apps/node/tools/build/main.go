// Cross-compile talon-node for every supported target — the platform-neutral
// replacement for the old build-all.sh (which required a POSIX shell).
//
//	go run ./tools/build [-version <v>] [-out <dir>] [-targets os/arch,...]
//
// Run from apps/node (the directory holding go.mod). Produces
// talon-node-<os>-<arch>[.exe] plus a talon-node-SHA256SUMS manifest — the
// digests the daemon verifies when it fetches a binary from a release.
//
// The node's reported version always tracks the Talon version it was
// compiled against: version.txt (the embedded fallback) is refreshed from
// the root package.json here, and the ldflags stamp carries "<version>+<sha>".
package main

import (
	"crypto/sha256"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

// sumsFile is the checksum manifest name; release assets carry it so
// downloaders (the daemon's node-binary resolver) can verify integrity.
const sumsFile = "talon-node-SHA256SUMS"

var defaultTargets = []string{
	"linux/amd64",
	"linux/arm64",
	"linux/arm",
	"darwin/amd64",
	"darwin/arm64",
	"windows/amd64",
}

func main() {
	versionFlag := flag.String("version", "", `full version stamp (default "<package.json version>+<git sha>")`)
	out := flag.String("out", "build", "output directory")
	targets := flag.String("targets", strings.Join(defaultTargets, ","), "comma-separated os/arch list")
	flag.Parse()

	if _, err := os.Stat("go.mod"); err != nil {
		fatalf("run from apps/node (go.mod not found): %v", err)
	}

	pkgVersion, err := packageVersion("../../package.json")
	if err != nil {
		fatalf("read package.json version: %v", err)
	}
	version := *versionFlag
	if version == "" {
		version = pkgVersion + "+" + gitShortSHA()
	}

	// Keep the embedded Talon version (bare-build fallback) in sync. The
	// trailing annotation lets release-please bump this file on the release
	// PR; consumers (main.go, CI) read only the first field.
	if err := os.WriteFile(
		"version.txt",
		[]byte(pkgVersion+" # x-release-please-version\n"),
		0o644,
	); err != nil {
		fatalf("write version.txt: %v", err)
	}

	if err := os.MkdirAll(*out, 0o755); err != nil {
		fatalf("mkdir %s: %v", *out, err)
	}

	sums := make(map[string]string)
	for _, target := range strings.Split(*targets, ",") {
		goos, goarch, ok := strings.Cut(strings.TrimSpace(target), "/")
		if !ok || goos == "" || goarch == "" {
			fatalf("bad target %q (want os/arch)", target)
		}
		name := "talon-node-" + goos + "-" + goarch
		if goos == "windows" {
			name += ".exe"
		}
		dest := filepath.Join(*out, name)
		fmt.Printf("→ %s\n", dest)
		cmd := exec.Command(
			"go", "build",
			"-trimpath",
			"-ldflags", "-s -w -X main.ldflagsVersion="+version,
			"-o", dest, ".",
		)
		cmd.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS="+goos, "GOARCH="+goarch)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			fatalf("build %s: %v", target, err)
		}
		sum, err := fileSHA256(dest)
		if err != nil {
			fatalf("hash %s: %v", dest, err)
		}
		sums[name] = sum
	}

	if err := writeSums(filepath.Join(*out, sumsFile), sums); err != nil {
		fatalf("write %s: %v", sumsFile, err)
	}
	fmt.Printf("\nBuilt %d binaries (version %s) + %s\n", len(sums), version, sumsFile)
}

func packageVersion(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var pkg struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(raw, &pkg); err != nil {
		return "", err
	}
	if pkg.Version == "" {
		return "", fmt.Errorf("no version field in %s", path)
	}
	return pkg.Version, nil
}

func gitShortSHA() string {
	out, err := exec.Command("git", "rev-parse", "--short", "HEAD").Output()
	if err != nil {
		return "dev"
	}
	return strings.TrimSpace(string(out))
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", h.Sum(nil)), nil
}

// writeSums emits the standard "<hex>  <name>" format `sha256sum -c` and the
// daemon's resolver both parse, sorted for a deterministic manifest.
func writeSums(path string, sums map[string]string) error {
	names := make([]string, 0, len(sums))
	for name := range sums {
		names = append(names, name)
	}
	sort.Strings(names)
	var b strings.Builder
	for _, name := range names {
		fmt.Fprintf(&b, "%s  %s\n", sums[name], name)
	}
	return os.WriteFile(path, []byte(b.String()), 0o644)
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
