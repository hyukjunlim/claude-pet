"""Generate "Ember", the default Claude Pet, as a Codex-compatible v2 sprite atlas.

Pure Python (no dependencies). Every cell is drawn on a 48x52 logical pixel grid and
scaled 4x into the 192x208 cells of a 1536x2288 atlas (8 columns x 11 rows):

    row 0 idle, 1 running-right, 2 running-left, 3 waving, 4 jumping,
    5 failed, 6 waiting, 7 running (working), 8 review, 9-10 look directions.

Usage:  python tools/make_ember.py
Writes: pets/ember/spritesheet.png, pets/ember/pet.json, assets/tray*.png,
        assets/icon.png, tools/ember-preview.png
"""
import json
import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

LW, LH = 48, 52          # logical cell size
SCALE = 4                # logical pixel -> atlas pixels
CELL_W, CELL_H = LW * SCALE, LH * SCALE
COLS, ROWS = 8, 11
FRAMES_BY_ROW = [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8]

PALETTE = {
    "o": (74, 38, 24, 255),       # outline
    "b": (217, 119, 87, 255),     # body (Claude terracotta)
    "s": (181, 88, 59, 255),      # body shade
    "h": (236, 152, 118, 255),    # body highlight
    "H": (250, 204, 180, 255),    # specular
    "e": (42, 23, 18, 255),       # eyes / mouth
    "w": (255, 255, 255, 255),    # eye glint
    "k": (240, 132, 122, 255),    # blush
    "f": (150, 66, 42, 255),      # feet
    "y": (245, 190, 96, 255),     # spark gold
    "c": (255, 244, 222, 255),    # spark core / cream
    "m": (160, 150, 144, 255),    # drooped spark gray
    "q": (255, 252, 246, 255),    # bubble fill
    "g": (58, 170, 98, 255),      # check green
    "u": (130, 190, 250, 255),    # sweat
    "p": (255, 247, 232, 255),    # paper
    "l": (196, 178, 160, 255),    # paper lines
    "d": (214, 196, 180, 225),    # dust (slightly translucent)
    "z": (40, 20, 12, 46),        # ground shadow
}


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
        """Draw a list-of-strings pattern; '.' and ' ' are transparent."""
        for dy, row in enumerate(pattern):
            for dx, ch in enumerate(row):
                if ch not in ". ":
                    self.set(x0 + dx, y0 + dy, ch)


def ellipse_pixels(cx, cy, rx, ry, power=2.0):
    pts = []
    for y in range(int(cy - ry - 1), int(cy + ry + 2)):
        for x in range(int(cx - rx - 1), int(cx + rx + 2)):
            nx = (x + 0.5 - cx) / rx
            ny = (y + 0.5 - cy) / ry
            if abs(nx) ** power + abs(ny) ** power <= 1.0:
                pts.append((x, y))
    return pts


def outline(c, mask, color="o"):
    """1px outline on transparent pixels 4-adjacent to the mask."""
    mask = set(mask)
    for (x, y) in list(mask):
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if (nx, ny) not in mask and c.get(nx, ny) is None:
                c.set(nx, ny, color)


# ---------------------------------------------------------------- the critter

CX, CY, RX, RY = 24.0, 34.5, 14.0, 12.0     # body ellipse at rest
GROUND = 48                                  # first transparent row under the feet


