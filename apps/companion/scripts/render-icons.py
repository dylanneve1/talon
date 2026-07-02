#!/usr/bin/env python3
"""Regenerate every committed launcher-icon PNG from the SVG sources.

The single source of truth for the app icon is assets/icon/talon_icon.svg
(full rounded-square tile) and talon_icon_foreground.svg (transparent bird for
the Android adaptive layer). This renders each committed platform PNG directly
from those SVGs at its native size — the same sizes flutter_launcher_icons
produces — so icon changes don't require a Flutter toolchain, only:

    pip install cairosvg && python3 scripts/render-icons.py

windows/ is gitignored (scaffolded in CI), where flutter_launcher_icons
regenerates the .exe icon from assets/icon/talon_icon.png via
icons-windows.yaml — which this script also refreshes.
"""

from pathlib import Path

import cairosvg

ROOT = Path(__file__).resolve().parent.parent
TILE = ROOT / "assets/icon/talon_icon.svg"
FOREGROUND = ROOT / "assets/icon/talon_icon_foreground.svg"

RES = ROOT / "android/app/src/main/res"
APPICONSET = ROOT / "macos/Runner/Assets.xcassets/AppIcon.appiconset"

TARGETS = [
    # 1024px reference renders (flutter_launcher_icons input; also the README art)
    (TILE, ROOT / "assets/icon/talon_icon.png", 1024),
    (FOREGROUND, ROOT / "assets/icon/talon_icon_foreground.png", 1024),
    # Android legacy launcher mipmaps
    (TILE, RES / "mipmap-mdpi/ic_launcher.png", 48),
    (TILE, RES / "mipmap-hdpi/ic_launcher.png", 72),
    (TILE, RES / "mipmap-xhdpi/ic_launcher.png", 96),
    (TILE, RES / "mipmap-xxhdpi/ic_launcher.png", 144),
    (TILE, RES / "mipmap-xxxhdpi/ic_launcher.png", 192),
    # Android adaptive-icon foreground layer (108dp grid)
    (FOREGROUND, RES / "drawable-mdpi/ic_launcher_foreground.png", 108),
    (FOREGROUND, RES / "drawable-hdpi/ic_launcher_foreground.png", 162),
    (FOREGROUND, RES / "drawable-xhdpi/ic_launcher_foreground.png", 216),
    (FOREGROUND, RES / "drawable-xxhdpi/ic_launcher_foreground.png", 324),
    (FOREGROUND, RES / "drawable-xxxhdpi/ic_launcher_foreground.png", 432),
    # macOS iconset
    *[(TILE, APPICONSET / f"app_icon_{s}.png", s)
      for s in (16, 32, 64, 128, 256, 512, 1024)],
]


def main() -> None:
    for src, dest, size in TARGETS:
        dest.parent.mkdir(parents=True, exist_ok=True)
        cairosvg.svg2png(
            url=str(src),
            write_to=str(dest),
            output_width=size,
            output_height=size,
        )
        print(f"{dest.relative_to(ROOT)} ({size}px)")


if __name__ == "__main__":
    main()
