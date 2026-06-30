#!/usr/bin/env bash
# Patches the macOS Runner entitlements with the outbound-network sandbox
# entitlement Flutter's default `flutter create` template omits.
#
# Why this exists: Flutter's macOS scaffold enables App Sandbox
# (com.apple.security.app-sandbox) but does NOT add
# com.apple.security.network.client. Without it, every outbound socket
# (even to a perfectly reachable host/port) is rejected by the OS before
# it leaves the sandbox, surfacing in Dart as:
#
#   ClientException with SocketException: Connection failed
#   (OS Error: Operation not permitted, errno = 1)
#
# This is a one-time fix per scaffold — `macos/` isn't committed (see
# .gitignore), so run this right after `flutter create`.
#
# Usage: from apps/companion/ — ./scripts/fix-macos-entitlements.sh

set -euo pipefail
cd "$(dirname "$0")/.."

ENTITLEMENTS=(
  "macos/Runner/DebugProfile.entitlements"
  "macos/Runner/Release.entitlements"
)

if [ ! -d macos ]; then
  echo "error: macos/ not found. Run 'flutter create --platforms=macos .' first." >&2
  exit 1
fi

patch_one() {
  local file="$1"
  if [ ! -f "$file" ]; then
    echo "warn: $file not found, skipping" >&2
    return
  fi
  if grep -q "com.apple.security.network.client" "$file"; then
    echo "ok: $file already has network.client"
    return
  fi
  python3 - "$file" <<'PYEOF'
import plistlib, sys
path = sys.argv[1]
with open(path, "rb") as f:
    data = plistlib.load(f)
data["com.apple.security.network.client"] = True
with open(path, "wb") as f:
    plistlib.dump(data, f)
print(f"patched: {path}")
PYEOF
}

for f in "${ENTITLEMENTS[@]}"; do
  patch_one "$f"
done

echo "Done. Rebuild with: flutter clean && flutter run -d macos"