def draw_pet(c, *, dx=0, dy=0, squash=0, lean=0, eyes="open", eye_dx=0, eye_dy=0,
             feet=((0, 0), (0, 0)), arms=("down", "down"), mouth="smile", blush=True,
             spark="normal", spark_phase=0, spark_tilt=0, face_dx=None, face_dy=None,
             shadow=True):
    """Draw the pet. dy<0 moves up. squash>0 = wider/shorter, <0 = taller/narrower."""
    rx = RX + squash * 0.6
    ry = RY - squash * 0.8
    cx = CX + dx
    bottom = GROUND - 3 + dy                  # body bottom row sits just above the feet
    cy = bottom - ry + 0.5
    top = int(round(cy - ry))

    # ground shadow (does not move with dy, shrinks while airborne)
    if shadow:
        air = max(0, -dy)
        srx = max(5.0, 12.0 - air * 0.55)
        for (x, y) in ellipse_pixels(CX + dx * 0.5, GROUND - 0.5, srx, 1.6):
            c.set(x, y, "z")

    body = ellipse_pixels(cx, cy, rx, ry, power=2.3)
    if lean:
        # shear the top half toward the lean direction
        sheared = []
        for (x, y) in body:
            t = (cy - y) / ry          # 1 at top, 0 at center, <0 below
            sheared.append((x + int(round(lean * max(0.0, t))), y))
        body = sheared

    # feet (behind the body)
    foot_pts = []
    for side, (fx, fy) in zip((-1, 1), feet):
        fcx = cx + side * 6.5 + fx
        fcy = bottom + 1.5 - fy
        foot_pts += ellipse_pixels(fcx, fcy, 3.2, 1.9)
    for p in foot_pts:
        c.set(p[0], p[1], "f")

    # arms
    arm_pts = []
    for side, pose in zip((-1, 1), arms):
        if pose == "none":
            continue
        ax, ay, arx, ary = {
            "down": (rx + 0.2, 3.0, 2.2, 3.0),
            "out": (rx + 2.2, -0.5, 2.6, 2.0),
            "up": (rx - 3.0, -9.0, 2.0, 3.6),
            "wave1": (rx - 2.0, -9.5, 2.0, 3.6),
            "wave2": (rx + 0.5, -7.0, 2.2, 3.4),
            "hold": (rx - 5.5, 5.0, 2.4, 2.2),
            "type1": (rx - 1.0, 5.5, 2.4, 2.0),
            "type2": (rx - 1.0, 4.5, 2.4, 2.0),
        }[pose]
        arm_pts += ellipse_pixels(cx + side * ax, cy + ay, arx, ary)
    for p in arm_pts:
        c.set(p[0], p[1], "b")

    # body with directional shading (light from upper-left)
    for (x, y) in body:
        nx = (x + 0.5 - cx) / rx
        ny = (y + 0.5 - cy) / ry
        k = nx * 0.55 + ny * 0.83
        c.set(x, y, "s" if k > 0.58 else ("h" if k < -0.66 else "b"))
    for (x, y) in ((int(cx - rx * 0.52), int(cy - ry * 0.62)), (int(cx - rx * 0.52) + 1, int(cy - ry * 0.62)),
                   (int(cx - rx * 0.52), int(cy - ry * 0.62) + 1)):
        c.set(x, y, "H")
    for (x, y) in arm_pts:              # re-shade arms that overlap the body so they read
        nx = (x + 0.5 - cx)
        if c.get(x, y) in ("b", "h", "s"):
            c.set(x, y, "h" if (y < cy - 2 and nx * (1 if x > cx else -1) > 0) else "b")

    outline(c, set(body) | set(foot_pts) | set(arm_pts))

    # face
    fdx = eye_dx // 2 if face_dx is None else face_dx
    fdy = eye_dy // 2 if face_dy is None else face_dy
    ex_l, ex_r = int(round(cx - 5.5)) + eye_dx, int(round(cx + 4.5)) + eye_dx
    ey = int(round(cy - 3)) + eye_dy
    for ex in (ex_l, ex_r):
        draw_eye(c, ex, ey, eyes)
    if blush:
        by = int(round(cy + 1.5)) + fdy
        for bx in (int(round(cx - 10)) + fdx, int(round(cx + 8)) + fdx):
            c.set(bx, by, "k")
            c.set(bx + 1, by, "k")
    draw_mouth(c, int(round(cx - 1.5)) + fdx, int(round(cy + 2.5)) + fdy, mouth)

    # spark antenna
    draw_spark(c, int(round(cx + 2 + lean * 0.8)), top, spark, spark_phase, spark_tilt)
    return {"cx": cx, "cy": cy, "rx": rx, "ry": ry, "top": top, "bottom": bottom}


