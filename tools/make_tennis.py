"""PET-TENNIS: build an animated, Codex-format tennis ball pet without external packages.

Run: python tools/make_tennis.py
"""

import json
import math
import os

import make_clay as base


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PET_DIR = os.path.join(ROOT, "pets", "tennis")
PALETTE = {
    **base.PALETTE,
    "O": (42, 76, 27, 255),
    "o": (72, 111, 39, 255),
    "D": (104, 150, 29, 255),
    "s": (145, 191, 33, 255),
    "b": (190, 222, 46, 255),
    "l": (215, 238, 75, 255),
    "h": (237, 249, 128, 255),
    "W": (255, 255, 205, 255),
    "T": (104, 145, 48, 255),   # seam shadow
    "t": (255, 251, 221, 255),  # felt seam
    "e": (34, 58, 27, 255),
    "m": (105, 51, 62, 255),
    "k": (255, 151, 143, 255),
    "f": (65, 104, 43, 255),
    "F": (40, 74, 35, 255),
    "z": (40, 65, 25, 45),
}


def body_mask(cx, cy, rx, ry, lean):
    points = set()
    for y in range(int(cy - ry) - 1, int(cy + ry) + 2):
        tilt = (cy - y) / ry
        shift = lean * max(0.0, tilt) * 0.7
        for x in range(int(cx - rx) - 2, int(cx + rx) + 3):
            nx = (x + 0.5 - cx - shift) / rx
            ny = (y + 0.5 - cy) / ry
            if nx * nx + ny * ny <= 1:
                points.add((x, y))
    return points


def draw_pet(pose):
    canvas = base.Canvas()
    cx = 24 + pose.dx
    rx = 15.1 + pose.squash * 0.45
    ry = 15.1 - pose.squash * 0.55
    bottom = 44 + pose.dy
    cy = bottom - ry + 0.5
    top = int(cy - ry)

    if pose.shadow:
        air = max(0, -pose.dy)
        for x, y in base.ellipse(24 + pose.dx * 0.5, 47, max(5, 12 - air * 0.5), 1.5):
            canvas.set(x, y, "z")
    base.draw_props(canvas, pose, "back", cx, cy, rx, ry, top)

    feet = set()
    for side, (foot_x, lift) in zip((-1, 1), pose.feet):
        part = base.ellipse(cx + side * 8 + foot_x, bottom + 1.8 - lift, 3.3, 1.8)
        feet |= part
        for x, y in part:
            canvas.set(x, y, "F" if y > bottom + 2 - lift else "f")

    arms = set()
    for side, action in zip((-1, 1), pose.arms):
        if action in base.ARM_SPOTS:
            deg, out, arx, ary = base.ARM_SPOTS[action]
            angle = math.radians(deg)
            parts = [(cx + side * (rx + out) * math.sin(angle),
                      cy - (ry + out) * math.cos(angle), arx, ary)]
        elif action in base.ARM_LIMBS:
            parts = [(x, y, radius, radius)
                     for x, y, radius in base.limb_pixels(cx, cy, rx, ry, side, action)]
        else:
            parts = []
        for ax, ay, arx, ary in parts:
            for x, y in base.ellipse(ax, ay, arx, ary):
                arms.add((x, y))
                canvas.set(x, y, base.tone(base.shade((x - ax) / arx, (y - ay) / ary)))

    body = body_mask(cx, cy, rx, ry, pose.lean)
    for x, y in body:
        nx = (x + 0.5 - cx) / rx
        ny = (y + 0.5 - cy) / ry
        canvas.set(x, y, base.tone(base.shade(nx, ny)))

    # Two curved cream felt seams are visible in every animation state.
    for y in range(top + 2, int(bottom) - 1):
        t = (y - top) / max(1, bottom - top)
        distance = 7.1 + 3.0 * math.sin(math.pi * t)
        shift = pose.lean * max(0, (cy - y) / ry) * 0.7
        for side in (-1, 1):
            x = round(cx + shift + side * distance)
            for px, color in ((x - 1, "T"), (x, "t"), (x + 1, "t")):
                if (px, y) in body:
                    canvas.set(px, y, color)

    for x, y in base.outline_of(body | feet | arms):
        nx, ny = (x - cx) / rx, (y - cy) / ry
        canvas.set(x, y, "o" if -0.55 * nx - 0.83 * ny > 0.42 else "O")
    for x, y in ((round(cx - 6), round(top + 6)), (round(cx - 5), round(top + 6))):
        if (x, y) in body:
            canvas.set(x, y, "W")

    base.draw_face(canvas, pose, cx, cy)
    base.draw_props(canvas, pose, "front", cx, cy, rx, ry, top)
    for side, action in zip((-1, 1), pose.arms):
        if action not in base.FRONT_ARMS:
            continue
        ox, oy, arx, ary = base.FRONT_ARMS[action]
        part = base.ellipse(cx + side * ox, cy + oy, arx, ary)
        for x, y in base.outline_of(part):
            canvas.set(x, y, "O")
        for x, y in part:
            canvas.set(x, y, "l")
    base.draw_props(canvas, pose, "over", cx, cy, rx, ry, top)
    return canvas


