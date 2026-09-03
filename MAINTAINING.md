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

**Chat is part of the boundary.** `S.shipView` protected every *renderer*, and for a
long time chat walked straight past it: every shot published the target's exact AC,
every damage line published `hull cur/max` and the full reduction pipeline, and every
enemy-turn line named the crew. A gunner learned by firing what the rules say the
Science officer must scan for.

So there are three helpers, and new chat must use them:

| helper | what it does |
|---|---|
| `sayRedacted(publicHtml, gmHtml, speaker)` | posts the public line, then whispers the real numbers to the GM only when they differ |
| `S.hullWord(cur, max)` / `S.hitWord(dmg, max)` | the qualitative readout a player gets instead — *"a heavy hit … she is opening up"* |
| `crewLabel(sh, crew)` | *"Her port mount"* until the manifest is scanned, the real name after |

`crewLabel` must **never** branch on `game.user.isGM`. Chat content is identical for
everyone who receives the message; a GM-only branch there put the real name into a
message every player then read. That bug shipped, and `check_shipcombat.js` now runs
every enemy seat action and greps the resulting public chat for crew names.

**Secrecy is UI-level by the owner's choice.** Foundry replicates every world
setting to every client, so a determined player with the console open can read
`combatState`. Keeping the boundary to one function is what makes it cheap to
upgrade later: hold the truth in a `scope:"client"` GM-side setting and publish
only the revealed projection (see sundowner's `MAINTAINING.md` §3).

---

## 5a. Socket authorisation — the table is the contract

Foundry sockets are broadcast-to-all and **every client runs the dispatch**, so a
message is a *request*, not a command. Each type declares a rule in `SOCKET_RULES`:

| key | meaning |
|---|---|
| `gm` | the handler writes world state → only the **active** GM runs it (two GM seats can no longer double-apply) |
| `fromGM` | only a GM may **send** it — UI broadcasts: pickers, notifications, visual effects |
| `crew` | the field naming the crew member acted for; the sender must control them |
| `seat` | the station the sender must be sitting at |
| `self` | the field that must equal the sender's own id |
| `anyCrew` | the sender must control at least one crew member in the fight |

**A type absent from the table is dropped.** Adding a socket message and forgetting
its rule therefore fails loudly instead of shipping a hole, and `check_shipcombat.js`
cross-checks the table against both the `switch` and every `emit({type:…})`.

This exists because the handlers used to check only that *they* were the GM, never
that the sender was entitled. Any player could emit `ram`, `cloak`, `patch`, `spool`
or `applyScan` — the last with a hand-crafted `result` that revealed a hull nobody
had scanned. `applyScan` now **recomputes** the result from the roll, and the dead
`applyDamage` case (no emitter, arbitrary damage to any ship) is gone.

---

## 5b1. Driving an enemy ship

The GM's requirement was speed: pick a chair, press a button, move on.

- **`S.enemySeatActions(ship, crew)`** (pure) returns the buttons for one seat.
  Gunners get **one button per online gun**, not a picker plus a fire button.
- **`S.enemyStandingOrders(ship, {distance})`** (pure) is what `▶ Run` executes —
  the same action ids the buttons use, so hand-play and standing orders cannot
  drift apart. It is **arc-aware**: opening the range turns the stern to you, so it
  will not order a fore mount to fire over its own tail; it says so instead.
- **`gmCrewAct(shipId, crewId, actionId)`** is the single executor. It returns
  `false` when it refuses (out of arc, out of range, no token) so `gmRunShip` can
  report *"orders not carried out"* rather than going quiet.
- **`gmEnemyFire`** is the mirror of `gmResolveAgainstShip`: facing measured off the
  two tokens, the enemy's own gun arc checked, then damage through `gmApplyDamage`
  so shields, armour, resistances, the impact beat and the red alert all behave
  exactly as they do for the players.

`check_shipcombat.js` runs **every action × every seat × seven hull states × every
doctrine** (about 1,000 invocations) and fails on any `ReferenceError`. That gate
exists because `node --check` cannot see a bad identifier in a branch nothing
executes, and a blunt search-and-replace put one into three functions.

---

## 5b. Boarding and scene Levels

Foundry v14 has native scene Levels, so a multi-deck ship is **one scene with N
Levels** — `scene.view({level})` switches deck with no scene change and no texture
reload. `multilevel-tokens` is not needed.

**The rule that will bite you:** a wall, tile or light with an EMPTY `levels` set is
on **every** level (`client/documents/wall.mjs:164`), and the map packs ship exactly
that. `buildDeckScene()` therefore writes `levels:[thatLevelId]` on every placeable
it copies. Omit it and deck 1's walls block deck 2.

Scenes are built into **"SSV — Boarded Hulls"**, owned OBSERVER by default (players
cannot `scene.view()` a non-active scene below that). Enemy crew are **records until
somebody boards** — `materialiseCrew()` creates the tokens lazily, hidden and
hostile, flagged with their `crewId` so a death takes their station offline.

`S.assignSeats()` holds the one-crew-per-station rule and is pure, so the selftest
holds it to that. Extras are spare hands with no seat — which is what makes killing
the *right* person matter.

## 5c. The canvas overlay

One `PIXI.Container` per ship, glued to its token, holding the shield arcs, the
firing cone and the FX. It replaced a path that composited ship+shield onto a canvas
and uploaded a uniquely named `.webp` on **every shield change without ever deleting
the last one** — check `Data/ssv-ship-icon/` on an old world and you will find one
file per shield allocation ever made.

Arcs are elliptical, derived from the token's own width and height, so all 56 hulls
work with no art. Unshielded facings are drawn as hairlines on purpose: that is what
makes the shielded arc read as a *choice* and makes flanking legible.

**Canvas work must never swallow.** Everything goes through `canvasSafe(label, fn)`,
which reports once per distinct message. A silent `catch {}` is how a call to a
function deleted in a refactor survived a whole release looking like "the arcs just
don't draw".

## 6. Verification

```bash
node --check scripts/ship-combat-render.js && node --check scripts/ship-combat.js
grep -nE '\b(game|ui|Hooks|canvas)\.' scripts/ship-combat-render.js   # empty
node scripts/ship-combat-render.js --selftest
node ../tools/fuzz_render.js
node ../tools/check_shipcombat.js
node ../tools/check_hulls.js
python3 ../tools/build_fleet.py --check
```

Three of these exist because of bugs that actually shipped:

- **`fuzz_render.js`** throws nulls, NaN, Infinity, negatives and junk types at every
  pure function. It found damage returning `Infinity`, `applyStatus` throwing on a
  number, and a zero-max hull that divided by zero in every bar.
- **The round-trip guard** inside `--selftest` builds a record with every field set to
  a non-default value, normalizes it, and requires every key to survive. Every
  data-loss bug in this module had that one shape — `actorId` (enemy actors could
  never be deleted), `statuses` (the Gull alone could not catch fire), `skin`, `art`,
  `target`, `buff`. A new field on `defaultShip`/`defaultState` is covered the moment
  it exists.
- **The canvas pass** in `check_shipcombat.js` fires the hooks against a PIXI stub and
  fails on any error the module reports. It catches a name a refactor orphaned —
  which has happened twice.
- **`check_hulls.js`** renders **all 53 hulls** through **every** view — GM and player,
  at each of six reveal tiers, for every skin and four crew counts (~32,000 fleet
  cards) — and asserts no throw, no `undefined`/`NaN`/`[object Object]`, balanced
  markup, no unallowlisted key in a player view, and a resolvable deck plan for every
  skin. It found 19 unboardable skins and the Platanus spawning derelict.
- **The stale-write sweep** looks for the shape that has bitten this module five
  times: read the setting → `await` something → write the **stale** object, silently
  discarding whatever landed in the gap.
- **The socket cross-check** asserts every `case` has a `SOCKET_RULES` entry, every
  rule has a case, and every `emit({type:…})` is covered.
- **The enemy-action smoke run** invokes every seat action against seven hull states
  and fails on a `ReferenceError`. It also greps the resulting public chat for
  unscanned crew names.

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
- **Every `fx` call sits inside a `gm*` handler**, which returns early on a player's
  client — so the tracers, impacts, red alert and screen shake were only ever drawn
  for the GM, and the people being shot at saw a silent map. Visuals go through
  `playFx()`, which runs locally and broadcasts so every client draws its own copy.
- **A missing `systems` map means UNKNOWN, not BROKEN.** A player's view of an enemy
  only gains `systems` at the SYSTEMS tier, so `S.systemWorks(view,"shields")` was
  false at VITALS tier and drew every arc of a freshly-scanned enemy as unshielded —
  contradicting the readout they had just paid an action for. `S.systemKnown()` is
  the distinction; `S.shieldDR` uses it.
- **Pose skins ship no interior.** "Landed", "TuckedUp", "Breached Stage 2",
  "Original Deployed" and 16 others carry an exterior only, and a few colour skins
  are missing an upper deck — so `buildDeckScene` refused and the party physically
  could not board that hull. `S.decksForSkin()` borrows the missing decks from the
  richest sibling skin ("Original" winning ties). Every skin of every hull is boardable.
- **A stored `hull.max` of 0 is ABSENT, not "one hit point".** Clamping it up to 1 is
  how the Platanus — the only capital, whose class band was `[0, 0]` — reached the
  board at 0/1 and went derelict on the first shot. A malformed max is repaired from
  the class band; a **`cur` of 0 with a valid max is a derelict and must stay one**,
  or every wreck refloats on reload.
- **`frozen` had no expiry clock.** Its scope is `"next-hit"`, which `applyStatus`
  gave no `expiresRound`, so the Cryo-Beam doubled every hit for the rest of the
  fight. `S.resolveDamage` now returns a `consumed` list and `gmApplyDamage` clears
  it in the same write.
- **Whiff protection must not be permanent.** A grazing miss dropped `shield.on` to
  false *and* applied a one-round status; nothing ever set `shield.on` back, so one
  lucky miss disarmed an enemy for the whole fight. The status is now facing-scoped
  and `shield.on` is left alone.

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
