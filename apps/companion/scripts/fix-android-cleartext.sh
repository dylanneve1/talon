#!/usr/bin/env bash
# Patches the Android manifest with the two fixes a remote-bridge
# connection needs that flutter create's default release manifest lacks:
# the INTERNET permission and cleartext-traffic allowance. (Despite the
# filename -- kept for compat with existing references -- this now fixes
# both; they were two separate bugs that happen to produce the exact same
# Dart-side error text, see AppLog.diagnose() in lib/src/services/log.dart.)
#
# Why this exists:
#  1. Flutter's debug/profile manifests get android.permission.INTERNET
#     merged in automatically (for hot reload / the VM service), but the
#     RELEASE manifest -- what actually ships -- does not. Without it,
#     every socket connect fails at the OS level with errno=1 "Operation
#     not permitted", indistinguishable in the raw error text from a
#     macOS sandbox denial or a cleartext block.
#  2. Since API 28 (Android 9), the platform also blocks cleartext HTTP by
#     default, and the Talon bridge protocol is plain HTTP with no TLS
#     support on the daemon side (see ../README.md).
#
# This is a one-time fix per scaffold -- run it right after
# `flutter create --platforms=android .` if you ever regenerate android/
# from scratch (it's normally committed, see ../README.md).
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

python3 - "$MANIFEST" <<'PYEOF'
import re, sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

changed = False

if "android.permission.INTERNET" not in content:
    m = re.search(r"(<manifest\b[^>]*>)", content)
    if not m:
        print("error: <manifest> tag not found", file=sys.stderr)
        sys.exit(1)
    insert = (
        '\n    <uses-permission android:name="android.permission.INTERNET"/>'
    )
    content = content[: m.end()] + insert + content[m.end() :]
    changed = True
    print("patched: added INTERNET permission")
else:
    print("ok: INTERNET permission already present")

if "usesCleartextTraffic" not in content:
    m = re.search(r"(<application\b)", content)
    if not m:
        print("error: <application> tag not found", file=sys.stderr)
        sys.exit(1)
    content = content[: m.end()] + ' android:usesCleartextTraffic="true"' + content[m.end() :]
    changed = True
    print("patched: added usesCleartextTraffic")
else:
    print("ok: usesCleartextTraffic already present")

if changed:
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
PYEOF

echo "Done. Rebuild with: flutter clean && flutter run -d <android-device>"
echo ""
echo "Note: usesCleartextTraffic=\"true\" allows cleartext to ANY host"
echo "app-wide -- fine for a personal tool talking to your own daemon. If"
echo "you want it scoped to one host instead, replace this with a"
echo "network_security_config.xml allow-list."
