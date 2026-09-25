"""Generate "Clay", a refined terracotta pet for Claude Pet, as a Codex-compatible v2 atlas.

Same chunky pixel-art style as Ember (48x52 logical pixels per cell, scaled 4x into
192x208 cells), with refinements: selective two-tone outlines, smoother shading with
bounce light, eyebrows and more mouth shapes, a run cycle with squash and stretch,
a spark antenna that trails behind, and props for the states (a laptop while working,
a paper while reviewing, a question bubble while waiting, smoke when something fails).

Rows: 0 idle, 1 running-right, 2 running-left, 3 waving, 4 jumping, 5 failed,
      6 waiting, 7 running (working), 8 review, 9-10 look directions.

Usage:  python tools/make_clay.py
Writes: pets/clay/spritesheet.png, pets/clay/pet.json, pets/clay/tray*.png (tray icons),
        tools/clay-preview.png
"""
import json
import math
import os
import struct
import zlib
from dataclasses import dataclass, field, replace

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

LW, LH = 48, 52
SCALE = 4
CELL_W, CELL_H = LW * SCALE, LH * SCALE
COLS, ROWS = 8, 11
FRAMES_BY_ROW = [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8]

PALETTE = {
    "O": (78, 34, 22, 255),       # outline, shadow side
    "o": (132, 58, 38, 255),      # outline, lit side
    "D": (166, 78, 50, 255),      # body deep shade
    "s": (194, 96, 64, 255),      # body shade
    "b": (217, 119, 87, 255),     # body (Claude terracotta)
    "l": (233, 146, 112, 255),    # body light
    "h": (246, 186, 156, 255),    # body highlight
    "W": (255, 230, 212, 255),    # specular glint
    "e": (38, 21, 16, 255),       # eyes, brows, mouth
    "w": (255, 255, 255, 255),    # eye glint
    "k": (238, 118, 110, 255),    # blush
    "m": (170, 56, 50, 255),      # mouth inside
    "f": (156, 70, 44, 255),      # feet
    "F": (116, 50, 32, 255),      # feet shade
    "y": (250, 196, 92, 255),     # spark
    "Y": (218, 146, 50, 255),     # spark tips
    "c": (255, 247, 222, 255),    # spark core
    "g": (150, 142, 138, 255),    # dimmed spark
    "S": (180, 172, 168, 200),    # smoke
    "z": (40, 20, 12, 46),        # ground shadow
    "d": (214, 196, 180, 225),    # dust
    "q": (255, 252, 246, 255),    # bubble fill
    "u": (120, 186, 250, 255),    # sweat
    "U": (226, 242, 255, 255),    # sweat highlight
    "p": (255, 248, 236, 255),    # paper
    "P": (200, 182, 164, 255),    # paper lines
    "G": (52, 168, 96, 255),      # check mark
    "L": (74, 78, 90, 255),       # laptop lid
    "K": (44, 46, 56, 255),       # laptop edge
    "n": (112, 118, 134, 255),    # laptop keyboard edge
    "H": (238, 88, 100, 255),     # heart
}

CX = 24.0              # body center; pixel columns 9..38 are symmetric around it
BODY_BOTTOM = 44       # last body row at rest; the feet sit just below
RX, RY = 15.0, 13.0
LIGHT = (-0.5, -0.72, 0.48)       # from the upper left, a little in front


class Canvas:
    def __init__(self):
        self.px = [[None] * LW for _ in range(LH)]

    def set(self, x, y, c):
        x, y = int(x), int(y)
        if 0 <= x < LW and 0 <= y < LH:
            self.px[y][x] = c

    def get(self, x, y):
        if 0 <= x < LW and 0 <= y < LH:
            return self.px[y][x]
        return None

    def blit(self, pattern, x0, y0):
        for dy, row in enumerate(pattern):
            for dx, ch in enumerate(row):
                if ch not in ". ":
                    self.set(x0 + dx, y0 + dy, ch)


def ellipse(cx, cy, rx, ry):
    pts = set()
    for y in range(int(cy - ry) - 1, int(cy + ry) + 2):
        for x in range(int(cx - rx) - 1, int(cx + rx) + 2):
            nx = (x + 0.5 - cx) / rx
            ny = (y + 0.5 - cy) / ry
            if nx * nx + ny * ny <= 1.0:
                pts.add((x, y))
    return pts


