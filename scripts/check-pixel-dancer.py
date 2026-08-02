#!/usr/bin/env python3
"""Verify the pixel-dancer GIF: frame count, palette presence, pose motion."""

import sys

from PIL import Image
import numpy as np

PAL = {
    "R": (255, 93, 93),
    "D": (43, 64, 100),
    "B": (74, 111, 165),
    "L": (143, 179, 224),
    "E": (126, 240, 255),
    "G": (255, 209, 102),
    "W": (255, 255, 255),
    "M": (28, 32, 52),
}
SCALE = 12

# mirrors the generator
FRAMES = [
    ("up", "down", 0, "L"),
    ("down", "up", -1, "R"),
    ("up", "up", 0, "L"),
    ("up", "down", 1, "R"),
    ("down", "up", 0, "L"),
    ("out", "out", -1, "R"),
    ("up", "down", 0, "L"),
    ("up", "up", 1, "L"),
]


def near(arr, target, tol=40):
    return int(
        (np.abs(np.asarray(arr, dtype=int) - np.array(target)).sum(axis=2) < tol).sum()
    )


def main(path):
    gif = Image.open(path)
    n = getattr(gif, "n_frames", 1)
    ok = True
    print(f"frames: {n} (expected 8)")
    ok &= n == 8

    frames = []
    for i in range(n):
        gif.seek(i)
        frames.append(np.array(gif.convert("RGB")))

    W, H = frames[0].shape[1], frames[0].shape[0]
    print(f"size: {W}x{H} (expected {48 * SCALE}x{56 * SCALE})")
    ok &= (W, H) == (48 * SCALE, 56 * SCALE)

    # canvas pixel regions for hands, in canvas units (robot offset 12,12)
    def reg(r0, r1, c0, c1):
        return (slice(r0 * SCALE, r1 * SCALE), slice(c0 * SCALE, c1 * SCALE))

    topL = reg(10, 19, 14, 21)  # raised hand, left
    topR = reg(10, 19, 27, 34)  # raised hand, right
    midL = reg(24, 32, 11, 18)  # jazz hand, left
    midR = reg(24, 32, 30, 37)  # jazz hand, right
    lowL = reg(34, 42, 14, 21)  # down hand, left
    lowR = reg(34, 42, 27, 34)  # down hand, right
    regions = {"up": (topL, topR), "out": (midL, midR), "down": (lowL, lowR)}

    for i, f in enumerate(frames):
        pose_l, pose_r, bob, _ = FRAMES[i]
        l_region, r_region = regions[pose_l], regions[pose_r]
        gl = near(f[l_region[0]], PAL["G"]) > 2
        gr = near(f[r_region[1]], PAL["G"]) > 2
        topL_g = near(f[topL], PAL["G"]) > 2
        topR_g = near(f[topR], PAL["G"]) > 2
        gl_bad = topL_g and pose_l == "down"
        gr_bad = topR_g and pose_r == "down"
        line_ok = gl and gr and not gl_bad and not gr_bad
        ok &= line_ok
        print(
            f"f{i} {pose_l}/{pose_r}: hands-ok={line_ok} "
            f"(topL={near(f[topL], PAL['G'])}, midL={near(f[l_region[0]], PAL['G'])}, "
            f"midR={near(f[r_region[1]], PAL['G'])}, topR={near(f[topR], PAL['G'])})"
        )

    for i, f in enumerate(frames):
        for name, col in (
            ("eye", "E"),
            ("beacon", "R"),
            ("dial", "G"),
            ("body", "B"),
            ("light", "L"),
        ):
            cnt = near(f, PAL[col])
            if cnt < 2:
                print(f"  MISSING {name} in frame {i} (px={cnt})")
                ok = False

    # bob actually moves the body vertically
    def body_top(f):
        dist = np.abs(np.asarray(f, dtype=int) - np.array(PAL["B"])).sum(axis=2) < 60
        per_row = dist.sum(axis=1)
        rows = np.where(per_row > 3)[0]
        return int(rows.min()) if len(rows) else None

    b0 = body_top(frames[0])  # bob 0
    b1 = body_top(frames[1])  # bob -1 (higher -> smaller row)
    b3 = body_top(frames[3])  # bob +1 (lower -> larger row)
    print(f"body top: f0(bob0)={b0}, f1(bob-1)={b1}, f3(bob+1)={b3}")
    bob_ok = (
        b0 is not None and b1 is not None and b3 is not None and b1 < b0 and b3 > b0
    )
    print(f"bob-motion={'OK' if bob_ok else 'FAIL'}")
    ok &= bob_ok

    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
