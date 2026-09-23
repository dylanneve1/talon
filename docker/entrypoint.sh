#!/bin/sh
# Talon container entrypoint.
#
# Runs as whatever user the container was started with — UID 1000 by
# default, or e.g. `user: "568:568"` on TrueNAS, where apps run as the
# `apps` user and own their datasets. It never needs root.
set -eu

# A HOME we can't write means Claude Code can't keep ~/.claude.json and
# Talon can't create ~/.talon. The image makes /home/bun world-writable for
# exactly this case; if someone mounted over it read-only, say so up front
# instead of failing somewhere deep in a backend.
if [ ! -w "$HOME" ]; then
  echo "[entrypoint] WARNING: HOME ($HOME) is not writable by uid $(id -u) — mount a writable volume there" >&2
fi

for dir in "${TALON_HOME:-$HOME/.talon}" "$HOME/.claude" "$HOME/.gemini"; do
  mkdir -p "$dir" 2>/dev/null || true
  if [ -d "$dir" ] && [ ! -w "$dir" ]; then
    echo "[entrypoint] WARNING: $dir is not writable by uid $(id -u):$(id -g) — fix the host path's owner (TrueNAS: set the dataset owner to the app's user)" >&2
  fi
done

# First boot only: turn TALON_* env vars into ~/.talon/config.json.
"${TALON_RUNTIME:-bun}" /app/docker/seed-config.mjs

exec "$@"