def outline_of(mask):
    out = set()
    for (x, y) in mask:
        for n in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if n not in mask:
                out.add(n)
    return out


@dataclass
class Pose:
    dx: int = 0
    dy: int = 0
    squash: float = 0.0            # >0 wider and shorter, <0 taller and narrower
    lean: int = 0                  # shifts the top of the body sideways
    eyes: str = "open"             # open closed happy wide x half
    look: tuple = (0, 0)           # eye offset in pixels
    brows: str = ""                # worried determined raised
    mouth: str = "smile"           # smile grin flat frown o wobble
    blush: bool = True
    arms: tuple = ("rest", "rest")
    feet: tuple = ((0, 0), (0, 0))  # (x offset, lift) per foot, left then right
    spark: str = "normal"          # normal bright spin dim droop
    spark_phase: int = 0
    spark_tilt: int = 0
    props: list = field(default_factory=list)
    shadow: bool = True


def body_geometry(p):
    rx = RX + p.squash * 0.7
    ry = RY - p.squash * 0.9
    cx = CX + p.dx
    bottom = BODY_BOTTOM + p.dy
    cy = bottom - ry + 1.0
    return cx, cy, rx, ry, bottom


def body_mask(cx, cy, rx, ry, lean):
    """A soft mochi shape: a superellipse that is a little wider at the bottom."""
    pts = set()
    for y in range(int(math.floor(cy - ry)), int(math.ceil(cy + ry)) + 1):
        t = (y + 0.5 - cy) / ry
        if abs(t) >= 1:
            continue
        hw = rx * (1 - abs(t) ** 2.3) ** (1 / 2.3) * (1 + 0.07 * t)
        shift = lean * max(0.0, -t)
        xl, xr = cx - hw + shift, cx + hw + shift
        for x in range(int(math.floor(xl)) - 1, int(math.ceil(xr)) + 2):
            if xl <= x + 0.5 <= xr:
                pts.add((x, y))
    return pts


def shade(nx, ny):
    nz = math.sqrt(max(0.0, 1 - min(1.0, nx * nx + ny * ny)))
    return nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]


def tone(v):
    if v > 0.93:
        return "h"
    if v > 0.72:
        return "l"
    if v > 0.30:
        return "b"
    if v > 0.02:
        return "s"
    return "D"


LIGHTER = {"D": "s", "s": "b", "b": "b", "l": "l", "h": "h"}

# Resting arms are little nubs on the body's edge: (angle from straight up, clockwise for
# the right arm; how far out past the edge; radii).
ARM_SPOTS = {
    "rest": (112, 0.3, 2.3, 3.1),
    "swing_f": (100, 0.7, 2.3, 3.0),
    "swing_b": (124, 0.3, 2.3, 3.0),
}
# Raised arms are short limbs from a shoulder on the body's edge to a round hand:
# (shoulder angle, hand offset (outward, down) from the shoulder).
ARM_LIMBS = {
    "wave_a": (66, (3.5, -7.5)),
    "wave_b": (70, (6.5, -5.0)),
    "wave_low": (80, (5.5, -2.0)),
    "cheer": (56, (3.5, -7.0)),
    "out": (86, (6.0, -0.5)),
}


def limb_pixels(cx, cy, rx, ry, side, pose):
    deg, (hx, hy) = ARM_LIMBS[pose]
    a = math.radians(deg)
    sx = cx + side * rx * 0.9 * math.sin(a)
    sy = cy - ry * 0.9 * math.cos(a)
    parts = []
    for t, r in ((0.0, 2.0), (0.35, 1.9), (0.7, 1.9), (1.0, 2.5)):
        parts.append((sx + side * hx * t, sy + hy * t, r))
    return parts
# Arms held in front of the body: (x offset from the center, y offset from the center, radii).
FRONT_ARMS = {
    "hold": (6.0, 6.6, 2.4, 2.2),
    "type_up": (7.0, 5.2, 2.4, 2.1),
    "type_down": (7.0, 6.4, 2.4, 2.1),
}


