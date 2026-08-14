#!/usr/bin/env python3
"""Generate holographic HUD art (system icons + shield arcs) for the Ship Overview.

Adapted from maps/generators/gen_backdrop.py. Reads OPENAI_API_KEY from the repo-root
.env, calls gpt-image-1 with a TRANSPARENT background, and writes PNGs into the
module's assets/ folders. Costs credits — run deliberately.

Usage:
  python3 gen_hud_asset.py working          # all systems + arcs, ONLY the working state
  python3 gen_hud_asset.py damaged          # all, damaged state
  python3 gen_hud_asset.py destroyed        # all, destroyed state
  python3 gen_hud_asset.py all              # every asset, every state (~33 images)
  python3 gen_hud_asset.py <id> <state>     # one asset, e.g.  engine working

Asset ids: shields engine thrusters reactor weapons sensors lifesupport cloak
           arc-fore arc-side arc-secondary
States:    working | damaged | destroyed
"""
import os, sys, json, base64, urllib.request, pathlib, time

HERE = pathlib.Path(__file__).resolve().parent
MODULE = HERE.parent                       # ssv-silver-gull-ship-combat/
ENV = MODULE.parent.parent.parent / ".env" # repo root
SYS_DIR = MODULE / "assets" / "systems"
ARC_DIR = MODULE / "assets" / "shields"

STYLE = ("A photorealistic, highly detailed 3D render of a spaceship subsystem set into a section of the "
         "ship's hull plating, physically based materials, sharp focus, cinematic soft studio lighting, "
         "STRONG three-quarter perspective with real depth and dimensionality — the hardware stands proud "
         "of the hull panel and projects out toward the viewer, deep shadows and volume, a chunky "
         "dimensional mechanical object (not a flat head-on panel). It wears the ship's livery: steel "
         "blue-grey armor panels with a subtle hexagonal pattern, glossy bright golden-yellow trim strips "
         "and edging, and cyan-blue glowing accent lights. The component is realistic hardware, clearly and "
         "instantly readable as what it is, mounted in the surrounding blue-and-gold hull panel (an "
         "integrated ship module, not a toy on a pedestal). Centered on a FULLY TRANSPARENT background. AAA "
         "sci-fi game asset quality. Absolutely NO lettering, NO written words, NO logos, NO numbers, NO "
         "text of any kind, no studio backdrop, no ground, no UI, no watermark. ")

ARC_STYLE = ("A high-quality game VFX asset of a glowing translucent energy deflector shield, a single "
             "curved dome-like force-field arc that bulges outward, physically based volumetric light, "
             "crisp hexagonal energy-scale shimmer across the surface, a bright glowing leading rim and "
             "softer trailing edge, semi-transparent so stars would show through, the CURVED/BULGING edge "
             "facing UP toward the top of the frame. Centered on a FULLY TRANSPARENT background. "
             "No hardware, no ship, no planet, no text, no frame, no watermark. ")

SHIP_STYLE = ("A clean top-down orthographic hero illustration of a complete sci-fi starship, nose "
              "pointing up, in the SSV Silver Gull style: a tall vertical vessel with steel blue-grey "
              "hexagonal-plated hull, glossy golden-yellow trim, a cockpit canopy at the nose, swept "
              "wing-fins, and a large engine bell at the tail. Detailed painted game-art, crisp, evenly "
              "lit, the whole ship centered and fully visible on a FULLY TRANSPARENT background. "
              "No text, no logos, no background scene, no ground, no watermark. ")

SHIP_DIR = MODULE / "assets" / "ship"

STATE_MOD = {
    "working":   "The component is brand-new and fully operational — pristine panels, clean paint, its "
                 "power indicators and energy elements lit a steady bright cyan-blue.",
    "damaged":   "The component is battle-damaged but still running — scorched and dented plating, a "
                 "cracked panel and exposed wiring, a few sparks, indicator lights flickering amber-orange.",
    "destroyed": "The component is destroyed and dead — torn open and blackened, shattered and melted "
                 "pieces, snapped cables, heavy scorch marks, no lights, cold dead metal with faint smoke.",
}

