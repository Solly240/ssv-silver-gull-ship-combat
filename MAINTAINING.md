# Maintaining — SSV Silver Gull: Ship Combat

Read this before editing the module. It is the same shape as the sibling guides
(`shop`, `settlements`, `sundowner`), because the modules share their conventions.

---

## 1. The two-file split — the rule everything else depends on

| File | What it is | The rule |
|---|---|---|
| `scripts/ship-combat-render.js` | **Pure.** Every constant, the CSS, all renderers, the mini-games, and all combat maths. Ends with `S.selftest()`. | **Must never touch `game`, `ui`, `Hooks` or `canvas`.** The release gate greps for exactly that and refuses to ship on a hit. |
| `scripts/ship-combat.js` | Foundry wiring only: settings, the ctx builders, dialogs, the socket, GM-authoritative handlers, and all actor / token / scene / canvas work. | Everything that reaches into the runtime lives here, and nowhere else. |

`module.json` loads the pure half through `"scripts"` (classic, runs first) and
the wiring through `"esmodules"`, so `globalThis.SSVShipHUD` always exists by the
time the wiring runs. The wiring destructures the handful of helpers it needs
(`esc`, `token`, `stationName`…) at the top of its IIFE.

Why it matters beyond tidiness: the purity rule is what makes `--selftest`,
`tools/check_shipcombat.js` and `preview.html` possible at all. Break it and you
lose the ability to test any of this outside a running world.

```bash
grep -nE '\b(game|ui|Hooks|canvas)\.' scripts/ship-combat-render.js   # must be empty
```

That grep also catches prose — a comment containing "…the game." trips it.
**Reword the comment; never weaken the grep.**

---

## 2. Content vs state — what a release overwrites

| Store | Survives a release? |
|---|---|
| `data/fleet.json` | **No — every release overwrites it.** |
| `assets/` | **No.** |
| world settings (`shipState`, `combatState`) | yes |
| `localStorage` (`barCollapsed`, `gmBarHidden`) | yes, and never leaves the browser |

**No instance state may ever live in `data/fleet.json`.** It is a catalogue of
hull *profiles*; a spawned ship is a record in `combatState.ships`. The journal
module learned this the hard way when a deploy reset every player assignment.

---

## 3. Regenerating the fleet

```
tools/fleet_scan.json   machine truth — pack ids, scene ids, real art paths, hull
                        footprints, deck counts. Produced INSIDE Foundry.
tools/fleet_source.py   the half a machine cannot know — faction, doctrine, guns,
                        abilities, crew roster, and the line the GM reads.
tools/build_fleet.py    joins them, validates, and refuses to write on a problem.
```

After installing or updating a ship map pack, as GM in the console:

```js
await SilverGullShip.dumpFleet()      // writes ssv-fleet-dump/fleet_scan.json on the server
```

then pull it down and rebuild:

```bash
curl -sS https://vtt.framecore.org/ssv-fleet-dump/fleet_scan.json -o tools/fleet_scan.json
python3 tools/build_fleet.py --verify        # HEAD-checks all ~1,500 art paths
```

**Never write an art path by hand.** These packs do not survive it:

- The Razorbill's images are spelled `GL_Razorbill_Orginal_…` (the artist's typo)
  while its scenes say `Original`, and its `.webm` files say `Original` again.
- The **Tenrec Digger**'s scenes point at `HyperdriveFleet-Tenroc-Digger/`, a
  directory that does not exist. Repaired through `PATH_FIXES` in `fleet_source.py`.
- **`HyperdriveFleet-Planatus`** is labelled *Platanus*. See `ALIASES`.
- The **"Acorn Explorer"** pack is full of **Dynamo Bomber** scenes — the same
  hull, listed twice. See `EXCLUDE`.
- **Tettigarctidax** is a three-scene "TEST SHIP" with no interiors. Excluded.

`--verify` is what found all of that. Run it whenever the packs change.

---

## 4. The combat model

Every ship — the Gull included, as id `"gull"` — is one record shape, so one set
of helpers serves both sides. The Gull's authoritative copy stays in the
`shipState` setting and appears in the fleet as a view over it, so the S menu and
the fleet board can never disagree.

- **Shields are damage reduction, not AC.** The allocated facing halves damage;
  Micro-Adjust takes a flat 3 off a second facing. `AC = base + maneuver + status`
  and nothing else, which keeps it in a readable 8–18 band. This is deliberate:
  AC is a binary gate, and the 10–25 band is why Session 5's AC 24–25 getting hit
  felt arbitrary.
- **Facing is derived from the two tokens**, via `S.facingFrom(target, from)`.
  Rotation 0 = nose up, forward = `(sin r, −cos r)` — the same convention the
  pilot's movement already used. Swinging to an unshielded arc is therefore a
  mechanic, not a GM ruling.
- **`S.resolveDamage` order is fixed and asserted**: status multipliers →
  resistance → shields → armour → floor at zero. Armour last is what makes the
  Directorate's "many small hits are worthless" read correctly.
- **At 0 hull a ship is a DERELICT**, not an explosion — drifting, boardable,
  salvageable, crew alive. `destroyed` needs the reactor already gone, a crit, or
  a declared Kill Shot.
- **Statuses are data** (`S.STATUSES`), with a `scope` that says when they expire.
  `S.statusMods(ship)` flattens them for everyone else; never read a status's
  rules text in code.

---

## 5. The reveal boundary — one function

`S.shipView(ship, {isGM, own})` is the only thing that decides what a viewer may
see. Renderers are handed its result and never the record, so they cannot leak.

