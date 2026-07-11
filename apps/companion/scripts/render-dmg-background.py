#!/usr/bin/env python3
"""Render the macOS DMG installer background.

Produces assets/dmg/dmg-background.png (660x400, the Finder window size the
companion workflow opens the DMG at) plus a @2x variant for Retina. CI folds
the pair into a multi-resolution TIFF with `tiffutil -cathidpicheck` and hands
it to create-dmg (see .github/workflows/companion.yml, macos package step).

The art matches the app icon: deep navy field (#101220 family) with the
periwinkle accent (#788AFF). It draws the drag-to-Applications arrow between
the two icon slots create-dmg pins at (180, 195) and (480, 195), a short
instruction line, and a footnote about opening an unsigned build.

Pure Pillow — regenerate with:

    pip install pillow && python3 scripts/render-dmg-background.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "assets/dmg"

# Finder window content size (must match --window-size in the workflow).
W, H = 660, 400
SCALE = 2  # render at 2x, downscale for 1x

# Icon slots (centers, 1x coords — must match --icon/--app-drop-link).
APP_X, APPS_X, ICON_Y = 180, 480, 195

NAVY_TOP = (23, 26, 44)
NAVY_BOTTOM = (12, 14, 24)
ACCENT = (120, 135, 255)
TEXT_PRIMARY = (235, 238, 250)
TEXT_MUTED = (150, 156, 185)
TEXT_FAINT = (108, 114, 142)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    names = (
        ["DejaVuSans-Bold.ttf", "Arial Bold.ttf", "Helvetica.ttc"]
        if bold
        else ["DejaVuSans.ttf", "Arial.ttf", "Helvetica.ttc"]
    )
    candidates = [
        p / n
        for n in names
        for p in (
            Path("/usr/share/fonts/truetype/dejavu"),
            Path("/Library/Fonts"),
            Path("/System/Library/Fonts"),
            Path.home() / "Library/Fonts",
        )
    ]
    for c in candidates:
        if c.exists():
            return ImageFont.truetype(str(c), size)
    return ImageFont.load_default(size)  # Pillow >= 10 scalable fallback


def render() -> Image.Image:
    w, h = W * SCALE, H * SCALE
    im = Image.new("RGB", (w, h), NAVY_BOTTOM)
    d = ImageDraw.Draw(im)

    # Vertical gradient wash.
    for y in range(h):
        t = y / h
        row = tuple(
            round(NAVY_TOP[i] + (NAVY_BOTTOM[i] - NAVY_TOP[i]) * t) for i in range(3)
        )
        d.line([(0, y), (w, y)], fill=row)

    def center_text(cy, text, f, fill):
        bbox = d.textbbox((0, 0), text, font=f)
        d.text(
            ((w - (bbox[2] - bbox[0])) / 2, cy - (bbox[3] - bbox[1]) / 2),
            text,
            font=f,
            fill=fill,
        )

    # Header.
    center_text(64 * SCALE, "Talon", font(30 * SCALE, bold=True), TEXT_PRIMARY)
    center_text(
        96 * SCALE,
        "Drag the app into Applications to install",
        font(14 * SCALE),
        TEXT_MUTED,
    )

    # Drag arrow between the two icon slots.
    y = ICON_Y * SCALE
    x0 = (APP_X + 85) * SCALE
    x1 = (APPS_X - 85) * SCALE
    lw = 5 * SCALE
    head = 16 * SCALE
    d.line([(x0, y), (x1 - head, y)], fill=ACCENT, width=lw)
    d.polygon(
        [(x1, y), (x1 - head, y - head * 0.62), (x1 - head, y + head * 0.62)],
        fill=ACCENT,
    )

    # Footnote for the unsigned build.
    center_text(
        352 * SCALE,
        "Unsigned build — on first launch, right-click Talon and choose Open",
        font(11 * SCALE),
        TEXT_FAINT,
    )
    return im


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    two_x = render()
    two_x.save(OUT_DIR / "dmg-background@2x.png")
    two_x.resize((W, H), Image.LANCZOS).save(OUT_DIR / "dmg-background.png")
    print(f"wrote {OUT_DIR}/dmg-background.png and @2x")


if __name__ == "__main__":
    main()