def compose(rows):
    width, height = base.CELL_W * base.COLS, base.CELL_H * base.ROWS
    pixels = bytearray(width * height * 4)
    canvases = []
    for row_index, poses in enumerate(rows):
        assert len(poses) == base.FRAMES_BY_ROW[row_index]
        row = []
        for col, pose in enumerate(poses):
            canvas = draw_pet(pose)
            row.append(canvas)
            for y in range(base.LH):
                for x in range(base.LW):
                    key = canvas.px[y][x]
                    if key is None:
                        continue
                    block = bytes(PALETTE[key]) * base.SCALE
                    for dy in range(base.SCALE):
                        at = (((row_index * base.CELL_H + y * base.SCALE + dy) * width)
                              + col * base.CELL_W + x * base.SCALE) * 4
                        pixels[at:at + base.SCALE * 4] = block
        canvases.append(row)
    return width, height, pixels, canvases


def tray_icons():
    canvas = draw_pet(base.Pose())
    icon = bytearray(32 * 32 * 4)
    for y in range(32):
        for x in range(32):
            key = canvas.px[y + 15][x + 8]
            if key is not None and key != "z":
                at = (y * 32 + x) * 4
                icon[at:at + 4] = bytes(PALETTE[key])
    for size, name in ((32, "tray@2x.png"), (24, "tray@1.5x.png"), (16, "tray.png")):
        data = icon if size == 32 else base.area_resample(icon, 32, 32, size, size)
        base.write_png(os.path.join(PET_DIR, name), size, size, data)


def main():
    rows = [base.idle(), base.run(1), base.run(-1), base.wave(), base.jump(),
            base.failed(), base.waiting(), base.working(), base.review(),
            base.looks(0), base.looks(8)]
    width, height, pixels, canvases = compose(rows)
    base.write_png(os.path.join(PET_DIR, "spritesheet.png"), width, height, pixels)
    tray_icons()
    with open(os.path.join(PET_DIR, "pet.json"), "w", encoding="utf-8") as manifest:
        json.dump({
            "id": "tennis",
            "displayName": "Tennis Ball",
            "description": "A cheerful tennis ball that bounces, works, waits, and celebrates with you.",
            "spriteVersionNumber": 2,
            "spritesheetPath": "spritesheet.png",
            "pixelArt": True,
        }, manifest, indent=2)
        manifest.write("\n")
    base.PALETTE = PALETTE
    base.write_preview(canvases, os.path.join(ROOT, "tools", "tennis-preview.png"))
    print(f"Wrote {width}x{height} tennis pet to {PET_DIR}")


if __name__ == "__main__":
    main()
