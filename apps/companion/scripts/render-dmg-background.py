#!/usr/bin/env python3
"""Render the macOS DMG installer background.

Produces assets/dmg/dmg-background.png (660x400, the Finder window size the
companion workflow opens the DMG at) plus a @2x variant for Retina. CI folds
the pair into a multi-resolution TIFF with `tiffutil -cathidpicheck` and hands
it to create-dmg (see .github/workflows/companion.yml, macos package step).

Design notes — learned the hard way:

  - LIGHT background. Finder draws icon labels ("Talon", "Applications")
    in black in light mode with no halo; the first dark-navy design made
    them unreadable. Light field + dark painted text matches how iTerm2/
    VLC/Arc-style DMGs handle it.
  - Drop-zone rings under both icon slots. macOS Tahoe 26.1 has a Finder
    bug where the /Applications symlink icon renders blank in DMGs from
    any tool (create-dmg#202, DropDMG forum reports; partially fixed in
    26.2). The rings keep the layout legible even when the icon vanishes.

Icon slots are pinned by create-dmg at (180, 195) and (480, 195), 128px.
Accent stays the app icon's periwinkle (#6F7FFF family).

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

LIGHT_TOP = (247, 248, 252)
LIGHT_BOTTOM = (232, 234, 242)
ACCENT = (111, 127, 255)
RING = (183, 191, 235)
RING_FILL = (240, 242, 250)
TEXT_PRIMARY = (23, 26, 44)
TEXT_MUTED = (99, 105, 133)
TEXT_FAINT = (139, 145, 170)


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
    im = Image.new("RGB", (w, h), LIGHT_BOTTOM)
    d = ImageDraw.Draw(im)

    # Vertical gradient wash.
    for y in range(h):
        t = y / h
        row = tuple(
            round(LIGHT_TOP[i] + (LIGHT_BOTTOM[i] - LIGHT_TOP[i]) * t)
            for i in range(3)
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

    # Header — dark text on the light field.
    center_text(58 * SCALE, "Talon", font(30 * SCALE, bold=True), TEXT_PRIMARY)
    center_text(
        92 * SCALE,
        "Drag the app into Applications to install",
        font(14 * SCALE),
        TEXT_MUTED,
    )

    # Drop-zone rings under both icon slots: keep the layout readable even
    # when Finder's Tahoe bug blanks the Applications symlink icon.
    ring_r = 76 * SCALE
    lw = 2 * SCALE
    for cx in (APP_X * SCALE, APPS_X * SCALE):
        cy = ICON_Y * SCALE
        d.ellipse(
            [cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r],
            fill=RING_FILL,
            outline=RING,
            width=lw,
        )

    # Drag arrow between the two rings.
    y = ICON_Y * SCALE
    x0 = (APP_X + 88) * SCALE
    x1 = (APPS_X - 88) * SCALE
    alw = 5 * SCALE
    head = 15 * SCALE
    d.line([(x0, y), (x1 - head, y)], fill=ACCENT, width=alw)
    d.polygon(
        [(x1, y), (x1 - head, y - head * 0.62), (x1 - head, y + head * 0.62)],
        fill=ACCENT,
    )

    # Footnote for the unsigned build.
    center_text(
        356 * SCALE,
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