def draw_pet(p):
    c = Canvas()
    cx, cy, rx, ry, bottom = body_geometry(p)
    top = int(math.floor(cy - ry + 0.5))

    if p.shadow:
        air = max(0, -p.dy)
        for (x, y) in ellipse(CX + p.dx * 0.5, BODY_BOTTOM + 3.2, max(5.0, 12.5 - air * 0.6), 1.5):
            c.set(x, y, "z")
    draw_props(c, p, "back", cx, cy, rx, ry, top)

    feet, feet_shade = set(), set()
    for side, (fx, lift) in zip((-1, 1), p.feet):
        pts = ellipse(cx + side * 7.2 + fx, bottom + 1.6 - lift, 3.4, 1.9)
        feet |= pts
        low = max(y for _, y in pts)
        feet_shade |= {(x, y) for (x, y) in pts if y == low}
    for (x, y) in feet:
        c.set(x, y, "F" if (x, y) in feet_shade else "f")

    side_arms = set()
    for side, pose in zip((-1, 1), p.arms):
        if pose in ARM_SPOTS:
            deg, out, arx, ary = ARM_SPOTS[pose]
            a = math.radians(deg)
            acx = cx + side * (rx + out) * math.sin(a)
            acy = cy - (ry + out) * math.cos(a)
            parts = [(acx, acy, arx, ary)]
        elif pose in ARM_LIMBS:
            parts = [(x, y, r, r) for (x, y, r) in limb_pixels(cx, cy, rx, ry, side, pose)]
        else:
            continue
        for (acx, acy, arx, ary) in parts:
            pts = ellipse(acx, acy, arx, ary)
            side_arms |= pts
            for (x, y) in pts:
                c.set(x, y, tone(shade((x + 0.5 - acx) / arx * 0.8, (y + 0.5 - acy) / ary * 0.8)))

    body = body_mask(cx, cy, rx, ry, p.lean)
    edge = outline_of(body)
    for (x, y) in body:
        nx = (x + 0.5 - cx) / rx
        ny = (y + 0.5 - cy) / ry
        t = tone(shade(nx, ny))
        if ((x + 1, y) in edge or (x, y + 1) in edge) and nx * 0.6 + ny * 0.8 > 0.55:
            t = LIGHTER[t]                      # bounce light along the lower right edge
        c.set(x, y, t)
    gx, gy = int(round(cx - rx * 0.5)), int(round(cy - ry * 0.62))
    for (x, y) in ((gx, gy), (gx + 1, gy), (gx, gy + 1)):
        if (x, y) in body:
            c.set(x, y, "W")

    # selective outline: lighter on the lit upper left, darker elsewhere
    feet_edge = outline_of(feet)
    for (x, y) in outline_of(body | feet | side_arms):
        nx = (x + 0.5 - cx) / rx
        ny = (y + 0.5 - cy) / ry
        lit = nx * -0.55 + ny * -0.83 > 0.42 and (x, y) not in feet_edge
        c.set(x, y, "o" if lit else "O")

    draw_face(c, p, cx, cy)
    draw_props(c, p, "front", cx, cy, rx, ry, top)

    for side, pose in zip((-1, 1), p.arms):
        if pose not in FRONT_ARMS:
            continue
        ox, oy, arx, ary = FRONT_ARMS[pose]
        acx, acy = cx + side * ox, cy + oy
        pts = ellipse(acx, acy, arx, ary)
        for (x, y) in outline_of(pts):
            c.set(x, y, "O")
        for (x, y) in pts:
            c.set(x, y, tone(shade((x + 0.5 - acx) / arx * 0.7, (y + 0.5 - acy) / ary * 0.7) + 0.1))

    draw_spark(c, p, cx, top)
    draw_props(c, p, "over", cx, cy, rx, ry, top)
    return c


EYES = {
    "open": [".e.", "ewe", "eee", "eee", ".e."],
    "wide": [".e.", "ewe", "eee", "eee", "eee", ".e."],
    "closed": ["...", "...", "...", "eee", "..."],
    "happy": ["...", "...", ".e.", "e.e", "..."],
    "half": ["...", "eee", "...", "ewe", ".e."],
    "x": ["...", "e.e", ".e.", "e.e", "..."],
}
BROWS = {
    # (left eye pixels, right eye pixels) relative to the eye's top-left
    "worried": ([(0, -2), (1, -2), (2, -3)], [(0, -3), (1, -2), (2, -2)]),
    "determined": ([(0, -3), (1, -3), (2, -2)], [(0, -2), (1, -3), (2, -3)]),
    "raised": ([(0, -3), (1, -3), (2, -3)], [(0, -3), (1, -3), (2, -3)]),
}
MOUTHS = {
    "smile": ["e..e", ".ee."],
    "grin": ["eeee", "emme", ".ee."],
    "flat": [".ee."],
    "frown": [".ee.", "e..e"],
    "o": [".ee.", "e..e", ".ee."],
    "wobble": [".e.e", "e.e."],
}


