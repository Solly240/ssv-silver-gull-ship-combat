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

## 3b. The printed rules are the spec

`source/pdfs/ssv-silver-gull-crew-dossier.pdf` is the campaign's own rulebook and
the module must match it. A balance pass once changed six numbers at once and the
drift went unnoticed for weeks, so **`--selftest` now asserts each one by name**:

| Constant | Dossier |
|---|---|
| `S.SHIELD_AC` = 5 | Allocate Shields — *"half damage + 5 AC"* |
| `S.MICRO_AC` = 2, `S.MICRO_DR` = 0 | Micro-Adjust — *"+2 AC … (no damage-halving)"* |
| `S.MANEUVERS` | Evasive +5 / 5 MP · Steady 0 / 3 MP · Aggressive −5 / 2 MP |
| `S.CALLED_SHOT_PENALTY` = −5 | Called Shot — *"−5 to hit, no hull damage either way"* |
| `S.STATUSES.rerouted.ac` = 5 | Reroute Power — *"+5 temp AC … stacks with maneuver AC"* |
| `S.QUICK_AIM_BONUS` = 2 · `S.SCAN_DC` / `S.BOARDING_DC` = 15 | as printed |

**Shields are AC *and* damage reduction**, which is why `S.shipAC` returns a
different number per facing — a shielded bow is five better than a bare stern, and
that difference is the entire reason to allocate. Anything that renders AC must
read `ac[facing]`, never a single value.

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

## 5b0. Where people stand on a deck

Deck art is a transparent PNG on a map image **far larger than the hull** — the
Leiothrix's is 1147x840 inside a 7000x7000 scene, down in one corner. So "the
middle of the scene" is open space beside the ship, and both the boarding drop and
the enemy crew used it: boarders arrived about fourteen squares off her hull.

Everything that places a token on a deck now goes through the hull box:

| | |
|---|---|
| `deckInterior(scene, levelId)` | the bounding box of that level's walls — the pack's walls trace the hull |
| `S.deckBounds(walls, fallback)` | pure; falls back to the scene box when a deck has no walls |
| `S.breachPoint(bounds, facing, grid)` | one entry point per arc, inset inside the skin. Deck art is drawn nose-up, so **fore is the top edge** |
| `S.deckSpots(bounds, grid, n)` | where a deck's own crew stand, spread across the middle 70% |

**Boarding chooses an arc.** `runBreach` defaults to the facing you are actually
flying on, draws four red rings on the target's token (`showBreachMarkers`) and
lets the boarder pick another. The chosen facing rides through `gmBreach` →
`gmGoToDeck({facing})` and is remembered in `whereIs` so the deck panel can say
where they came in.

**A token MOVES between ships.** `liftTokenFrom(actorId, keepSceneId)` deletes the
actor's token from every other module-owned deck scene first — boarding used to
create one on the destination and leave the old one behind, so a boarder stood on
the Gull and on the enemy at once.

**Enemy boarding parties are real.** `boardingParty` sat on every hull and in the
spawn browser for a long time with nothing to spawn it; `gmEnemyBoard` puts those
marines on the Gull's deck 1, through the arc they came from, once
(`boardersSent`). It is the captain's `e_board` action and the `boarder` doctrine
reaches for it at range 1.

**SPACE ⇄ DECKS moves the camera.** It used to switch only the console panel, so
a boarder pressing SPACE got the space readout over the enemy's engine room.
`viewSpace()` / `viewMyDeck()` change the scene; your token does not move — you
are aboard, you are just looking out of the window.

---

## 5b. Deck scenes are the pack's own scenes

**Import the whole scene. Do not rebuild it.**

The first version reconstructed a deck: one `Level` per deck on a single scene,
the ship's interior PNG pulled out of the pack scene's **tiles** and set as the
Level **background**, then the walls and lights copied across. That art is a tile
at a specific size and position — the Razorbill's is 3640×5600 inside a 7000×7000
scene — so promoting it to a full-bleed background **stretched it**, and every
wall then sat slightly off the picture. The owner's word for it was "so off".

These packs already ship finished maps: correct art placement, walls, lighting,
grid, padding, sounds. So `deckScene(hull, skin, deck)` takes the compendium
document, `toObject()`s it, strips the demo tokens, renames it, sets OBSERVER
ownership and a `{deckScene, hullId, skin, deck}` flag, and creates it. Nothing is
derived and nothing is scaled.

**One scene per deck**, which also gives deck separation for free — no `Level`
documents, and none of the `levels: []` means-every-level trap that came with them.
`whereIs[userId] = {shipId, deck, facing}` and `findDeckScene(name, skin, deck)`
are how everything finds its way around.

`S.decksForSkin()` still fills a pose skin's missing decks from a sibling, so every
skin of every hull is boardable, and the imported scene records which skin it
borrowed from.

### The name you see is not the name we look up

`deckSceneName(hullName, skin, deck)` — `SSV Silver Gull — Original · Deck 2` — is
the **key**. It is what goes in the scene's `deckScene` flag and what
`findDeckScene()` matches on. The scene's **name** is `deckDisplayName()`, which
appends what the deck actually is: `… · Deck 2 — Main Deck`.

