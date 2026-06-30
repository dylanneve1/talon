#!/usr/bin/env bash
# Patches the Android manifest to allow cleartext (plain HTTP) traffic.
#
# Why this exists: since API 28 (Android 9), the platform blocks all
# cleartext HTTP by default. The Talon bridge protocol is plain HTTP with
# no TLS support on the daemon side (see ../README.md), so without this,
# every remote-bridge connection attempt on Android fails — typically
# surfacing as a SocketException / CleartextNotPermittedException, even
# with a correct host/port/token.
#
# This is a one-time fix per scaffold — `android/` isn't committed (see
# .gitignore), so run this right after `flutter create`.
#
# Usage: from apps/companion/ — ./scripts/fix-android-cleartext.sh

set -euo pipefail
cd "$(dirname "$0")/.."

MANIFEST="android/app/src/main/AndroidManifest.xml"

if [ ! -d android ]; then
  echo "error: android/ not found. Run 'flutter create --platforms=android .' first." >&2
  exit 1
fi

if [ ! -f "$MANIFEST" ]; then
  echo "error: $MANIFEST not found." >&2
  exit 1
fi

if grep -q "usesCleartextTraffic" "$MANIFEST"; then
  echo "ok: $MANIFEST already sets usesCleartextTraffic"
else
  python3 - "$MANIFEST" <<'PYEOF'
import re, sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

# Insert android:usesCleartextTraffic="true" on the <application ...> tag.
pattern = re.compile(r"(<application\b)")
if not pattern.search(content):
    print("error: <application> tag not found", file=sys.stderr)
    sys.exit(1)

content = pattern.sub(r'\1 android:usesCleartextTraffic="true"', content, count=1)
with open(path, "w", encoding="utf-8") as f:
    f.write(content)
print(f"patched: {path}")
PYEOF
fi

echo "Done. Rebuild with: flutter clean && flutter run -d <android-device>"
echo ""
echo "Note: this allows cleartext to ANY host app-wide — fine for a personal"
echo "tool talking to your own daemon. If you want it scoped to one host"
echo "instead, replace this with a network_security_config.xml allow-list."
