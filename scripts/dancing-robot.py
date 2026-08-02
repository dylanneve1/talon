#!/usr/bin/env python3
"""Procedural dancing-robot GIF renderer.

Draws a disco robot with matplotlib frame by frame, assembles the GIF
with Pillow. No assets, no network - pure math.
"""

import math
import os
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mp
from PIL import Image

OUT = "/tmp/dancing-robot-frames"
FPS = 12
N_FRAMES = 36
SIZE = 2.0

os.makedirs(OUT, exist_ok=True)

# Palette
BODY = "#4a6fa5"
BODY_DARK = "#33507a"
HEAD = "#5b83ba"
EYE = "#7ef0ff"
ACCENT = "#ffd166"
GROUND = "#2b2f3a"
BG = "#1a1d2b"
DISCO = "#c9d4ff"


def deg2rad(d):
    return math.radians(d)


def arm_patch(ax, x, y, ang_deg, length=0.42, color=BODY, width=0.09):
    """Draw an arm as a rounded line from shoulder (x,y) rotated ang from straight-down."""
    ang = deg2rad(ang_deg)
    dx, dy = math.sin(ang) * length, math.cos(ang) * length
    line = mp.FancyBboxPatch(
        (x - width / 2, y - length),
        width,
        length,
        boxstyle="round,pad=0.012,rounding_size=0.03",
        fc=color,
        ec="none",
    )
    t = mp.transforms.Affine2D().rotate_around(x, y, -ang) + ax.transData
    line.set_transform(t)
    ax.add_patch(line)
    hand = mp.Circle((x + dx, y - dy), width * 0.72, fc=ACCENT, ec="none")
    ax.add_patch(hand)
    return x + dx, y - dy


def leg_patch(ax, x, y, ang_deg, length=0.46, color=BODY_DARK, width=0.1):
    ang = deg2rad(ang_deg)
    dx, dy = math.sin(ang) * length, math.cos(ang) * length
    line = mp.FancyBboxPatch(
        (x - width / 2, y - length),
        width,
        length,
        boxstyle="round,pad=0.012,rounding_size=0.03",
        fc=color,
        ec="none",
    )
    t = mp.transforms.Affine2D().rotate_around(x, y, -ang) + ax.transData
    line.set_transform(t)
    ax.add_patch(line)
    foot = mp.FancyBboxPatch(
        (x + dx - 0.06, y - dy - 0.045),
        0.14,
        0.05,
        boxstyle="round,pad=0.008,rounding_size=0.02",
        fc=color,
        ec="none",
    )
    ax.add_patch(foot)
    return x + dx, y - dy


def disco_ball(ax, cx, cy, r, phase):
    ball = mp.Circle((cx, cy), r, fc=DISCO, ec="#8fa0d8", lw=1.2)
    ax.add_patch(ball)
    for i in range(6):
        ang = deg2rad(i * 60 + phase)
        x1, y1 = cx + math.cos(ang) * r * 0.7, cy + math.sin(ang) * r * 0.7
        ax.plot([cx, x1], [cy, y1], color="#8fa0d8", lw=0.7, alpha=0.9)
    for i in range(3):
        ang = deg2rad(45 + i * 60 + phase * 0.7)
        x2, y2 = cx + math.cos(ang) * r * 1.05, cy + math.sin(ang) * r * 1.05
        ax.plot([cx, x2], [cy, y2], color="#ffffff", lw=1.1, alpha=0.8)
    for k in range(8):
        ang = deg2rad(k * 45 + phase * 2)
        sp = r * 1.45
        ax.plot(
            [cx + math.cos(ang) * r, cx + math.cos(ang) * sp],
            [cy + math.sin(ang) * r, cy + math.sin(ang) * sp],
            color="#ffe9a8",
            lw=1.0,
            alpha=0.75,
        )


def sparkle(ax, x, y, size, alpha):
    ax.plot([x - size, x + size], [y, y], color="#fff", lw=0.8, alpha=alpha)
    ax.plot([x, x], [y - size, y + size], color="#fff", lw=0.8, alpha=alpha)