# id -> (subject prompt, size, output-dir, filename-prefix)
SUBJECTS = {
    "shields":     ("a starship shield-generator: a heavy domed deflector-shield projector node with a "
                    "glowing hemispherical energy emitter lens on top and focusing coil rings around it, "
                    "clearly a shield emitter dome (not a radar dish)", "1024x1024", SYS_DIR, "shields"),
    "engine":      ("a starship main FTL warp / hyperfold drive engine seen from behind: a big rocket "
                    "engine with a deep glowing exhaust nozzle bell, fold-coil rings and cooling fins, "
                    "clearly a propulsion engine with a bright energy plume core", "1024x1024", SYS_DIR, "engine"),
    "thrusters":   ("a cluster of three starship maneuvering thruster nozzles: small angled rocket "
                    "thruster cones grouped together with fuel lines and gimbal mounts, small blue "
                    "flames, clearly rocket thrusters", "1024x1024", SYS_DIR, "thrusters"),
    "reactor":     ("a starship main reactor / power core: an armored spherical fusion reactor with "
                    "radiating power conduits, shielding panels and a bright glowing core", "1024x1024", SYS_DIR, "reactor"),
    "weapons":     ("a starship gun turret: an armored rotating turret with twin heavy autocannon "
                    "barrels, ammunition feeds and hydraulic mounts", "1024x1024", SYS_DIR, "weapons"),
    "sensors":     ("a starship sensor & navigation array: a rotating radar/comms dish with antenna "
                    "clusters, scan emitters and a reinforced mast", "1024x1024", SYS_DIR, "sensors"),
    "lifesupport": ("a starship life-support module: an oxygen recycler and atmosphere processor unit "
                    "with pipes, tanks, filters and status gauges", "1024x1024", SYS_DIR, "lifesupport"),
    "cloak":       ("a starship cloaking-field generator: an advanced faceted stealth-emitter device "
                    "with a shimmering refractive crystal core, phase coils and armored housing", "1024x1024", SYS_DIR, "cloak"),
    # Shield faces — a strong MAIN deflector arc and a fainter SECONDARY arc (energy fields).
    "arc-main":      ("the MAIN deflector shield: a strong, bright, vivid cyan-teal energy shield dome "
                      "arc, dense and opaque energy, powerful glowing leading rim, bold hexagonal "
                      "scales", "1024x1024", ARC_DIR, "arc-main"),
    "arc-secondary": ("the SECONDARY deflector shield: a fainter, thinner, more transparent pale-blue "
                      "energy shield arc, softer and dimmer than the main shield, delicate hexagonal "
                      "shimmer", "1024x1024", ARC_DIR, "arc-secondary"),
    # Full ship hero image for the HUD centre.
    "ship-intact":   ("the intact starship, pristine and undamaged", "1024x1536", SHIP_DIR, "ship"),
}

def bake_arc_alpha(path):
    """Convert a glowing energy-shield render on a dark background into a PNG with real
    transparency (alpha derived from the glow's luminance), so it composites cleanly."""
    try:
        from PIL import Image
    except ImportError:
        print("    (Pillow not installed — skipping alpha bake)")
        return
    im = Image.open(path).convert("RGBA")
    r, g, b, _ = im.split()
    lum = Image.merge("RGB", (r, g, b)).convert("L")
    # Hard cut the dim outer glow so there is no boxy halo — keep only the shield body/rim.
    lum = Image.eval(lum, lambda v: 0 if v < 60 else min(255, int((v - 60) * 2.0)))
    im.putalpha(lum)
    im.save(path)

def load_key():
    for line in ENV.read_text().splitlines():
        if line.startswith("OPENAI_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise SystemExit(f"OPENAI_API_KEY not found in {ENV}")

def generate(key, asset_id, state):
    subject, size, outdir, prefix = SUBJECTS[asset_id]
    is_ship = asset_id.startswith("ship")
    base = SHIP_STYLE if is_ship else ARC_STYLE if asset_id.startswith("arc-") else STYLE
    # Ship variants encode their own state in the subject; hardware/arcs append a damage mod.
    prompt = base + subject + ("" if is_ship else ". " + STATE_MOD[state])
    body = json.dumps({
        "model": "gpt-image-1", "prompt": prompt, "size": size,
        "quality": "high", "background": "transparent", "n": 1,
    }).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/images/generations", data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    outdir.mkdir(parents=True, exist_ok=True)
    # Ship files are named by variant (ship-intact.png); everything else by state.
    out = outdir / (f"{prefix}-{asset_id.split('-', 1)[1]}.png" if is_ship else f"{prefix}-{state}.png")
    print(f"  → {asset_id} [{state}] {size} …", flush=True)
    with urllib.request.urlopen(req, timeout=300) as resp:
        data = json.load(resp)
    out.write_bytes(base64.b64decode(data["data"][0]["b64_json"]))
    if asset_id.startswith("arc-"):
        bake_arc_alpha(out)   # glow-on-dark -> true transparency, so no boxy halo in the HUD
    print(f"    saved {out.relative_to(MODULE)} ({out.stat().st_size // 1024} KB)")
    if "usage" in data:
        print("    usage:", data["usage"])

def main():
    args = sys.argv[1:]
    if not args:
        raise SystemExit(__doc__)
    key = load_key()

    if len(args) == 2 and args[0] in SUBJECTS:
        generate(key, args[0], args[1]); return

    mode = args[0]
    states = ["working", "damaged", "destroyed"] if mode == "all" else [mode]
    for st in states:
        if st not in STATE_MOD:
            raise SystemExit(f"Unknown state '{st}'. Use working | damaged | destroyed | all.")
    print(f"Generating {mode} set ({len(SUBJECTS)} assets × {len(states)} state[s])…")
    for st in states:
        for aid in SUBJECTS:
            generate(key, aid, st)
            time.sleep(1)
    print("Done.")

if __name__ == "__main__":
    main()
