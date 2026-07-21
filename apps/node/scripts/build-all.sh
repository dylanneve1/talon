#!/usr/bin/env bash
# Cross-compile talon-node for every supported target.
#
#   ./scripts/build-all.sh [version] [outdir]
#
# version defaults to the root package.json version + short SHA; outdir
# defaults to ./build. Produces talon-node-<os>-<arch>[.exe] — fully static
# binaries (CGO_ENABLED=0), no runtime dependencies on the target host.
#
# The node's reported version always tracks the Talon version it was
# compiled against: version.txt (embedded fallback) is refreshed from
# package.json here, and the ldflags stamp carries "<version>+<sha>".
set -euo pipefail

cd "$(dirname "$0")/.."

PKG_VERSION=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' ../../package.json | head -1)
SHA=$(git rev-parse --short HEAD 2>/dev/null || echo dev)
VERSION="${1:-${PKG_VERSION:-0.0.0}+${SHA}}"
OUT="${2:-build}"

# Keep the embedded Talon version (bare-build fallback) in sync. The trailing
# annotation lets release-please bump this file on the release PR; consumers
# (main.go, CI) read only the first field.
printf '%s # x-release-please-version\n' "${PKG_VERSION:-0.0.0}" > version.txt

TARGETS=(
  linux/amd64
  linux/arm64
  linux/arm
  darwin/amd64
  darwin/arm64
  windows/amd64
)

mkdir -p "$OUT"
for target in "${TARGETS[@]}"; do
  os="${target%/*}"
  arch="${target#*/}"
  ext=""
  [[ "$os" == "windows" ]] && ext=".exe"
  out="$OUT/talon-node-${os}-${arch}${ext}"
  echo "→ $out"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build \
    -trimpath \
    -ldflags "-s -w -X main.ldflagsVersion=${VERSION}" \
    -o "$out" .
done

echo
echo "Built $(ls "$OUT" | wc -l) binaries (version ${VERSION}):"
ls -lh "$OUT"
