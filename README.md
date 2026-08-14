# SSV Silver Gull — Ship Combat

Foundry VTT module for the **SSV Silver Gull** campaign. First release: a **Ship Overview HUD**.

Press **`S`** to toggle a holographic overview of the ship:

- the **ship** in the center (art states: intact / damaged / cloaked),
- each **system** flanking it (Shield Generator, J-X Hyperfold Engine, Thrusters, Reactor,
  Weapons/Turrets, Sensors & Nav, Life Support, Cloaking Generator — the last shown *Not installed*),
- the **hull HP** bar below (150 HP, Titanium-Aegis Matrix Plating),
- the **shield facings** drawn around the hull — fore, aft, port, starboard, plus a secondary ring.

**GM** clicks a system or shield arc to cycle it `online → damaged → destroyed`, and clicks the hull
bar to set HP. Players see a read-only view. State is stored world-scoped and syncs to open windows.

> This is the display/state foundation. Combat math, damage from attacks, turret firing, and the
> other crew stations come in later releases.

## Layout

```
ssv-silver-gull-ship-combat/
  module.json
  scripts/ship-combat.js      # data + holo-HUD renderer + Foundry wiring (single file)
  lang/en.json
  assets/
    ship/      ship-intact.png ship-damaged.png ship-cloaked.png   # owner-provided
    systems/   <system>-working.png  -damaged.png  -destroyed.png
    shields/   arc-fore-*.png  arc-side-*.png  arc-secondary-*.png
  generators/gen_hud_asset.py # gpt-image-1 → transparent HUD art
```

Missing art degrades gracefully to dashed placeholders, so the HUD works before the art lands.

## Art generation

`generators/gen_hud_asset.py` calls OpenAI `gpt-image-1` (key from the repo-root `.env`) with a
transparent background. Generate one state at a time:

```bash
python3 generators/gen_hud_asset.py working     # system icons + shield arcs, working state
python3 generators/gen_hud_asset.py damaged
python3 generators/gen_hud_asset.py destroyed
python3 generators/gen_hud_asset.py engine working   # a single asset
```

The three **ship** center images are supplied by the owner (dropped into the campaign `Input info/`
inbox, filed to `assets/ship/`) — they are not generated.

## Preview

`../preview.html` runs the real renderer with a fake in-memory state. Serve over HTTP and open it:

```bash
cd ".."          # the vtt/ship-combat/ folder
python3 -m http.server 8009
# open http://localhost:8009/preview.html
```

Toggle *View as GM* to test state-cycling; *Simulate battle damage* seeds a mixed-state scenario.