Keep those two separate. Pack deck numbers are export order and say nothing about
the ship — on the Razorbill, **deck 2 is the main deck** (bridge, quarters, galley,
engine room) and **deck 1 is the sparse second deck**. `DECK_ROLES`, keyed by
**pack** so every skin and every enemy on the same frame agrees, supplies the role;
`deckLabel(hull, n)` falls back to `Deck N` for hulls we have not labelled, and it
also drives the deck strip in the boarding HUD. Because the key lives in the flag,
renaming a deck can never orphan its scene, and `_importDeck` renames any scene
imported by an older version in place on the next build.

### Stairwells: a pair of teleport Regions, laid by us

The packs draw the stair shaft on both decks and ship **nothing that connects
them**. `STAIR_LINKS`, also keyed by pack, holds the shaft's box on each deck in
scene coordinates; `ensureStairLinks(hull, skin)` runs at the end of
`buildDeckScene()` and lays a `teleportToken` Region over each end pointing at the
other. Walk onto the stairs and you arrive on the other deck's stairs, and core
pulls your view across with you.

Three things to know before touching it:

- **It cannot loop.** A teleport arrival is a `displace` movement and
  `teleport-token.mjs` returns early on those — *"Displacement does not trigger
  teleportation"*. The token lands inside the destination region and stays there.
- **It is idempotent.** Regions are found by the `stairLink` flag (a string index),
  so re-running after a rebuild re-points the existing pair instead of stacking a
  second one. Change the flag's shape and you will get duplicates.
- **Both ends must exist first**, so the regions are created in one pass and
  cross-linked in a second. A hull with no entry in `STAIR_LINKS` is skipped
  silently — that is the normal case.

Measure a new hull's shaft off its own deck scenes; the boxes are in **scene**
coordinates, not grid squares, and the two decks' boxes are usually a few pixels
apart because the artist drew them separately.

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

## 5d. Which page the console opens on

`S` is one key for two jobs, so the **open** picks the page:

| | lands on |
|---|---|
| **not** in ship combat | 📦 the ship inventory |
| in ship combat | ⚔ the station panel |

The reason is that out of combat there is nothing to drive: `endCombat()` sets
`next.crew = {}`, so `drivenCrew()` returns null and the station panel is the dead
end that reads *"you're not manning a station yet"*. Between fights the console is
opened to move cargo, burn a fuel cell or convert power — and the inventory's socket
rules are `{gm: true, player: true}` **precisely** so they work with no combat
running (see §5a; an earlier `anyCrew` rule silently refused every player-side
inventory action out of combat).

Two rules:

- **The decision is `S.defaultConsoleMode(combat)` in the pure half**, so it is
  asserted in `--selftest` and demonstrated in `preview.html`. Do not inline the
  `combat.active` test into the wiring.
- **It applies to the OPEN only.** `openShipHUD()` sets `invMode` and nothing else
  does; `refreshOpen()` / `renderConsole()` must never re-apply it, or a live
  re-render — and this module re-renders on every state write — would yank a player
  off the page they chose mid-action.

`openShipHUD()` also clears `gmActMode` and `deckMode` on the way in, so an open
never inherits a stale mode from the last time the console was up.

**A landing page must carry its own navigation.** Making the inventory the
out-of-combat default exposed that its header had only `⚔ Stations` and `✕` — no
SPACE⇄DECKS toggle and no `⚙ GM`. That quietly broke the rule stated on the station
panel: *walking around the ship should not require being in a fight.* Both are on
the inventory header now. If you ever change which panel S lands on, move the
navigation with it. (The GM Actions panel still has the impoverished header — it is
never a landing page, so it is left alone.)

Covered by two gates in `check_shipcombat.js`: one presses the registered `S` binding
under the stub with combat off, on, and with an empty blob, and checks `api.open()`
agrees — both the "always station" and the inverted mutation fail it. The other reads
`renderInventoryPanel`'s source and asserts the landing page can still reach stations,
decks and GM actions. `S.defaultConsoleMode` is also in the cross-half export list, so
deleting it from the pure half fails the gate rather than breaking the key at runtime.

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
  and every doctrine (~1,000 calls) and fails on any programming error — not a
  whitelist of three strings, which let "x is not a function" through. It also greps
  the resulting public chat for unscanned crew names.
- **The socket cross-check also refuses an empty rule.** `{}` would satisfy "has an
  entry" while authorising everyone, so a rule must name at least one restriction.
- **The stale-write sweep sees `await new Roll(...)`** — the first version only
  matched `await ident(`, and missed `gmRollInitiative` rolling a d20 per ship
  between its read and its write.
