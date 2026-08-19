#!/usr/bin/env python3
"""Pixel-art dancing robot GIF.

A hand-authored 24x31 robot sprite (character grid) with per-frame arm/leg
poses, blitted onto a fixed 48x56 pixel scene, scaled up and assembled into
an 8-frame looping GIF with Pillow.
"""

import os

from PIL import Image

# ---- palette (char -> RGB) -------------------------------------------------
PAL = {
    "R": (255, 93, 93),  # beacon red
    "D": (43, 64, 100),  # dark steel
    "B": (74, 111, 165),  # body blue
    "L": (143, 179, 224),  # light blue
    "E": (126, 240, 255),  # eye cyan
    "G": (255, 209, 102),  # gold
    "W": (255, 255, 255),  # white
    "M": (28, 32, 52),  # mouth / panel
}
BG = (23, 26, 38)
FLOOR = (54, 60, 92)
BALL1 = (202, 212, 244)
BALL2 = (158, 170, 214)
SHADOW = (14, 16, 26)

# ---- robot body sprite: 24 cols x 31 rows ('.' = empty) --------------------
SPRITE = [
    "...........RR...........",  #  0 beacon
    "...........RR...........",  #  1
    "...........DD...........",  #  2 antenna
    "...........DD...........",  #  3
    "...........DD...........",  #  4
    "......LLLLLLLLLL.......",  #  5 head top
    "......LLLLLLLLLL.......",  #  6
    "......LBBBBBBBBBBL.......",  #  7
    "......LBEEBBBBEEL.......",  #  8 eyes
    "......LBBBBBBBBBBL.......",  #  9
    "......LBBMMMMMMBBL.......",  # 10 mouth
    "......LBBBBBBBBBBL.......",  # 11
    "......LLLLLLLLLL.......",  # 12
    ".......DDDDDDDD........",  # 13 neck
    "......DDDDDDDDDD.......",  # 14 shoulders
    "......DDLLLLLLDD.......",  # 15
    "......DBLLLLLLBD.......",  # 16
    "......DBGGGGGGBD.......",  # 17 gold dial
    "......DBGGGGGGBD.......",  # 18
    "......DBGGGGGGBD.......",  # 19
    "......DBBBBBBBBD.......",  # 20
    "......DMMMMMMMMD.......",  # 21 panel
    "......DBBBBBBBBD.......",  # 22
    "......DBBBBBBBBD.......",  # 23
    "......DBBBBBBBBD.......",  # 24
    "......DDDDDDDDDD.......",  # 25 hips
    "......DDDDDDDDDD.......",  # 26
    ".......DDD....DDD.......",  # 27 legs
    ".......BBB....BBB.......",  # 28
    ".......BBB....BBB.......",  # 29
    "......BBBBB..BBBBB......",  # 30 feet
]
SPR_W, SPR_H = 24, len(SPRITE)


def add_rect(d, c0, r0, c1, r1, color):
    for r in range(r0, r1 + 1):
        for c in range(c0, c1 + 1):
            d[(r, c)] = color


def add_arm(d, side, pose):
    """side in {'L','R'}; pose in {'up','down','out'}."""
    if pose == "up":
        # raised straight up above the head
        cols = (4, 5) if side == "L" else (18, 19)
        add_rect(d, cols[0], 3, cols[1], 9, "B")
        add_rect(d, cols[0], 1, cols[1], 2, "G")  # hand on top
    elif pose == "down":
        # hanging at the side
        cols = (4, 5) if side == "L" else (18, 19)
        add_rect(d, cols[0], 16, cols[1], 24, "B")
        add_rect(d, cols[0], 25, cols[1], 26, "G")  # hand at bottom
    elif pose == "out":
        # jazz hands, straight out at shoulder height
        if side == "L":
            add_rect(d, 1, 15, 5, 16, "B")
            add_rect(d, 1, 15, 2, 16, "G")
        else:
            add_rect(d, 18, 15, 22, 16, "B")
            add_rect(d, 21, 15, 22, 16, "G")


def add_leg(d, tap):
    """Draw legs/feet; tap in {'','L','R'} shifts one foot for a step."""
    c0l = 8 if tap == "L" else 7
    add_rect(d, c0l, 27, c0l + 2, 29, "D")  # left thigh
    add_rect(d, c0l, 28, c0l + 2, 29, "B")  # left shin
    add_rect(d, c0l - 2, 30, c0l + 2, 30, "B")  # left foot
    c0r = 13 if tap == "R" else 14
    add_rect(d, c0r, 27, c0r + 2, 29, "D")  # right thigh
    add_rect(d, c0r, 28, c0r + 2, 29, "B")  # right shin
    add_rect(d, c0r, 30, c0r + 4, 30, "B")  # right foot


def frame_robot(pose_l, pose_r, leg_tap):
    """Build a dict {(row,col): char} for one frame of the robot sprite."""
    d = {}
    for r, row in enumerate(SPRITE):
        if r > 26:
            break
        for c, ch in enumerate(row):
            if ch != ".":
                d[(r, c)] = ch
    add_leg(d, leg_tap)
    add_arm(d, "L", pose_l)
    add_arm(d, "R", pose_r)
    return d


# ---- scene geometry ----------------------------------------------------------
SCENE_W, SCENE_H = 48, 56
DX, DY = 12, 12  # robot offset into canvas
SCALE = 12

# 8-frame dance loop: (left arm, right arm, bob, leg tap)
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

# static sparkles (col, row, color)
SPARKLES = [
    (6, 8, "G"),
    (40, 30, "W"),
    (9, 40, "G"),
    (35, 12, "W"),
    (3, 46, "G"),
    (44, 44, "W"),
    (42, 22, "G"),
]


def render_scene():
    img = Image.new("RGB", (SCENE_W, SCENE_H), BG)
    px = img.load()
    # floor
    for r in range(44, SCENE_H):
        for c in range(SCENE_W):
            px[c, r] = FLOOR
    # disco ball: 5x5 at top right, stem above
    for r in range(0, 2):
        px[41, r] = BALL2
    for r in range(1, 6):
        for c in range(39, 44):
            px[c, r] = BALL1
    px[40, 2] = PAL["W"]  # specular highlight
    px[42, 4] = BALL2
    px[40, 4] = BALL2
    for c, r, ch in SPARKLES:
        px[c, r] = PAL[ch]
    return img, px


def blit_robot(px, robot, dy):
    for (r, c), ch in robot.items():
        cr, cc = r + DY + dy, c + DX
        if 0 <= cr < SCENE_H and 0 <= cc < SCENE_W:
            px[cc, cr] = PAL[ch]


def main():
    base, px = render_scene()
    frames = []
    for pose_l, pose_r, bob, tap in FRAMES:
        robot = frame_robot(pose_l, pose_r, tap)
        # ground shadow under robot
        img = base.copy()
        p = img.load()
        for c in range(17, 31):
            p[c, 43] = SHADOW
        blit_robot(p, robot, bob)
        big = img.resize((SCENE_W * SCALE, SCENE_H * SCALE), Image.NEAREST)
        frames.append(big)

    out = "/tmp/pixel-dancer.gif"
    frames[0].save(
        out,
        save_all=True,
        append_images=frames[1:],
        duration=130,
        loop=0,
        optimize=True,
    )
    print(out)


if __name__ == "__main__":
    main()
