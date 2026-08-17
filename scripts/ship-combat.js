/**
 * SSV Silver Gull — Ship Combat: Ship Overview HUD
 *
 * Press S to open a holographic overview of the SSV Silver Gull: the ship in the
 * center, each system flanking it, hull HP below, and the directional shield arcs
 * (fore / aft / port / starboard) plus a secondary shield ring drawn around the hull.
 *
 * This is the display/state-tracking foundation. Combat math comes in later releases.
 *
 * The rendering is environment-agnostic: it draws through a small `ctx` contract so
 * the SAME renderer runs inside Foundry (real settings + dialogs) and inside the
 * standalone preview.html (fake in-memory ctx). Foundry wiring lives at the bottom,
 * guarded by `typeof Hooks`.
 *
 * Built for Foundry VTT v12–v14. No dependency on any other module.
 */

(function () {
  const S = {};
  const MODULE_ID = "ssv-silver-gull-ship-combat";

  /* ---------------------------------------------------------------------- */
  /*  Static definitions (the ship's fixed loadout)                         */
  /* ---------------------------------------------------------------------- */

  // Ordered top→bottom within each side column. `installed:false` renders locked.
  S.SYSTEMS = [
    { id: "shields",   label: "Shield Generator",  side: "left",  icon: "shields",
      blurb: "Concord-Pattern Thermal Shield Generator. Powers the directional shield facings." },
    { id: "engine",    label: "J-X Hyperfold Engine", side: "left", icon: "engine",
      blurb: "Experimental Terran-Alliance hyperfold drive. Warp-microfolds for FTL travel." },
    { id: "thrusters", label: "Thrusters",         side: "left",  icon: "thrusters",
      blurb: "Sub-light takeoff & maneuvering thrusters." },
    { id: "reactor",   label: "Reactor / Power Core", side: "left", icon: "reactor",
      blurb: "Main reactor & auxiliary power distribution." },

    { id: "weapons",   label: "Weapons / Turrets", side: "right", icon: "weapons",
      blurb: "Detachable mono gun turrets & the rebuildable turret array." },
    { id: "sensors",   label: "Sensors & Nav",     side: "right", icon: "sensors",
      blurb: "Internal sensors, nav arrays, long-range comms." },
    { id: "lifesupport", label: "Life Support",    side: "right", icon: "lifesupport",
      blurb: "Atmosphere, gravity, and emergency reserves." },
    { id: "cloak",     label: "Cloaking Generator", side: "right", icon: "cloak",
      blurb: "Cloaking field generator — bends light around the hull to hide the ship." }
  ];

  // One directional shield at a time: it's either ON, aimed at one side of the ship,
  // or OFF. Each side has its own custom art that hugs that part of the hull.
  S.FACINGS = ["fore", "starboard", "aft", "port"];
  S.FACING_LABEL = { fore: "Fore", starboard: "Starboard", aft: "Aft", port: "Port" };

  S.SYSTEM_STATES = ["working", "damaged", "destroyed"];

  S.STATE_META = {
    working:   { label: "ONLINE",       c: "#38e1c4" },
    damaged:   { label: "DAMAGED",      c: "#f2b03d" },
    destroyed: { label: "DESTROYED",    c: "#e0454d" },
    off:       { label: "OFFLINE",      c: "#5a6b7a" },
    offline:   { label: "NOT INSTALLED", c: "#5a6b7a" }
  };

  /* ---------------------------------------------------------------------- */
  /*  Ship-combat: crew stations + turn/action tracker                       */
  /* ---------------------------------------------------------------------- */

  // The 15 crew stations (ship/ship-combat.md). Bridge 1–8 unlocked; Cloaking + the
  // 6 turrets start locked. The GM can toggle any of these on/off per campaign.
  S.STATIONS = [
    { id: "captain",          num: 1,  name: "Captain / Commander",     defaultUnlocked: true },
    { id: "pilot",            num: 2,  name: "Pilot / Helm",            defaultUnlocked: true },
    { id: "gunner_port",      num: 3,  name: "Gunner — Port",           defaultUnlocked: true },
    { id: "gunner_starboard", num: 4,  name: "Gunner — Starboard",      defaultUnlocked: true },
    { id: "boarding",         num: 5,  name: "Boarding Actions",        defaultUnlocked: true },
    { id: "engineer",         num: 6,  name: "Engineer",                defaultUnlocked: true },
    { id: "shields_officer",  num: 7,  name: "Shields / Comms Officer", defaultUnlocked: true },
    { id: "science",          num: 8,  name: "Science / Sensors",       defaultUnlocked: true },
    { id: "cloaking",         num: 9,  name: "Cloaking Officer",        defaultUnlocked: false },
    { id: "turret_flak",      num: 10, name: "Light Flak Turret",       defaultUnlocked: false },
    { id: "turret_autocannon",num: 11, name: "Heavy Autocannon",        defaultUnlocked: false },
    { id: "turret_plasma",    num: 12, name: "Plasma Casing Cannon",    defaultUnlocked: false },
    { id: "turret_cryo",      num: 13, name: "Cryo-Beam",               defaultUnlocked: false },
    { id: "turret_ion",       num: 14, name: "Ion Charge Cannon",       defaultUnlocked: false },
    { id: "turret_gravity",   num: 15, name: "Gravity Well Projector",  defaultUnlocked: false }
  ];
  S.station = (id) => S.STATIONS.find((s) => s.id === id);

  // Per-station playable actions (from ship/ship-combat.md). Action `type`s:
  //   shield-allocate → arm the red circles, move the MAIN shield facing
  //   shield-micro    → arm the green circles, set the SECONDARY shield facing (+2 AC)
  //   roll            → d20 + ability (from the 5e sheet) or manual, posted to chat
  //   grant           → Captain's Grant Actions: pick a crew, give them a +1 extra (purple star)
  //   note            → spends the action + posts a one-line chat card (effects/dice come later)
  const N = (id, name, text) => ({ id, name, type: "note", text });
  S.STATION_ACTIONS = {
    captain: {
      main: [
        N("cmd_adv", "Command · Double Advantage", "Give one crew Double Advantage on their Main Action this round."),
        { id: "grant", name: "Grant Actions", type: "grant", text: "Give one crew +1 extra action (a purple star, usable as a Main or Bonus). They spend it after their normal action of that type. Lasts one turn." },
        N("bc_flee", "Big Call · Flee", "Opposed Piloting vs enemy Pilot (DC 15). Success disengages next round; failure gives the enemy a free attack."),
        N("bc_ram", "Big Call · Ram", "Pilot must be Aggressive & within 3 spaces. Hit: +4d6, ignores Shield Facing; you take ¼ back."),
        N("bc_allhands", "Big Call · All Hands", "Every station gets +3 to their Main check this round OR an extra Bonus Action; you lose your Rally this round.")
      ],
      bonus: [N("rally", "Rally", "Give one ally a flat +1 to their Main Action roll.")]
    },
    pilot: {
      main: [
        N("evasive", "Evasive Maneuvers", "+5 ship AC; forward gunners at disadvantage; 5 Movement Points."),
        N("steady", "Steady Approach", "+0 AC; gunners normal; 3 Movement Points."),
        N("aggressive", "Aggressive Positioning", "−5 AC; forward gunners advantage; 2 Movement Points; enables Ram.")
      ],
      bonus: [N("reposition", "Reposition", "Spend Movement Points: Move Forward, Rotate 45°/90°, or Enter Hiding.")]
    },
    gunner_port: {
      main: [N("attack", "Attack", "Gun to-hit + Pilot/Science mods vs AC."), N("called", "Called Shot", "−5, no hull damage; inflict Engines Disabled / Weapon Offline / Shields Down."), N("launch", "Launch a Boarder", "Fire a crewmate at the enemy hull instead of shooting.")],
      bonus: [N("quickaim", "Quick Aim", "+2 to hit this round (+4 with perk).")]
    },
    gunner_starboard: {
      main: [N("attack", "Attack", "Gun to-hit + Pilot/Science mods vs AC."), N("called", "Called Shot", "−5, no hull damage; inflict Engines Disabled / Weapon Offline / Shields Down."), N("launch", "Launch a Boarder", "Fire a crewmate at the enemy hull instead of shooting.")],
      bonus: [N("quickaim", "Quick Aim", "+2 to hit this round (+4 with perk).")]
    },
    boarding: {
      main: [N("launch_breach", "Launch & Breach", "At close range: the boarder + that bay's gunner both spend their Main. Roll Athletics/Acrobatics (DC 15) to latch & breach.")],
      bonus: [N("repel", "Repel Boarders", "Leave your station to fight enemy boarders (you lose this station's Main this round).")]
    },
    engineer: {
      main: [N("repair", "Repair", "Int DC 15 → 2d6 + Int Hull (+1d6 per 5 over)."), N("reroute", "Reroute Power", "Buff an ally (+1d4 roll, +5 temp AC to Pilot, or +1d6 damage); risk of a self-mishap.")],
      bonus: [N("patch", "Patch Job", "Flat 1d4 Hull or Shield back, or clear one negative status.")]
    },
    shields_officer: {
      main: [
        { id: "allocate", name: "Allocate Shields", type: "shield-allocate",
          text: "Pick a facing (fore/aft/port/starboard). Attacks from that direction this round take half damage and the target gets +5 AC." },
        { id: "jam", name: "Jam / Scramble", type: "roll", ability: "int", dc: 15,
          text: "Opposed INT vs the enemy (flat DC 15 otherwise). Success: disadvantage on one enemy gunner's attack, OR block their reinforcements this round." },
        { id: "hail", name: "Hail", type: "roll", ability: "cha", dc: null,
          text: "CHA check vs enemy morale/attitude DC (GM sets, usually 12–18). Roleplay-first, GM adjudicated." }
      ],
      bonus: [
        { id: "micro", name: "Micro-Adjust", type: "shield-micro",
          text: "Grant a second facing +2 AC (no damage-halving) on top of your main allocation. Lasts until the start of your next turn." }
      ]
    },
    science: {
      main: [N("scan", "Scan", "Int/Investigation DC 15 → reveal enemy AC, resistances, shield facing; beat by 3+/10+ grants gunners advantage."), N("counter", "Countermeasures", "Opposed Int to negate an enemy Scan/Jam; can be held for the enemy's turn."), N("navsupport", "Navigation Support", "Double the Pilot's Movement Points; safe passage; Enter Hiding even on Aggressive.")],
      bonus: [N("ping", "Quick Ping", "No roll — ask the GM one factual question about the enemy, get a truthful answer.")]
    },
    cloaking: {
      main: [N("engage", "Engage Cloak", "Enemy attacks at disadvantage until you fire or take damage."), N("burst", "Cloak Burst", "Undetectable for 1 round."), N("phase", "Phase Shift", "Auto-dodge one attack."), N("decoy", "Decoy Drop", "Drop a decoy to misdirect.")],
      bonus: [N("stealth", "Stealth Debuff", "Impose a stealth-based debuff on the enemy.")]
    },
    turret_flak: { main: [N("attack", "Flak Spread", "Hit up to 3 targets; anti-swarm point-defense."), N("adjust", "Adjust Aim", "Line up a better shot.")], bonus: [] },
    turret_autocannon: { main: [N("attack", "Armor-Piercing Shot", "Ignores armor AC; Called Shots ignore the −5."), N("adjust", "Adjust Aim", "Line up a better shot.")], bonus: [] },
    turret_plasma: { main: [N("attack", "Plasma Shot", "Auto-inflicts Shields Down; +1d6 vs already-Shields-Down."), N("adjust", "Adjust Aim", "Line up a better shot.")], bonus: [] },
    turret_cryo: { main: [N("attack", "Cryo-Beam", "Inflicts Frozen/Brittle; frozen take double from kinetic."), N("adjust", "Adjust Aim", "Line up a better shot.")], bonus: [] },
    turret_ion: { main: [N("attack", "Ion Shot", "Inflicts Engines Disabled or Shields Down; advantage vs disabled."), N("adjust", "Adjust Aim", "Line up a better shot.")], bonus: [] },
    turret_gravity: { main: [N("attack", "Gravity Well", "Grapple/Crush up to 2–3 targets; crushed take double from Rams."), N("adjust", "Adjust Aim", "Line up a better shot.")], bonus: [] }
  };
  S.stationActions = (id) => S.STATION_ACTIONS[id] || { main: [], bonus: [] };

  // The crew — a persistent roster of characters, each normally played by one user.
  // Combat participants are drawn from this roster; the GM can reassign who controls
  // each one (e.g. cover an absent player) and exclude any from a given fight.
  S.defaultRoster = function () {
    return [
      { id: "astra", name: "ASTRA",        userId: "" },
      { id: "kael",  name: "Kael Voss",    userId: "" },
      { id: "baldy", name: "Baldy",        userId: "" },
      { id: "gobby", name: "Gobby",        userId: "" },
      { id: "glimm", name: "G.L.I.M.M.",   userId: "" },
      { id: "ronon", name: "Ronon Dex",    userId: "" },
      { id: "gerth", name: "Gerthorlemue", userId: "" }
    ];
  };

  S.defaultCombat = function () {
    const rolesEnabled = {};
    for (const st of S.STATIONS) rolesEnabled[st.id] = !!st.defaultUnlocked;
    return { active: false, turn: 1, rolesEnabled, roster: S.defaultRoster(), crew: {}, pendingSwap: null };
  };

  // Merge stored combat onto defaults so new fields/stations forward-migrate.
  S.normalizeCombat = function (stored) {
    const d = S.defaultCombat();
    if (!stored || typeof stored !== "object") return d;
    const out = {
      active: !!stored.active,
      turn: Number.isFinite(stored.turn) ? stored.turn : 1,
      rolesEnabled: { ...d.rolesEnabled },
      roster: Array.isArray(stored.roster) && stored.roster.length ? [] : S.defaultRoster(),
      crew: {},
      pendingSwap: null
    };
    for (const st of S.STATIONS) {
      if (typeof stored.rolesEnabled?.[st.id] === "boolean") out.rolesEnabled[st.id] = stored.rolesEnabled[st.id];
    }
    if (Array.isArray(stored.roster) && stored.roster.length) {
      for (const m of stored.roster) {
        if (m && m.id && m.name) out.roster.push({ id: String(m.id), name: String(m.name), userId: String(m.userId || "") });
      }
    }
    const validStation = (s) => (s && S.station(s) ? s : "");
    for (const [cid, c] of Object.entries(stored.crew || {})) {
      if (!c || typeof c !== "object" || !c.name) continue;
      out.crew[cid] = {
        id: cid, name: String(c.name),
        ownerUserId: String(c.ownerUserId || ""),
        controllerUserId: String(c.controllerUserId || c.ownerUserId || ""),
        station: validStation(c.station),
        action: !!c.action, bonus: !!c.bonus,
        granted: Number.isFinite(c.granted) && c.granted > 0 ? Math.floor(c.granted) : 0
      };
    }
    const ps = stored.pendingSwap;
    if (ps && ps.fromCrew && ps.targetCrew) {
      out.pendingSwap = { fromCrew: String(ps.fromCrew), targetCrew: String(ps.targetCrew) };
    }
    return out;
  };

  // Crew a given user currently operates (their own + any the GM handed them).
  S.crewControlledBy = function (combat, userId) {
    return Object.values(combat.crew).filter((c) => c.controllerUserId === userId);
  };

  /* ---------------------------------------------------------------------- */
  /*  Default state (seeded into the world setting on first GM load)        */
  /* ---------------------------------------------------------------------- */

  S.defaultState = function () {
    const systems = {};
    for (const sys of S.SYSTEMS) systems[sys.id] = sys.installed === false ? "offline" : "working";
    return {
      name: "SSV Silver Gull",
      plating: "Titanium-Aegis Matrix Plating",
      hull: { cur: 150, max: 150 },
      ship: "auto", // auto | intact | damaged | cloaked
      systems,
      // Main directional shield (on/off + facing) plus an optional smaller SECONDARY
      // facing (the Shields Officer's Micro-Adjust bonus, +2 AC, cleared each turn).
      shield: { on: true, facing: "fore", secondary: null },
      // Ship resources for the inventory screen (GM-tunable).
      fuel:  { cur: 100, max: 100 },
      power: { cur: 100, max: 100 },
      tuning: { fuelPerItem: 25, powerPerItem: 25, convertFuel: 10, convertPower: 50 },
      actorId: ""   // GM-selected ship (dnd5e vehicle) actor; falls back to a name lookup
    };
  };

  // Merge stored state onto defaults so new systems/arcs appear without a reset.
  S.normalize = function (stored) {
    const d = S.defaultState();
    if (!stored || typeof stored !== "object") return d;
    const out = {
      name: stored.name || d.name,
      plating: stored.plating || d.plating,
      hull: {
        max: Number(stored.hull?.max ?? d.hull.max),
        cur: Number(stored.hull?.cur ?? d.hull.cur)
      },
      ship: stored.ship || d.ship,
      systems: { ...d.systems },
      shield: { ...d.shield },
      fuel:  { max: Number(stored.fuel?.max  ?? d.fuel.max),  cur: Number(stored.fuel?.cur  ?? d.fuel.cur)  },
      power: { max: Number(stored.power?.max ?? d.power.max), cur: Number(stored.power?.cur ?? d.power.cur) },
      tuning: {
        fuelPerItem:  Number(stored.tuning?.fuelPerItem  ?? d.tuning.fuelPerItem),
        powerPerItem: Number(stored.tuning?.powerPerItem ?? d.tuning.powerPerItem),
        convertFuel:  Number(stored.tuning?.convertFuel  ?? d.tuning.convertFuel),
        convertPower: Number(stored.tuning?.convertPower ?? d.tuning.convertPower)
      },
      actorId: String(stored.actorId ?? d.actorId)
    };
    for (const sys of S.SYSTEMS) {
      const v = stored.systems?.[sys.id];
      if (sys.installed === false) out.systems[sys.id] = "offline";
      else if (S.SYSTEM_STATES.includes(v)) out.systems[sys.id] = v;
    }
    const sh = stored.shield;
    if (sh && typeof sh === "object") {
      out.shield.on = !!sh.on;
      if (S.FACINGS.includes(sh.facing)) out.shield.facing = sh.facing;
      out.shield.secondary = S.FACINGS.includes(sh.secondary) ? sh.secondary : null;
    }
    out.hull.cur = Math.max(0, Math.min(out.hull.cur, out.hull.max));
    for (const g of ["fuel", "power"]) {
      if (!(out[g].max > 0)) out[g].max = d[g].max;
      out[g].cur = Math.max(0, Math.min(out[g].cur, out[g].max));
    }
    for (const k in out.tuning) if (!Number.isFinite(out.tuning[k]) || out.tuning[k] < 0) out.tuning[k] = d.tuning[k];
    return out;
  };

  /* ---------------------------------------------------------------------- */
  /*  Helpers                                                               */
  /* ---------------------------------------------------------------------- */

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const stripHtml = (h) => String(h ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  const DEFAULT_ITEM_IMG = "icons/svg/item-bag.svg";

  // Which ship image to show. Variants: intact | damaged | cloaked (no "destroyed" art).
  // "auto" derives from hull + system health. "cloaked" is only shown when set explicitly
  // (or when the cloak system is engaged, once that's wired up).
  S.SHIP_VARIANTS = ["intact", "damaged", "cloaked"];
  S.shipVariant = function (state) {
    if (state.ship === "cloaked") return "cloaked";
    if (state.ship && state.ship !== "auto") return state.ship === "destroyed" ? "damaged" : state.ship;
    // Damaged hull art only kicks in below half health — not for individual destroyed systems.
    const hullPct = state.hull.max ? state.hull.cur / state.hull.max : 1;
    return hullPct <= 0.5 ? "damaged" : "intact";
  };

  /* ---------------------------------------------------------------------- */
  /*  Scoped styles                                                         */
  /* ---------------------------------------------------------------------- */

  S.ensureStyles = function () {
    if (typeof document === "undefined" || document.getElementById("ssvsc-styles")) return;
    const st = document.createElement("style");
    st.id = "ssvsc-styles";
    st.textContent = `
.sgsc{--bg:#040a12;--panel:rgba(14,34,48,.55);--edge:#12455a;--edge2:#1d6a86;--teal:#38e1c4;--amber:#f2b03d;--red:#e0454d;--dim:#5a6b7a;--ink:#cfeef0;--muted:#6f97a6;
  font-family:'Courier New',monospace;color:var(--ink);background:
   radial-gradient(1200px 700px at 50% -10%,rgba(29,106,134,.25),transparent 60%),
   radial-gradient(900px 600px at 50% 120%,rgba(242,176,61,.10),transparent 55%),var(--bg);
  padding:18px 18px 22px;overflow:hidden;position:relative;}
.sgsc *{box-sizing:border-box;}
.sgsc .sc-title{position:relative;z-index:2;font-size:22px;font-weight:700;letter-spacing:2px;color:var(--teal);text-align:center;text-shadow:0 0 12px rgba(56,225,196,.45);}
.sgsc .sc-sub{position:relative;z-index:2;font-size:12px;color:var(--muted);text-align:center;margin:2px 0 16px;letter-spacing:1px;}
.sgsc .sc-grid{position:relative;z-index:2;display:grid;grid-template-columns:1fr minmax(300px,360px) 1fr;gap:18px;align-items:start;pointer-events:none;min-height:600px;}
.sgsc .sc-col{display:flex;flex-direction:column;gap:12px;}
.sgsc .sc-center{position:relative;align-self:stretch;}
.sgsc .sc-card{pointer-events:auto;z-index:2;display:flex;gap:12px;align-items:center;padding:9px 11px;border:1px solid var(--edge);border-radius:9px;
  background:var(--panel);position:relative;transition:border-color .15s,box-shadow .15s;}
.sgsc .sc-card.gm{cursor:pointer;}
.sgsc .sc-card.gm:hover{border-color:var(--edge2);box-shadow:0 0 14px rgba(29,106,134,.5);}
.sgsc .sc-card.right{flex-direction:row-reverse;text-align:right;}
.sgsc .sc-ico{width:52px;height:52px;flex:none;position:relative;display:flex;align-items:center;justify-content:center;}
.sgsc .sc-ico img{max-width:100%;max-height:100%;filter:drop-shadow(0 0 6px rgba(56,225,196,.5));}
.sgsc .sc-ico .ph{width:44px;height:44px;border:1.5px dashed currentColor;border-radius:8px;opacity:.6;}
.sgsc .sc-card.st-damaged .sc-ico img{filter:drop-shadow(0 0 6px rgba(242,176,61,.55));}
.sgsc .sc-card.st-destroyed .sc-ico img{filter:grayscale(.4) drop-shadow(0 0 5px rgba(224,69,77,.55));opacity:.55;}
.sgsc .sc-card.st-offline{opacity:.6;border-style:dashed;}
.sgsc .sc-name{font-size:14px;font-weight:700;color:var(--ink);line-height:1.15;}
.sgsc .sc-pill{display:inline-block;margin-top:3px;font-size:10px;font-weight:700;letter-spacing:1px;padding:1px 7px;border-radius:10px;border:1px solid currentColor;}
/* Ship + shield sit BEHIND the panels, confined to the central band (clear of the title & hull bar). */
.sgsc .sc-shipbg{position:absolute;top:-55px;bottom:0;left:-78%;right:-78%;z-index:1;display:flex;align-items:center;justify-content:center;pointer-events:none;}
.sgsc .sc-shipwrap{position:relative;height:112%;aspect-ratio:1218/1620;pointer-events:auto;}
.sgsc.gm .sc-shipwrap{cursor:crosshair;}
.sgsc .sc-shipwrap img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;}
.sgsc .sc-shipimg{filter:drop-shadow(0 0 20px rgba(29,106,134,.5));}
.sgsc .sc-shieldimg{z-index:2;filter:drop-shadow(0 0 8px rgba(72,232,226,.75)) drop-shadow(0 0 22px rgba(72,232,226,.5));
  animation:sgsc-pulse 2.6s ease-in-out infinite;}
.sgsc .sc-shieldimg.dmg{filter:sepia(1) saturate(9) hue-rotate(-38deg) brightness(1) contrast(1.1)
  drop-shadow(0 0 8px rgba(235,60,60,.9)) drop-shadow(0 0 22px rgba(235,60,60,.55));animation:sgsc-flicker .5s steps(2,end) infinite;}
/* Secondary shield (Micro-Adjust): a thin violet arc hugging the allocated side —
   a slimmer, inward-scaled copy of that side's main shield, tinted distinct from the cyan primary. */
/* Sits at scale 1.0 (same footprint as that side's main shield) so it aligns with the hull;
   distinguished purely by being violet + much fainter than the cyan primary. */
.sgsc .sc-shield2img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:3;pointer-events:none;
  filter:hue-rotate(92deg) saturate(1.2) brightness(.72) drop-shadow(0 0 2px rgba(176,107,240,.45));
  opacity:.42;animation:sgsc-pulse2 2.6s ease-in-out infinite;}
@keyframes sgsc-pulse2{0%,100%{opacity:.3;}50%{opacity:.5;}}
@keyframes sgsc-pulse{0%,100%{opacity:.82;}50%{opacity:1;}}
@keyframes sgsc-flicker{0%,100%{opacity:.92;}44%{opacity:.5;}}
.sgsc .sc-shipph{position:absolute;inset:20% 15%;border:1.5px dashed var(--edge2);border-radius:40% 40% 20% 20%/30% 30% 12% 12%;
  display:flex;align-items:flex-end;justify-content:center;padding-bottom:10px;color:var(--muted);font-size:11px;letter-spacing:1px;background:rgba(29,106,134,.08);}
.sgsc .sc-shield-tag{position:absolute;top:14%;left:50%;transform:translateX(-50%);z-index:3;font-size:11px;font-weight:700;letter-spacing:1px;
  color:var(--teal);background:rgba(4,10,18,.8);border:1px solid var(--edge2);padding:2px 10px;border-radius:10px;pointer-events:none;white-space:nowrap;}
.sgsc .sc-hull{position:relative;z-index:2;max-width:520px;margin:16px auto 0;}
.sgsc .sc-hull .row{display:flex;justify-content:space-between;align-items:baseline;font-size:12px;color:var(--muted);letter-spacing:1px;}
.sgsc .sc-hull .bar{position:relative;height:16px;background:#0a1c26;border:1px solid var(--edge);border-radius:9px;overflow:hidden;margin-top:5px;}
.sgsc .sc-hull .fill{position:absolute;left:0;top:0;bottom:0;border-radius:9px;transition:width .25s;}
.sgsc .sc-hull .hp{font-size:20px;font-weight:700;color:var(--ink);}
.sgsc .sc-hull.gm .bar{cursor:pointer;}
.sgsc .sc-foot{position:relative;z-index:2;text-align:center;font-size:11px;color:var(--muted);margin-top:14px;letter-spacing:1px;}
.sgsc .sc-legend{position:relative;z-index:2;display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin-top:6px;font-size:10px;letter-spacing:1px;}
.sgsc .sc-legend span{display:inline-flex;align-items:center;gap:5px;color:var(--muted);}
.sgsc .sc-legend i{width:9px;height:9px;border-radius:2px;display:inline-block;}
@media (max-width:720px){.sgsc .sc-grid{grid-template-columns:1fr;}.sgsc .sc-card.right{flex-direction:row;text-align:left;}}

/* ---- Ship-combat turn/action tracker bar (top of screen) ---- */
.sgct{--bg:rgba(6,14,22,.94);--edge:#12455a;--edge2:#1d6a86;--teal:#38e1c4;--amber:#f2b03d;--ink:#cfeef0;--muted:#7fa6b4;
  font-family:'Courier New',monospace;color:var(--ink);display:flex;flex-direction:column;gap:6px;
  background:var(--bg);border:1px solid var(--edge2);border-radius:12px;padding:8px 12px;box-shadow:0 6px 26px rgba(0,0,0,.55);
  max-width:min(96vw,1180px);}
.sgct.host{position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:70;pointer-events:auto;}
.sgct *{box-sizing:border-box;}
.sgct .ct-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:center;}
.sgct .ct-turn{font-weight:700;letter-spacing:2px;color:var(--teal);text-shadow:0 0 10px rgba(56,225,196,.4);white-space:nowrap;}
.sgct .ct-btn{font-family:inherit;font-size:12px;font-weight:700;letter-spacing:1px;cursor:pointer;color:var(--ink);
  background:#0a1c26;border:1px solid var(--edge2);border-radius:7px;padding:5px 11px;white-space:nowrap;}
.sgct .ct-btn:hover{border-color:var(--teal);box-shadow:0 0 10px rgba(56,225,196,.4);}
.sgct .ct-btn.enter{color:#0a1c26;background:var(--teal);border-color:var(--teal);}
.sgct .ct-btn.warn:hover{border-color:var(--amber);box-shadow:0 0 10px rgba(242,176,61,.4);}
.sgct .ct-seats{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;}
.sgct .ct-seat{display:flex;align-items:center;gap:10px;border:1px solid var(--edge);border-radius:9px;padding:6px 10px;background:rgba(14,34,48,.5);}
.sgct .ct-seat.mine{border-color:var(--teal);box-shadow:0 0 12px rgba(56,225,196,.25);}
.sgct .ct-name{font-weight:700;font-size:13px;color:var(--ink);white-space:nowrap;}
.sgct .ct-sub{font-size:10px;color:var(--muted);letter-spacing:1px;}
.sgct .ct-toks{display:flex;align-items:center;gap:7px;}
.sgct .ct-tok{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:6px;
  cursor:default;line-height:0;}
.sgct .ct-tok.click{cursor:pointer;}
.sgct .ct-tok.click:hover{background:rgba(255,255,255,.08);}
.sgct .ct-tok svg{display:block;filter:drop-shadow(0 0 4px rgba(0,0,0,.5));}
.sgct .ct-ctrl{display:flex;align-items:center;gap:6px;}
.sgct select.ct-sel{font-family:inherit;font-size:11px;background:#0a1c26;color:var(--ink);border:1px solid var(--edge);border-radius:6px;padding:3px 5px;max-width:130px;}
.sgct .ct-x{cursor:pointer;color:var(--muted);font-weight:700;padding:0 4px;}
.sgct .ct-x:hover{color:var(--amber);}
.sgct .ct-note{text-align:center;font-size:11px;color:var(--amber);letter-spacing:1px;}
.sgct .ct-legend{display:flex;gap:14px;justify-content:center;font-size:10px;color:var(--muted);letter-spacing:1px;flex-wrap:wrap;}
.sgct .ct-legend span{display:inline-flex;align-items:center;gap:5px;}
.sgct .ct-empty{font-size:11px;color:var(--muted);letter-spacing:1px;text-align:center;}

/* ---- Full-screen station console ---- */
.sgcon{position:fixed;inset:0;z-index:60;display:flex;gap:0;background:
   radial-gradient(1200px 700px at 30% -10%,rgba(29,106,134,.22),transparent 60%),#03070d;
  font-family:'Courier New',monospace;color:#cfeef0;overflow:hidden;}
.sgcon *{box-sizing:border-box;}
.sgcon .con-left{flex:1 1 62%;min-width:0;overflow:auto;padding:6px 6px 20px;}
.sgcon .con-left .sgsc{background:transparent;min-height:100%;}
.sgcon .con-right{flex:0 0 clamp(320px,34%,460px);border-left:1px solid #12455a;background:rgba(6,14,22,.6);
  display:flex;flex-direction:column;gap:14px;padding:16px 16px 22px;overflow:auto;}
.sgcon .con-head{display:flex;align-items:center;gap:10px;}
.sgcon .con-title{flex:1;font-size:16px;font-weight:700;letter-spacing:2px;color:#38e1c4;text-shadow:0 0 10px rgba(56,225,196,.4);}
.sgcon select.con-sel{font-family:inherit;font-size:12px;background:#0a1c26;color:#cfeef0;border:1px solid #1d6a86;border-radius:6px;padding:4px 6px;max-width:160px;}
.sgcon .con-x{cursor:pointer;background:#0a1c26;border:1px solid #1d6a86;color:#cfeef0;border-radius:7px;width:30px;height:30px;font-weight:700;}
.sgcon .con-x:hover{border-color:#f2b03d;color:#f2b03d;}
.sgcon .con-inv{cursor:pointer;background:#0a1c26;border:1px solid #1d6a86;color:#cfeef0;border-radius:7px;height:30px;padding:0 9px;font-weight:700;}
.sgcon .con-inv:hover{border-color:#38e1c4;color:#38e1c4;}
/* inventory panel */
.sgcon .con-gauge{border:1px solid #12455a;border-radius:9px;padding:8px 10px;background:rgba(14,34,48,.5);}
.sgcon .con-gauge.gm{cursor:pointer;}
.sgcon .con-gauge.gm:hover{border-color:#1d6a86;}
.sgcon .con-gauge .cg-row{display:flex;justify-content:space-between;font-size:12px;letter-spacing:1px;color:#7fa6b4;}
.sgcon .con-gauge .cg-val{color:#cfeef0;font-weight:700;}
.sgcon .con-gauge .cg-bar{height:12px;margin-top:5px;background:#0a1c26;border:1px solid #12455a;border-radius:7px;overflow:hidden;}
.sgcon .con-gauge .cg-fill{height:100%;border-radius:7px;transition:width .25s;}
.sgcon .con-gauge.fuel .cg-fill{background:#f2b03d;box-shadow:0 0 10px rgba(242,176,61,.6);}
.sgcon .con-gauge.power .cg-fill{background:#38e1c4;box-shadow:0 0 10px rgba(56,225,196,.6);}
.sgcon .con-gmrow{display:flex;gap:8px;}
.sgcon .con-items{display:flex;flex-direction:column;gap:6px;}
.sgcon .con-item{display:flex;align-items:center;justify-content:space-between;gap:8px;border:1px solid #12455a;border-radius:8px;padding:6px 9px;background:rgba(14,34,48,.4);}
.sgcon .con-item .ci-name{font-size:13px;}
.sgcon .con-item .ci-qty{color:#7fa6b4;}
.sgcon .con-item .ci-btns{display:inline-flex;gap:5px;flex:none;}
.sgcon .con-mini{cursor:pointer;font-family:inherit;font-size:12px;font-weight:700;color:#cfeef0;background:#0a1c26;border:1px solid #1d6a86;border-radius:6px;padding:3px 7px;white-space:nowrap;}
.sgcon .con-mini:hover{border-color:#38e1c4;color:#38e1c4;}
/* ---- Game-style inventory (inv-mode): narrow ship on the left, big item grid on the right ---- */
.sgcon.inv-mode .con-left{flex:0 0 30%;display:flex;flex-direction:column;overflow:hidden;}
.sgcon.inv-mode .con-left > div{flex:1;min-height:0;}
.sgcon.inv-mode .con-right{flex:1 1 auto;padding:16px 18px 20px;}
.sgcon .invship{display:flex;flex-direction:column;height:100%;gap:8px;padding:6px 4px;background:transparent;}
.sgcon .invship .sc-mtitle{font-size:13px;font-weight:700;letter-spacing:2px;color:#38e1c4;text-align:center;text-shadow:0 0 10px rgba(56,225,196,.4);}
.sgcon .invship .miniwrap{flex:1;min-height:0;position:relative;display:flex;align-items:center;justify-content:center;}
.sgcon .invship .sc-shipwrap{position:relative;height:100%;max-height:100%;aspect-ratio:1218/1620;}
.sgcon.gm .invship .sc-shipwrap,.sgcon .invship.gm .sc-shipwrap{cursor:crosshair;}
.sgcon .invship .sc-hull{margin:0;max-width:100%;}
.sgcon .inv-wrap{display:flex;flex-direction:column;gap:12px;height:100%;min-height:0;}
.sgcon .inv-gauges{display:flex;gap:12px;align-items:stretch;flex-wrap:wrap;}
.sgcon .inv-gauges > *{min-height:74px;}
.sgcon .inv-gauges .con-btn{flex:0 1 210px;min-width:150px;align-self:stretch;display:flex;align-items:center;justify-content:center;
  border-radius:12px;background:linear-gradient(180deg,rgba(14,34,48,.65),rgba(8,20,30,.65));}
/* Sci-fi fuel/power gauges — wider than the Convert button */
.sgcon .ig{position:relative;flex:1 1 260px;min-width:200px;border:1px solid #163b4e;border-radius:12px;padding:10px 13px;
  display:flex;flex-direction:column;justify-content:center;background:linear-gradient(180deg,rgba(16,38,52,.7),rgba(8,20,30,.7));overflow:hidden;}
.sgcon .ig.gm{cursor:pointer;}
.sgcon .ig.gm:hover{border-color:#2b7d99;box-shadow:0 0 16px rgba(56,225,196,.2);}
.sgcon .ig-top{display:flex;align-items:center;gap:9px;margin-bottom:9px;}
.sgcon .ig-ico{font-size:16px;line-height:1;filter:drop-shadow(0 0 5px rgba(0,0,0,.5));}
.sgcon .ig-label{font-size:12px;letter-spacing:2px;color:#8fb2c0;font-weight:700;}
.sgcon .ig-val{margin-left:auto;font-size:19px;font-weight:700;color:#eaf7fa;text-shadow:0 0 10px rgba(0,0,0,.4);}
.sgcon .ig-val small{font-size:12px;color:#7fa6b4;font-weight:700;}
.sgcon .ig-track{position:relative;height:15px;border-radius:9px;background:#07141d;border:1px solid #103042;overflow:hidden;box-shadow:inset 0 1px 4px rgba(0,0,0,.7);}
.sgcon .ig-track::after{content:"";position:absolute;inset:0;pointer-events:none;opacity:.45;
  background:repeating-linear-gradient(90deg,transparent 0 13px,rgba(0,0,0,.45) 13px 14px);}
.sgcon .ig-fill{position:absolute;top:0;left:0;bottom:0;border-radius:9px;transition:width .4s cubic-bezier(.2,.7,.2,1);overflow:hidden;}
.sgcon .ig-fill::before{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.32),transparent);
  transform:translateX(-100%);animation:ig-sheen 3.4s ease-in-out infinite;}
@keyframes ig-sheen{0%{transform:translateX(-100%);}55%,100%{transform:translateX(240%);}}
.sgcon .ig.fuel .ig-ico{color:#f2b03d;}
.sgcon .ig.power .ig-ico{color:#38e1c4;}
.sgcon .ig.fuel .ig-fill{background:linear-gradient(90deg,#a75f16,#f2b03d,#ffd987);box-shadow:0 0 14px rgba(242,176,61,.75);}
.sgcon .ig.power .ig-fill{background:linear-gradient(90deg,#0f8f89,#38e1c4,#9dffef);box-shadow:0 0 14px rgba(56,225,196,.75);}
.sgcon .ig.low .ig-fill{background:linear-gradient(90deg,#7c1c1c,#e0454d,#ff8f8f)!important;box-shadow:0 0 14px rgba(224,69,77,.75)!important;}
.sgcon .ig.low .ig-val{color:#ff9c9c;}
.sgcon .ig.low .ig-ico{color:#ff6b6b;animation:ig-blink 1.1s steps(2,end) infinite;}
@keyframes ig-blink{0%,100%{opacity:1;}50%{opacity:.4;}}
.sgcon .inv-convert{flex:0 1 210px;min-width:150px;display:flex;flex-direction:column;gap:6px;}
.sgcon .inv-convert .con-btn{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;font-size:12px;padding:6px 10px;
  border-radius:10px;background:linear-gradient(180deg,rgba(14,34,48,.65),rgba(8,20,30,.65));}
/* Add-item browser (searchable, world + compendiums) */
.sgib-overlay{position:fixed;inset:0;z-index:120;background:rgba(2,6,12,.72);display:flex;align-items:center;justify-content:center;
  font-family:'Courier New',monospace;color:#cfeef0;}
.sgib{width:min(780px,94vw);max-height:84vh;display:flex;flex-direction:column;border:1px solid #1d6a86;border-radius:16px;overflow:hidden;
  background:linear-gradient(180deg,#0c2334,#081521);box-shadow:0 26px 74px rgba(0,0,0,.72);}
.sgib-head{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid #12455a;flex-wrap:wrap;}
.sgib-title{font-weight:700;letter-spacing:2px;color:#38e1c4;text-shadow:0 0 10px rgba(56,225,196,.4);white-space:nowrap;}
.sgib-search{flex:1;min-width:180px;display:flex;align-items:center;gap:8px;background:#0a1c26;border:1px solid #1d6a86;border-radius:9px;padding:8px 12px;}
.sgib-search input{flex:1;background:transparent;border:none;outline:none;color:#cfeef0;font-family:inherit;font-size:14px;}
.sgib-x{cursor:pointer;background:#0a1c26;border:1px solid #1d6a86;color:#cfeef0;border-radius:8px;width:32px;height:32px;font-weight:700;}
.sgib-x:hover{border-color:#f2b03d;color:#f2b03d;}
.sgib-count{padding:8px 16px 0;font-size:11px;letter-spacing:1px;color:#7fa6b4;}
.sgib-body{flex:1;min-height:0;overflow:auto;padding:12px 16px 16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;align-content:start;}
.sgib-card{display:flex;gap:10px;align-items:center;padding:9px;border:1px solid #1d6a86;border-radius:11px;cursor:pointer;
  background:linear-gradient(180deg,rgba(22,48,64,.55),rgba(9,22,32,.55));transition:border-color .12s,box-shadow .12s,transform .12s;min-width:0;}
.sgib-card:hover{border-color:#38e1c4;box-shadow:0 0 14px rgba(56,225,196,.3);transform:translateY(-2px);}
.sgib-card.added{border-color:#42d16a;box-shadow:0 0 14px rgba(66,209,106,.5);}
.sgib-card img{width:42px;height:42px;flex:none;object-fit:contain;border-radius:8px;background:rgba(4,10,18,.4);}
.sgib-meta{min-width:0;}
.sgib-name{font-size:13px;font-weight:700;color:#eaf7fa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sgib-sub{font-size:11px;color:#7fa6b4;text-transform:capitalize;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sgib-empty{grid-column:1/-1;text-align:center;color:#6f97a6;padding:30px;font-size:12px;letter-spacing:1px;}
.sgib-foot{display:flex;align-items:center;gap:12px;justify-content:space-between;padding:11px 16px;border-top:1px solid #12455a;flex-wrap:wrap;}
.sgib-hint{flex:1;font-size:11px;color:#6f97a6;text-align:center;min-width:140px;}
.sgcon .inv-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.sgcon .inv-tabs{display:flex;gap:6px;}
.sgcon .inv-tab{cursor:pointer;font-family:inherit;font-weight:700;font-size:12px;letter-spacing:1px;color:#7fa6b4;background:#0a1c26;border:1px solid #12455a;border-radius:9px;padding:7px 14px;}
.sgcon .inv-tab:hover{border-color:#1d6a86;color:#cfeef0;}
.sgcon .inv-tab.active{color:#38e1c4;border-color:#38e1c4;box-shadow:0 0 10px rgba(56,225,196,.28);}
.sgcon .inv-search{flex:1;min-width:150px;display:flex;align-items:center;gap:8px;background:#0a1c26;border:1px solid #1d6a86;border-radius:9px;padding:7px 12px;}
.sgcon .inv-search input{flex:1;background:transparent;border:none;outline:none;color:#cfeef0;font-family:inherit;font-size:13px;}
.sgcon .inv-grid{flex:1;min-height:0;overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(108px,1fr));gap:12px;align-content:start;padding:6px 2px;border-radius:10px;}
.sgcon .inv-grid.inv-drop{outline:2px dashed #38e1c4;outline-offset:-6px;background:rgba(56,225,196,.05);}
.sgcon .inv-tile{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;padding:8px 8px 8px;border:1px solid #1d6a86;border-radius:13px;
  background:linear-gradient(180deg,rgba(22,48,64,.65),rgba(9,22,32,.65));transition:border-color .12s,box-shadow .12s,transform .12s;}
.sgcon .inv-tile:hover{border-color:#38e1c4;box-shadow:0 0 16px rgba(56,225,196,.35);transform:translateY(-2px);}
.sgcon .inv-tile .it-imgwrap{position:relative;margin-top:2px;}
.sgcon .inv-tile .it-imgwrap img{display:block;width:56px;height:56px;object-fit:contain;border-radius:9px;filter:drop-shadow(0 0 5px rgba(0,0,0,.55));background:rgba(4,10,18,.35);}
.sgcon .inv-tile .it-qty{position:absolute;top:-9px;left:50%;transform:translateX(-50%);font-size:12px;font-weight:700;color:#04121c;
  background:#38e1c4;border-radius:9px;padding:1px 8px;box-shadow:0 0 8px rgba(56,225,196,.55);white-space:nowrap;}
.sgcon .inv-tile .it-name{font-size:11px;line-height:1.2;text-align:center;color:#cfeef0;max-height:2.5em;overflow:hidden;}
.sgcon .inv-tile .it-bottom{display:flex;width:100%;align-items:center;justify-content:space-between;gap:6px;margin-top:1px;min-height:28px;}
.sgcon .inv-tile .it-bl,.sgcon .inv-tile .it-br{display:flex;}
/* Uniform icon buttons in every corner/slot */
.sgcon .it-ib{width:28px;height:28px;flex:none;display:flex;align-items:center;justify-content:center;font-size:14px;line-height:1;padding:0;
  font-family:inherit;color:#cfeef0;background:#0a1c26;border:1px solid #1d6a86;border-radius:8px;cursor:pointer;transition:border-color .12s,color .12s,box-shadow .12s;}
.sgcon .it-ib:hover{border-color:#38e1c4;color:#38e1c4;box-shadow:0 0 8px rgba(56,225,196,.3);}
.sgcon .it-ib.danger:hover{border-color:#e0454d;color:#e0454d;box-shadow:0 0 8px rgba(224,69,77,.35);}
.sgcon .inv-tile .it-tl{position:absolute;top:6px;left:6px;z-index:2;}
.sgcon .inv-tile .it-tr{position:absolute;top:6px;right:6px;z-index:2;}
.sgcon .inv-empty{grid-column:1/-1;color:#6f97a6;font-size:12px;letter-spacing:1px;text-align:center;padding:28px 10px;}
/* Item hover popup (details) — pointer-events:none so tile buttons still work */
.sgcon-invpop{position:fixed;z-index:90;width:240px;pointer-events:none;font-family:'Courier New',monospace;
  background:linear-gradient(180deg,#0d2334,#081521);border:1px solid #1d6a86;border-radius:13px;box-shadow:0 16px 46px rgba(0,0,0,.65);padding:13px;opacity:0;transform:translateY(4px);transition:opacity .12s,transform .12s;}
.sgcon-invpop.show{opacity:1;transform:none;}
.sgcon-invpop img{width:66px;height:66px;object-fit:contain;float:left;margin:0 11px 6px 0;border-radius:9px;background:rgba(4,10,18,.4);}
.sgcon-invpop .ip-name{font-size:14px;font-weight:700;color:#38e1c4;line-height:1.2;}
.sgcon-invpop .ip-type{font-size:11px;color:#7fa6b4;text-transform:capitalize;margin:2px 0 7px;}
.sgcon-invpop .ip-meta{font-size:11px;color:#9fc0cc;margin-bottom:7px;}
.sgcon-invpop .ip-desc{clear:both;font-size:12px;line-height:1.45;color:#bcd7df;max-height:150px;overflow:hidden;}
/* Mode-swap transition (stations ↔ inventory ↔ GM) */
@keyframes sgcon-swap{from{opacity:0;transform:translateX(26px);}to{opacity:1;transform:none;}}
@keyframes sgcon-fade{from{opacity:.25;}to{opacity:1;}}
.sgcon.do-swap .con-right{animation:sgcon-swap .3s cubic-bezier(.2,.75,.25,1) both;}
.sgcon.do-swap .con-left{animation:sgcon-fade .32s ease both;}
.sgcon .con-crew{display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid #12455a;border-radius:9px;padding:8px 12px;background:rgba(14,34,48,.5);}
.sgcon .con-cname{font-size:15px;font-weight:700;}
.sgcon .con-toks{display:inline-flex;align-items:center;gap:8px;}
.sgcon .con-toks .ct-tok{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;}
.sgcon .con-sec{display:flex;flex-direction:column;gap:8px;}
.sgcon .con-h{font-size:11px;letter-spacing:2px;color:#7fa6b4;border-bottom:1px solid #12455a;padding-bottom:4px;}
.sgcon .con-btns{display:flex;flex-direction:column;gap:8px;}
.sgcon .con-btn{font-family:inherit;text-align:left;font-size:13px;font-weight:700;color:#cfeef0;background:#0a1c26;
  border:1px solid #1d6a86;border-radius:8px;padding:9px 12px;cursor:pointer;transition:border-color .12s,box-shadow .12s;}
.sgcon .con-btn:hover{border-color:#38e1c4;box-shadow:0 0 12px rgba(56,225,196,.35);}
.sgcon .con-btn.armed{border-color:#f2b03d;box-shadow:0 0 14px rgba(242,176,61,.5);color:#f2b03d;}
.sgcon .con-btn.used,.sgcon .con-btn[disabled]{opacity:.4;cursor:not-allowed;border-style:dashed;box-shadow:none;}
/* Action row: the button + a little (i) info circle that toggles an inline explanation. */
.sgcon .con-act{display:flex;flex-direction:column;gap:6px;}
.sgcon .con-btnrow{display:flex;align-items:stretch;gap:6px;}
.sgcon .con-btnrow .con-btn{flex:1;}
.sgcon .con-i{flex:none;align-self:center;width:22px;height:22px;border-radius:50%;border:1px solid #1d6a86;
  color:#7fbecb;background:#0a1c26;display:flex;align-items:center;justify-content:center;
  font:italic 700 13px Georgia,'Times New Roman',serif;cursor:pointer;transition:border-color .12s,color .12s,box-shadow .12s;}
.sgcon .con-i:hover,.sgcon .con-i.open{border-color:#38e1c4;color:#38e1c4;box-shadow:0 0 8px rgba(56,225,196,.35);}
.sgcon .con-desc{font-size:12px;line-height:1.45;color:#9fc0cc;background:rgba(10,28,38,.55);
  border-left:2px solid #1d6a86;border-radius:0 6px 6px 0;padding:6px 10px;}
.sgcon .con-desc[hidden]{display:none;}
.sgcon .con-hint{font-size:12px;color:#f2b03d;letter-spacing:1px;text-align:center;}
.sgcon .con-empty{font-size:12px;color:#6f97a6;letter-spacing:1px;}
/* shield-allocation circles — larger, clustered on the hull (~half on the ship) */
.sgsc .con-circle{position:absolute;width:52px;height:52px;margin:-26px 0 0 -26px;border-radius:50%;cursor:pointer;z-index:6;
  border:4px solid #e0454d;background:rgba(224,69,77,.32);box-shadow:0 0 16px rgba(224,69,77,.85);animation:sgsc-pulse 1.1s ease-in-out infinite;}
.sgsc .con-circle.secondary{border-color:#4fe07a;background:rgba(80,235,120,.32);box-shadow:0 0 16px rgba(80,235,120,.85);}
.sgsc .con-circle:hover{transform:scale(1.15);}
.sgsc .con-circle.pos-fore{top:20%;left:50%;}
.sgsc .con-circle.pos-aft{top:80%;left:50%;}
.sgsc .con-circle.pos-port{top:56%;left:41%;}
.sgsc .con-circle.pos-starboard{top:56%;left:59%;}
@media (max-width:820px){.sgcon{flex-direction:column;}.sgcon .con-right{flex-basis:auto;border-left:none;border-top:1px solid #12455a;}}
`;
    document.head.appendChild(st);
  };

  /* ---------------------------------------------------------------------- */
  /*  Render (through the ctx contract)                                     */
  /*                                                                        */
  /*  ctx = {                                                               */
  /*    isGM: boolean,                                                      */
  /*    getState(): state,                                                  */
  /*    setState(state): Promise|void,  // persists + should re-render      */
  /*    assetUrl(relPath): string,                                          */
  /*    promptHull(cur, max): Promise<number|null>   (optional)             */
  /*  }                                                                     */
  /* ---------------------------------------------------------------------- */

  const cycle = (list, v) => list[(list.indexOf(v) + 1) % list.length];

  function iconEl(ctx, sys, st) {
    const file = ctx.assetUrl(`assets/systems/${sys.icon}-${st === "offline" ? "destroyed" : st}.png`);
    return `<div class="sc-ico"><span class="ph" style="color:${S.STATE_META[st]?.c || "#5a6b7a"}"></span>` +
      `<img src="${file}" alt="" onload="this.previousElementSibling.style.display='none'" onerror="this.style.display='none'"></div>`;
  }

  function systemCard(ctx, sys, state) {
    const st = state.systems[sys.id];
    const meta = S.STATE_META[st] || S.STATE_META.working;
    const gm = ctx.isGM && sys.installed !== false ? "gm" : "";
    const info = `<div class="sc-info"><div class="sc-name">${esc(sys.label)}</div>` +
      `<span class="sc-pill" style="color:${meta.c}">${meta.label}</span></div>`;
    return `<div class="sc-card ${sys.side} st-${st} ${gm}" data-sys="${sys.id}" title="${esc(sys.blurb)}">` +
      iconEl(ctx, sys, st) + info + `</div>`;
  }

  // The active shield overlays the ship exactly (same wrap); each side's art is pre-fitted to the hull.
  // The shield depends on the Shield Generator: damaged → the field flickers RED; destroyed → no field.
  function shieldEl(ctx, state) {
    const gen = state.systems.shields;
    if (gen === "destroyed") return "";
    let html = "";
    if (state.shield.on) {
      const file = ctx.assetUrl(`assets/shields/shield-${state.shield.facing}.png`);
      const cls = "sc-shieldimg" + (gen === "damaged" ? " dmg" : "");
      html += `<img class="${cls}" src="${file}" alt="" onerror="this.style.display='none'">`;
    }
    // Secondary facing (Micro-Adjust): a thin violet arc hugging that side.
    if (state.shield.secondary) {
      const f2 = ctx.assetUrl(`assets/shields/shield-${state.shield.secondary}.png`);
      html += `<img class="sc-shield2img face-${state.shield.secondary}" src="${f2}" alt="" onerror="this.style.display='none'">`;
    }
    return html;
  }

  // Sub-header shield readout, coloured by the generator's condition.
  function shieldStatus(state) {
    const gen = state.systems.shields;
    if (gen === "destroyed") return { label: "OFFLINE", color: "var(--red)" };
    if (!state.shield.on) return { label: "DOWN", color: "var(--dim)" };
    const dir = S.FACING_LABEL[state.shield.facing].toUpperCase();
    if (gen === "damaged") return { label: dir + " (FAILING)", color: "var(--red)" };
    return { label: dir, color: "var(--teal)" };
  }

  // Which side of the ship was clicked, from a point relative to the stage centre.
  function sideFromPoint(rect, x, y) {
    const dx = x - (rect.left + rect.width / 2);
    const dy = y - (rect.top + rect.height / 2);
    // Bias to the vertical axis a little since the ship is tall.
    if (Math.abs(dy) * 0.8 >= Math.abs(dx)) return dy < 0 ? "fore" : "aft";
    return dx < 0 ? "port" : "starboard";
  }

  S.render = function (root, ctx) {
    S.ensureStyles();
    const state = S.normalize(ctx.getState());
    const left = S.SYSTEMS.filter((s) => s.side === "left");
    const right = S.SYSTEMS.filter((s) => s.side === "right");
    const shipFile = ctx.assetUrl(`assets/ship/ship-${S.shipVariant(state)}.png`);

    const hullPct = state.hull.max ? clamp(state.hull.cur / state.hull.max, 0, 1) * 100 : 0;
    const hullColor = hullPct > 50 ? "var(--teal)" : hullPct > 20 ? "var(--amber)" : "var(--red)";

    root.className = `sgsc ${ctx.isGM ? "gm" : ""}`;
    root.innerHTML = `
      <div class="sc-title">${esc(state.name)} — SHIP OVERVIEW</div>
      <div class="sc-sub">SYSTEMS · HULL INTEGRITY · SHIELD: <b style="color:${shieldStatus(state).color}">${shieldStatus(state).label}</b></div>
      <div class="sc-grid">
        <div class="sc-col">${left.map((s) => systemCard(ctx, s, state)).join("")}</div>
        <div class="sc-col sc-center">
          <div class="sc-shipbg"><div class="sc-shipwrap">
            <span class="sc-shipph">SSV SILVER GULL</span>
            <img class="sc-shipimg" src="${shipFile}" alt="SSV Silver Gull" onload="this.previousElementSibling.style.display='none'" onerror="this.style.display='none'">
            ${shieldEl(ctx, state)}
          </div></div>
        </div>
        <div class="sc-col">${right.map((s) => systemCard(ctx, s, state)).join("")}</div>
      </div>
      <div class="sc-hull ${ctx.isGM ? "gm" : ""}">
        <div class="row"><span>HULL — ${esc(state.plating).toUpperCase()}</span><span class="hp">${state.hull.cur} / ${state.hull.max} HP</span></div>
        <div class="bar" data-hull="1"><div class="fill" style="width:${hullPct}%;background:${hullColor};box-shadow:0 0 12px ${hullColor}"></div></div>
      </div>
      <div class="sc-legend">
        <span><i style="background:var(--teal)"></i>Online</span>
        <span><i style="background:var(--amber)"></i>Damaged</span>
        <span><i style="background:var(--red)"></i>Destroyed</span>
        <span><i style="background:var(--dim)"></i>Offline / Not installed</span>
      </div>
      <div class="sc-foot">${ctx.isGM ? "GM: click a system to change its status · click a side of the ship to move the shield there (click the same side to switch it off) · click the hull bar to set HP" : "Press S to toggle · read-only"}</div>
    `;

    if (!ctx.isGM) return;

    root.querySelectorAll(".sc-card.gm").forEach((el) => {
      el.onclick = async () => {
        const id = el.dataset.sys;
        const next = S.normalize(ctx.getState());
        next.systems[id] = cycle(S.SYSTEM_STATES, next.systems[id]);
        await ctx.setState(next);
      };
    });
    const wrap = root.querySelector(".sc-shipwrap");
    if (wrap) wrap.onclick = async (ev) => {
      const side = sideFromPoint(wrap.getBoundingClientRect(), ev.clientX, ev.clientY);
      const next = S.normalize(ctx.getState());
      if (next.shield.on && next.shield.facing === side) {
        next.shield.on = false;                 // click the active side again → shields off
      } else {
        next.shield.on = true; next.shield.facing = side;
      }
      await ctx.setState(next);
    };
    const hullBar = root.querySelector('[data-hull]');
    if (hullBar && ctx.promptHull) hullBar.onclick = async () => {
      const cur = S.normalize(ctx.getState());
      const v = await ctx.promptHull(cur.hull.cur, cur.hull.max);
      if (v == null || isNaN(v)) return;
      const next = S.normalize(ctx.getState());
      next.hull.cur = clamp(Number(v), 0, next.hull.max);
      await ctx.setState(next);
    };
  };

  /* ---------------------------------------------------------------------- */
  /*  Combat turn/action tracker bar (environment-agnostic)                  */
  /*                                                                          */
  /*  cctx = {                                                                */
  /*    isGM, userId, users:[{id,name,isGM}],                                 */
  /*    getCombat(): combatState,                                             */
  /*    enterCombat(), endCombat(), nextTurn(),                              */
  /*    spend(role, which), requestSwitch(role), pickRole(),                 */
  /*    addSeat(), openRoles(), broadcastPick(),                             */
  /*    assignController(role, userId), removeSeat(role)                     */
  /*  }                                                                       */
  /* ---------------------------------------------------------------------- */

  const nameOf = (cctx, id) => { const u = (cctx.users || []).find((x) => x.id === id); return u ? u.name : "?"; };

  // Action = green circle, Bonus = orange triangle; filled when ready, outline when used.
  function token(kind, used, clickable) {
    const c = kind === "action" ? "#42d16a" : "#f2a03d";
    const shape = kind === "action"
      ? (used ? `<circle cx="12" cy="12" r="8" fill="none" stroke="${c}" stroke-width="2.6"/>`
              : `<circle cx="12" cy="12" r="9" fill="${c}"/>`)
      : (used ? `<polygon points="12,3 22,21 2,21" fill="none" stroke="${c}" stroke-width="2.6" stroke-linejoin="round"/>`
              : `<polygon points="12,3 22,21 2,21" fill="${c}"/>`);
    const label = (kind === "action" ? "Action" : "Bonus action") + " — " + (used ? "used" : "ready") + (clickable ? " (click to toggle)" : "");
    return `<span class="ct-tok${clickable ? " click" : ""}" data-tok="${kind}" title="${label}">` +
      `<svg width="22" height="22" viewBox="0 0 24 24">${shape}</svg></span>`;
  }

  // Granted extra actions (Captain's Grant Actions) show as purple stars.
  function grantedTokens(n) {
    if (!n || n < 1) return "";
    const star = `<span class="ct-tok" title="Extra action (spend after your normal action of that type)">` +
      `<svg width="22" height="22" viewBox="0 0 24 24"><polygon points="12,2 14.9,8.6 22,9.3 16.7,14 18.2,21 12,17.3 5.8,21 7.3,14 2,9.3 9.1,8.6" fill="#b06bf0"/></svg></span>`;
    return star.repeat(Math.min(n, 4));
  }

  function wireTokens(el, id, cctx) {
    el.querySelectorAll(".ct-tok.click").forEach((t) => { t.onclick = () => cctx.spend(id, t.dataset.tok); });
  }
  const stationName = (id) => { const st = S.station(id); return st ? st.name : ""; };

  S.renderTracker = function (root, cctx) {
    S.ensureStyles();
    const combat = S.normalizeCombat(cctx.getCombat());
    root.className = "sgct host";
    const collapseBtn = `<button class="ct-btn" data-act="collapse" title="Hide the tracker">▾ Hide</button>`;

    // Inactive: GM sees Enter + Crew config (hidden by default — press \ to show); players see nothing.
    if (!combat.active) {
      if (cctx.isGM && !cctx.gmBarHidden) {
        root.style.display = "flex";
        root.innerHTML = `<div class="ct-top"><span class="ct-turn">SHIP COMBAT</span>` +
          `<button class="ct-btn enter" data-act="enter">⚔ ENTER SHIP COMBAT</button>` +
          `<button class="ct-btn" data-act="crew">Crew</button></div>`;
        root.querySelector('[data-act="enter"]').onclick = () => cctx.enterCombat();
        root.querySelector('[data-act="crew"]').onclick = () => cctx.editCrew();
      } else { root.style.display = "none"; root.innerHTML = ""; }
      return;
    }

    // Hidden (Hide button / press C): fully gone until toggled back with C.
    if (cctx.collapsed) { root.style.display = "none"; root.innerHTML = ""; return; }
    root.style.display = "flex";

    if (cctx.isGM) {
      const crew = Object.values(combat.crew);
      const stationOpts = (cur) => `<option value="">— station —</option>` +
        S.STATIONS.filter((st) => combat.rolesEnabled[st.id]).map((st) => `<option value="${st.id}" ${st.id === cur ? "selected" : ""}>${st.num}. ${esc(st.name)}</option>`).join("");
      const roster = crew.length ? crew.map((c) => {
        const ctrlOpts = (cctx.users || []).map((u) => `<option value="${u.id}" ${u.id === c.controllerUserId ? "selected" : ""}>${esc(u.name)}${u.isGM ? " (GM)" : ""}</option>`).join("");
        return `<div class="ct-seat" data-crew="${c.id}">` +
          `<div><div class="ct-name">${esc(c.name)}</div><div class="ct-sub">owner: ${esc(c.ownerUserId ? nameOf(cctx, c.ownerUserId) : "—")}</div></div>` +
          `<select class="ct-sel" data-station title="Station">${stationOpts(c.station)}</select>` +
          `<div class="ct-toks">${token("action", c.action, true)}${token("bonus", c.bonus, true)}${grantedTokens(c.granted)}</div>` +
          `<div class="ct-ctrl"><select class="ct-sel" data-ctrl title="Controlled by">${ctrlOpts}</select>` +
          `<span class="ct-x" data-remove title="Exclude from combat">✕</span></div></div>`;
      }).join("") : `<div class="ct-empty">No crew in this fight — use “+ Add crew”.</div>`;
      const swap = combat.pendingSwap ? `<div class="ct-note">Station swap pending — awaiting confirmation…</div>` : "";
      root.innerHTML =
        `<div class="ct-top"><span class="ct-turn">SHIP'S TURN ${combat.turn}</span>` +
        `<button class="ct-btn" data-act="next">⏭ Next Turn</button>` +
        `<button class="ct-btn" data-act="add">+ Add crew</button>` +
        `<button class="ct-btn" data-act="crew">Edit crew</button>` +
        `<button class="ct-btn" data-act="roles">Stations</button>` +
        `<button class="ct-btn" data-act="resend">Re-send picker</button>` +
        collapseBtn +
        `<button class="ct-btn warn" data-act="end">✖ End Combat</button></div>` +
        `<div class="ct-seats">${roster}</div>${swap}`;
      const on = (sel, fn) => { const e = root.querySelector(sel); if (e) e.onclick = fn; };
      on('[data-act="next"]', () => cctx.nextTurn());
      on('[data-act="add"]', () => cctx.addCrew());
      on('[data-act="crew"]', () => cctx.editCrew());
      on('[data-act="roles"]', () => cctx.openRoles());
      on('[data-act="resend"]', () => cctx.broadcastPick());
      on('[data-act="collapse"]', () => cctx.toggleCollapse());
      on('[data-act="end"]', () => cctx.endCombat());
      root.querySelectorAll(".ct-seat").forEach((el) => {
        const id = el.dataset.crew;
        wireTokens(el, id, cctx);
        const stn = el.querySelector("[data-station]"); if (stn) stn.onchange = () => cctx.setStation(id, stn.value);
        const sel = el.querySelector("[data-ctrl]"); if (sel) sel.onchange = () => cctx.assignController(id, sel.value);
        const x = el.querySelector("[data-remove]"); if (x) x.onclick = () => cctx.excludeCrew(id);
      });
      return;
    }

    // Player view — only the crew this user controls.
    const mine = S.crewControlledBy(combat, cctx.userId);
    if (!mine.length) {
      root.innerHTML = `<div class="ct-top"><span class="ct-turn">SHIP'S TURN ${combat.turn}</span>` +
        `<span class="ct-sub">Waiting for the GM…</span>${collapseBtn}</div>`;
      const c = root.querySelector('[data-act="collapse"]'); if (c) c.onclick = () => cctx.toggleCollapse();
      return;
    }
    const blocks = mine.map((c) => {
      const sub = c.ownerUserId === cctx.userId ? "" : `<div class="ct-sub">covering ${esc(c.ownerUserId ? nameOf(cctx, c.ownerUserId) : c.name)}</div>`;
      const stLabel = c.station ? esc(stationName(c.station)) : "no station";
      const btn = c.station
        ? `<button class="ct-btn" data-switch title="Switch station (costs a Bonus action)">Switch</button>`
        : `<button class="ct-btn enter" data-pick title="Pick your station (free at the start)">Pick station</button>`;
      return `<div class="ct-seat mine" data-crew="${c.id}">` +
        `<div><div class="ct-name">${esc(c.name)}</div><div class="ct-sub">${stLabel}</div>${sub}</div>` +
        `<div class="ct-toks">${token("action", c.action, true)}${token("bonus", c.bonus, true)}${grantedTokens(c.granted)}</div>${btn}</div>`;
    }).join("");
    root.innerHTML = `<div class="ct-top"><span class="ct-turn">SHIP'S TURN ${combat.turn}</span>${collapseBtn}</div>` +
      `<div class="ct-seats">${blocks}</div>`;
    const cbtn = root.querySelector('[data-act="collapse"]'); if (cbtn) cbtn.onclick = () => cctx.toggleCollapse();
    root.querySelectorAll(".ct-seat").forEach((el) => {
      const id = el.dataset.crew;
      wireTokens(el, id, cctx);
      const sw = el.querySelector("[data-switch]"); if (sw) sw.onclick = () => cctx.switchStation(id);
      const pk = el.querySelector("[data-pick]"); if (pk) pk.onclick = () => cctx.pickStation(id);
    });
  };

  /* ---------------------------------------------------------------------- */
  /*  Full-screen station console (environment-agnostic)                      */
  /*                                                                          */
  /*  kctx = {                                                                */
  /*    isGM, userId, overviewCtx,           // overviewCtx → S.render(left)  */
  /*    getCombat(), station, crew, currentCrewId,                           */
  /*    stationOptions:[{crewId,station,label}], selectStation(crewId),      */
  /*    armed, setArmed(mode), allocate(facing, slot),                       */
  /*    runAction(action, isBonus), close()                                  */
  /*  }                                                                       */
  /* ---------------------------------------------------------------------- */

  // Simplified ship for inventory mode: ship + shields + a small HP bar (no system cards).
  function renderMiniShip(leftEl, kctx) {
    const ctx = kctx.overviewCtx;
    const state = S.normalize(ctx.getState());
    const shipFile = ctx.assetUrl(`assets/ship/ship-${S.shipVariant(state)}.png`);
    const hullPct = state.hull.max ? clamp(state.hull.cur / state.hull.max, 0, 1) * 100 : 0;
    const hullColor = hullPct > 50 ? "var(--teal)" : hullPct > 20 ? "var(--amber)" : "var(--red)";
    leftEl.innerHTML =
      `<div class="sgsc invship ${ctx.isGM ? "gm" : ""}">` +
        `<div class="sc-mtitle">${esc(state.name)}</div>` +
        `<div class="miniwrap"><div class="sc-shipwrap">` +
          `<img class="sc-shipimg" src="${shipFile}" alt="" onerror="this.style.display='none'">${shieldEl(ctx, state)}` +
        `</div></div>` +
        `<div class="sc-hull ${ctx.isGM ? "gm" : ""}">` +
          `<div class="row"><span>HULL</span><span class="hp">${state.hull.cur} / ${state.hull.max} HP</span></div>` +
          `<div class="bar" data-hull="1"><div class="fill" style="width:${hullPct}%;background:${hullColor};box-shadow:0 0 12px ${hullColor}"></div></div>` +
        `</div>` +
      `</div>`;
    if (!ctx.isGM) return;
    const wrap = leftEl.querySelector(".sc-shipwrap");
    if (wrap) wrap.onclick = async (ev) => {
      const side = sideFromPoint(wrap.getBoundingClientRect(), ev.clientX, ev.clientY);
      const next = S.normalize(ctx.getState());
      if (next.shield.on && next.shield.facing === side) next.shield.on = false;
      else { next.shield.on = true; next.shield.facing = side; }
      await ctx.setState(next);
    };
    const hullBar = leftEl.querySelector('[data-hull]');
    if (hullBar && ctx.promptHull) hullBar.onclick = async () => {
      const cur = S.normalize(ctx.getState());
      const v = await ctx.promptHull(cur.hull.cur, cur.hull.max);
      if (v == null || isNaN(v)) return;
      const next = S.normalize(ctx.getState());
      next.hull.cur = clamp(Number(v), 0, next.hull.max);
      await ctx.setState(next);
    };
  }

  // A single shared hover popup element (lives on <body> so it escapes the console's overflow).
  function invPopEl() {
    let p = document.getElementById("ssv-inv-pop");
    if (!p) { p = document.createElement("div"); p.id = "ssv-inv-pop"; p.className = "sgcon-invpop"; document.body.appendChild(p); }
    return p;
  }
  function hideInvPop() { const p = document.getElementById("ssv-inv-pop"); if (p) p.classList.remove("show"); }
  function showInvPop(it, tileEl) {
    const p = invPopEl();
    const meta = [it.qty > 1 ? `Qty ${it.qty}` : "", it.weight ? `${it.weight} lb` : ""].filter(Boolean).join(" · ");
    p.innerHTML =
      `<img src="${esc(it.img || DEFAULT_ITEM_IMG)}" alt="" onerror="this.style.display='none'">` +
      `<div class="ip-name">${esc(it.name)}</div><div class="ip-type">${esc(it.type || "item")}</div>` +
      (meta ? `<div class="ip-meta">${esc(meta)}</div>` : "") +
      `<div class="ip-desc">${esc(it.desc || "No description.")}</div>`;
    p.classList.add("show");
    const r = tileEl.getBoundingClientRect(), pw = 240, ph = p.offsetHeight || 180, gap = 12;
    let left = r.right + gap;
    if (left + pw > window.innerWidth - 8) left = r.left - pw - gap;       // flip to the left if off-screen
    if (left < 8) left = 8;
    let top = r.top;
    if (top + ph > window.innerHeight - 8) top = window.innerHeight - ph - 8;
    if (top < 8) top = 8;
    p.style.left = `${left}px`; p.style.top = `${top}px`;
  }

  // Searchable "add item" browser (environment-agnostic). items:[{uuid?,name,type,img,source}];
  // opts: { onAdd(item), onNew(), onClose() }. Stays open for multiple adds.
  function closeItemBrowser() { const o = document.getElementById("ssv-item-browser"); if (o) o.remove(); }
  function openItemBrowser(items, opts) {
    closeItemBrowser();
    const ov = document.createElement("div");
    ov.id = "ssv-item-browser"; ov.className = "sgib-overlay";
    ov.innerHTML =
      `<div class="sgib" role="dialog">` +
        `<div class="sgib-head"><span class="sgib-title">ADD ITEM TO SHIP</span>` +
          `<div class="sgib-search"><span>🔎</span><input type="text" placeholder="Search all items…" data-s></div>` +
          `<button class="sgib-x" title="Close">✕</button></div>` +
        `<div class="sgib-count" data-count></div>` +
        `<div class="sgib-body" data-body></div>` +
        `<div class="sgib-foot"><button class="con-inv" data-new>＋ New blank loot</button>` +
          `<span class="sgib-hint">Click an item to add it · drag items onto the grid also works</span>` +
          `<button class="con-inv" data-done>Done</button></div>` +
      `</div>`;
    document.body.appendChild(ov);
    const body = ov.querySelector("[data-body]"), countEl = ov.querySelector("[data-count]"), input = ov.querySelector("[data-s]");
    const CAP = 200;
    let shown = [];
    const flash = (card) => {
      card.classList.add("added");
      const n = card.querySelector(".sgib-name"); const old = n ? n.textContent : "";
      if (n) n.textContent = "✓ Added";
      setTimeout(() => { card.classList.remove("added"); if (n) n.textContent = old; }, 900);
    };
    const draw = (q) => {
      q = (q || "").trim().toLowerCase();
      const matches = q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items;
      shown = matches.slice(0, CAP);
      countEl.textContent = `${matches.length} item${matches.length === 1 ? "" : "s"}` + (matches.length > CAP ? ` — showing first ${CAP}, refine your search` : "");
      body.innerHTML = shown.length
        ? shown.map((it, i) => `<div class="sgib-card" data-i="${i}"><img src="${esc(it.img || DEFAULT_ITEM_IMG)}" alt="" onerror="this.src='${DEFAULT_ITEM_IMG}'">` +
            `<div class="sgib-meta"><div class="sgib-name">${esc(it.name)}</div><div class="sgib-sub">${esc(it.type || "item")}${it.source ? ` · ${esc(it.source)}` : ""}</div></div></div>`).join("")
        : `<div class="sgib-empty">No items match “${esc(q)}”.</div>`;
      body.querySelectorAll(".sgib-card").forEach((c) => { c.onclick = () => { const it = shown[Number(c.dataset.i)]; if (it && opts.onAdd) { opts.onAdd(it); flash(c); } }; });
    };
    const done = () => { closeItemBrowser(); opts.onClose && opts.onClose(); };
    input.oninput = () => draw(input.value);
    ov.querySelector(".sgib-x").onclick = done;
    ov.querySelector("[data-done]").onclick = done;
    ov.querySelector("[data-new]").onclick = () => opts.onNew && opts.onNew();
    ov.onclick = (e) => { if (e.target === ov) done(); };
    draw("");
    setTimeout(() => input.focus(), 30);
  }
  S.openItemBrowser = openItemBrowser;
  S.closeItemBrowser = closeItemBrowser;

  // Ship inventory panel (right column, when kctx.invMode) — game-style grid with item pictures,
  // search, ship/you tabs, hover detail popup, per-tile move/use, GM add-item + drag-drop.
  function renderInventoryPanel(rightEl, kctx) {
    const st = kctx.getState();
    const t = st.tuning;
    const ratio = t.convertFuel > 0 ? Math.round(t.convertPower / t.convertFuel) : 5;   // power per 1 fuel
    const ship = kctx.shipItems || [], mine = kctx.playerItems || [];
    const tab = kctx.invTab === "you" ? "you" : "ship";
    const gauge = (label, g, cls, ico) => {
      const pct = g.max > 0 ? Math.max(0, Math.min(1, g.cur / g.max)) * 100 : 0;
      const low = pct <= 20;
      return `<div class="ig ${cls}${low ? " low" : ""}${kctx.isGM ? " gm" : ""}" ${kctx.isGM ? `data-edit="${cls}"` : ""} title="${kctx.isGM ? "Click to set" : ""}">` +
        `<div class="ig-top"><span class="ig-ico">${ico}</span><span class="ig-label">${label}</span>` +
        `<span class="ig-val">${g.cur}<small> / ${g.max}</small></span></div>` +
        `<div class="ig-track"><div class="ig-fill" style="width:${pct}%"></div></div></div>`;
    };
    const tile = (it, isShip) => {
      // Top corners: GM delete (TL) + edit (TR), ship items only.
      const corners = (isShip && kctx.isGM)
        ? `<button class="it-ib it-tl danger" data-del title="Delete from ship">🗑</button>` +
          `<button class="it-ib it-tr" data-qty title="Edit item">✏</button>`
        : "";
      // Bottom-left: resource-use icon, only for a fuel/power item. Bottom-right: move.
      const resIco = it.resKind === "fuel" ? "⛽" : it.resKind === "power" ? "⚡" : "";
      const resBtn = (isShip && it.resKind)
        ? `<button class="it-ib" data-res title="Use as ${it.resKind} (+${it.resAmount} ${it.resKind})">${resIco}</button>`
        : "";
      const moveBtn = isShip
        ? `<button class="it-ib" data-move title="Move to your inventory">→</button>`
        : `<button class="it-ib" data-move title="Move to the ship">→</button>`;
      return `<div class="inv-tile" data-id="${it.id}" data-name="${esc(it.name)}">` +
        corners +
        `<div class="it-imgwrap"><img src="${esc(it.img || DEFAULT_ITEM_IMG)}" alt="" onerror="this.src='${DEFAULT_ITEM_IMG}'">` +
          (it.qty > 1 ? `<span class="it-qty">×${it.qty}</span>` : "") + `</div>` +
        `<span class="it-name">${esc(it.name)}</span>` +
        `<div class="it-bottom"><span class="it-bl">${resBtn}</span><span class="it-br">${moveBtn}</span></div>` +
      `</div>`;
    };
    const list = tab === "ship" ? ship : mine;
    const gridInner = (tab === "you" && !kctx.hasPlayerActor)
      ? `<div class="inv-empty">No character is assigned to you.</div>`
      : (list.length ? list.map((it) => tile(it, tab === "ship")).join("") : `<div class="inv-empty">— empty —</div>`);
    const gmBtns = kctx.isGM
      ? `<button class="con-inv" data-act="additem" title="Add any item to the ship">＋ Add item</button>` +
        `<button class="con-inv" data-act="tune" title="Set fuel/power amounts">Tune</button>` +
        `<button class="con-inv" data-act="actor" title="Pick the ship actor">Ship actor</button>`
      : "";
    rightEl.innerHTML =
      `<div class="inv-wrap">` +
        `<div class="con-head"><span class="con-title">SHIP INVENTORY</span>` +
          `<button class="con-inv" data-act="stations" title="Back to stations">⚔ Stations</button>` +
          `<button class="con-x" title="Close (Esc)">✕</button></div>` +
        `<div class="inv-gauges">${gauge("FUEL", st.fuel, "fuel", "⛽")}${gauge("POWER", st.power, "power", "⚡")}` +
          `<div class="inv-convert"><button class="con-btn" data-convert="1">Convert ⛽1 → ${ratio}⚡</button>` +
          `<button class="con-btn" data-convert="10">Convert ⛽10 → ${ratio * 10}⚡</button></div></div>` +
        `<div class="inv-top">` +
          `<div class="inv-tabs"><button class="inv-tab${tab === "ship" ? " active" : ""}" data-tab="ship">SHIP CARGO</button>` +
          `<button class="inv-tab${tab === "you" ? " active" : ""}" data-tab="you">YOUR ITEMS</button></div>` +
          `<div class="inv-search"><span>🔎</span><input type="text" placeholder="Search inventory…" data-search="1"></div>${gmBtns}</div>` +
        `<div class="inv-grid${tab === "ship" ? " drop-ok" : ""}" data-tab="${tab}">${gridInner}</div>` +
      `</div>`;

    rightEl.querySelector(".con-x").onclick = () => { hideInvPop(); kctx.close(); };
    rightEl.querySelector('[data-act="stations"]').onclick = () => { hideInvPop(); kctx.toggleInv(); };
    rightEl.querySelectorAll("[data-convert]").forEach((b) => { b.onclick = () => kctx.convert(Number(b.dataset.convert)); });
    const tuneB = rightEl.querySelector('[data-act="tune"]'); if (tuneB) tuneB.onclick = () => kctx.tune();
    const actorB = rightEl.querySelector('[data-act="actor"]'); if (actorB) actorB.onclick = () => kctx.setActor();
    const addB = rightEl.querySelector('[data-act="additem"]'); if (addB) addB.onclick = () => kctx.addItem();
    if (kctx.isGM) rightEl.querySelectorAll(".ig.gm").forEach((g) => { g.onclick = () => (g.dataset.edit === "fuel" ? kctx.editFuel() : kctx.editPower()); });
    rightEl.querySelectorAll(".inv-tab").forEach((b) => { b.onclick = () => { hideInvPop(); kctx.setInvTab(b.dataset.tab); }; });

    // Search: filter tiles in-place (no re-render → keeps input focus).
    const search = rightEl.querySelector("[data-search]");
    const grid = rightEl.querySelector(".inv-grid");
    if (search && grid) search.oninput = () => {
      const q = search.value.trim().toLowerCase();
      grid.querySelectorAll(".inv-tile").forEach((tl) => {
        tl.style.display = (!q || (tl.dataset.name || "").toLowerCase().includes(q)) ? "" : "none";
      });
    };

    // Tiles: hover popup + per-tile actions.
    const byId = Object.fromEntries(list.map((it) => [it.id, it]));
    const fromShip = tab === "ship";
    rightEl.querySelectorAll(".inv-tile").forEach((tl) => {
      const id = tl.dataset.id, it = byId[id];
      tl.onmouseenter = () => it && showInvPop(it, tl);
      tl.onmouseleave = hideInvPop;
      const mv = tl.querySelector("[data-move]"); if (mv) mv.onclick = (e) => { e.stopPropagation(); hideInvPop(); kctx.moveItem(fromShip, id); };
      const res = tl.querySelector("[data-res]"); if (res) res.onclick = (e) => { e.stopPropagation(); hideInvPop(); kctx.useResource(id); };
      const qtyB = tl.querySelector("[data-qty]"); if (qtyB) qtyB.onclick = (e) => { e.stopPropagation(); hideInvPop(); kctx.editItem(id); };
      const delB = tl.querySelector("[data-del]"); if (delB) delB.onclick = (e) => { e.stopPropagation(); hideInvPop(); kctx.deleteItem(id); };
    });

    // GM drag-drop: drop any Foundry Item onto the SHIP grid to add it.
    if (kctx.isGM && fromShip && grid && kctx.dropItemData) {
      grid.ondragover = (e) => { e.preventDefault(); grid.classList.add("inv-drop"); };
      grid.ondragleave = () => grid.classList.remove("inv-drop");
      grid.ondrop = (e) => {
        e.preventDefault(); grid.classList.remove("inv-drop");
        const raw = e.dataTransfer?.getData("text/plain"); if (raw) kctx.dropItemData(raw);
      };
    }
  }

  // GM Actions panel: a list of direct, GM-only controls (no crew action economy). Extensible.
  function renderGMPanel(rightEl, kctx) {
    const st = kctx.getState();
    const mainOn = st.shield.on, curMain = st.shield.facing, curSec = st.shield.secondary;
    const lbl = (f) => esc(S.FACING_LABEL[f].toUpperCase());
    const mainBtns = S.FACINGS.map((f) => `<button class="con-btn${mainOn && f === curMain ? " armed" : ""}" data-main="${f}">${esc(S.FACING_LABEL[f])}</button>`).join("") +
      `<button class="con-btn${!mainOn ? " armed" : ""}" data-main="off">Shields Off</button>`;
    const secBtns = S.FACINGS.map((f) => `<button class="con-btn${f === curSec ? " armed" : ""}" data-sec="${f}">${esc(S.FACING_LABEL[f])}</button>`).join("") +
      `<button class="con-btn${!curSec ? " armed" : ""}" data-sec="off">Clear</button>`;
    rightEl.innerHTML =
      `<div class="con-head"><span class="con-title">GM ACTIONS</span><button class="con-inv" data-act="stations" title="Back to stations">⚔ Stations</button><button class="con-x" title="Close (Esc)">✕</button></div>` +
      `<div class="con-sec"><div class="con-h">MAIN SHIELD · ${mainOn ? lbl(curMain) : "OFF"}</div><div class="con-btns">${mainBtns}</div></div>` +
      `<div class="con-sec"><div class="con-h">SECONDARY SHIELD · ${curSec ? lbl(curSec) : "NONE"}</div><div class="con-btns">${secBtns}</div></div>` +
      `<div class="con-hint">GM controls change the ship directly and announce in chat — no action cost.</div>`;
    rightEl.querySelector(".con-x").onclick = () => kctx.close();
    rightEl.querySelector('[data-act="stations"]').onclick = () => kctx.toggleGM();
    rightEl.querySelectorAll("[data-main]").forEach((b) => { b.onclick = () => kctx.gmMainShield(b.dataset.main); });
    rightEl.querySelectorAll("[data-sec]").forEach((b) => { b.onclick = () => kctx.gmSecondaryShield(b.dataset.sec); });
  }

  S.renderConsole = function (root, kctx) {
    S.ensureStyles();
    root.className = "sgcon" + (kctx.invMode ? " inv-mode" : "") + (kctx.animateSwap ? " do-swap" : "");
    root.innerHTML = `<div class="con-left"></div><div class="con-right"></div>`;
    const leftEl = root.querySelector(".con-left");
    const rightEl = root.querySelector(".con-right");

    // Left column: inventory mode → a slimmed ship (no system cards); otherwise the full overview.
    const leftInner = document.createElement("div");
    leftEl.appendChild(leftInner);
    if (kctx.invMode) {
      renderMiniShip(leftInner, kctx);
    } else {
      S.render(leftInner, kctx.overviewCtx);
      // Shield-allocation circles overlaid on the ship when armed.
      if (kctx.armed) {
        const wrap = leftInner.querySelector(".sc-shipwrap");
        if (wrap) for (const f of S.FACINGS) {
          const c = document.createElement("div");
          c.className = `con-circle pos-${f}${kctx.armed === "secondary" ? " secondary" : ""}`;
          c.title = `Allocate to ${S.FACING_LABEL[f]}`;
          c.onclick = () => kctx.allocate(f, kctx.armed);
          wrap.appendChild(c);
        }
      }
    }

    // Right column: GM Actions / inventory modes override the station panel.
    if (kctx.gmActMode && kctx.isGM) { renderGMPanel(rightEl, kctx); return; }
    if (kctx.invMode) { renderInventoryPanel(rightEl, kctx); return; }

    // Right column = station action panel.
    const stId = kctx.station, crew = kctx.crew;
    const acts = stId ? S.stationActions(stId) : { main: [], bonus: [] };
    const stName = stId ? (S.station(stId)?.name || stId) : "STATION";
    const picker = (kctx.isGM && kctx.stationOptions?.length)
      ? `<select class="con-sel" title="Drive which station">${kctx.stationOptions.map((o) => `<option value="${o.crewId}" ${o.crewId === kctx.currentCrewId ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`
      : "";

    if (!stId || !crew) {
      rightEl.innerHTML = `<div class="con-head"><span class="con-title">STATION</span>${picker}${kctx.isGM ? `<button class="con-inv" data-gm="1" title="GM actions">⚙ GM</button>` : ""}<button class="con-inv" data-inv="1" title="Ship inventory">📦 Inventory</button><button class="con-x" title="Close (Esc)">✕</button></div>` +
        `<div class="con-empty">${kctx.isGM ? "No station selected — pick a manned station to drive it." : "You're not manning a station yet. Join combat and pick a station to see its controls here."}</div>`;
      rightEl.querySelector(".con-x").onclick = () => kctx.close();
      const inv0 = rightEl.querySelector("[data-inv]"); if (inv0) inv0.onclick = () => kctx.toggleInv();
      const gm0 = rightEl.querySelector("[data-gm]"); if (gm0) gm0.onclick = () => kctx.toggleGM();
      const sel = rightEl.querySelector(".con-sel"); if (sel) sel.onchange = () => kctx.selectStation(sel.value);
      return;
    }

    const btn = (a, isBonus) => {
      const used = isBonus ? crew.bonus : crew.action;
      const disabled = used && !(crew.granted > 0);   // still usable if a granted ⭐ is available
      const star = used && crew.granted > 0 ? " ⭐" : "";
      const armedThis = (a.type === "shield-allocate" && kctx.armed === "main") || (a.type === "shield-micro" && kctx.armed === "secondary");
      return `<div class="con-act">` +
        `<div class="con-btnrow">` +
          `<button class="con-btn${disabled ? " used" : ""}${armedThis ? " armed" : ""}" data-act="${a.id}" ${disabled ? "disabled" : ""} title="${esc(a.text)}">${esc(a.name)}${armedThis ? " · pick a side" : star}</button>` +
          `<span class="con-i" data-info="${a.id}" title="What does this do?" role="button">i</span>` +
        `</div>` +
        `<div class="con-desc" data-desc="${a.id}" hidden>${esc(a.text)}</div>` +
      `</div>`;
    };
    rightEl.innerHTML =
      `<div class="con-head"><span class="con-title">${esc(stName)}</span>${picker}${kctx.isGM ? `<button class="con-inv" data-gm="1" title="GM actions">⚙ GM</button>` : ""}<button class="con-inv" data-inv="1" title="Ship inventory">📦 Inventory</button><button class="con-x" title="Close (Esc)">✕</button></div>` +
      `<div class="con-crew"><span class="con-cname">${esc(crew.name)}</span>` +
      `<span class="con-toks">${token("action", crew.action, false)}${token("bonus", crew.bonus, false)}${grantedTokens(crew.granted)}</span></div>` +
      `<div class="con-sec"><div class="con-h">MAIN ACTION${crew.action ? " · used" : ""}</div><div class="con-btns">${acts.main.map((a) => btn(a, false)).join("") || `<span class="con-empty">— none —</span>`}</div></div>` +
      `<div class="con-sec"><div class="con-h">BONUS ACTION${crew.bonus ? " · used" : ""}</div><div class="con-btns">${acts.bonus.map((a) => btn(a, true)).join("") || `<span class="con-empty">— none —</span>`}</div></div>` +
      (kctx.armed ? `<div class="con-hint">Click a ${kctx.armed === "main" ? "red" : "green"} circle on the ship to allocate — or click the button again to cancel.</div>` : "");

    rightEl.querySelector(".con-x").onclick = () => kctx.close();
    const invBtn = rightEl.querySelector("[data-inv]"); if (invBtn) invBtn.onclick = () => kctx.toggleInv();
    const gmBtn = rightEl.querySelector("[data-gm]"); if (gmBtn) gmBtn.onclick = () => kctx.toggleGM();
    const sel = rightEl.querySelector(".con-sel"); if (sel) sel.onchange = () => kctx.selectStation(sel.value);
    const wire = (a, isBonus) => {
      const el = rightEl.querySelector(`[data-act="${a.id}"]`); if (!el || el.disabled) return;
      el.onclick = () => {
        if (a.type === "shield-allocate") kctx.setArmed(kctx.armed === "main" ? null : "main");
        else if (a.type === "shield-micro") kctx.setArmed(kctx.armed === "secondary" ? null : "secondary");
        else kctx.runAction(a, isBonus);
      };
    };
    acts.main.forEach((a) => wire(a, false));
    acts.bonus.forEach((a) => wire(a, true));
    // Info circles toggle their inline explanation (works even for used/disabled actions).
    rightEl.querySelectorAll(".con-i[data-info]").forEach((ic) => {
      ic.onclick = () => {
        const desc = rightEl.querySelector(`.con-desc[data-desc="${ic.dataset.info}"]`);
        if (!desc) return;
        const show = desc.hasAttribute("hidden");
        if (show) desc.removeAttribute("hidden"); else desc.setAttribute("hidden", "");
        ic.classList.toggle("open", show);
      };
    });
  };

  // Expose for the preview harness and external callers.
  (typeof globalThis !== "undefined" ? globalThis : window).SSVShipHUD = S;

  /* ====================================================================== */
  /*  Foundry wiring (skipped in the browser preview)                       */
  /* ====================================================================== */

  if (typeof Hooks === "undefined") return;

  const SETTING_DATA = "shipState";
  const assetUrl = (p) => (/^https?:/i.test(p) ? p : `modules/${MODULE_ID}/${p}`);

  function getState() {
    const stored = game.settings.get(MODULE_ID, SETTING_DATA);
    return S.normalize(stored && Object.keys(stored).length ? stored : S.defaultState());
  }

  async function setState(state) {
    if (!game.user.isGM) return ui.notifications?.warn("Only the GM can change ship status.");
    await game.settings.set(MODULE_ID, SETTING_DATA, state);
    refreshOpen();
    Hooks.callAll(`${MODULE_ID}.updated`, state);
  }

  async function promptHull(cur, max) {
    const content = `<div style="display:flex;flex-direction:column;gap:6px;">
      <label>Hull HP (0–${max})<input type="number" name="hp" value="${cur}" min="0" max="${max}"/></label></div>`;
    const read = (form) => Number(form.elements.hp.value);
    const D2 = foundry.applications?.api?.DialogV2;
    if (D2) return D2.prompt({
      window: { title: "Set Hull HP" }, content,
      ok: { label: "Set", callback: (ev, button) => read(button.form) }
    }).catch(() => null);
    return new Promise((resolve) => {
      new Dialog({
        title: "Set Hull HP", content,
        buttons: { ok: { label: "Set", callback: (html) => resolve(read(html[0].querySelector("form") || html[0])) },
                   cancel: { label: "Cancel", callback: () => resolve(null) } },
        default: "ok"
      }).render(true);
    });
  }

  const ctx = () => ({ isGM: game.user.isGM, getState, setState, assetUrl, promptHull });

  /* -- Full-screen station console (frameless overlay) ------------------- */

  let _console = null;
  let armed = null;            // transient shield-allocation mode: 'main' | 'secondary' | null
  let gmDriveCrewId = null;    // which crew the GM is driving in the console
  let invMode = false;         // console showing the inventory panel instead of the station panel
  let gmActMode = false;       // console showing the GM Actions panel (GM-only, direct state control)
  let invTab = "ship";         // inventory active tab: 'ship' | 'you'
  let swapAnim = false;        // one-shot: play the mode-swap animation on the next render

  const consoleOpen = () => _console && _console.style.display !== "none" && document.body.contains(_console);
  function renderConsole() {
    if (!_console) { _console = document.createElement("div"); _console.id = "ssv-ship-console"; document.body.appendChild(_console); }
    _console.style.display = "flex";   // must be flex (the .sgcon layout); inline style wins over the class
    try { S.renderConsole(_console, consoleCtx()); } catch (e) { console.error(`${MODULE_ID} | console render failed`, e); }
    renderBar();                       // hide the top tracker bar while the console is open
  }
  function closeConsole() { armed = null; invMode = false; gmActMode = false; hideInvPop(); closeItemBrowser(); if (_console) _console.style.display = "none"; renderBar(); }
  function openShipHUD() { if (consoleOpen()) closeConsole(); else renderConsole(); }
  function refreshOpen() { if (consoleOpen()) renderConsole(); }

  function drivenCrew() {
    const combat = getCombat();
    if (game.user.isGM) {
      const stationed = Object.values(combat.crew).filter((c) => c.station);
      return stationed.find((x) => x.id === gmDriveCrewId) || stationed[0] || null;
    }
    return S.crewControlledBy(combat, game.user.id).filter((c) => c.station)[0] || null;
  }
  function consoleCtx() {
    const combat = getCombat();
    const crew = drivenCrew();
    const stName = crew?.station ? (S.station(crew.station)?.name || crew.station) : "";
    return {
      isGM: game.user.isGM, userId: game.user.id,
      overviewCtx: ctx(),
      getCombat,
      station: crew?.station || null, crew, currentCrewId: crew?.id || null,
      stationOptions: game.user.isGM
        ? Object.values(combat.crew).filter((c) => c.station).map((c) => ({ crewId: c.id, station: c.station, label: `${c.name} — ${S.station(c.station)?.name || c.station}` }))
        : [],
      selectStation: (cid) => { gmDriveCrewId = cid; armed = null; renderConsole(); },
      get armed() { return armed; },
      setArmed: (m) => { armed = m; renderConsole(); },
      allocate: (facing, slot) => {
        armed = null;
        if (!crew) return;
        if (game.user.isGM) gmAllocateShield(crew.id, facing, slot, null);
        else emit({ type: "allocateShield", toGM: true, crewId: crew.id, facing, slot, userId: game.user.id });
        renderConsole();
      },
      runAction: (a, isBonus) => runStationAction(a, isBonus, crew, stName),
      // GM Actions panel (GM-only, direct control + chat, no action economy)
      gmActMode, toggleGM: () => { gmActMode = !gmActMode; invMode = false; armed = null; swapAnim = true; renderConsole(); },
      gmMainShield: (f) => gmSetMainShieldDirect(f),
      gmSecondaryShield: (f) => gmSetSecondaryDirect(f),
      // Inventory
      invMode, toggleInv: () => { invMode = !invMode; gmActMode = false; armed = null; swapAnim = true; renderConsole(); },
      invTab, setInvTab: (tb) => { invTab = (tb === "you" ? "you" : "ship"); renderConsole(); },
      animateSwap: (() => { const a = swapAnim; swapAnim = false; return a; })(),
      addItem: () => gmAddItemBrowser(),
      dropItemData: (raw) => gmAddDroppedItem(raw),
      deleteItem: (id) => gmDeleteItem(id),
      getState,
      shipItems: physicalItems(getShipActor()),
      playerItems: physicalItems(game.user.character),
      hasPlayerActor: !!game.user.character,
      moveItem: async (fromShip, itemId) => {
        const src = fromShip ? getShipActor() : game.user.character;
        const item = src?.items?.get(itemId); if (!item) return;
        const max = item.system?.quantity ?? 1;
        let qty = 1;
        if (max > 1) { qty = await promptNumber(`Move ${item.name}`, `How many? (max ${max})`, max, max); if (qty == null) return; }
        if (game.user.isGM) gmMoveItem(fromShip, itemId, qty, null);
        else emit({ type: "moveItem", toGM: true, fromShip, itemId, qty, userId: game.user.id });
      },
      useResource: (itemId) => { if (game.user.isGM) gmUseResource(itemId, null); else emit({ type: "useResource", toGM: true, itemId, userId: game.user.id }); },
      convert: (fuelAmt) => { if (game.user.isGM) gmConvert(null, fuelAmt); else emit({ type: "convert", toGM: true, fuelAmt, userId: game.user.id }); },
      editFuel: () => gmEditGauge("fuel"),
      editPower: () => gmEditGauge("power"),
      editItem: (id) => gmEditItemDialog(id),
      tune: gmTuneDialog,
      setActor: gmSetActorDialog,
      close: () => closeConsole()
    };
  }

  /* -- Ship inventory: actor lookup, GM handlers ------------------------- */

  const PHYSICAL_TYPES = new Set(["weapon", "equipment", "consumable", "tool", "loot", "container", "backpack"]);
  function getShipActor() {
    const st = getState();
    return (st.actorId && game.actors.get(st.actorId)) || game.actors.getName(st.name) || null;
  }
  function physicalItems(actor) {
    if (!actor?.items) return [];
    return actor.items.filter((i) => PHYSICAL_TYPES.has(i.type)).map((i) => {
      const w = i.system?.weight;
      const weight = (w && typeof w === "object") ? (w.value ?? 0) : (w ?? 0);
      const fl = i.flags?.[MODULE_ID] || {};
      const resKind = (fl.resKind === "fuel" || fl.resKind === "power") ? fl.resKind : null;
      return { id: i.id, name: i.name, qty: i.system?.quantity ?? 1, img: i.img || DEFAULT_ITEM_IMG,
        type: i.type, weight, desc: stripHtml(i.system?.description?.value),
        resKind, resAmount: Number(fl.resAmount) || 0 };
    });
  }
  async function promptNumber(title, label, value, max) {
    const content = `<div style="display:flex;flex-direction:column;gap:6px;"><label>${esc(label)}<input type="number" name="v" value="${value}" min="1"${max != null ? ` max="${max}"` : ""}/></label></div>`;
    const read = (form) => { const n = Number(form.elements.v.value); return Number.isFinite(n) ? n : null; };
    const d = D2();
    if (d) return d.prompt({ window: { title }, content, ok: { label: "OK", callback: (e, b) => read(b.form) } }).catch(() => null);
    return new Promise((res) => new Dialog({ title, content, buttons: { ok: { label: "OK", callback: (h) => res(read(h[0].querySelector("form") || h[0])) }, cancel: { label: "Cancel", callback: () => res(null) } }, default: "ok" }).render(true));
  }

  async function gmMoveItem(fromShip, itemId, qty, byUserId) {
    if (!game.user.isGM) return;
    const pc = (byUserId && game.users.get(byUserId)?.character) || game.user.character;
    const ship = getShipActor();
    if (!ship) return notifyUser(byUserId || game.user.id, "No ship actor configured (GM: Inventory → Ship actor).");
    if (!pc) return notifyUser(byUserId || game.user.id, "No character assigned to that player.");
    const src = fromShip ? ship : pc, dst = fromShip ? pc : ship;
    const item = src.items.get(itemId); if (!item) return;
    const have = item.system?.quantity ?? 1;
    const move = Math.max(1, Math.min(Number(qty) || 1, have));
    const twin = dst.items.find((i) => i.name === item.name && i.type === item.type);
    if (twin) await twin.update({ "system.quantity": (twin.system?.quantity ?? 1) + move });
    else { const data = item.toObject(); if (data.system) data.system.quantity = move; delete data._id; await dst.createEmbeddedDocuments("Item", [data]); }
    if (have - move > 0) await item.update({ "system.quantity": have - move });
    else await item.delete();
    refreshOpen();
  }
  // GM: edit an item's quantity AND its resource role (none/fuel/power) + amount-per-use (stored on the item).
  async function gmEditItemDialog(itemId) {
    if (!game.user.isGM) return;
    const ship = getShipActor(); const item = ship?.items?.get(itemId); if (!item) return;
    const qty = item.system?.quantity ?? 1;
    const fl = item.flags?.[MODULE_ID] || {};
    const kind = (fl.resKind === "fuel" || fl.resKind === "power") ? fl.resKind : "none";
    const amt = Number(fl.resAmount) || 25;
    const content = `<div style="display:flex;flex-direction:column;gap:10px;min-width:300px;">` +
      `<label style="display:flex;justify-content:space-between;align-items:center;gap:10px;">Quantity <input type="number" name="qty" value="${qty}" min="0" style="width:100px"></label>` +
      `<label style="display:flex;justify-content:space-between;align-items:center;gap:10px;">Resource type ` +
        `<select name="kind" style="width:120px"><option value="none"${kind === "none" ? " selected" : ""}>None</option>` +
        `<option value="fuel"${kind === "fuel" ? " selected" : ""}>Fuel ⛽</option>` +
        `<option value="power"${kind === "power" ? " selected" : ""}>Power ⚡</option></select></label>` +
      `<label style="display:flex;justify-content:space-between;align-items:center;gap:10px;">Amount per use <input type="number" name="amt" value="${amt}" min="0" style="width:100px"></label>` +
      `<p style="opacity:.7;font-size:12px;margin:0">Fuel/power items show a ⛽ / ⚡ button; using one spends 1 and adds “amount per use” to that gauge. Quantity 0 deletes the item.</p></div>`;
    const read = (form) => ({ qty: Number(form.elements.qty.value), kind: form.elements.kind.value, amt: Number(form.elements.amt.value) });
    const D = D2();
    let v = null;
    if (D) v = await D.prompt({ window: { title: `Edit — ${item.name}` }, content, ok: { label: "Save", callback: (e, b) => read(b.form) } }).catch(() => null);
    else v = await new Promise((res) => new Dialog({ title: `Edit — ${item.name}`, content, buttons: { ok: { label: "Save", callback: (h) => res(read(h[0].querySelector("form") || h[0])) }, cancel: { label: "Cancel", callback: () => res(null) } }, default: "ok" }).render(true));
    if (!v) return;
    if (Number.isFinite(v.qty) && v.qty <= 0) { await item.delete(); refreshOpen(); return; }
    if (Number.isFinite(v.qty)) await item.update({ "system.quantity": Math.max(1, Math.floor(v.qty)) });
    if (v.kind === "fuel" || v.kind === "power") await item.update({ [`flags.${MODULE_ID}.resKind`]: v.kind, [`flags.${MODULE_ID}.resAmount`]: Math.max(0, Math.floor(v.amt) || 0) });
    else await item.update({ [`flags.${MODULE_ID}.-=resKind`]: null, [`flags.${MODULE_ID}.-=resAmount`]: null });
    refreshOpen();
  }
  async function gmDeleteItem(itemId) {
    if (!game.user.isGM) return;
    const ship = getShipActor(); const item = ship?.items?.get(itemId); if (!item) return;
    const ok = await confirmDlg("Delete item", `Delete <b>${esc(item.name)}</b> from the ship?`);
    if (!ok) return;
    await item.delete();
    refreshOpen();
  }
  // Use a fuel/power item — the kind and amount come from the item itself (set via Edit).
  async function gmUseResource(itemId, byUserId) {
    if (!game.user.isGM) return;
    const ship = getShipActor(); const item = ship?.items?.get(itemId); if (!item) return;
    const fl = item.flags?.[MODULE_ID] || {};
    const kind = fl.resKind; const add = Number(fl.resAmount) || 0;
    if (kind !== "fuel" && kind !== "power") return notifyUser(byUserId || game.user.id, "That item isn't a fuel or power source.");
    const st = getState();
    const have = item.system?.quantity ?? 1;
    if (have - 1 > 0) await item.update({ "system.quantity": have - 1 }); else await item.delete();
    st[kind].cur = Math.min(st[kind].max, st[kind].cur + add);
    await setState(st);
    await ChatMessage.create({ content: `Used <b>${esc(item.name)}</b> → +${add} ${kind}`, speaker: { alias: "SSV Silver Gull" } });
  }
  // GM: add any item to the ship — a searchable browser over ALL world items + every Item compendium.
  async function gmAddItemBrowser() {
    if (!game.user.isGM) return;
    const ship = getShipActor();
    if (!ship) return ui.notifications?.warn("No ship actor configured — use the “Ship actor” button first.");
    const items = [];
    for (const it of (game.items?.contents || [])) if (PHYSICAL_TYPES.has(it.type)) items.push({ uuid: it.uuid, name: it.name, type: it.type, img: it.img, source: "World" });
    const packs = (game.packs || []).filter((p) => p.documentName === "Item");
    ui.notifications?.info(`Loading ${packs.length} item compendium(s)…`);
    await Promise.all(packs.map(async (p) => {
      let idx; try { idx = await p.getIndex({ fields: ["img", "type"] }); } catch (e) { return; }
      const label = p.metadata?.label || p.collection;
      for (const e of idx) {
        if (!PHYSICAL_TYPES.has(e.type)) continue;
        items.push({ uuid: e.uuid || `Compendium.${p.collection}.${e._id}`, name: e.name, type: e.type, img: e.img, source: label });
      }
    }));
    items.sort((a, b) => a.name.localeCompare(b.name));
    const addOne = async (it) => {
      try {
        const src = await fromUuid(it.uuid); if (!src) return;
        const data = src.toObject(); delete data._id;
        await ship.createEmbeddedDocuments("Item", [data]);
        refreshOpen();
      } catch (e) { console.error(`${MODULE_ID} | add item failed`, e); }
    };
    const addNew = async () => {
      const name = await promptText("New item", "Item name", "New Cargo");
      if (!name) return;
      await ship.createEmbeddedDocuments("Item", [{ name, type: "loot", img: DEFAULT_ITEM_IMG, system: { quantity: 1 } }]);
      refreshOpen();
    };
    openItemBrowser(items, { onAdd: addOne, onNew: addNew, onClose: () => {} });
  }
  async function gmAddDroppedItem(raw) {
    if (!game.user.isGM) return;
    const ship = getShipActor(); if (!ship) return ui.notifications?.warn("No ship actor configured.");
    let data; try { data = JSON.parse(raw); } catch (e) { return; }
    if (data?.type !== "Item") return;
    const src = data.uuid ? await fromUuid(data.uuid) : null;
    if (!src) return;
    const obj = src.toObject(); delete obj._id;
    await ship.createEmbeddedDocuments("Item", [obj]);
    await ChatMessage.create({ content: `GM added <b>${esc(src.name)}</b> to the ship.`, speaker: { alias: "SSV Silver Gull" } });
    refreshOpen();
  }
  async function promptText(title, label, value) {
    const content = `<div style="display:flex;flex-direction:column;gap:6px;"><label>${esc(label)}<input type="text" name="v" value="${esc(value || "")}"/></label></div>`;
    const read = (form) => { const s = String(form.elements.v.value || "").trim(); return s || null; };
    const d = D2();
    if (d) return d.prompt({ window: { title }, content, ok: { label: "OK", callback: (e, b) => read(b.form) } }).catch(() => null);
    return new Promise((res) => new Dialog({ title, content, buttons: { ok: { label: "OK", callback: (h) => res(read(h[0].querySelector("form") || h[0])) }, cancel: { label: "Cancel", callback: () => res(null) } }, default: "ok" }).render(true));
  }
  async function gmConvert(byUserId, fuelAmt) {
    if (!game.user.isGM) return;
    const st = getState(); const t = st.tuning;
    const ratio = t.convertFuel > 0 ? (t.convertPower / t.convertFuel) : 5;
    const spend = Math.max(1, Math.floor(Number(fuelAmt) || t.convertFuel));   // default to the big batch
    const gain = Math.round(spend * ratio);
    if (st.fuel.cur < spend) return notifyUser(byUserId || game.user.id, `Not enough fuel to convert (need ${spend}).`);
    st.fuel.cur -= spend;
    st.power.cur = Math.min(st.power.max, st.power.cur + gain);
    await setState(st);
    await ChatMessage.create({ content: `Converted <b>${spend}</b> fuel → <b>${gain}</b> power`, speaker: { alias: "SSV Silver Gull" } });
  }
  async function gmEditGauge(kind) {
    if (!game.user.isGM) return;
    const st = getState();
    const cur = await promptNumber(`Set ${kind}`, `${kind.toUpperCase()} current (max ${st[kind].max})`, st[kind].cur, st[kind].max);
    if (cur == null) return;
    st[kind].cur = Math.max(0, Math.min(cur, st[kind].max));
    await setState(st);
  }
  async function gmTuneDialog() {
    if (!game.user.isGM) return;
    const st = getState(), t = st.tuning;
    const content = `<div style="display:flex;flex-direction:column;gap:6px;">
      <label>Fuel per item <input type="number" name="fpi" value="${t.fuelPerItem}" min="0"/></label>
      <label>Power per item <input type="number" name="ppi" value="${t.powerPerItem}" min="0"/></label>
      <label>Convert — fuel spent <input type="number" name="cf" value="${t.convertFuel}" min="0"/></label>
      <label>Convert — power gained <input type="number" name="cp" value="${t.convertPower}" min="0"/></label>
      <label>Fuel max <input type="number" name="fmax" value="${st.fuel.max}" min="1"/></label>
      <label>Power max <input type="number" name="pmax" value="${st.power.max}" min="1"/></label></div>`;
    const read = (f) => ({ fpi: +f.elements.fpi.value, ppi: +f.elements.ppi.value, cf: +f.elements.cf.value, cp: +f.elements.cp.value, fmax: +f.elements.fmax.value, pmax: +f.elements.pmax.value });
    const d = D2();
    const r = d
      ? await d.prompt({ window: { title: "Tune fuel & power" }, content, ok: { label: "Save", callback: (e, b) => read(b.form) } }).catch(() => null)
      : await new Promise((res) => new Dialog({ title: "Tune fuel & power", content, buttons: { ok: { label: "Save", callback: (h) => res(read(h[0].querySelector("form") || h[0])) }, cancel: { label: "Cancel", callback: () => res(null) } }, default: "ok" }).render(true));
    if (!r) return;
    st.tuning = { fuelPerItem: r.fpi, powerPerItem: r.ppi, convertFuel: r.cf, convertPower: r.cp };
    st.fuel.max = Math.max(1, r.fmax); st.power.max = Math.max(1, r.pmax);
    st.fuel.cur = Math.min(st.fuel.cur, st.fuel.max); st.power.cur = Math.min(st.power.cur, st.power.max);
    await setState(st);
  }
  async function gmSetActorDialog() {
    if (!game.user.isGM) return;
    const vehicles = game.actors.filter((a) => a.type === "vehicle");
    const opts = (vehicles.length ? vehicles : game.actors.contents).map((a) => ({ value: a.id, label: `${a.name} (${a.type})` }));
    if (!opts.length) return ui.notifications?.warn("No actors found.");
    const id = await chooseDlg("Ship actor", "Which actor is the ship? (its inventory is the ship's cargo)", opts);
    if (!id) return;
    const st = getState(); st.actorId = id; await setState(st);
    ui.notifications?.info(`Ship actor set to ${game.actors.get(id)?.name}.`);
  }

  // Spend a crew's action: use the normal Main/Bonus first, then a granted extra (purple star).
  function tryConsume(c, which) {
    if (which === "action" && !c.action) { c.action = true; return true; }
    if (which === "bonus" && !c.bonus) { c.bonus = true; return true; }
    if (c.granted > 0) { c.granted -= 1; return true; }   // spend the extra
    return false;
  }
  async function gmConsume(crewId, which, byUserId) {
    if (!game.user.isGM) return;
    const next = getCombat(); const c = next.crew[crewId]; if (!c) return;
    const gmActor = !byUserId || game.users.get(byUserId)?.isGM;
    if (!gmActor && c.controllerUserId !== byUserId) return;
    if (!tryConsume(c, which)) return notifyUser(byUserId || game.user.id, `No ${which === "bonus" ? "Bonus" : "Main"} action left.`);
    await saveCombat(next);
  }
  async function gmGrant(captainCrewId, targetCrewId, byUserId) {
    if (!game.user.isGM) return;
    const next = getCombat(); const cap = next.crew[captainCrewId], tgt = next.crew[targetCrewId];
    if (!cap || !tgt) return;
    const gmActor = !byUserId || game.users.get(byUserId)?.isGM;
    if (!gmActor && cap.controllerUserId !== byUserId) return;
    if (!tryConsume(cap, "action")) return notifyUser(byUserId || game.user.id, "You've no Main action left to Grant.");
    tgt.granted = (tgt.granted || 0) + 1;
    await saveCombat(next);
    await ChatMessage.create({ content: `<b>${esc(cap.name)}</b> grants <b>${esc(tgt.name)}</b> an extra action ⭐`, speaker: { alias: "SSV Silver Gull" } });
  }

  async function gmAllocateShield(crewId, facing, slot, byUserId) {
    if (!game.user.isGM) return;
    const combat = getCombat(); const c = combat.crew[crewId]; if (!c) return;
    const who = byUserId || game.user.id;
    const gmActor = !byUserId || game.users.get(byUserId)?.isGM;
    if (!gmActor && c.controllerUserId !== byUserId) return;
    if (c.station !== "shields_officer") return notifyUser(who, "Only the Shields Officer can allocate shields.");
    if (!S.FACINGS.includes(facing)) return;
    const ship = getState();
    if (ship.systems.shields === "destroyed") return notifyUser(who, "The Shield Generator is destroyed.");
    const which = slot === "secondary" ? "bonus" : "action";
    if (!tryConsume(c, which)) return notifyUser(who, `No ${which === "bonus" ? "Bonus" : "Main"} action left.`);
    if (slot === "secondary") ship.shield.secondary = facing;
    else { ship.shield.on = true; ship.shield.facing = facing; }
    await setState(ship); await saveCombat(combat);
    const stn = S.station("shields_officer")?.name || "Shields Officer";
    await ChatMessage.create({ content: `<b>${esc(stn)}</b> · ${esc(c.name)} — ${slot === "secondary" ? "secondary" : "main"} shield → <b>${esc(S.FACING_LABEL[facing].toUpperCase())}</b>`, speaker: { alias: "SSV Silver Gull" } });
  }

  // GM Actions — direct, GM-only shield control (no crew action economy); always announces in chat.
  async function gmSetMainShieldDirect(facing) {
    if (!game.user.isGM) return;
    const ship = getState();
    if (facing === "off") {
      ship.shield.on = false; await setState(ship);
      await ChatMessage.create({ content: `<b>GM</b> — main shields <b>OFFLINE</b>`, speaker: { alias: "SSV Silver Gull" } });
      return;
    }
    if (!S.FACINGS.includes(facing)) return;
    ship.shield.on = true; ship.shield.facing = facing; await setState(ship);
    await ChatMessage.create({ content: `<b>GM</b> — main shield → <b>${esc(S.FACING_LABEL[facing].toUpperCase())}</b>`, speaker: { alias: "SSV Silver Gull" } });
  }
  async function gmSetSecondaryDirect(facing) {
    if (!game.user.isGM) return;
    const ship = getState();
    if (facing === "off") {
      ship.shield.secondary = null; await setState(ship);
      await ChatMessage.create({ content: `<b>GM</b> — secondary shield <b>cleared</b>`, speaker: { alias: "SSV Silver Gull" } });
      return;
    }
    if (!S.FACINGS.includes(facing)) return;
    ship.shield.secondary = facing; await setState(ship);
    await ChatMessage.create({ content: `<b>GM</b> — secondary shield → <b>${esc(S.FACING_LABEL[facing].toUpperCase())}</b>`, speaker: { alias: "SSV Silver Gull" } });
  }

  // Roll dialog: pull the ability mod from the acting player's dnd5e sheet, or manual total.
  async function stationRoll(a, crew, stName) {
    const abil = a.ability, abilLabel = abil ? abil.toUpperCase() : "";
    const dcTxt = a.dc != null ? `DC ${a.dc}` : "a GM-set DC (usually 12–18)";
    const actor = game.user.character;
    const mod = actor?.system?.abilities?.[abil]?.mod;
    const hasMod = Number.isFinite(mod);
    const content = `<div style="display:flex;flex-direction:column;gap:8px;min-width:300px;">` +
      `<p style="opacity:.85">${esc(a.text)}</p><p>${abilLabel} check vs ${dcTxt}.</p>` +
      (hasMod ? `<p>Sheet: <b>${esc(actor.name)}</b> · ${abilLabel} <b>${mod >= 0 ? "+" : ""}${mod}</b></p>` : `<p><i>No linked character — enter your total.</i></p>`) +
      `<label>Manual total: <input type="number" name="total" placeholder="d20 + mods" style="width:90px"/></label></div>`;
    const D = D2();
    let choice = "cancel", form = null;
    if (D) {
      const buttons = [];
      if (hasMod) buttons.push({ action: "roll", label: `Roll 1d20 ${mod >= 0 ? "+" : ""}${mod}`, default: true, callback: (e, b) => { form = b.form; return "roll"; } });
      buttons.push({ action: "manual", label: "Use manual total", default: !hasMod, callback: (e, b) => { form = b.form; return "manual"; } });
      buttons.push({ action: "cancel", label: "Cancel", callback: () => "cancel" });
      choice = await D.wait({ window: { title: a.name }, content, buttons, rejectClose: false }).catch(() => "cancel");
    } else {
      choice = await new Promise((res) => {
        const bt = {};
        if (hasMod) bt.roll = { label: "Roll", callback: (h) => { form = h[0].querySelector("form") || h[0]; res("roll"); } };
        bt.manual = { label: "Manual", callback: (h) => { form = h[0].querySelector("form") || h[0]; res("manual"); } };
        bt.cancel = { label: "Cancel", callback: () => res("cancel") };
        new Dialog({ title: a.name, content, buttons: bt, default: hasMod ? "roll" : "manual", close: () => res("cancel") }).render(true);
      });
    }
    if (choice === "cancel" || !choice) return false;
    let total, rollObj = null;
    if (choice === "roll") { rollObj = await (new Roll(`1d20 + ${mod}`)).evaluate(); total = rollObj.total; }
    else { total = Number(form?.elements?.total?.value); if (!Number.isFinite(total)) { ui.notifications?.warn("Enter a number for your total."); return false; } }
    const pass = a.dc != null ? (total >= a.dc ? ` — <b style="color:#42d16a">SUCCESS</b>` : ` — <b style="color:#e0454d">FAIL</b>`) : "";
    const body = `<div><b>${esc(stName)}</b> · ${esc(crew.name)}<br>${esc(a.name)} — <b>${total}</b>${pass}<br><span style="opacity:.7">${esc(a.text)}</span></div>`;
    await ChatMessage.create({ content: body, speaker: { alias: "SSV Silver Gull" }, rolls: rollObj ? [rollObj] : undefined });
    return true;
  }
  async function runStationAction(a, isBonus, crew, stName) {
    if (!crew) return;
    // Grant Actions: pick a target crew who gains a purple-star extra action.
    if (a.type === "grant") {
      const combat = getCombat();
      const opts = Object.values(combat.crew).map((c) => ({ value: c.id, label: `${c.name}${c.station ? ` — ${S.station(c.station)?.name || c.station}` : ""}` }));
      if (!opts.length) return;
      const target = await chooseDlg("Grant Actions", "Give a +1 extra action (purple star) to which crew?", opts);
      if (!target) return;
      if (game.user.isGM) gmGrant(crew.id, target, null);
      else emit({ type: "grantAction", toGM: true, captainCrewId: crew.id, targetCrewId: target, userId: game.user.id });
      return;
    }
    let ok = true;
    if (a.type === "roll") ok = await stationRoll(a, crew, stName);
    else await ChatMessage.create({ content: `<b>${esc(stName)}</b> · ${esc(crew.name)} — ${esc(a.name)}<br><span style="opacity:.7">${esc(a.text)}</span>`, speaker: { alias: "SSV Silver Gull" } });
    if (!ok) return;
    const which = isBonus ? "bonus" : "action";
    if (game.user.isGM) gmConsume(crew.id, which, null);
    else emit({ type: "consume", toGM: true, crewId: crew.id, which, userId: game.user.id });
  }

  /* -- Ship combat: setting, socket, dialogs, handlers ------------------- */

  const SETTING_COMBAT = "combatState";
  const SOCKET = `module.${MODULE_ID}`;

  const usersList = () => game.users.map((u) => ({ id: u.id, name: u.name, isGM: u.isGM }));
  const nameById = (id) => game.users.get(id)?.name || "?";
  const isActiveGM = () => game.user.isGM && (game.users.activeGM?.id ?? game.user.id) === game.user.id;

  function getCombat() {
    const stored = game.settings.get(MODULE_ID, SETTING_COMBAT);
    return S.normalizeCombat(stored && Object.keys(stored).length ? stored : S.defaultCombat());
  }
  async function saveCombat(next) {           // GM-authoritative write
    if (!game.user.isGM) return;
    await game.settings.set(MODULE_ID, SETTING_COMBAT, next);
  }

  /* Dialogs (DialogV2 with classic Dialog fallback) */
  const D2 = () => foundry.applications?.api?.DialogV2;
  async function confirmDlg(title, content) {
    const d = D2(); if (d) return d.confirm({ window: { title }, content: `<p>${content}</p>` }).catch(() => false);
    return Dialog.confirm({ title, content: `<p>${content}</p>` });
  }
  async function chooseDlg(title, intro, options) {  // options: [{value,label}] → value|null
    const body = `<div style="display:flex;flex-direction:column;gap:6px;">${intro ? `<p>${intro}</p>` : ""}` +
      `<select name="v" style="width:100%">${options.map((o) => `<option value="${o.value}">${esc(o.label)}</option>`).join("")}</select></div>`;
    const read = (form) => form.elements.v.value;
    const d = D2();
    if (d) return d.prompt({ window: { title }, content: body, ok: { label: "OK", callback: (e, b) => read(b.form) } }).catch(() => null);
    return new Promise((res) => new Dialog({ title, content: body,
      buttons: { ok: { label: "OK", callback: (h) => res(read(h[0].querySelector("form") || h[0])) }, cancel: { label: "Cancel", callback: () => res(null) } }, default: "ok" }).render(true));
  }

  /* Socket */
  function emit(msg) { game.socket.emit(SOCKET, msg); }
  function notifyUser(userId, text) {
    if (userId === game.user.id) ui.notifications?.warn(text);
    else emit({ type: "notify", toUser: userId, text });
  }
  function onSocket(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.toUser && msg.toUser !== game.user.id) return;
    if (msg.toGM && !isActiveGM()) return;
    switch (msg.type) {
      case "pickPrompt":     if (!game.user.isGM) promptPickAll(); break;
      case "pickStation":    gmSetStation(msg.crewId, msg.station, msg.userId); break;
      case "spend":          gmSpend(msg.crewId, msg.which, msg.userId); break;
      case "switchRequest":  gmSwitch(msg.userId, msg.crewId, msg.target); break;
      case "swapConfirm":    promptSwapConfirm(msg); break;
      case "swapResult":     gmResolveSwap(msg.accepted); break;
      case "allocateShield": gmAllocateShield(msg.crewId, msg.facing, msg.slot, msg.userId); break;
      case "consume":        gmConsume(msg.crewId, msg.which, msg.userId); break;
      case "grantAction":    gmGrant(msg.captainCrewId, msg.targetCrewId, msg.userId); break;
      case "moveItem":       gmMoveItem(msg.fromShip, msg.itemId, msg.qty, msg.userId); break;
      case "useResource":    gmUseResource(msg.itemId, msg.userId); break;
      case "convert":        gmConvert(msg.userId, msg.fuelAmt); break;
      case "notify":         ui.notifications?.warn(msg.text); break;
    }
  }

  /* Bar collapse (per-client, localStorage) */
  const BAR_KEY = `${MODULE_ID}.barCollapsed`;
  const barCollapsed = () => { try { return localStorage.getItem(BAR_KEY) === "1"; } catch (e) { return false; } };
  const setBarCollapsed = (v) => { try { localStorage.setItem(BAR_KEY, v ? "1" : "0"); } catch (e) {} };
  // The pre-combat GM bar (SHIP COMBAT / Enter / Crew) is HIDDEN by default — press \ to show it.
  const GMBAR_KEY = `${MODULE_ID}.gmBarHidden`;
  const gmBarHidden = () => { try { return localStorage.getItem(GMBAR_KEY) !== "0"; } catch (e) { return true; } };
  const setGMBarHidden = (v) => { try { localStorage.setItem(GMBAR_KEY, v ? "1" : "0"); } catch (e) {} };

  const newId = () => "c" + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);

  /* GM-authoritative handlers */
  async function enterCombat() {
    if (!game.user.isGM) return;
    const cur = getCombat();
    const included = await includeDialog(cur);
    if (!included) return;
    const next = S.defaultCombat();
    next.active = true; next.turn = 1; next.rolesEnabled = cur.rolesEnabled; next.roster = cur.roster;
    for (const m of cur.roster) {
      if (!included.has(m.id)) continue;
      next.crew[m.id] = { id: m.id, name: m.name, ownerUserId: m.userId || "", controllerUserId: m.userId || game.user.id, station: "", action: false, bonus: false, granted: 0 };
    }
    await saveCombat(next);
    emit({ type: "pickPrompt" });
    ui.notifications?.info("Ship combat started — players, pick your station.");
  }
  async function endCombat() {
    if (!game.user.isGM) return;
    const next = getCombat(); next.active = false; next.crew = {}; next.pendingSwap = null;
    await saveCombat(next);
  }
  async function nextTurn() {
    if (!game.user.isGM) return;
    const next = getCombat();
    for (const c of Object.values(next.crew)) { c.action = false; c.bonus = false; c.granted = 0; }
    next.turn = (next.turn || 1) + 1; next.pendingSwap = null;
    await saveCombat(next);
    // Micro-Adjust's secondary shield lasts only until the start of the next turn.
    const ship = getState();
    if (ship.shield.secondary) { ship.shield.secondary = null; await setState(ship); }
  }
  async function gmSpend(crewId, which, byUserId) {
    if (!game.user.isGM) return;
    const next = getCombat(); const c = next.crew[crewId]; if (!c) return;
    const gmActor = !byUserId || game.users.get(byUserId)?.isGM;
    if (!gmActor && c.controllerUserId !== byUserId) return;   // players only touch crew they control
    if (which === "action") c.action = !c.action;
    else if (which === "bonus") c.bonus = !c.bonus;
    await saveCombat(next);
  }
  async function assignController(crewId, userId) {
    if (!game.user.isGM) return;
    const next = getCombat(); const c = next.crew[crewId]; if (!c) return;
    c.controllerUserId = userId; await saveCombat(next);
  }
  async function excludeCrew(crewId) {
    if (!game.user.isGM) return;
    const next = getCombat(); delete next.crew[crewId]; await saveCombat(next);
  }
  async function gmSetStation(crewId, station, byUserId) {
    if (!game.user.isGM) return;
    const next = getCombat(); const c = next.crew[crewId]; if (!c) return;
    const gmActor = !byUserId || game.users.get(byUserId)?.isGM;
    if (!gmActor && c.controllerUserId !== byUserId) return;
    if (station && !next.rolesEnabled[station]) return;
    if (station) {
      const clash = Object.values(next.crew).find((o) => o.id !== crewId && o.station === station);
      if (clash) return notifyUser(byUserId || game.user.id, `That station is taken by ${clash.name}.`);
    }
    c.station = station || "";
    await saveCombat(next);
  }
  async function gmSwitch(byUserId, crewId, target) {
    if (!game.user.isGM) return;
    const next = getCombat(); const c = next.crew[crewId]; if (!c) return;
    const gmActor = game.users.get(byUserId)?.isGM;
    if (!gmActor && c.controllerUserId !== byUserId) return;
    if (!next.rolesEnabled[target]) return notifyUser(byUserId, "That station is disabled.");
    if (c.bonus) return notifyUser(byUserId, "You've already used your Bonus action.");
    const occ = Object.values(next.crew).find((o) => o.id !== crewId && o.station === target);
    if (!occ) { c.bonus = true; c.station = target; await saveCombat(next); }
    else {
      if (occ.bonus) return notifyUser(byUserId, `${occ.name} has no Bonus action left.`);
      next.pendingSwap = { fromCrew: crewId, targetCrew: occ.id };
      await saveCombat(next);
      const payload = { type: "swapConfirm", toUser: occ.controllerUserId, fromName: c.name, occName: occ.name };
      if (occ.controllerUserId === game.user.id) promptSwapConfirm(payload);
      else emit(payload);
    }
  }
  async function gmResolveSwap(accepted) {
    if (!game.user.isGM) return;
    const next = getCombat(); const ps = next.pendingSwap; if (!ps) return;
    const a = next.crew[ps.fromCrew], b = next.crew[ps.targetCrew];
    if (!accepted) { next.pendingSwap = null; await saveCombat(next); if (a) notifyUser(a.controllerUserId, "Your station swap was declined."); return; }
    if (a && b) { const t = a.station; a.station = b.station; b.station = t; a.bonus = true; b.bonus = true; }
    next.pendingSwap = null;
    await saveCombat(next);
  }

  /* Player-side prompts */
  async function promptPickAll() {
    const combat = getCombat();
    if (!combat.active) return;
    const mine = S.crewControlledBy(combat, game.user.id).filter((c) => !c.station);
    for (const c of mine) await pickStationFor(c.id);
  }
  async function pickStationFor(crewId) {
    const combat = getCombat(); const c = combat.crew[crewId]; if (!c) return;
    const taken = new Set(Object.values(combat.crew).map((x) => x.station).filter(Boolean));
    const opts = S.STATIONS.filter((st) => combat.rolesEnabled[st.id] && !taken.has(st.id)).map((st) => ({ value: st.id, label: `${st.num}. ${st.name}` }));
    if (!opts.length) return ui.notifications?.warn("No free stations left to crew.");
    const station = await chooseDlg(`Pick ${c.name}'s station`, "Which station will they crew this combat?", opts);
    if (!station) return;
    if (game.user.isGM) gmSetStation(crewId, station, null);
    else emit({ type: "pickStation", toGM: true, crewId, station, userId: game.user.id });
  }
  async function promptSwapConfirm(msg) {
    const ok = await confirmDlg("Station swap request",
      `${esc(msg.fromName)} wants to swap stations with ${esc(msg.occName || "you")}. This spends your Bonus action. Accept?`);
    if (game.user.isGM) gmResolveSwap(ok);
    else emit({ type: "swapResult", toGM: true, accepted: !!ok });
  }

  /* GM dialogs: who's in the fight, add a crew member, edit the roster, enable stations */
  async function includeDialog(combat) {
    if (!combat.roster.length) { ui.notifications?.warn("No crew in the roster — set it up via ‘Crew’ first."); return null; }
    const rows = combat.roster.map((m) => `<label style="display:flex;gap:8px;align-items:center;margin-bottom:3px;">` +
      `<input type="checkbox" name="${m.id}" checked/> ${esc(m.name)}${m.userId ? ` — ${esc(nameById(m.userId))}` : " — (no player)"}</label>`).join("");
    const content = `<div style="display:flex;flex-direction:column;"><p>Who's in this fight?</p>${rows}</div>`;
    const read = (form) => { const s = new Set(); for (const m of combat.roster) if (form.elements[m.id]?.checked) s.add(m.id); return s; };
    const d = D2();
    if (d) return d.prompt({ window: { title: "Start ship combat" }, content, ok: { label: "Start", callback: (e, b) => read(b.form) } }).catch(() => null);
    return new Promise((res) => new Dialog({ title: "Start ship combat", content,
      buttons: { ok: { label: "Start", callback: (h) => res(read(h[0].querySelector("form") || h[0])) }, cancel: { label: "Cancel", callback: () => res(null) } }, default: "ok" }).render(true));
  }
  async function addCrewDialog() {
    if (!game.user.isGM) return;
    const combat = getCombat();
    const inFight = new Set(Object.keys(combat.crew));
    const opts = combat.roster.filter((m) => !inFight.has(m.id)).map((m) => ({ value: m.id, label: m.name + (m.userId ? ` — ${nameById(m.userId)}` : "") }));
    if (!opts.length) return ui.notifications?.warn("Every roster crew is already in the fight (add more via ‘Edit crew’).");
    const cid = await chooseDlg("Add crew", "Bring which crew member into the fight?", opts);
    if (!cid) return;
    const m = combat.roster.find((x) => x.id === cid); if (!m) return;
    const next = getCombat();
    next.crew[cid] = { id: cid, name: m.name, ownerUserId: m.userId || "", controllerUserId: m.userId || game.user.id, station: "", action: false, bonus: false, granted: 0 };
    await saveCombat(next);
  }
  async function editCrewDialog() {
    if (!game.user.isGM) return;
    const combat = getCombat();
    const userSel = (name, sel) => `<select name="${name}" style="width:150px"><option value="">(no player)</option>` +
      game.users.map((u) => `<option value="${u.id}" ${u.id === sel ? "selected" : ""}>${esc(u.name)}${u.isGM ? " (GM)" : ""}</option>`).join("") + `</select>`;
    const rows = combat.roster.map((m, i) => `<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;">` +
      `<input name="name_${i}" value="${esc(m.name)}" style="flex:1"/>${userSel("user_" + i, m.userId)}` +
      `<label style="font-size:11px;white-space:nowrap"><input type="checkbox" name="del_${i}"/> remove</label></div>`).join("");
    const addRow = `<div style="display:flex;gap:6px;align-items:center;margin-top:6px;border-top:1px solid #555;padding-top:6px;">` +
      `<input name="name_new" placeholder="+ new crew member" style="flex:1"/>${userSel("user_new", "")}</div>`;
    const content = `<div style="display:flex;flex-direction:column;max-height:60vh;overflow:auto;"><p>Your ship's crew — assign each to a player (or leave blank for the GM to run).</p>${rows}${addRow}</div>`;
    const read = (form) => {
      const roster = [];
      combat.roster.forEach((m, i) => {
        if (form.elements["del_" + i]?.checked) return;
        const nm = (form.elements["name_" + i]?.value || "").trim(); if (!nm) return;
        roster.push({ id: m.id, name: nm, userId: form.elements["user_" + i]?.value || "" });
      });
      const nn = (form.elements["name_new"]?.value || "").trim();
      if (nn) roster.push({ id: newId(), name: nn, userId: form.elements["user_new"]?.value || "" });
      return roster;
    };
    const d = D2();
    let result = null;
    if (d) result = await d.prompt({ window: { title: "Ship crew roster" }, content, ok: { label: "Save", callback: (e, b) => read(b.form) } }).catch(() => null);
    else result = await new Promise((res) => new Dialog({ title: "Ship crew roster", content,
      buttons: { ok: { label: "Save", callback: (h) => res(read(h[0].querySelector("form") || h[0])) }, cancel: { label: "Cancel", callback: () => res(null) } }, default: "ok" }).render(true));
    if (!result) return;
    const next = getCombat(); next.roster = result;
    for (const cid of Object.keys(next.crew)) if (!result.find((m) => m.id === cid)) delete next.crew[cid];
    await saveCombat(next);
  }
  async function rolesDialog() {
    if (!game.user.isGM) return;
    const combat = getCombat();
    const rows = S.STATIONS.map((st) => `<label style="display:flex;gap:8px;align-items:center;">` +
      `<input type="checkbox" name="${st.id}" ${combat.rolesEnabled[st.id] ? "checked" : ""}/> ${st.num}. ${esc(st.name)}${st.defaultUnlocked ? "" : " (locked by default)"}</label>`).join("");
    const content = `<div style="display:flex;flex-direction:column;gap:4px;max-height:60vh;overflow:auto;">${rows}</div>`;
    const read = (form) => { const out = {}; for (const st of S.STATIONS) out[st.id] = !!form.elements[st.id].checked; return out; };
    const d = D2();
    let result = null;
    if (d) result = await d.prompt({ window: { title: "Enabled stations" }, content, ok: { label: "Save", callback: (e, b) => read(b.form) } }).catch(() => null);
    else result = await new Promise((res) => new Dialog({ title: "Enabled stations", content,
      buttons: { ok: { label: "Save", callback: (h) => res(read(h[0].querySelector("form") || h[0])) }, cancel: { label: "Cancel", callback: () => res(null) } }, default: "ok" }).render(true));
    if (!result) return;
    const next = getCombat(); next.rolesEnabled = result; await saveCombat(next);
  }

  /* Foundry combat-context for the tracker bar */
  const combatCtx = () => ({
    isGM: game.user.isGM,
    userId: game.user.id,
    users: usersList(),
    getCombat,
    get collapsed() { return barCollapsed(); },
    get gmBarHidden() { return gmBarHidden(); },
    toggleCollapse: () => { setBarCollapsed(!barCollapsed()); renderBar(); },
    enterCombat, endCombat, nextTurn,
    editCrew: editCrewDialog,
    openRoles: rolesDialog,
    addCrew: addCrewDialog,
    broadcastPick: () => { emit({ type: "pickPrompt" }); ui.notifications?.info("Re-sent the station picker to players."); },
    assignController, excludeCrew,
    setStation: (crewId, station) => gmSetStation(crewId, station, null),
    spend: (crewId, which) => { if (game.user.isGM) gmSpend(crewId, which, null); else emit({ type: "spend", toGM: true, crewId, which, userId: game.user.id }); },
    pickStation: (crewId) => pickStationFor(crewId),
    switchStation: async (crewId) => {
      const combat = getCombat(); const c = combat.crew[crewId]; if (!c) return;
      const opts = S.STATIONS.filter((st) => combat.rolesEnabled[st.id] && st.id !== c.station).map((st) => {
        const occ = Object.values(combat.crew).find((o) => o.station === st.id);
        return { value: st.id, label: `${st.num}. ${st.name}${occ ? ` — ${occ.name}` : ""}` };
      });
      if (!opts.length) return;
      const target = await chooseDlg("Switch station", "Move to which station? (costs a Bonus action)", opts);
      if (!target) return;
      if (game.user.isGM) gmSwitch(game.user.id, crewId, target);
      else emit({ type: "switchRequest", toGM: true, userId: game.user.id, crewId, target });
    }
  });

  /* The always-on tracker bar mounted into the Foundry UI */
  let _bar = null;
  function renderBar() {
    if (!_bar || !document.body.contains(_bar)) {
      _bar = document.createElement("div");
      _bar.id = "ssv-combat-bar";
      document.body.appendChild(_bar);
    }
    if (consoleOpen()) { _bar.style.display = "none"; return; }  // console shows its own tokens
    _bar.style.display = "";
    try { S.renderTracker(_bar, combatCtx()); } catch (e) { console.error(`${MODULE_ID} | tracker render failed`, e); }
  }

  /* -- Hooks ------------------------------------------------------------- */

  Hooks.once("init", () => {
    // onChange fires on every client when a world setting replicates → our cross-client refresh.
    // Both the bar AND the console read combat + ship state, so refresh both on either change.
    const refreshUI = () => { renderBar(); refreshOpen(); };
    game.settings.register(MODULE_ID, SETTING_DATA, { scope: "world", config: false, type: Object, default: {}, onChange: refreshUI });
    game.settings.register(MODULE_ID, SETTING_COMBAT, { scope: "world", config: false, type: Object, default: {}, onChange: refreshUI });
    game.keybindings.register(MODULE_ID, "open", {
      name: game.i18n?.localize(`${MODULE_ID}.keybind.open.name`) || "Open Ship Overview HUD",
      hint: game.i18n?.localize(`${MODULE_ID}.keybind.open.hint`) || "Opens the SSV Silver Gull ship-combat overview.",
      editable: [{ key: "KeyS" }],
      onDown: () => { openShipHUD(); return true; }
    });
    game.keybindings.register(MODULE_ID, "toggleCombatBar", {
      name: "Show/Hide Ship Combat Bar",
      hint: "Fully hides or reopens the ship-combat turn tracker at the top of the screen. Rebind here if it clashes.",
      editable: [{ key: "Backslash" }],   // was KeyC (conflicted); '\' is rebindable in Configure Controls
      onDown: () => {
        // Idle → toggle the GM Enter/Crew bar; mid-combat → toggle the turn tracker.
        if (game.user.isGM && !S.normalizeCombat(getCombat()).active) setGMBarHidden(!gmBarHidden());
        else setBarCollapsed(!barCollapsed());
        renderBar();
        return true;
      }
    });
  });

  Hooks.once("ready", async () => {
    if (game.user.isGM) {
      const stored = game.settings.get(MODULE_ID, SETTING_DATA);
      if (!stored || !Object.keys(stored).length) await game.settings.set(MODULE_ID, SETTING_DATA, S.defaultState());
      const combat = game.settings.get(MODULE_ID, SETTING_COMBAT);
      if (!combat || !Object.keys(combat).length) await game.settings.set(MODULE_ID, SETTING_COMBAT, S.defaultCombat());
    }
    game.socket.on(SOCKET, onSocket);
    renderBar();
    // Live inventory: re-render the open console when the ship actor or this user's character changes.
    const itemTouches = (item) => { const p = item?.parent; return p && (p === getShipActor() || p === game.user.character); };
    for (const hook of ["createItem", "updateItem", "deleteItem"]) Hooks.on(hook, (item) => { if (consoleOpen() && invMode && itemTouches(item)) refreshOpen(); });
    Hooks.on("updateActor", (actor) => { if (consoleOpen() && invMode && (actor === getShipActor() || actor === game.user.character)) refreshOpen(); });
    // Esc closes the full-screen console (capture phase so we can stop Foundry's own Esc handling).
    window.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && consoleOpen()) { ev.preventDefault(); ev.stopImmediatePropagation(); closeConsole(); }
    }, true);
    const mod = game.modules.get(MODULE_ID);
    if (mod) mod.api = { open: openShipHUD, getState, setState, defaultState: S.defaultState,
      SYSTEMS: S.SYSTEMS, FACINGS: S.FACINGS, STATIONS: S.STATIONS,
      getCombat, enterCombat, endCombat, nextTurn };
    globalThis.SilverGullShip = mod?.api;
  });
})();