def draw_face(c, p, cx, cy):
    lx, ly = p.look
    icx, icy = int(cx), int(cy)
    lift = 1 if p.eyes == "wide" else 0
    ey = icy - 4 + ly - lift
    eyes_x = (icx - 6 + lx, icx + 3 + lx)
    for ex in eyes_x:
        c.blit(EYES[p.eyes], ex, ey)
    if p.brows:
        for ex, pts in zip(eyes_x, BROWS[p.brows]):
            for (x, y) in pts:
                c.set(ex + x, ey + y, "e")
    fx, fy = int(lx / 2), int(ly / 2)
    if p.blush:
        for bx in (icx - 8 + fx, icx + 6 + fx):
            c.set(bx, icy + 1 + fy, "k")
            c.set(bx + 1, icy + 1 + fy, "k")
    c.blit(MOUTHS[p.mouth], icx - 2 + fx, icy + 2 + fy)


SPARKS = {
    "plus": ["..y..", "..y..", "yycyy", "..y..", "..y.."],
    "small": [".y.", "ycy", ".y."],
    "x": ["Y...Y", ".y.y.", "..c..", ".y.y.", "Y...Y"],
    "bright": ["...Y...", "...y...", "..yyy..", "YyycyyY", "..yyy..", "...y...", "...Y..."],
    "dim": [".g.", "gcg", ".g."],
}