- **`check_hulls.js` validates DECK art too.** The Brutus tug shipped with both of
  its boarding decks pointing at `Supplements/Triple Booster.png`, so the party
  would have boarded a thruster sprite.

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
- **Deck scenes are imported whole, not rebuilt.** The pack art is a TILE at a set
  size and position; using it as a scene background stretches it and everything
  drifts off the walls. See §5b. (Foundry v14's `Level` documents are no longer
  used here — one scene per deck is simpler and cannot hit the `levels: []`
  means-every-level trap.)
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
- **`gmBreach` must call `gmGoToDeck` with `trusted: true`.** The goDeck guard asks
  whether you are already aboard, and `whereIs` is only ever written *by*
  `gmGoToDeck` — so a breach without the flag refuses **itself** and the boarder
  never moves. A hardening change caused that; `check_shipcombat.js` now asserts
  the call site.
- **A `check` on a socket rule runs *after* `seat`, not instead of it.** `gunHitCheck`
  is seat-authorised but its handler acts on `msg.crewId`, so one gunner could fire
  the other's gun until the rule carried both.
- **`consumeSlot` can refuse** — no action left, or not enough power — and for a long
  time every one of its fourteen callers ignored the answer and fired anyway. It
  returns a boolean now; callers bail.
- **Only the seat that owns a move may make it.** `gmGrant` checked that you control
  the crew member, not that they are sitting in the Captain's chair; `swapResult`
  was `anyCrew`, so anyone could answer someone else's station-swap prompt.
- **Precision fire replaces the hull hit; it does not add to one.** `gmEnemyFire`
  applied full hull damage *and* the system hit, one line under a comment saying it
  would not and one line above a chat message telling the crew their hull was spared.
- **A bare custom property is not animatable.** `@keyframes {--sweep: 360deg}` needs
  `@property` to register the type, so the active-ship ring silently never moved.
  Animate a real property (`transform`) instead.
- **Esc must FAIL a timed mini-game, not remove it.** `closeRepairPuzzle()` is the raw
  teardown; only `finish(false)` runs `onFail`. The action is already spent by the
  time the puzzle opens, so tearing it down silently ate the whole repair.
  `S.abortRepairPuzzle()` / `S.abortNavGame()` are the Esc-safe doors.
- **A scene cannot lose its last Level on v14.** `Level._preDeleteOperation` throws
  "must have at least one level", so `buildDeckScene`'s rebuild — delete all the
  Levels, then create the new ones — threw *after* it had already deleted the
  walls and lights. **Rebuild has never worked on v14.** Create the replacements
  first, delete the originals second.
- **The deck art is a TILE, not the background.** These packs lay a transparent
  ship PNG over a nebula `background`, so reading `background.src` gets you deep
  space. Prefer the largest tile whose name contains "Interior".
- **A guard keyed on state that the guarded function itself writes needs a
  trusted door.** `goDeck` refuses a hull you are not already aboard, and
  `whereIs` is only written by `gmGoToDeck` — so `gmBreach`, the moment access is
  granted, refused itself.
- **`shipPoint("gull")` must read the scene DOCUMENT.** It used the *canvas*,
  which only knows the scene the GM is looking at — so the instant anyone boarded
  (which switches the GM's view to a deck) the Gull had no position: `measured`
  went false, the arc and range checks were skipped, and every enemy fired at
  point-blank against her bow.
- **A socket rule that denies everyone fails silently.** `swapResult` checked
  `pendingSwap.occId`, a field that has never existed, so every station-swap
  answer was dropped. The gate now asserts each rule ADMITS its legitimate sender,
  not just that it refuses a stranger.
- **`anyCrew` is the wrong rule for the inventory.** It is used *between* fights,
  when `combat.crew` is empty — so every player-side inventory action was silently
  refused out of combat. That is what `player` is for.
- **The turn bar is FLEET-AWARE, and compact on purpose.** It used to draw every
  crew member as a full-width row with two `<select>`s — seven of those is half a
  monitor — and it showed the Gull's crew whether or not it was the Gull's turn.
  Now: an initiative strip of every ship across the top, the seats of the ONE ship
  whose turn it is below, `.ct-body` capped at `32vh` with internal scroll, and all
  the housekeeping behind `⋯`. Clicking a ship it is NOT the turn of shows its
  **reactions** (`S.reactionsFor`) — the Captain's Command Point, held
  Countermeasures, point defence, Slip — which is exactly when they matter.
- **`enterCombat` must keep `combatState.ships`.** It built a fresh
  `S.defaultCombat()` and copied only the roster across, so pressing
  **⚔ ENTER SHIP COMBAT** silently deleted every enemy the GM had already spawned
  from Fleet Command — the records went, their actors and tokens stayed as
  orphans. The turn bar and the fleet board are one system; that was the seam
  where they came apart. The idle bar now shows the contact count and carries a
  🛰 Fleet button so the link is visible.
- **ABSENT is not FALSE in a normalizer.** `gmSpawnShip` passes no `shield` block,
  and `on: !!stored.shield?.on` read that as "shields down" — every enemy in the
  fleet had been arriving with her bow open and five AC light. Fall back to the
  default when the key is missing, and only honour an explicit `false`.
- **Never put a backtick inside the CSS template literals.** They are one big
  template string; a backtick in a comment ends it and the file stops parsing.
  `node --check` catches it, which is why it runs first in the gate.

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