- `S.SHIP_PUBLIC_KEYS` is the allowlist. `check_shipcombat.js` renders an
  unscanned enemy for a player and greps the resulting DOM for the hull, AC,
  armour, shield facing and crew names.
- Statuses are **filtered, not hidden wholesale**: a burning ship is visibly
  burning; a ship in cover does not advertise it.
- A **rift** hull withholds even its class until scanned — "Corvette" on something
  that ignores shields and AC would quietly reassure the crew.

**Secrecy is UI-level by the owner's choice.** Foundry replicates every world
setting to every client, so a determined player with the console open can read
`combatState`. Keeping the boundary to one function is what makes it cheap to
upgrade later: hold the truth in a `scope:"client"` GM-side setting and publish
only the revealed projection (see sundowner's `MAINTAINING.md` §3).

---

## 6. Verification

```bash
node --check scripts/ship-combat-render.js && node --check scripts/ship-combat.js
grep -nE '\b(game|ui|Hooks|canvas)\.' scripts/ship-combat-render.js   # empty
node scripts/ship-combat-render.js --selftest
node ../tools/check_shipcombat.js
python3 ../tools/build_fleet.py --check
```

`tools/deploy.sh <version> "<notes>"` runs all of it, then commits, pushes, zips
and cuts the release. Nothing ships that has not passed.

- **`--selftest`** covers the pure maths: AC over every facing × maneuver × shield
  state, the damage pipeline as a table, facing from all four quarters, range
  bands for every gun at every distance 0–12, status stacking and expiry across a
  round wrap, and the reveal boundary.
- **`check_shipcombat.js`** loads *both* halves under `tools/stub-foundry.js` — a
  stand-in Foundry just deep enough to fire `init` — and asserts the settings and
  keybindings register, the renderers run headless, the player's fleet DOM leaks
  nothing, and `data/fleet.json` agrees with the renderer's own tables.
- **`preview.html`** (`cd vtt/ship-combat && python3 -m http.server 8010`) runs the
  real renderer with a fake ctx. The rule: *anything you cannot see in
  preview.html is a wrapper, not logic.*

---

## 7. Deploying, and the cache trap

`tools/deploy.sh 0.20.1 "what changed"` → then install on the server:

1. In the world: **Game Settings → Return to Setup** (open the settings sidebar
   first; the button needs a moment, and it will not fire while other players are
   connected without a confirm).
2. Setup → **Add-on Modules** → find the module → **Update**.
3. Setup → **Game Worlds** → **Launch**.
4. **Every client must hard-refresh** (Cmd/Ctrl + Shift + R).

Step 4 is not optional. Browsers cache these scripts hard, and a client running
an old script against new data fails in ways that read as bugs — the pure half's
`SSVShipHUD` gets clobbered, `renderFleet` goes missing, and the console silently
misbehaves. **`deploy.sh` stamps the version into `S.VERSION`, and the wiring half
compares it against the manifest on load and raises a permanent error banner on a
mismatch.** If a player reports something impossible, ask them what that banner
says first.

`/setup`'s HTTP POST API (`installPackage`, `launchWorld`) works only from a fresh
setup session and 403s otherwise. The UI buttons always work — prefer them.

---

## 8. Gotchas already paid for

- **Keybindings.** `S` = the ship console, `\` = the combat bar, **`F` = Fleet
  Command**. `F` is also core's `rulerWaypoint`, so it is registered at
  `PRIORITY` **and `restricted: true`** — GM-only, so players keep waypoints.
  `I`, `G`, `B`, `P`, `J` belong to the sibling modules; `C` is core's character
  sheet and unusable.
- **`refreshUI` must stay at module scope.** It was defined inside `init()`, and
  every handler that calls it threw.
- **Inline `<svg>` does not survive Foundry's dialog content pipeline.** Faction
  crests are `<img src=…svg>` for exactly this reason.
- **Foundry's own input/select rules leak in** and set `width:100%`. The spawn
  browser's header row pins explicit widths; expect to do the same anywhere else.
- **The turn bar sits above both full-screen views**, so `renderBar()` hides it
  when the console or the fleet board is open.
- **`onSocket` trusts the server's sender id**, never `msg.userId`. The payload id
  is spoofable and every GM handler authorises against it.
- **`normalizeShip` must carry `actorId`, `skin` and `art`.** Dropping `actorId`
  meant nothing could delete an enemy's actor, and every fight left orphans in the
  sidebar. `gmClearFleet()` sweeps by flag as a backstop and runs on `endCombat`.
- **Foundry v14 has native multi-level scenes** (`Level` documents). A wall with an
  empty `levels` set is on **every** level (`client/documents/wall.mjs:164`), so a
  merged multi-deck ship must tag every wall, tile and light with its own level id.
- **`scene.update({background})` is a silent no-op on v14** — it builds the change
  and discards it. Use `updateEmbeddedDocuments("Level", …)`.

---

## 9. API for macros and sibling modules

```js
const api = game.modules.get("ssv-silver-gull-ship-combat").api;   // = globalThis.SilverGullShip

await api.openFleet();                       // the fleet board (F)
await api.hullIds();                         // every spawnable hull id
await api.findHull("scyph");                 // fuzzy lookup
await api.spawnShip("gullwing-fighter", { crew: 4, tier: 1, disp: "hostile" });
await api.rollInitiative();
await api.endShipTurn();
await api.removeShip(shipId);
await api.clearFleet();                      // and sweep any orphaned actors
await api.dumpFleet();                       // rescan the map packs (slow)
api.getState(); api.getCombat();
```