def draw_eye(c, x, y, kind):
    if kind in ("open", "up", "wide"):
        h = 4 if kind != "wide" else 5
        w = 2 if kind != "wide" else 3
        for yy in range(h):
            for xx in range(w):
                c.set(x + xx, y + yy - (1 if kind == "wide" else 0), "e")
        c.set(x, y - (1 if kind == "wide" else 0), "w")
    elif kind == "focused":
        for xx in (0, 1):
            c.set(x + xx, y + 1, "e")
            c.set(x + xx, y + 2, "e")
        c.set(x - 1, y - 1, "e")         # determined brows
        c.set(x + 2, y - 1, "e")
    elif kind == "closed":
        for xx in (-1, 0, 1, 2):
            c.set(x + xx, y + 2, "e")
    elif kind == "happy":
        c.blit([".ee.", "e..e"], x - 1, y + 1)
    elif kind == "sad":
        for yy in (1, 2, 3):
            c.set(x, y + yy, "e")
            c.set(x + 1, y + yy, "e")
        c.set(x, y + 1, "w")
    elif kind == "x":
        c.blit(["e.e", ".e.", "e.e"], x - 1 + 1, y)


def draw_mouth(c, x, y, kind):
    pattern = {
        "smile": ["e..e", ".ee."],
        "open": ["eeee", ".ee."],
        "flat": ["....", ".ee."],
        "frown": [".ee.", "e..e"],
        "o": [".ee.", ".ee."],
        "none": [],
    }[kind]
    c.blit(pattern, x, y)


def draw_spark(c, x, top, kind, phase, tilt):
    if kind == "none":
        return
    if kind == "droop":
        # stalk bends sideways, spark dims
        c.blit(["..oo", ".o..", "o..."], x - 1, top - 3)
        c.blit([".m.", "mmm", ".m."], x + 3, top - 4)
        return
    # stalk
    sx = x + tilt
    c.set(x, top - 1, "o")
    c.set(x + (1 if tilt > 0 else 0), top - 2, "o")
    c.set(sx, top - 3, "o")
    cy = top - 6
    if kind == "bright":
        c.blit(["...y...", "...y...", "..ycy..", "yycccyy", "..ycy..", "...y...", "...y..."], sx - 3, cy - 3)
        return
    shapes = [
        ["..y..", "..y..", "yycyy", "..y..", "..y.."],   # plus
        [".....", ".y.y.", "..c..", ".y.y.", "....."],   # small x
        ["..y..", ".yyy.", "yycyy", ".yyy.", "..y.."],   # full
        [".....", "..y..", ".ycy.", "..y..", "....."],   # tiny
    ]
    if kind == "spin":
        c.blit(shapes[phase % 4], sx - 2, cy - 2)
    else:
        c.blit(shapes[0] if phase % 2 == 0 else shapes[3], sx - 2, cy - 2)


def bubble(c, x, y, glyph):
    c.blit([
        ".ooooooo.",
        "oqqqqqqqo",
        "oqqqqqqqo",
        "oqqqqqqqo",
        "oqqqqqqqo",
        "oqqqqqqqo",
        "oqqqqqqqo",
        ".ooooooo.",
        "..oqo....",
        "...o.....",
    ], x, y)
    if glyph == "?":
        c.blit([".bbb.", "b...b", "...b.", "..b..", ".....", "..b.."], x + 2, y + 1)
    elif glyph == "!":
        c.blit(["..b..", "..b..", "..b..", "..b..", ".....", "..b.."], x + 2, y + 1)


def dust(c, x, y, size):
    shapes = {
        4: [".dd.", "dddd", "dddd", ".dd."],
        3: [".dd.", "dddd", ".dd."],
        2: [".d.", "ddd", ".d."],
        1: ["d"],
    }
    if size in shapes:
        c.blit(shapes[size], x, y)