def render(ax, t):
    """t in [0, 2pi). Draws one frame."""
    phase = t
    # body bounce
    bob = 0.06 * math.sin(2 * t)
    hip_y = -0.15 + bob
    chest_y = 0.42 + bob * 0.6
    head_y = 0.98 + bob * 0.4

    # disco ball + sparkles
    disco_ball(ax, 0.72, 1.62, 0.16, phase)
    sparkle(ax, -0.8, 1.5, 0.04, max(0.05, 0.5 + 0.5 * math.sin(phase * 1.3)))
    sparkle(ax, 0.15, 1.75, 0.03, max(0.05, 0.4 + 0.5 * math.sin(phase * 1.7 + 1)))
    sparkle(ax, 0.9, 0.5, 0.035, max(0.05, 0.5 + 0.4 * math.sin(phase * 1.1 + 2)))

    # ---- legs (step) ----
    l_leg = 14 * math.sin(t)
    r_leg = 14 * math.sin(t + math.pi)
    leg_patch(ax, -0.11, hip_y, l_leg)
    leg_patch(ax, 0.11, hip_y, r_leg)

    # ---- torso ----
    torso = mp.FancyBboxPatch(
        (-0.28, chest_y),
        0.56,
        0.6,
        boxstyle="round,pad=0.02,rounding_size=0.07",
        fc=BODY,
        ec=BODY_DARK,
        lw=1.5,
    )
    ax.add_patch(torso)
    # chest dial
    dial = mp.Circle((0.0, chest_y + 0.3), 0.075, fc="#2b2f3a", ec=ACCENT, lw=1.2)
    ax.add_patch(dial)
    n_deg = 120 * math.sin(t)
    ax.plot(
        [0, 0.052 * math.sin(deg2rad(n_deg))],
        [chest_y + 0.3, chest_y + 0.3 + 0.052 * math.cos(deg2rad(n_deg))],
        color=ACCENT,
        lw=1.6,
    )

    # ---- arms (swing opposite) ----
    arm_swing = 42 * math.sin(t)
    arm_patch(ax, -0.23, chest_y + 0.52, arm_swing, length=0.4)
    arm_patch(ax, 0.23, chest_y + 0.52, -arm_swing, length=0.4)

    # ---- head ----
    head = mp.FancyBboxPatch(
        (-0.19, head_y),
        0.38,
        0.32,
        boxstyle="round,pad=0.015,rounding_size=0.06",
        fc=HEAD,
        ec=BODY_DARK,
        lw=1.5,
    )
    ax.add_patch(head)
    # antenna
    ax.plot([0, 0], [head_y + 0.32, head_y + 0.46], color=BODY_DARK, lw=2)
    blink = 0.04 if (math.sin(phase * 4) > 0.97) else 0.09
    for ex in (-0.075, 0.075):
        eye = mp.Ellipse((ex, head_y + 0.22), 0.075, blink, fc=EYE, ec="none")
        ax.add_patch(eye)
    mouth = mp.FancyBboxPatch(
        (-0.06, head_y + 0.07),
        0.12,
        0.04,
        boxstyle="round,pad=0.005,rounding_size=0.02",
        fc="#2b2f3a",
        ec="none",
    )
    ax.add_patch(mouth)


def main():
    frames = []
    for i in range(N_FRAMES):
        t = (i / N_FRAMES) * 2 * math.pi
        fig, ax = plt.subplots(figsize=(3.2, 3.6), dpi=110)
        fig.patch.set_facecolor(BG)
        ax.set_facecolor(BG)
        ax.set_xlim(-1, 1)
        ax.set_ylim(-0.75, 1.95)
        ax.set_aspect("equal")
        ax.axis("off")
        # floor
        ax.plot([-1, 1], [-0.62, -0.62], color=GROUND, lw=6, solid_capstyle="round")
        render(ax, t)
        fig.tight_layout(pad=0.1)
        p = os.path.join(OUT, f"f{i:03d}.png")
        fig.savefig(p, facecolor=BG)
        plt.close(fig)
        frames.append(Image.open(p).convert("RGBA"))

    gif_path = "/tmp/dancing-robot.gif"
    frames[0].save(
        gif_path,
        save_all=True,
        append_images=frames[1:],
        duration=int(1000 / FPS),
        loop=0,
        optimize=True,
    )
    print(gif_path)


if __name__ == "__main__":
    main()
