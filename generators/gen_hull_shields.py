#!/usr/bin/env python3
"""Build 4 directional shields that fit the SSV Silver Gull's hull perfectly.

Instead of a generic dome, each shield is derived from the ship's own silhouette
(the alpha channel of ship-intact.png): a smooth glowing energy band that hugs the
hull just outside its edge, masked to one side (fore / aft / port / starboard).

Because each shield PNG is rendered on the SAME canvas as the ship image, the HUD can
overlay it directly on the ship for a pixel-perfect fit.

Output: assets/shields/shield-<side>.png   (RGBA, ship-sized)
"""
import pathlib
from PIL import Image, ImageFilter, ImageChops, ImageDraw

MODULE = pathlib.Path(__file__).resolve().parent.parent
SHIP = MODULE / "assets" / "ship" / "ship-intact.png"
OUT = MODULE / "assets" / "shields"

TEAL = (72, 232, 226)   # shield colour

def side_gradient(size, side):
    """L-mode ramp: 255 on the chosen side, fading to 0 past the middle."""
    w, h = size
    g = Image.new("L", size, 0)
    px = g.load()
    for y in range(h):
        for x in range(w):
            if side == "fore":       t = 1 - y / (h * 0.55)
            elif side == "aft":      t = 1 - (h - y) / (h * 0.55)
            elif side == "port":     t = 1 - x / (w * 0.55)
            else:                    t = 1 - (w - x) / (w * 0.55)   # starboard
            px[x, y] = max(0, min(255, int(t * 255)))
    return g

def build(side, sil, glow, rim):
    grad = side_gradient(sil.size, side)
    # shield body = soft outward glow + bright hull-hugging rim, limited to this side
    body = ImageChops.add(glow, rim)
    alpha = ImageChops.multiply(body, grad)
    shield = Image.new("RGBA", sil.size, TEAL + (0,))
    shield.putalpha(alpha)
    OUT.mkdir(parents=True, exist_ok=True)
    shield.save(OUT / f"shield-{side}.png")
    print("saved", (OUT / f"shield-{side}.png").name)

def main():
    ship = Image.open(SHIP).convert("RGBA")
    a = ship.split()[3]
    sil = a.point(lambda v: 255 if v > 40 else 0)         # clean silhouette
    sil = sil.filter(ImageFilter.MaxFilter(5))            # close small gaps
    outside = sil.point(lambda v: 0 if v > 0 else 255)    # 255 outside the ship

    # smooth outward glow: two layers (a wide soft halo + a tighter brighter one), OUTSIDE the hull
    wide = ImageChops.multiply(sil.filter(ImageFilter.GaussianBlur(70)), outside).point(lambda v: min(255, int(v * 2.4)))
    tight = ImageChops.multiply(sil.filter(ImageFilter.GaussianBlur(30)), outside).point(lambda v: min(255, int(v * 2.2)))
    glow = ImageChops.lighter(wide, tight)

    # thick bright rim hugging the hull edge (dilated silhouette minus the silhouette)
    dil = sil.filter(ImageFilter.MaxFilter(29))
    rim = ImageChops.subtract(dil, sil)
    rim = rim.filter(ImageFilter.GaussianBlur(3)).point(lambda v: min(255, int(v * 1.7)))

    for side in ("fore", "aft", "port", "starboard"):
        build(side, sil, glow, rim)

if __name__ == "__main__":
    main()