def paper(c, x, y):
    c.blit([
        "oooooooooo",
        "oppppppppo",
        "opllllllpo",
        "oppppppppo",
        "opllllpppo",
        "oppppppppo",
        "oplllllppo",
        "oooooooooo",
    ], x, y)


def check(c, x, y):
    c.blit([
        "......gg",
        ".....gg.",
        "g...gg..",
        "gg.gg...",
        ".ggg....",
        "..g.....",
    ], x, y)


def sweat(c, x, y):
    c.blit([".u.", "uuu", "uuu", ".u."], x, y)


# ---------------------------------------------------------------- animations

def frames_idle():
    out = []
    for i, (sq, eyes) in enumerate([(0, "open"), (1, "open"), (1, "closed"), (0, "open"), (-1, "open"), (0, "open")]):
        c = Canvas()
        draw_pet(c, squash=sq, eyes=eyes, spark_phase=i // 3)
        out.append(c)
    return out


def frames_run(direction):
    out = []
    for i in range(8):
        p = i / 8 * 2 * math.pi
        c = Canvas()
        lift_a = max(0, int(round(2.4 * math.sin(p))))
        lift_b = max(0, int(round(-2.4 * math.sin(p))))
        bob = -1 if i % 4 in (1, 2) else 0
        swing = ("out", "down") if i < 4 else ("down", "out")
        feet = ((direction * int(round(1.5 * math.cos(p))), lift_a),
                (direction * int(round(-1.5 * math.cos(p))), lift_b))
        draw_pet(c, dy=bob, lean=direction * 2, eyes="open", eye_dx=direction * 2,
                 feet=feet, arms=swing, mouth="open" if i % 4 == 0 else "smile",
                 spark_tilt=-direction, spark_phase=i)
        # dust puffs trailing behind
        back = -direction
        for k, size in enumerate((4, 3, 2)):
            age = (i + k * 3) % 8
            if age < 5:
                px = int(CX + back * (RX + 3 + age * 2 + k))
                dust(c, px - (3 if back < 0 else 0), GROUND - 3 - (age // 2), max(1, size - age // 2))
        out.append(c)
    return out


def frames_wave():
    out = []
    for pose, sq in (("wave1", 0), ("wave2", 0), ("wave1", 0), ("up", 1)):
        c = Canvas()
        draw_pet(c, squash=sq, eyes="happy", arms=("down", pose), mouth="open", spark="bright" if pose == "wave2" else "normal")
        out.append(c)
    return out


def frames_jump():
    spec = [  # dy, squash, arms, eyes, mouth, feet lift
        (1, 2, ("down", "down"), "closed", "smile", 0),
        (-6, -2, ("up", "up"), "open", "open", 1),
        (-11, -1, ("up", "up"), "happy", "open", 2),
        (-5, -1, ("out", "out"), "open", "o", 1),
        (1, 2, ("down", "down"), "happy", "smile", 0),
    ]
    out = []
    for dy, sq, arms, eyes, mouth, lift in spec:
        c = Canvas()
        draw_pet(c, dy=dy, squash=sq, arms=arms, eyes=eyes, mouth=mouth,
                 feet=((0, lift), (0, lift)), spark="bright" if dy < -8 else "normal")
        out.append(c)
    return out


def frames_failed():
    spec = [  # dx, squash, eyes, mouth, spark, sweat_y
        (0, 0, "wide", "o", "normal", None),
        (-1, 0, "x", "o", "normal", None),
        (1, 0, "x", "frown", "normal", None),
        (0, 1, "x", "frown", "droop", None),
        (0, 2, "sad", "frown", "droop", 0),
        (0, 2, "sad", "frown", "droop", 2),
        (0, 3, "sad", "frown", "droop", 4),
        (0, 3, "sad", "flat", "droop", None),
    ]
    out = []
    for dx, sq, eyes, mouth, spark, sy in spec:
        c = Canvas()
        g = draw_pet(c, dx=dx, squash=sq, eyes=eyes, mouth=mouth, spark=spark, arms=("down", "down"), blush=False)
        if sy is not None:
            sweat(c, int(g["cx"] + g["rx"] - 3), int(g["cy"] - g["ry"] + 4 + sy))
        out.append(c)
    return out


def frames_waiting():
    out = []
    bob = [0, -1, -1, 0, 0, -1]
    sway = [-1, 0, 1, 1, 0, -1]
    for i in range(6):
        c = Canvas()
        tap = (0, 1) if i in (2, 5) else (0, 0)
        g = draw_pet(c, lean=sway[i], eyes="up", eye_dx=1, eye_dy=-1, face_dx=0, face_dy=0,
                     feet=((0, 0), tap), arms=("down", "down"), mouth="o" if i in (1, 2) else "smile",
                     spark_phase=i // 2)
        bubble(c, int(g["cx"] + 6), int(g["top"] - 13 + bob[i]), "?")
        out.append(c)
    return out


def frames_working():
    out = []
    bob = [0, -1, -1, 0, -1, 0]
    for i in range(6):
        c = Canvas()
        arms = ("type1", "type2") if i % 2 == 0 else ("type2", "type1")
        g = draw_pet(c, dy=bob[i], eyes="focused", eye_dy=1, face_dy=0, arms=arms, mouth="flat",
                     spark="spin", spark_phase=i)
        # orbiting motes around the spark
        sx, sy = g["cx"] + 2, g["top"] - 6
        a = i / 6 * 2 * math.pi
        for k in range(2):
            ang = a + k * math.pi
            c.set(int(round(sx + 5 * math.cos(ang))), int(round(sy + 2.5 * math.sin(ang))), "c" if k == 0 else "y")
        out.append(c)
    return out


def frames_review():
    out = []
    looks = [-2, -1, 0, 1, 2, 0]
    for i in range(6):
        c = Canvas()
        done = i == 5
        g = draw_pet(c, eyes="happy" if done else "open", eye_dx=looks[i], eye_dy=1, face_dx=0, face_dy=0,
                     arms=("hold", "hold"), mouth="open" if done else "flat",
                     spark="bright" if done else "normal")
        paper(c, int(g["cx"] - 5), int(g["cy"] + 3))
        if i >= 4:
            check(c, int(g["cx"] + g["rx"] - 2), int(g["top"] - (6 if done else 3)))
        out.append(c)
    return out


def look_offset(i):
    a = math.radians(i * 22.5)
    return (int(math.floor(2.2 * math.sin(a) + 0.5)), int(math.floor(-2.2 * math.cos(a) + 0.5)))


def frames_look(start):
    out = []
    for i in range(start, start + 8):
        c = Canvas()
        ox, oy = look_offset(i)
        draw_pet(c, eyes="open", eye_dx=ox, eye_dy=oy, spark_tilt=(1 if ox > 0 else -1 if ox < 0 else 0),
                 lean=ox // 2)
        out.append(c)
    return out


# ---------------------------------------------------------------- output

def rgba(ch):
    return bytes(PALETTE[ch]) if ch else b"\x00\x00\x00\x00"


def compose_atlas(rows):
    w, h = CELL_W * COLS, CELL_H * ROWS
    buf = bytearray(w * h * 4)
    for r, frames in enumerate(rows):
        assert len(frames) == FRAMES_BY_ROW[r], (r, len(frames))
        for col, canvas in enumerate(frames):
            ox, oy = col * CELL_W, r * CELL_H
            for ly in range(LH):
                for lx in range(LW):
                    ch = canvas.px[ly][lx]
                    if ch is None:
                        continue
                    block = rgba(ch) * SCALE
                    for sy in range(SCALE):
                        start = ((oy + ly * SCALE + sy) * w + ox + lx * SCALE) * 4
                        buf[start:start + SCALE * 4] = block
    return w, h, buf


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


def render_canvas(canvas, scale, crop=None, bg=None):
    x0, y0, x1, y1 = crop or (0, 0, LW, LH)
    w, h = (x1 - x0) * scale, (y1 - y0) * scale
    buf = bytearray((bg or (0, 0, 0, 0)) * (w * h)) if bg else bytearray(w * h * 4)
    for ly in range(y0, y1):
        for lx in range(x0, x1):
            ch = canvas.px[ly][lx]
            if ch is None:
                continue
            color = PALETTE[ch]
            if bg and color[3] < 255:           # blend translucent pixels over preview bg
                a = color[3] / 255
                color = tuple(int(color[i] * a + bg[i] * (1 - a)) for i in range(3)) + (255,)
            block = bytes(color) * scale
            for sy in range(scale):
                start = (((ly - y0) * scale + sy) * w + (lx - x0) * scale) * 4
                buf[start:start + scale * 4] = block
    return w, h, buf


def write_preview(rows, path, scale=2):
    pad = 4
    cw, ch = LW * scale, LH * scale
    w, h = COLS * (cw + pad) + pad, ROWS * (ch + pad) + pad
    buf = bytearray(bytes((236, 232, 226, 255)) * (w * h))
    for r, frames in enumerate(rows):
        for col, canvas in enumerate(frames):
            tile_bg = (250, 248, 244, 255) if (r + col) % 2 == 0 else (242, 238, 232, 255)
            tw, th, tile = render_canvas(canvas, scale, bg=tile_bg)
            ox, oy = pad + col * (cw + pad), pad + r * (ch + pad)
            for y in range(th):
                dst = ((oy + y) * w + ox) * 4
                buf[dst:dst + tw * 4] = tile[y * tw * 4:(y + 1) * tw * 4]
    write_png(path, w, h, buf)


def main():
    rows = [
        frames_idle(),
        frames_run(1),
        frames_run(-1),
        frames_wave(),
        frames_jump(),
        frames_failed(),
        frames_waiting(),
        frames_working(),
        frames_review(),
        frames_look(0),
        frames_look(8),
    ]
    pet_dir = os.path.join(ROOT, "pets", "ember")
    w, h, buf = compose_atlas(rows)
    write_png(os.path.join(pet_dir, "spritesheet.png"), w, h, buf)
    with open(os.path.join(pet_dir, "pet.json"), "w", encoding="utf-8") as f:
        json.dump({
            "id": "ember",
            "displayName": "Ember",
            "description": "A little terracotta critter that keeps an eye on your Claude sessions.",
            "spriteVersionNumber": 2,
            "spritesheetPath": "spritesheet.png",
            "pixelArt": True,
        }, f, indent=2)
        f.write("\n")

    idle = rows[0][0]
    face_crop = (8, 16, 40, 48)            # 32x32 logical region around the body
    tw, th, tray32 = render_canvas(idle, 1, crop=face_crop)
    write_png(os.path.join(ROOT, "assets", "tray@2x.png"), tw, th, tray32)
    write_png(os.path.join(ROOT, "assets", "tray.png"), *downsample(tw, th, tray32, 2))
    iw, ih, icon = render_canvas(idle, 8, crop=face_crop)
    write_png(os.path.join(ROOT, "assets", "icon.png"), iw, ih, icon)
    write_preview(rows, os.path.join(ROOT, "tools", "ember-preview.png"))
    print(f"wrote {w}x{h} atlas to {pet_dir}")


def downsample(w, h, buf, factor):
    """Nearest-neighbour downsample that prefers opaque pixels in each block."""
    nw, nh = w // factor, h // factor
    out = bytearray(nw * nh * 4)
    for y in range(nh):
        for x in range(nw):
            best = None
            for sy in range(factor):
                for sx in range(factor):
                    i = ((y * factor + sy) * w + x * factor + sx) * 4
                    px = buf[i:i + 4]
                    if best is None or px[3] > best[3]:
                        best = px
            j = (y * nw + x) * 4
            out[j:j + 4] = best
    return nw, nh, out


if __name__ == "__main__":
    main()
