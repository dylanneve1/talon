#!/usr/bin/env bash
# Thin wrapper for POSIX muscle memory — the real builder is the
# platform-neutral Go tool (works on Windows too):
#
#   go run ./tools/build [-version <v>] [-out <dir>] [-targets os/arch,...]
#
set -euo pipefail
cd "$(dirname "$0")/.."
exec go run ./tools/build "$@"
