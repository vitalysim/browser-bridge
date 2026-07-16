#!/usr/bin/env python3
"""Generate the Browser Bridge extension icons.

A suspension bridge (on-theme with the name) in white on a graphite squircle -
matching the hero banner (docs/banner.svg): monochrome, near-black gradient, a
soft white "live connection" node. Rendered at 4x and downscaled with LANCZOS
for crisp small sizes.
"""
from PIL import Image, ImageDraw, ImageFilter
import os

S = 512
TOP = (22, 22, 25)      # #161619 zinc-900 (banner card top)
BOT = (11, 11, 13)      # #0b0b0d near-black (banner card bottom)
BORDER = (42, 42, 49)   # #2a2a31 subtle edge (banner border) for dark-toolbar definition
WHITE = (255, 255, 255, 255)
NODE = (228, 228, 231)  # #e4e4e7 zinc-200 - light, monochrome connection node


def quad(p0, p1, p2, n=48):
    pts = []
    for i in range(n + 1):
        t = i / n
        mt = 1 - t
        x = mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0]
        y = mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1]
        pts.append((x, y))
    return pts


def build():
    # vertical gradient
    bg = Image.new("RGBA", (S, S))
    px = bg.load()
    for y in range(S):
        t = y / (S - 1)
        r = int(TOP[0] + (BOT[0] - TOP[0]) * t)
        g = int(TOP[1] + (BOT[1] - TOP[1]) * t)
        b = int(TOP[2] + (BOT[2] - TOP[2]) * t)
        for x in range(S):
            px[x, y] = (r, g, b, 255)

    # soft diagonal sheen (lighter top-left)
    sheen = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sheen)
    sd.ellipse([-160, -260, 360, 220], fill=(255, 255, 255, 40))
    sheen = sheen.filter(ImageFilter.GaussianBlur(60))
    bg = Image.alpha_composite(bg, sheen)

    # squircle mask
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=118, fill=255)

    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    icon.paste(bg, (0, 0), mask)
    d = ImageDraw.Draw(icon)

    # subtle edge for definition on dark toolbars (matches the banner's border)
    d.rounded_rectangle([3, 3, S - 4, S - 4], radius=116, outline=BORDER + (255,), width=4)

    deck_y = 340
    tower_top = 150
    L = (66, 300)
    T1 = (182, tower_top)
    T2 = (330, tower_top)
    R = (446, 300)
    M = (256, 300)  # control for the sagging mid-span

    # main cable: edge -> tower1 -> (sag) -> tower2 -> edge
    cable = (
        quad(L, (120, 250), T1)
        + quad(T1, M, T2)[1:]
        + quad(T2, (392, 250), R)[1:]
    )

    # suspenders (verticals from cable down to the deck)
    for i in range(6, len(cable) - 6, 4):
        x, y = cable[i]
        if y < deck_y - 6:
            d.line([(x, y), (x, deck_y)], fill=(255, 255, 255, 235), width=4)

    # main cable stroke
    d.line(cable, fill=WHITE, width=11, joint="curve")

    # towers
    for tx in (T1[0], T2[0]):
        d.rounded_rectangle([tx - 12, tower_top - 8, tx + 12, deck_y + 8], radius=8, fill=WHITE)

    # deck
    d.rounded_rectangle([56, deck_y - 12, 456, deck_y + 12], radius=12, fill=WHITE)
    # roadway pillars below deck
    for tx in (T1[0], T2[0]):
        d.rounded_rectangle([tx - 9, deck_y + 12, tx + 9, 396], radius=6, fill=(255, 255, 255, 220))

    # soft white "live connection" node at the mid-span dip (monochrome, matches banner)
    cx, cy = 256, 300
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([cx - 42, cy - 42, cx + 42, cy + 42], fill=(255, 255, 255, 120))
    glow = glow.filter(ImageFilter.GaussianBlur(20))
    icon = Image.alpha_composite(icon, glow)
    d = ImageDraw.Draw(icon)
    d.ellipse([cx - 16, cy - 16, cx + 16, cy + 16], fill=NODE + (255,))
    d.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], fill=WHITE)

    icon = icon.resize((S, S), Image.LANCZOS)
    return icon


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    icon = build()
    for size in (128, 48, 32, 16):
        out = icon.resize((size, size), Image.LANCZOS)
        out.save(os.path.join(here, f"icon{size}.png"))
        print("wrote", f"icon{size}.png")


if __name__ == "__main__":
    main()