def draw_spark(c, p, cx, top):
    sx = int(round(cx + 2 + p.lean * 0.8))
    tilt = p.spark_tilt
    if p.spark == "droop":
        if tilt >= 0:
            c.blit(["..OO", ".O..", "O..."], sx - 1, top - 3)
            c.blit(SPARKS["dim"], sx + 3, top - 5)
        else:
            c.blit(["OO..", "..O.", "...O"], sx - 2, top - 3)
            c.blit(SPARKS["dim"], sx - 5, top - 5)
        return
    for (x, y) in ((sx, top - 1), (sx, top - 2), (sx + tilt, top - 3)):
        c.set(x, y, "O")
    ox, oy = sx + tilt, top - 6
    if p.spark == "spin":
        shape = SPARKS[["plus", "x", "plus", "small"][p.spark_phase % 4]]
    elif p.spark in ("bright", "dim"):
        shape = SPARKS[p.spark]
    else:
        shape = SPARKS["plus" if p.spark_phase % 2 == 0 else "small"]
    c.blit(shape, ox - len(shape[0]) // 2, oy - len(shape) // 2)


# ---------------------------------------------------------------- props

BUBBLE = [
    "..OOOOOOOOO..",
    ".OqqqqqqqqqO.",
    "OqqqqqqqqqqqO",
    "OqqqqqqqqqqqO",
    "OqqqqqqqqqqqO",
    "OqqqqqqqqqqqO",
    "OqqqqqqqqqqqO",
    "OqqqqqqqqqqqO",
    ".OqqqqqqqqqO.",
    "..OOqOOOOOO..",
    "...OqO.......",
    "....O........",
]
QUESTION = [".bbb.", "b...b", "....b", "..bb.", "..b..", ".....", "..b.."]
CHECK = [
    ".......OOO",
    "......OGGO",
    "O....OGGO.",
    "OGO.OGGO..",
    "OGGOGGO...",
    ".OGGGO....",
    "..OGO.....",
    "...O......",
]
PAPER = [
    "OOOOOOO...",
    "OpppppOO..",
    "OpPPPpOpO.",
    "OpppppOOOO",
    "OpPPPPPPpO",
    "OppppppppO",
    "OpPPPPPppO",
    "OppppppppO",
    "OOOOOOOOOO",
]
LAPTOP = [
    ".KKKKKKKKKKKK.",
    "KLLLLLLLLLLLLK",
    "KLLLLLLLLLLLLK",
    "KLLLLLyyLLLLLK",
    "KLLLLyyyyLLLLK",
    "KLLLLLyyLLLLLK",
    "KLLLLLLLLLLLLK",
    "KKKKKKKKKKKKKK",
    ".nnnnnnnnnnnn.",
]
SWEAT = [".u.", "uUu", "uuu", ".u."]
HEART = [".HH.HH.", "HHHHHHH", "HHHHHHH", ".HHHHH.", "..HHH..", "...H..."]
SPARKLE = [".c.", "cyc", ".c."]
SMOKE = [["S"], [".S.", "SSS", ".S."], [".SS.", "SSSS", ".SS."]]
DUST = [["d"], [".d.", "ddd", ".d."], [".dd.", "dddd", ".dd."], [".dd.", "dddd", "dddd", ".dd."]]


def outlined(pattern):
    """Add a 1px dark outline around a pattern so it reads on any wallpaper."""
    h, w = len(pattern), max(len(r) for r in pattern)
    grid = [["."] * (w + 2) for _ in range(h + 2)]
    for y, row in enumerate(pattern):
        for x, ch in enumerate(row):
            if ch != ".":
                grid[y + 1][x + 1] = ch
    solid = {(x, y) for y in range(h + 2) for x in range(w + 2) if grid[y][x] != "."}
    for (x, y) in outline_of(solid):
        if 0 <= x < w + 2 and 0 <= y < h + 2:
            grid[y][x] = "O"
    return ["".join(r) for r in grid]


HEART_O = outlined(HEART)
SWEAT_O = outlined(SWEAT)


def draw_props(c, p, layer, cx, cy, rx, ry, top):
    icx, icy = int(cx), int(cy)
    for name, args in p.props:
        if layer == "back" and name == "dust":
            for (x, y, size) in args:
                c.blit(DUST[size], x, y)
        elif layer == "front" and name == "laptop":
            c.blit(LAPTOP, icx - 7, icy + 6 + args.get("dy", 0))
        elif layer == "front" and name == "paper":
            c.blit(PAPER, icx - 5, icy + 3 + args.get("dy", 0))
        elif layer == "over" and name == "bubble":
            bx, by = icx + 5, top - 14 + args.get("dy", 0)
            c.blit(BUBBLE, bx, by)
            c.blit(QUESTION, bx + 4, by + 1)
        elif layer == "over" and name == "check":
            c.blit(CHECK, int(cx + rx) - 5, top - 6 + args.get("dy", 0))
        elif layer == "over" and name == "sweat":
            c.blit(SWEAT_O, int(cx + rx) - 6, int(cy - ry) + 4 + args.get("dy", 0))
        elif layer == "over" and name == "tear":
            x, y = icx - 5 + args.get("dx", 0), icy + 1 + args.get("dy", 0)
            c.set(x, y, "u")
            c.set(x, y + 1, "u")
        elif layer == "over" and name == "heart":
            c.blit(HEART_O, int(cx + rx) - 3 + args.get("dx", 0), top - 10 + args.get("dy", 0))
        elif layer == "over" and name == "sparkles":
            for (x, y) in args:
                c.blit(SPARKLE, icx + x - 1, top + y - 1)
        elif layer == "over" and name == "smoke":
            for (x, y, size) in args:
                c.blit(SMOKE[size], icx + x, top + y)
        elif layer == "over" and name == "motes":
            for (x, y, ch) in args:
                c.set(int(round(cx + x)), int(round(top + y)), ch)


# ---------------------------------------------------------------- animations

def idle():
    base = Pose()
    return [
        base,
        replace(base, squash=0.6),
        replace(base, squash=0.8, eyes="closed"),
        replace(base, squash=0.3, spark_tilt=1),
        replace(base, squash=-0.5, spark_phase=1),
        replace(base, spark_tilt=-1),
    ]


def run(d):
    """Run cycle in direction d (+1 right, -1 left): contact, down, passing, up, then the other foot."""
    body = [(0, 0.8), (1, 1.3), (-1, -0.6), (-2, -1.0)]
    planted_x = [2, 1, 0, -1]
    swing_x = [-2, -1, 0, 1]
    swing_lift = [0, 1, 2, 1]
    frames = []
    for i in range(8):
        k = i % 4
        dy, sq = body[k]
        planted = (d * planted_x[k], 0)
        swing = (d * swing_x[k], swing_lift[k])
        first_half = i < 4
        feet = (planted, swing) if first_half else (swing, planted)
        arms = ("swing_b", "swing_f") if first_half else ("swing_f", "swing_b")
        dust = []
        behind = int(round(CX - d * (RX + 3)))
        if k == 0:
            dust.append((behind - (3 if d > 0 else 0), BODY_BOTTOM, 3))
        elif k == 1:
            dust.append((behind - d * 2 - (2 if d > 0 else 0), BODY_BOTTOM - 1, 2))
        elif k == 2:
            dust.append((behind - d * 4 - (1 if d > 0 else 0), BODY_BOTTOM - 2, 1))
        frames.append(Pose(
            dy=dy, squash=sq, lean=2 * d, look=(2 * d, 0),
            mouth="grin" if k == 3 else "smile",
            arms=arms, feet=feet, spark_tilt=-d, spark_phase=i // 2,
            props=[("dust", dust)] if dust else [],
        ))
    return frames


def wave():
    return [
        Pose(arms=("rest", "wave_a"), eyes="happy", mouth="grin", props=[("sparkles", [(17, -2)])]),
        Pose(arms=("rest", "wave_b"), eyes="happy", mouth="grin", spark="bright", props=[("sparkles", [(21, 3)])]),
        Pose(arms=("rest", "wave_a"), eyes="happy", mouth="grin", props=[("sparkles", [(17, -2)])]),
        Pose(arms=("rest", "wave_low"), mouth="smile", props=[("heart", {"dy": 1})]),
    ]


def jump():
    return [
        Pose(dy=1, squash=2.0, eyes="closed", mouth="flat"),
        Pose(dy=-6, squash=-2.2, mouth="o", arms=("cheer", "cheer"), feet=((0, -1), (0, -1))),
        Pose(dy=-10, squash=-0.3, eyes="happy", mouth="grin", arms=("cheer", "cheer"), spark="bright",
             props=[("sparkles", [(-15, 4), (16, 2)])]),
        Pose(dy=-5, squash=-1.4, mouth="o", arms=("out", "out"), feet=((0, -1), (0, -1))),
        Pose(dy=1, squash=2.2, eyes="happy",
             props=[("dust", [(int(CX - RX) - 6, BODY_BOTTOM, 2), (int(CX + RX) + 2, BODY_BOTTOM, 2)])]),
    ]


def failed():
    sad = dict(eyes="half", brows="worried", mouth="frown", spark="droop", blush=False)
    return [
        Pose(eyes="wide", brows="raised", mouth="o", spark_phase=1),
        Pose(dx=-1, eyes="x", mouth="wobble", spark="dim", blush=False),
        Pose(dx=1, eyes="x", mouth="wobble", spark="dim", blush=False, props=[("smoke", [(2, -9, 2)])]),
        Pose(squash=0.8, **sad, props=[("smoke", [(4, -10, 1), (1, -6, 2)])]),
        Pose(squash=1.6, **sad, props=[("smoke", [(5, -12, 0), (3, -8, 1)]), ("sweat", {"dy": 0})]),
        Pose(squash=2.0, **sad, props=[("smoke", [(4, -11, 0)]), ("sweat", {"dy": 2}), ("tear", {})]),
        Pose(squash=2.6, **{**sad, "mouth": "wobble"}, props=[("sweat", {"dy": 4}), ("tear", {"dy": 1})]),
        Pose(squash=2.6, **sad, props=[("tear", {"dy": 2})]),
    ]


def waiting():
    bob = [0, -1, -1, 0, 0, -1]
    sway = [-1, 0, 1, 1, 0, -1]
    return [
        Pose(
            lean=sway[i], eyes="closed" if i == 4 else "open", look=(1, -1), brows="raised",
            mouth="o" if i in (1, 2) else "smile",
            feet=((0, 0), (0, 1)) if i in (2, 5) else ((0, 0), (0, 0)),
            spark_phase=i // 2, props=[("bubble", {"dy": bob[i]})],
        )
        for i in range(6)
    ]


def working():
    bob = [0, -1, 0, 0, -1, 0]
    frames = []
    for i in range(6):
        a = i / 6 * 2 * math.pi
        motes = [(2 + 6 * math.cos(a), -6 + 2.5 * math.sin(a), "c"),
                 (2 + 6 * math.cos(a + math.pi), -6 + 2.5 * math.sin(a + math.pi), "y")]
        frames.append(Pose(
            dy=bob[i], look=(0, 1), brows="determined", mouth="flat",
            arms=("type_up", "type_down") if i % 2 == 0 else ("type_down", "type_up"),
            spark="spin", spark_phase=i,
            props=[("laptop", {"dy": -bob[i]}), ("motes", motes)],
        ))
    return frames


def review():
    looks = [(-2, 1), (-1, 1), (0, 1), (1, 1), (0, 0), (0, 0)]
    frames = []
    for i in range(6):
        done = i == 5
        props = [("paper", {})]
        if i >= 4:
            props.append(("check", {"dy": -2 if done else 0}))
        if done:
            props.append(("sparkles", [(-14, 2)]))
        frames.append(Pose(
            eyes="happy" if done else "open", look=looks[i],
            mouth="grin" if done else ("smile" if i == 4 else "flat"),
            arms=("hold", "hold"), spark="bright" if done else "normal", props=props,
        ))
    return frames


def look_offset(i):
    a = math.radians(i * 22.5)
    return int(math.floor(2.2 * math.sin(a) + 0.5)), int(math.floor(-2.2 * math.cos(a) + 0.5))


def looks(start):
    frames = []
    for i in range(start, start + 8):
        ox, oy = look_offset(i)
        side = 1 if ox > 0 else -1 if ox < 0 else 0
        frames.append(Pose(
            look=(ox, oy), lean=side, spark_tilt=side,
            squash=-0.4 if oy < 0 else (0.4 if oy > 0 else 0.0),
            brows="raised" if oy <= -2 else "",
        ))
    return frames


# ---------------------------------------------------------------- output

def compose(rows):
    w, h = CELL_W * COLS, CELL_H * ROWS
    buf = bytearray(w * h * 4)
    canvases = []
    for r, poses in enumerate(rows):
        assert len(poses) == FRAMES_BY_ROW[r], (r, len(poses))
        row = []
        for col, pose in enumerate(poses):
            canvas = draw_pet(pose)
            row.append(canvas)
            ox, oy = col * CELL_W, r * CELL_H
            for ly in range(LH):
                for lx in range(LW):
                    ch = canvas.px[ly][lx]
                    if ch is None:
                        continue
                    block = bytes(PALETTE[ch]) * SCALE
                    for sy in range(SCALE):
                        i = ((oy + ly * SCALE + sy) * w + ox + lx * SCALE) * 4
                        buf[i:i + SCALE * 4] = block
        canvases.append(row)
    return w, h, buf, canvases


def write_png(path, w, h, buf):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    stride = w * 4
    raw = b"".join(b"\x00" + bytes(buf[y * stride:(y + 1) * stride]) for y in range(h))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(chunk(b"IEND", b""))


def write_preview(canvases, path, scale=2):
    pad = 4
    cw, ch = LW * scale, LH * scale
    w, h = COLS * (cw + pad) + pad, ROWS * (ch + pad) + pad
    buf = bytearray(bytes((236, 232, 226, 255)) * (w * h))
    for r, row in enumerate(canvases):
        for col, canvas in enumerate(row):
            bg = (250, 248, 244) if (r + col) % 2 == 0 else (242, 238, 232)
            ox, oy = pad + col * (cw + pad), pad + r * (ch + pad)
            for ly in range(LH):
                for lx in range(LW):
                    key = canvas.px[ly][lx]
                    rgb = bg
                    if key is not None:
                        cr, cg, cb, ca = PALETTE[key]
                        a = ca / 255
                        rgb = tuple(int(v * a + bgv * (1 - a)) for v, bgv in zip((cr, cg, cb), bg))
                    px = bytes(rgb + (255,)) * scale
                    for sy in range(scale):
                        i = ((oy + ly * scale + sy) * w + ox + lx * scale) * 4
                        buf[i:i + scale * 4] = px
    write_png(path, w, h, buf)


def area_resample(buf, w, h, nw, nh):
    """Box-filter resize with premultiplied alpha, for small tray icons."""
    out = bytearray(nw * nh * 4)
    for oy in range(nh):
        y0, y1 = oy * h / nh, (oy + 1) * h / nh
        for ox in range(nw):
            x0, x1 = ox * w / nw, (ox + 1) * w / nw
            acc = [0.0, 0.0, 0.0, 0.0]
            area = 0.0
            for sy in range(int(y0), int(math.ceil(y1))):
                wy = min(y1, sy + 1) - max(y0, sy)
                for sx in range(int(x0), int(math.ceil(x1))):
                    wgt = (min(x1, sx + 1) - max(x0, sx)) * wy
                    i = (sy * w + sx) * 4
                    a = buf[i + 3] / 255 * wgt
                    acc[0] += buf[i] * a
                    acc[1] += buf[i + 1] * a
                    acc[2] += buf[i + 2] * a
                    acc[3] += a
                    area += wgt
            j = (oy * nw + ox) * 4
            if acc[3] > 0:
                out[j:j + 3] = bytes(min(255, int(round(acc[k] / acc[3]))) for k in range(3))
            out[j + 3] = min(255, int(round(acc[3] / area * 255)))
    return out


# Small tray icons are drawn natively at their size so the face stays crisp:
# body (cx, cy, rx, ry), eye pattern and positions, mouth, blush, spark.
SMALL_ICONS = {
    24: dict(body=(12.0, 14.2, 10.9, 8.9), eye=["w", "e", "e"], eyes=(7, 15), eye_y=12,
             mouth=(["e..e", ".ee."], 10, 16), blush=([(4, 15), (5, 15), (18, 15), (19, 15)]),
             spark=(13, 1), stalk=[(13, 3), (13, 4)]),
    16: dict(body=(8.0, 9.8, 7.3, 5.9), eye=["e", "e"], eyes=(5, 10), eye_y=8,
             mouth=(["ee"], 7, 11), blush=([(3, 10), (12, 10)]),
             spark=(9, 1), stalk=[(9, 3)]),
}


def draw_small_icon(n):
    spec = SMALL_ICONS[n]
    cx, cy, rx, ry = spec["body"]
    px = {}
    body = ellipse(cx, cy, rx, ry)
    for (x, y) in body:
        px[(x, y)] = tone(shade((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry))
    for (x, y) in outline_of(body):
        lit = ((x + 0.5 - cx) / rx) * -0.55 + ((y + 0.5 - cy) / ry) * -0.83 > 0.42
        px[(x, y)] = "o" if lit else "O"
    for ex in spec["eyes"]:
        for dy, ch in enumerate(spec["eye"]):
            px[(ex, spec["eye_y"] + dy)] = ch
    pattern, mx, my = spec["mouth"]
    for dy, row in enumerate(pattern):
        for dx, ch in enumerate(row):
            if ch != ".":
                px[(mx + dx, my + dy)] = ch
    for p in spec["blush"]:
        px[p] = "k"
    sx, sy = spec["spark"]
    for (x, y, ch) in ((sx, sy - 1, "y"), (sx - 1, sy, "y"), (sx, sy, "c"), (sx + 1, sy, "y"), (sx, sy + 1, "y")):
        px[(x, y)] = ch
    for p in spec["stalk"]:
        px[p] = "O"
    buf = bytearray(n * n * 4)
    for (x, y), key in px.items():
        if 0 <= x < n and 0 <= y < n:
            i = (y * n + x) * 4
            buf[i:i + 4] = bytes(PALETTE[key])
    return buf


def write_tray_icons(pet_dir):
    """tray.png (16px), tray@1.5x.png (24px), tray@2x.png (32px): Clay's head and spark."""
    canvas = draw_pet(Pose())
    x0, y0, size = 8, 11, 32                     # spark to chest, at 1px per art pixel
    icon = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            key = canvas.px[y0 + y][x0 + x]
            if key is not None and key != "z":
                i = (y * size + x) * 4
                icon[i:i + 4] = bytes(PALETTE[key])
    write_png(os.path.join(pet_dir, "tray@2x.png"), size, size, icon)
    write_png(os.path.join(pet_dir, "tray@1.5x.png"), 24, 24, draw_small_icon(24))
    write_png(os.path.join(pet_dir, "tray.png"), 16, 16, draw_small_icon(16))


def main():
    rows = [idle(), run(1), run(-1), wave(), jump(), failed(), waiting(), working(), review(), looks(0), looks(8)]
    pet_dir = os.path.join(ROOT, "pets", "clay")
    w, h, buf, canvases = compose(rows)
    write_png(os.path.join(pet_dir, "spritesheet.png"), w, h, buf)
    write_tray_icons(pet_dir)
    with open(os.path.join(pet_dir, "pet.json"), "w", encoding="utf-8") as f:
        json.dump({
            "id": "clay",
            "displayName": "Clay",
            "description": "A refined terracotta critter: types while Claude works, reads your results, sulks when things break.",
            "spriteVersionNumber": 2,
            "spritesheetPath": "spritesheet.png",
            "pixelArt": True,
        }, f, indent=2)
        f.write("\n")
    write_preview(canvases, os.path.join(ROOT, "tools", "clay-preview.png"))
    print(f"wrote {w}x{h} atlas to {pet_dir}")


if __name__ == "__main__":
    main()
