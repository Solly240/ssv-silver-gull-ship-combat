/**
 * SSV Silver Gull — Ship Combat: the PURE half.
 *
 * Styles, renderers, mini-games and every piece of combat maths. This file must
 * never touch `game`, `ui`, `Hooks` or `canvas` — the release gate greps for it:
 *
 *     grep -nE '\\b(game|ui|Hooks|canvas)\\.' scripts/ship-combat-render.js   # must be empty
 *
 * Everything it needs arrives through a small `ctx` contract, so the SAME code
 * runs inside Foundry (real settings + dialogs) and inside preview.html (a fake
 * in-memory ctx) and under plain node (`--selftest`).
 *
 * The Foundry wiring lives in scripts/ship-combat.js and reads this file's
 * exports off `globalThis.SSVShipHUD`.
 *
 * Built for Foundry VTT v12–v14. No dependency on any other module.
 */


(function () {
  const S = {};
  const MODULE_ID = "ssv-silver-gull-ship-combat";
  // Stamped by tools/deploy.sh. The wiring half compares this against the
  // manifest the server is actually serving: browsers cache esmodules hard,
  // and a client running yesterday's script against today's data fails in
  // ways that look like bugs. Better it says so out loud.
  S.VERSION = "0.26.4";

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
  // Each system has HP. 5 = working; 1–4 = damaged (doesn't work); ≤0 = destroyed (can't be repaired).
  S.SYSTEM_HP_MAX = 5;
  S.systemState = (hp) => {
    const cur = Number(hp?.cur), max = Number(hp?.max) || S.SYSTEM_HP_MAX;
    if (!(cur > 0)) return "destroyed";
    if (cur >= max) return "working";
    return "damaged";
  };
  // A system "works" only at full HP; damaged/destroyed = doesn't work.
  S.systemWorks = (state, id) => state?.systems?.[id] === "working";
  /** Does this record even carry a condition for that system? A player's view of
   *  an enemy only gains `systems` at the SYSTEMS scan tier, so before that the
   *  answer to "do her shields work?" is UNKNOWN, not "no". Treating unknown as
   *  broken drew every arc on a freshly-scanned enemy as unshielded — directly
   *  contradicting the VITALS readout the crew had just paid an action for. */
  S.systemKnown = (state, id) => !!(state && state.systems && id in state.systems);

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
        { id: "cmd_adv", name: "Command · Advantage", type: "command", text: "Give one crew member advantage on their Main Action this round. Double advantage was removed — extra sources are +2 flat, because rolling three d20s against a ten-point AC band makes every DC meaningless." },
        { id: "grant", name: "Grant Actions", type: "grant", text: "Give one crew +1 extra action (a purple star, usable as a Main or Bonus). They spend it after their normal action of that type. Lasts one turn." },
        { id: "bc_flee", name: "Big Call · Spool the Drive", type: "flee", text: "Begin a hyperfold spool: three successes across the fight and you are gone. While spooling you cannot go Evasive, and the drive is a target. A failure costs you time, not blood." },
        { id: "bc_ram", name: "Big Call · Ram", type: "ram", text: "The Pilot must be on Aggressive Positioning and the target within 3 squares. On a hit: 4d6, ignoring their shield facing entirely — and you take a quarter of it back." },
        N("bc_allhands", "Big Call · All Hands", "Every station gets +3 to their Main check this round OR an extra Bonus Action; you lose your Rally this round.")
      ],
      bonus: [{ id: "rally", name: "Rally", type: "rally", text: "Give one crew member a flat +1 to their Main Action roll this round." }]
    },
    pilot: {
      main: [
        N("evasive", "Evasive Maneuvers", "+4 ship AC; forward gunners at disadvantage; 6 Movement Points."),
        N("steady", "Steady Approach", "+0 AC; gunners normal; 4 Movement Points."),
        N("come_about", "Come About", "No AC change; forward gunners get +2 to hit. 2 Movement Points."),
        N("aggressive", "Aggressive Positioning", "−4 AC; forward gunners advantage; 3 Movement Points; enables Ram.")
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
      main: [{ id: "launch_breach", name: "Launch & Breach", type: "breach",
        text: "At close range: pick a hull and a tool, roll Athletics or Acrobatics against DC 15, and you are aboard. A failure leaves you latched to the outside of their hull, not adrift — you try again next round." }],
      bonus: [{ id: "repel", name: "Repel Boarders", type: "repel",
        text: "Leave your station to fight whoever is aboard. You lose this station's Main action this round." }]
    },
    engineer: {
      main: [{ id: "repair", name: "Repair System", type: "repair", text: "Pick a damaged system and roll d20 + INT. Nat 20 = auto-fix; nat 1 = auto-fail; otherwise solve a timed repair puzzle (the roll sets your time) to restore +2 HP. Can't repair a destroyed (0 HP) system." }, { id: "reroute", name: "Reroute Power", type: "reroute", text: "Pick a rail: +1d4 to one crew member next roll, +2 ship AC this round, or +1d6 on the next gunner hit. No mishap — a 10 percent chance of setting your own ship on fire for +1d4 was a deal nobody took twice." }],
      bonus: [{ id: "patch", name: "Patch Job", type: "patch", text: "No check: 1d4 hull back, or clear one negative status from the ship." }]
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
      main: [{ id: "scan", name: "Scan", type: "scan",
        text: "Int/Investigation vs DC 15 against one contact. Meet it for hull, armour, resistances and shield facing; beat it by 3 for every system and advantage for one gunner; by 10 for the crew manifest and advantage for both. A FAILED scan still names her class, allegiance and hot arc, and leaves her Painted — the next scan of her has advantage." }, N("counter", "Countermeasures", "Opposed Int to negate an enemy Scan/Jam; can be held for the enemy's turn."), { id: "navsupport", name: "Navigation Support", type: "navsupport", text: "Play a quick nav mini-game (plot the course or thread the gates). The better you fly it, the bigger the Pilot's Movement-Point multiplier this turn — ×1.5 (rough) up to ×2.5 (perfect). Applies to their maneuver even if they've already started moving." }],
      bonus: [{ id: "ping", name: "Quick Ping", type: "ping", text: "No roll. Ask the GM one factual question about a contact and get a truthful answer. This is the ability that found the Apostles three self-destruct modules." }]
    },
    cloaking: {
      main: [
        { id: "engage", name: "Engage Cloak", type: "cloak", cloak: "engage",
          text: "The Gull goes dark. Attacks against her have disadvantage until she fires. Taking damage no longer breaks it — that is the station's perk." },
        { id: "burst", name: "Cloak Burst", type: "cloak", cloak: "burst",
          text: "One round of true invisibility: nothing can target the Gull at all. Ends at the start of your next turn." },
        { id: "phase", name: "Phase Shift", type: "cloak", cloak: "phase",
          text: "Bank a phase charge. The next attack that would hit the Gull simply does not — resolved after the damage roll, so you watch it be undone." },
        { id: "decoy", name: "Decoy Drop", type: "cloak", cloak: "decoy",
          text: "Drop a decoy. The next enemy shot at the Gull hits it instead of her." }
      ],
      bonus: [{ id: "stealth", name: "Stealth Debuff", type: "cloak", cloak: "stealth",
        text: "Ghost their sensors — one contact's next scan of you fails outright." }]
    },
    turret_flak: {
      main: [{ id: "flakspread", name: "Flak Spread", type: "turret", turret: "turret_flak",
        text: "Up to three targets in the arc, each taking the roll. Also gives a free shot at anything trying to board." }],
      bonus: [{ id: "adjust", name: "Adjust Aim", type: "adjust",
        text: "Walk the mount onto the target: +2 to hit with this turret this round." }]
    },
    turret_autocannon: {
      main: [{ id: "apshot", name: "Armor-Piercing Shot", type: "turret", turret: "turret_autocannon",
        text: "Ignores armour entirely, and a Called Shot from this mount costs no accuracy." }],
      bonus: [{ id: "adjust", name: "Adjust Aim", type: "adjust",
        text: "Walk the mount onto the target: +2 to hit with this turret this round." }]
    },
    turret_plasma: {
      main: [{ id: "plasmashot", name: "Plasma Shot", type: "turret", turret: "turret_plasma",
        text: "Auto-inflicts Shields Down; +1d6 against a hull whose shields are already gone." }],
      bonus: [{ id: "adjust", name: "Adjust Aim", type: "adjust",
        text: "Walk the mount onto the target: +2 to hit with this turret this round." }]
    },
    turret_cryo: {
      main: [{ id: "cryobeam", name: "Cryo-Beam", type: "turret", turret: "turret_cryo",
        text: "Inflicts Frozen — the next kinetic hit on them has advantage and deals double." }],
      bonus: [{ id: "adjust", name: "Adjust Aim", type: "adjust",
        text: "Walk the mount onto the target: +2 to hit with this turret this round." }]
    },
    turret_ion: {
      main: [{ id: "ionshot", name: "Ion Shot", type: "turret", turret: "turret_ion",
        text: "Inflicts Engines Disabled or Shields Down, your choice; advantage against anything already disabled." }],
      bonus: [{ id: "adjust", name: "Adjust Aim", type: "adjust",
        text: "Walk the mount onto the target: +2 to hit with this turret this round." }]
    },
    turret_gravity: {
      main: [{ id: "gravwell", name: "Gravity Well", type: "turret", turret: "turret_gravity",
        text: "Grapples up to three contacts — no movement, and attacks against them have advantage." }],
      bonus: [{ id: "adjust", name: "Adjust Aim", type: "adjust",
        text: "Walk the mount onto the target: +2 to hit with this turret this round." }]
    }
  };
  S.stationActions = (id) => S.STATION_ACTIONS[id] || { main: [], bonus: [] };
  // Pilot maneuver → Movement Points (base 5/3/2 + the +1 perk) + a ship-AC modifier. Chosen as the Main action.
  // Pilot posture. AC spreads are ±4, not ±5: with shields moved off AC entirely,
  // ±5 on top of a 13 base put the ship outside the band where a d20 means
  // anything. `gun` is the modifier the forward gunners get, and `gunAdv` the
  // advantage state they fire under. MP keeps the +1 pilot perk already baked in.
  //
  // `status` names the matching entry in S.STATUSES for display and for the
  // enemy side. It is DELIBERATELY not applied when a pilot picks a maneuver:
  // S.shipAC already adds the maneuver's own `ac`, so applying the status too
  // would count Evasive twice and put the ship back in the unreadable band this
  // retune existed to escape. Show it; never stack it.
  S.MANEUVERS = {
    evasive:    { label: "Evasive",    mp: 6, ac:  4, gun:  0, gunAdv: -1, status: "evasive",
                  blurb: "+4 ship AC; forward gunners fire at disadvantage." },
    steady:     { label: "Steady",     mp: 4, ac:  0, gun:  0, gunAdv:  0, status: null,
                  blurb: "No modifier either way." },
    come_about: { label: "Come About", mp: 2, ac:  0, gun: +2, gunAdv:  0, status: null,
                  blurb: "Line the ship up: forward gunners get +2 to hit. The Pilot's move that serves gunnery." },
    aggressive: { label: "Aggressive", mp: 3, ac: -4, gun:  0, gunAdv: +1, status: "aggressive",
                  blurb: "−4 ship AC; forward gunners fire with advantage; enables Ram." }
  };
  // Fuel each move burns (players only — anything the GM drives is free). Rotate 45 = 1, Rotate 90 = 2, Forward = 4.
  S.MOVE_FUEL = { rotL45: 1, rotR45: 1, rotL90: 2, rotR90: 2, forward: 4 };
  // The ship's two forward-mounted mono-gun turrets. A gunner (port or starboard seat) picks which gun to fire.
  // Firing arc is 45° to either side of dead-ahead (90° cone). Ranges are in grid squares.
  S.GUNS = [
    { id: "flak",       label: "Light Flak Turret", toHit: 5, damage: "2d6", shortMax: 2, longMax: 4,  longNote: "−5 & half dmg" },
    { id: "autocannon", label: "Heavy Autocannon",  toHit: 3, damage: "4d6", shortMax: 4, longMax: 10, longNote: "no penalty" }
  ];
  S.gun = (id) => S.GUNS.find((g) => g.id === id) || (S.TURRETS || []).map((t) => t.gun).find((g) => g.id === id) || null;
  /* ---------------------------------------------------------------------- */
  /*  The six rebuildable turrets                                            */
  /*                                                                          */
  /*  These are the blueprints sheared off in the crash. Each is a station    */
  /*  (10-15) AND a mount with its own gun, its own HP pool, and a signature  */
  /*  that does something the wing guns cannot. A turret is only usable once  */
  /*  it has been BUILT — the module reads that from shipState.turrets, which */
  /*  the journal module's "Rebuild Turrets" quest drives.                    */
  /* ---------------------------------------------------------------------- */

  S.TURRET_HP_MAX = 18;
  S.TURRETS = [
    { id: "turret_flak", station: "turret_flak", name: "Light Flak Turret", num: 1,
      gun: { id: "t_flak", label: "Light Flak Turret", toHit: 5, damage: "2d6", shortMax: 3, longMax: 6, longNote: "−5 & half dmg" },
      signature: "spread", blurb: "Anti-swarm point defence. Hits up to three contacts, and shoots at boarders for free." },
    { id: "turret_autocannon", station: "turret_autocannon", name: "Heavy Autocannon", num: 2,
      gun: { id: "t_auto", label: "Heavy Autocannon", toHit: 3, damage: "4d6", shortMax: 5, longMax: 12, longNote: "no penalty" },
      signature: "pierce", blurb: "Armour-piercing. Ignores armour, and its Called Shots cost no accuracy." },
    { id: "turret_plasma", station: "turret_plasma", name: "Plasma Casing Cannon", num: 3,
      gun: { id: "t_plasma", label: "Plasma Casing Cannon", toHit: 4, damage: "3d8", shortMax: 3, longMax: 8, longNote: "−5 & half dmg" },
      signature: "shieldbreak", blurb: "Shield-breaker. Auto-inflicts Shields Down, and hits harder once they are." },
    { id: "turret_cryo", station: "turret_cryo", name: "Liquid Nitrogen Cryo-Beam", num: 4,
      gun: { id: "t_cryo", label: "Cryo-Beam", toHit: 4, damage: "2d8", shortMax: 2, longMax: 5, longNote: "−5 & half dmg" },
      signature: "freeze", blurb: "Brittle-shatter. Freezes the target: the next kinetic hit has advantage and doubles." },
    { id: "turret_ion", station: "turret_ion", name: "Ion Charge Cannon", num: 5,
      gun: { id: "t_ion", label: "Ion Charge Cannon", toHit: 4, damage: "2d10", shortMax: 4, longMax: 9, longNote: "−5 & half dmg" },
      signature: "emp", blurb: "EMP disruptor. Disables engines or drops shields, your choice." },
    { id: "turret_gravity", station: "turret_gravity", name: "Gravity Well Projector", num: 6,
      gun: { id: "t_grav", label: "Gravity Well Projector", toHit: 3, damage: "2d6", shortMax: 2, longMax: 6, longNote: "−5 & half dmg" },
      signature: "grapple", blurb: "Pull and crush. Grapples up to three contacts and makes them easy to hit." }
  ];
  S.turret = (id) => S.TURRETS.find((t) => t.id === id || t.station === id) || null;
  /** Has this turret been rebuilt? */
  S.turretBuilt = (state, id) => !!state?.turrets?.[id]?.built;
  S.turretHp = (state, id) => state?.turrets?.[id]?.hp ?? { cur: 0, max: S.TURRET_HP_MAX };
  /** A turret can fire if it is built, has HP, and the ship's Weapons are up. */
  S.turretOnline = function (state, id) {
    if (!S.turretBuilt(state, id)) return false;
    if ((S.turretHp(state, id).cur ?? 0) <= 0) return false;
    return S.systemWorks(state, "weapons");
  };
  /** Every turret gun currently available to fire, for the gunner's picker. */
  S.availableGuns = function (state) {
    const out = S.GUNS.slice();
    for (const t of S.TURRETS) if (S.turretOnline(state, t.id)) out.push({ ...t.gun, turret: t.id });
    return out;
  };

  /* The boarding tools from ship/ship-combat.md. `note` is the trade-off the
     player is actually choosing between — the modifier alone does not say it. */
  S.BOARDING_TOOLS = [
    { id: "harpoon", name: "Grappling Harpoon", mod: 2, note: "No downside. The safe choice." },
    { id: "clamps", name: "Magnetic Clamps", mod: 5, note: "Best odds against a metal hull — and an automatic failure against an energy-shielded or non-metal one.",
      failsIf: (ship) => !!(ship?.shield?.on) },
    { id: "mine", name: "Adhesive Breach Mine", mod: 99, note: "You are aboard, guaranteed. Everyone on that ship knows it.", loud: true },
    { id: "cutter", name: "Plasma Cutter", mod: 0, note: "No bonus, but you are through the hull the moment you land." },
    { id: "torpedo", name: "Boarding Torpedo", mod: 3, note: "The gunner fires you across. Spends a torpedo." }
  ];
  S.boardingTool = (id) => S.BOARDING_TOOLS.find((t) => t.id === id) || null;
  S.BOARDING_DC = 15;

  S.QUICK_AIM_BONUS = 2;   // Quick Aim: spend the Bonus action for +2 to hit
  // Power a station action draws from the reactor (players only; the GM never spends). Keyed by action id; default 0.
  // Movement is fuel (above), not power; repair/boarding/pilot-maneuvers are free; everything that "runs on power" pays here.
  S.ACTION_POWER = {
    // Captain
    cmd_adv: 8, grant: 6, bc_flee: 8, bc_ram: 12, bc_allhands: 12, rally: 3,
    // Gunners / turrets
    attack: 8, called: 10, launch: 6, quickaim: 3, adjust: 2,
    // Engineer (repair itself is free — it's a hands-on fix)
    reroute: 6, patch: 4,
    // Shields / Comms
    allocate: 10, jam: 6, hail: 2, micro: 4,
    // Science / Sensors
    scan: 6, counter: 5, navsupport: 8, ping: 2,
    // Cloaking
    engage: 12, burst: 15, phase: 10, decoy: 8, stealth: 6,
    // Boarding
    launch_breach: 6, repel: 0,
    // The six rebuildable turrets. These MUST be here as well as being charged
    // in runTurret: the ⚡ badge on the button is looked up by action id, so a
    // missing entry means the button silently claims the shot is free.
    flakspread: 8, apshot: 8, plasmashot: 9, cryobeam: 8, ionshot: 9, gravwell: 10
  };
  S.actionPower = (a) => (a && S.ACTION_POWER[a.id]) || 0;

  /* ---------------------------------------------------------------------- */
  /*  Status effects                                                         */
  /*                                                                          */
  /*  Every entry in the status appendix of ship/ship-combat.md, as data.      */
  /*  A ship carries `statuses: [{id, src, expiresRound, data}]`; the engine   */
  /*  never reads a status's rules text, only the fields below.                */
  /*                                                                          */
  /*  scope tells expireStatuses when to drop it:                             */
  /*    "round"    — until the end of the owning ship's next turn             */
  /*    "rounds"   — a counted duration (expiresRound is set on apply)        */
  /*    "until"    — cleared by an event (fire, move, repair, a Patch Job)    */
  /*    "next-hit" — consumed by the next hit that lands                      */
  /* ---------------------------------------------------------------------- */

  S.STATUSES = {
    // --- Pilot posture -----------------------------------------------------
    evasive:          { label: "Evasive",        kind: "good", scope: "round",    ac: 4,
                        blurb: "+4 AC; forward gunners fire at disadvantage." },
    aggressive:       { label: "Aggressive",     kind: "bad",  scope: "round",    ac: -4,
                        blurb: "−4 AC; forward gunners fire with advantage; enables Ram." },
    hidden:           { label: "In Cover",       kind: "good", scope: "until",    incomingAdv: -1,
                        blurb: "Attacks against you have disadvantage until you move or fire." },
    rerouted:         { label: "Power Rerouted", kind: "good", scope: "round",  ac: 2,
                        blurb: "+2 ship AC this round — the Engineer put the reactor into the shields." },
    ramming_committed:{ label: "Ramming",        kind: "warn", scope: "round",
                        blurb: "Committed to a ram — you cannot change maneuver this round." },

    // --- Shields & systems -------------------------------------------------
    shields_down:     { label: "Shields Down",   kind: "bad",  scope: "rounds",   noShield: true,
                        blurb: "No shield damage reduction on any facing." },
    engines_disabled: { label: "Engines Down",   kind: "bad",  scope: "rounds",   noMove: true, ac: -2,
                        blurb: "No Movement Points and no maneuver modifier." },
    weapon_offline:   { label: "Weapon Offline", kind: "bad",  scope: "rounds",
                        blurb: "One gun cannot fire." },

    // --- Applied by weapons ------------------------------------------------
    frozen:           { label: "Frozen",         kind: "bad",  scope: "next-hit", incomingAdv: 1, incomingMult: 2,
                        blurb: "The next kinetic hit has advantage and deals double damage." },
    grappled:         { label: "Grappled",       kind: "bad",  scope: "rounds",   noMove: true, incomingAdv: 1,
                        blurb: "No movement; attacks against you have advantage; rams deal double." },
    on_fire:          { label: "On Fire",        kind: "bad",  scope: "until",    dot: "1d4",
                        blurb: "1d4 hull at the start of your turn until patched or repaired." },

    // --- Information & boarding -------------------------------------------
    painted:          { label: "Painted",        kind: "warn", scope: "rounds",   scanAdv: 1,
                        blurb: "The next scan of this ship is made with advantage." },
    // Applied to the GULL by an enemy shields officer.
    jammed:           { label: "Fire Control Jammed", kind: "bad", scope: "rounds", gunDis: true,
                        blurb: "Gunnery rolls are made at disadvantage." },
    // Applied to an ENEMY by her own science officer.
    shrouded:         { label: "Shrouded",       kind: "good", scope: "rounds",   scanAdv: -1,
                        blurb: "Scans of this ship are made at disadvantage." },
    boarded:          { label: "Boarded",        kind: "warn", scope: "until",
                        blurb: "Enemy crew are physically aboard." },
    cloaked:          { label: "Cloaked",        kind: "good", scope: "until",    incomingAdv: -1,
                        blurb: "Undetectable; attacks against you have disadvantage until you fire." },

    // --- People ------------------------------------------------------------
    station_shock:    { label: "Station Shock",  kind: "bad",  scope: "round",
                        blurb: "Knocked off the chair — spend your Bonus re-seating, or lose it." },
    adrift:           { label: "Crew Adrift",    kind: "bad",  scope: "until",
                        blurb: "A crew member is in open space. Combat cannot end until they are recovered." }
  };
  S.status = (id) => S.STATUSES[id] || null;
  S.STATUS_IDS = Object.keys(S.STATUSES);

  // Normalise whatever is stored into a clean status array.
  S.normalizeStatuses = function (list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const s of list) {
      if (!s || !S.STATUSES[s.id]) continue;
      out.push({
        id: String(s.id),
        src: String(s.src || ""),
        expiresRound: Number.isFinite(s.expiresRound) ? s.expiresRound : null,
        data: (s.data && typeof s.data === "object") ? { ...s.data } : {}
      });
    }
    return out;
  };

  S.hasStatus = (ship, id) => !!(ship?.statuses || []).some((s) => s.id === id);
  S.getStatus = (ship, id) => (ship?.statuses || []).find((s) => s.id === id) || null;

  /** Add a status. `rounds` only means anything for scope:"rounds". Re-applying refreshes. */
  S.applyStatus = function (ship, id, { src = "", rounds = 1, round = 1, data = {} } = {}) {
    const def = S.STATUSES[id];
    // A truthy non-object (a number, a string) passed the old !ship check and then
    // threw on .statuses.find. Refuse anything that is not a real record.
    if (!ship || typeof ship !== "object" || !def) return null;
    ship.statuses = S.normalizeStatuses(ship.statuses);
    const expiresRound = def.scope === "rounds" ? round + Math.max(1, rounds)
      : def.scope === "round" ? round + 1 : null;
    const existing = ship.statuses.find((s) => s.id === id);
    if (existing) {
      // Refresh rather than stack — a second Shields Down should not mean two of them.
      existing.src = src || existing.src;
      existing.data = { ...existing.data, ...data };
      if (expiresRound != null) existing.expiresRound = Math.max(existing.expiresRound ?? 0, expiresRound);
      return existing;
    }
    const st = { id, src, expiresRound, data: { ...data } };
    ship.statuses.push(st);
    return st;
  };

  S.clearStatus = function (ship, id) {
    if (!ship) return false;
    const before = (ship.statuses || []).length;
    ship.statuses = S.normalizeStatuses(ship.statuses).filter((s) => s.id !== id);
    return ship.statuses.length !== before;
  };

  /** Drop everything whose clock has run out. Called at the start of a ship's turn. */
  S.expireStatuses = function (ship, round) {
    if (!ship) return [];
    const before = S.normalizeStatuses(ship.statuses);
    const kept = before.filter((s) => s.expiresRound == null || s.expiresRound > round);
    ship.statuses = kept;
    return before.filter((s) => !kept.includes(s)).map((s) => s.id);
  };

  /**
   * Everything the rest of the engine needs to know about a ship's statuses,
   * flattened into one object. Pure: it reads, it never writes.
   */
  S.statusMods = function (ship) {
    const out = { ac: 0, incomingAdv: 0, scanAdv: 0, incomingMult: 1,
                  noShield: false, noMove: false, gunDis: false, dots: [], ids: [] };
    for (const s of S.normalizeStatuses(ship?.statuses)) {
      const def = S.STATUSES[s.id];
      if (!def) continue;
      out.ids.push(s.id);
      if (def.ac) out.ac += def.ac;
      if (def.incomingAdv) out.incomingAdv += def.incomingAdv;
      if (def.scanAdv) out.scanAdv += def.scanAdv;
      if (def.incomingMult) out.incomingMult *= def.incomingMult;
      // A facing-scoped Shields Down is not a ship-wide one — S.shieldDR reads the
      // facing off the status itself.
      if (def.gunDis) out.gunDis = true;
      if (def.noShield && !(s.id === "shields_down" && s.data && s.data.facing)) out.noShield = true;
      if (def.noMove) out.noMove = true;
      if (def.dot) out.dots.push({ id: s.id, formula: def.dot });
    }
    return out;
  };
  // Crew can arrive as an array (one ship's crew — the multi-ship form), as a
  // combat object with a .crew map (the original single-ship form), or as null.
  // Normalising here is what lets one AC function serve the Gull and every enemy.
  S.crewList = function (crewOrCombat) {
    if (!crewOrCombat) return [];
    if (Array.isArray(crewOrCombat)) return crewOrCombat;
    if (crewOrCombat.crew) return Object.values(crewOrCombat.crew);
    return Object.values(crewOrCombat);
  };

  // Effective per-facing ship AC.
  //
  // Shields no longer add AC — they are damage reduction (S.shieldDR). AC is
  // base + pilot maneuver + status modifiers only, which keeps it in a readable
  // 8-18 band instead of the 10-25 band that made Session 5's AC 24-25 feel
  // arbitrary: past a threshold nothing lands, below it everything does.
  // The four facings therefore share a number; what differs per facing is DR.
  S.shipAC = function (state, crewOrCombat) {
    const raw = Number(state?.ac?.base), base = Number.isFinite(raw) ? raw : 13;
    let manMod = 0, manLabel = "";
    const crew = S.crewList(crewOrCombat);
    const mods = S.statusMods(state);
    if (crew.length) {
      const pilot = crew.find((c) => c && c.station === "pilot" && c.maneuver);
      const m = pilot && S.MANEUVERS[pilot.maneuver];
      // Pinned ships lose the BENEFIT of a posture, never its cost: grappling a
      // ship that had committed to Aggressive used to raise its AC by 4.
      if (m && (!mods.noMove || m.ac < 0)) { manMod = m.ac; manLabel = m.label; }
    }
    const ac = base + manMod + mods.ac;
    const out = { base, maneuver: manMod, maneuverLabel: manLabel, status: mods.ac, dr: {} };
    for (const f of S.FACINGS) { out[f] = ac; out.dr[f] = S.shieldDR(state, f); }
    return out;
  };

  /**
   * What a facing's shields do to an incoming damage packet.
   *   half  — the main allocated facing halves damage
   *   flat  — the Micro-Adjust secondary facing takes 3 off
   * Returns {half:boolean, flat:number, label:string}.
   */
  S.MICRO_DR = 3;
  S.shieldDR = function (state, facing) {
    const none = { half: false, flat: 0, label: "" };
    if (!state) return none;
    // Unknown shields are assumed to work — see S.systemKnown.
    if (S.systemKnown(state, "shields") && !S.systemWorks(state, "shields")) return none;
    const mods = S.statusMods(state);
    if (mods.noShield) return none;
    // A grazing miss drops ONE facing for a round. Ship-wide Shields Down has no
    // facing on it and is handled above; a facing-scoped drop only kills its own arc.
    const down = S.getStatus(state, "shields_down");
    if (down && down.data && down.data.facing === facing) return none;
    const sh = state.shield || {};
    const half = !!(sh.on && sh.facing === facing);
    const flat = sh.secondary === facing ? S.MICRO_DR : 0;
    return { half, flat, label: half ? "SHIELDED" : flat ? "MICRO" : "" };
  };

  /* ---------------------------------------------------------------------- */
  /*  Facing — which arc did that shot come from?                            */
  /*                                                                          */
  /*  Session 4's best play was swinging the ship so the enemy's unshielded   */
  /*  rear was pointing at the guns. That was worked out by eye at the table;  */
  /*  here it falls out of the two tokens' positions, so flanking is a real   */
  /*  mechanic rather than a GM ruling.                                       */
  /*                                                                          */
  /*  Convention matches the pilot's movement maths: rotation 0 = nose up,    */
  /*  forward = (sin r, -cos r), screen y grows downward.                     */
  /* ---------------------------------------------------------------------- */

  /** Signed bearing in degrees of `from` as seen by `target`. 0 = dead ahead, +90 = starboard. */
  S.bearing = function (target, from) {
    const r = ((Number(target?.rotation) || 0) * Math.PI) / 180;
    const nx = Math.sin(r), ny = -Math.cos(r);
    const vx = (from?.x ?? 0) - (target?.x ?? 0);
    const vy = (from?.y ?? 0) - (target?.y ?? 0);
    if (!vx && !vy) return 0;
    const dot = nx * vx + ny * vy;
    const cross = nx * vy - ny * vx;
    return (Math.atan2(cross, dot) * 180) / Math.PI;
  };

  /** The facing of `target` that a shot from `from` strikes. */
  S.facingFrom = function (target, from) {
    const b = S.bearing(target, from), a = Math.abs(b);
    if (a <= 45) return "fore";
    if (a > 135) return "aft";
    return b > 0 ? "starboard" : "port";
  };

  /* ---------------------------------------------------------------------- */
  /*  Damage                                                                  */
  /* ---------------------------------------------------------------------- */

  // Order is deliberate and is asserted in the selftest: status multipliers,
  // then resistance, then shields, then armour, then floor at zero. Armour last
  // is what makes the Iron Directorate's "many small hits are worthless" read.
  S.RESIST = { immune: 0, half: 0.5, normal: 1, double: 2 };
  S.resolveDamage = function (ship, raw, facing, { type = "kinetic", ignoreShields = false, ignoreArmour = false } = {}) {
    const steps = [];
    // Clamp hard: an Infinity or a NaN in here propagates into hull totals, bar
    // widths and chat, and there is no legitimate packet above a few hundred.
    const rawNum = Number(raw);
    let dmg = Number.isFinite(rawNum) ? Math.max(0, Math.min(99999, Math.round(rawNum))) : 0;
    steps.push({ label: "raw", value: dmg });

    const mods = S.statusMods(ship);
    if (mods.incomingMult !== 1) { dmg = Math.round(dmg * mods.incomingMult); steps.push({ label: `×${mods.incomingMult} (status)`, value: dmg }); }

    const res = ship?.resist?.[type];
    if (res && S.RESIST[res] !== undefined && S.RESIST[res] !== 1) {
      dmg = Math.floor(dmg * S.RESIST[res]);
      steps.push({ label: `${res} to ${type}`, value: dmg });
    }

    let shield = { half: false, flat: 0, label: "" };
    if (!ignoreShields) {
      shield = S.shieldDR(ship, facing);
      if (shield.half) { dmg = Math.floor(dmg / 2); steps.push({ label: `shields ${facing}`, value: dmg }); }
      if (shield.flat) { dmg = Math.max(0, dmg - shield.flat); steps.push({ label: `micro-adjust −${shield.flat}`, value: dmg }); }
    }

    const armour = ignoreArmour ? 0 : Math.max(0, Number(ship?.armour) || 0);
    if (armour) { dmg = Math.max(0, dmg - armour); steps.push({ label: `armour −${armour}`, value: dmg }); }

    // Statuses whose whole scope is "the next hit" are spent by this hit. The
    // function stays pure — it reports what to clear, and gmApplyDamage clears it
    // in the same write. Before this, `frozen` had no expiry clock at all and
    // doubled every hit for the rest of the fight.
    const consumed = S.normalizeStatuses(ship?.statuses)
      .filter((st) => S.STATUSES[st.id]?.scope === "next-hit").map((st) => st.id);
    return { final: Math.max(0, dmg), facing, absorbed: Math.max(0, Math.round(Number(raw) || 0) - Math.max(0, dmg)),
             shielded: shield.half || shield.flat > 0, steps, consumed };
  };

  /* ---------------------------------------------------------------------- */
  /*  Range bands                                                            */
  /* ---------------------------------------------------------------------- */

  /** Which band a target sits in for a given gun. distance is in grid squares. */
  S.rangeBand = function (gun, distance) {
    const d = Number(distance) || 0;
    if (!gun) return "out";
    if (d <= gun.shortMax) return "close";
    if (d <= gun.longMax) return "long";
    return "out";
  };
  // Long range costs accuracy and bite; out of range cannot be fired at all.
  S.LONG_TO_HIT = -5;
  S.rangePenalty = function (gun, distance) {
    const band = S.rangeBand(gun, distance);
    if (band === "close") return { band, toHit: 0, halve: false, ok: true };
    if (band === "long") {
      // The Heavy Autocannon is authored `longNote: "no penalty"`, and the gunner's
      // own panel says so — but the maths charged it −5 and halved its damage anyway.
      const free = /no penalty/i.test(String(gun?.longNote || ""));
      return { band, toHit: free ? 0 : S.LONG_TO_HIT, halve: !free, ok: true };
    }
    return { band, toHit: 0, halve: false, ok: false };
  };

  // Roles a crew can be proficient in — the active bridge stations (each makes rolls), EXCEPT Boarding.
  // A crew proficient in a role adds their character's proficiency bonus to that station's rolls.
  S.profRoles = () => S.STATIONS.filter((st) => st.defaultUnlocked && st.id !== "boarding").map((st) => ({ id: st.id, name: st.name }));

  // The crew — a persistent roster of characters, each normally played by one user.
  // Combat participants are drawn from this roster; the GM can reassign who controls
  // each one (e.g. cover an absent player) and exclude any from a given fight.
  S.defaultRoster = function () {
    return [
      { id: "astra", name: "ASTRA",        userId: "", prof: {} },
      { id: "kael",  name: "Kael Voss",    userId: "", prof: {} },
      { id: "baldy", name: "Baldy",        userId: "", prof: {} },
      { id: "gobby", name: "Gobby",        userId: "", prof: {} },
      { id: "glimm", name: "G.L.I.M.M.",   userId: "", prof: {} },
      { id: "ronon", name: "Ronon Dex",    userId: "", prof: {} },
      { id: "gerth", name: "Gerthorlemue", userId: "", prof: {} }
    ];
  };

  S.defaultCombat = function () {
    const rolesEnabled = {};
    for (const st of S.STATIONS) rolesEnabled[st.id] = !!st.defaultUnlocked;
    return { active: false, turn: 1, round: 1, rolesEnabled, roster: S.defaultRoster(), crew: {},
             pendingSwap: null,
             // Boarding: userId -> {shipId, deck}. Absent means "on the Gull's
             // main deck", which is where everyone starts and where they return.
             whereIs: {},
             spool: 0,             // Captain's hyperfold spool: three successes and the fight is over
             gunBuff: "",          // Engineer's gun rail: added to the next gunner hit
             ships: {},            // every ship in the engagement, the Gull included as "gull"
             initiative: [],       // [{shipId, roll}] sorted high-to-low
             activeShip: "gull" };
  };

  // Merge stored combat onto defaults so new fields/stations forward-migrate.
  S.normalizeCombat = function (stored) {
    const d = S.defaultCombat();
    if (!stored || typeof stored !== "object") return d;
    const out = {
      active: !!stored.active,
      turn: Number.isFinite(stored.turn) ? stored.turn : 1,
      round: Number.isFinite(stored.round) && stored.round > 0 ? Math.floor(stored.round) : (Number.isFinite(stored.turn) ? stored.turn : 1),
      ships: S.normalizeShips(stored.ships),
      initiative: Array.isArray(stored.initiative)
        ? stored.initiative.filter((e) => e && e.shipId).map((e) => ({ shipId: String(e.shipId), roll: Number(e.roll) || 0 }))
        : [],
      activeShip: String(stored.activeShip || "gull"),
      whereIs: (() => {
        const out = {};
        for (const [uid, w] of Object.entries(stored.whereIs || {})) {
          if (!w || !w.shipId) continue;
          out[uid] = { shipId: String(w.shipId), deck: Math.max(1, Number(w.deck) || 1) };
        }
        return out;
      })(),
      spool: Math.max(0, Math.min(3, Number(stored.spool) || 0)),
      gunBuff: String(stored.gunBuff || ""),
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
        if (m && m.id && m.name) out.roster.push({ id: String(m.id), name: String(m.name), userId: String(m.userId || ""),
          prof: (m.prof && typeof m.prof === "object") ? { ...m.prof } : {} });   // survives end/start of combat
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
        granted: Number.isFinite(c.granted) && c.granted > 0 ? Math.floor(c.granted) : 0,
        maneuver: S.MANEUVERS[c.maneuver] ? c.maneuver : null,        // pilot: chosen this turn
        mp: Number.isFinite(c.mp) && c.mp > 0 ? Math.floor(c.mp) : 0, // pilot: Movement Points left
        mpMax: Number.isFinite(c.mpMax) && c.mpMax > 0 ? Math.floor(c.mpMax) : 0, // pilot: this turn's full pool (after nav mult)
        navMult: Number.isFinite(c.navMult) && c.navMult >= 1 ? c.navMult : 1,     // pilot: Science nav-support multiplier this turn
        gun: S.gun(c.gun) ? c.gun : null,                                          // gunner: which gun is selected in the turn bar
        target: String(c.target || ""),   // gunner: which enemy ship this gun is laid on (persists across turns)
        // What the Captain and Engineer have handed this seat for the round.
        buff: (c.buff && typeof c.buff === "object")
          ? { flat: Math.max(0, Number(c.buff.flat) || 0), adv: !!c.buff.adv, die: String(c.buff.die || ""), turretAim: !!c.buff.turretAim }
          : { flat: 0, adv: false, die: "", turretAim: false },
        prof: (c.prof && typeof c.prof === "object") ? { ...c.prof } : {}   // {rollActionId: true} — persists
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


  /* ====================================================================== */
  /*  The fleet: factions, classes, ship records                            */
  /* ====================================================================== */

  /* ---------------------------------------------------------------------- */
  /*  Factions                                                               */
  /*                                                                          */
  /*  `politics` is the id in the ssv-silver-gull-politics module — those     */
  /*  three move a real standing number when you kill or spare one of their   */
  /*  hulls, and their crest is read live from that module so the colours     */
  /*  match what the players already see in the Politics tab.                 */
  /*  A hull with faction "" is unaligned: no crest, no standing, no          */
  /*  signature ability. That is itself information at the table.             */
  /* ---------------------------------------------------------------------- */

  S.FACTIONS = {
    "iron-directorate": {
      name: "The Iron Directorate", short: "Directorate", politics: "iron-directorate",
      color: "#8a939c", accent: "#e0343d", resolve: 8,
      signature: "Armour X — every damage packet is reduced. Two Directorate hulls within 2 squares share a shield pool.",
      wants: "To hold you in place.",
      abilities: ["armour_plate", "shield_link", "blockade", "cyber_boarders", "siege_barrage", "point_defence", "reinforce", "lockdown"]
    },
    "apostles-threshold": {
      name: "The Apostles of the Threshold", short: "Apostles", politics: "apostles-threshold",
      color: "#3f8fe0", accent: "#d4af37", resolve: null,   // null = never breaks
      signature: "Zeal — no morale. At half hull they enter Rapture. At 0 hull the three-module self-destruct fires.",
      wants: "To die on top of you.",
      abilities: ["self_destruct", "rapture", "reflector_shields", "plasma_lance", "boarding_pods", "zealot_charge", "martyr_ram", "no_parley"]
    },
    "sovereign-horizon": {
      name: "The Sovereign Horizon", short: "Horizon", politics: "sovereign-horizon",
      color: "#f2a03d", accent: "#e0552b", resolve: 4,
      signature: "Ghost Contacts — they arrive unresolved, mixed with decoys. Slip: forfeit movement to halve a hit.",
      wants: "Cargo, and an exit.",
      abilities: ["ghost_contacts", "slip", "engage_cloak", "decoy_drop", "smuggler_hold", "overtune_engine", "illegal_gun", "cut_and_run"]
    },
    "frostwatch": {
      name: "The Frostwatch", short: "Frostwatch", politics: null,
      color: "#7fd4e8", accent: "#cfeef0", resolve: 6,
      signature: "Precision — never targets hull; every shot is a free Called Shot. Compliance: hold fire and their damage halves.",
      wants: "Compliance.",
      abilities: ["precision_fire", "compliance", "deep_scan", "quiet_approach", "warning_shot", "sensor_lock", "impound", "escort_wing"]
    },
    "rift": {
      name: "Rift Vessel", short: "Rift", politics: null,
      color: "#b06bf0", accent: "#ff4fd8", resolve: null,
      signature: "Unmeasurable. Ignores shields, reduction and AC. Looking at it is the danger.",
      wants: "Nothing you can offer.",
      abilities: ["unmeasurable", "gravitic_unmaking", "phase_discontinuity", "it_notices_you", "rewrite_the_board", "no_wreck"]
    }
  };
  S.faction = (id) => (id && S.FACTIONS[id]) || null;
  S.factionName = (id) => S.faction(id)?.short || "Unaligned";

  /* ---------------------------------------------------------------------- */
  /*  Hull classes                                                            */
  /*                                                                          */
  /*  `sizeSq` is the hull's real footprint in grid squares, read off the map  */
  /*  pack's own exterior scene. It drives BOTH the stat band and the token    */
  /*  silhouette — but never directly: a 100x135 hull as a 100x135 token on a  */
  /*  40x30 space board is nonsense, so the class buckets it.                  */
  /*                                                                          */
  /*  Hull numbers come from the tuning laws, not taste: the Gull puts out     */
  /*  ~21 raw damage a round, and a fight should last 4-6 rounds.              */
  /* ---------------------------------------------------------------------- */

  S.SHIP_CLASSES = [
    { id: "fighter",   name: "Fighter",    maxSide: 14, token: [1, 1], scale: 0.62, hull: [15, 25],   ac: 15, crew: [1, 2],   mp: 8,
      blurb: "One hit, one kill. Four of them fly as a single squadron token." },
    { id: "corvette",  name: "Corvette",   maxSide: 40, token: [1, 1], scale: 1.0,  hull: [100, 140], ac: 13, crew: [4, 8],   mp: 6,
      blurb: "The Gull's own weight class." },
    { id: "frigate",   name: "Frigate",    maxSide: 60, token: [2, 2], scale: 1.0,  hull: [160, 220], ac: 12, crew: [8, 16],  mp: 4,
      blurb: "Slower, tougher, hits from more arcs." },
    // The band used to be the PER-SECTION figure (4 x ~110), but sectioned hulls
    // are not implemented — so a cruiser shipped with 110 total and was weaker
    // than a corvette. Until sections land, the band is the whole ship.
    { id: "cruiser",   name: "Cruiser",    maxSide: 90, token: [3, 3], scale: 1.0,  hull: [400, 480], ac: 11, crew: [16, 30], mp: 3, sections: 4,
      blurb: "Four sections' worth of ship. Kill it a quarter at a time — go for the guns, not the middle." },
    // A capital is fought as a level — you board her and kill the reactor — but she
    // still needs a real hull number: a (0, 0) band spawned the Platanus DERELICT
    // before the first shot, with a 0/1 bar on her card.
    { id: "capital",   name: "Capital",    maxSide: Infinity, token: [4, 4], scale: 1.0, hull: [900, 1400], ac: 10, crew: [30, 60], mp: 2, isLevel: true,
      blurb: "A level, not a duel. Fight her batteries, board her, blow the reactor — chewing 1200 hull off is not the plan." }
  ];
  S.shipClass = (id) => S.SHIP_CLASSES.find((c) => c.id === id) || null;
  /** Pick a class from the hull's real footprint [w,h] in grid squares. */
  S.classFor = function (sizeSq) {
    const side = Array.isArray(sizeSq) ? Math.max(sizeSq[0] || 0, sizeSq[1] || 0) : Number(sizeSq) || 0;
    return S.SHIP_CLASSES.find((c) => side <= c.maxSide) || S.SHIP_CLASSES[S.SHIP_CLASSES.length - 1];
  };
  /** Token footprint in squares, preserving the hull's aspect so nose-up art doesn't distort. */
  S.tokenSizeFor = function (sizeSq) {
    const cls = S.classFor(sizeSq);
    const [w, h] = Array.isArray(sizeSq) ? sizeSq : [sizeSq, sizeSq];
    const [tw, th] = cls.token;
    const aspect = (Number(h) || 1) / (Number(w) || 1);
    // Long hulls get an extra square along their length rather than a fatter square.
    if (aspect >= 1.5) return { width: tw, height: Math.max(th, Math.round(tw * Math.min(aspect, 2.2))), scale: cls.scale, cls: cls.id };
    if (aspect <= 1 / 1.5) return { width: Math.max(tw, Math.round(th * Math.min(1 / aspect, 2.2))), height: th, scale: cls.scale, cls: cls.id };
    return { width: tw, height: th, scale: cls.scale, cls: cls.id };
  };

  /* ---------------------------------------------------------------------- */
  /*  Deck plans, and the skins that do not have one                          */
  /*                                                                          */
  /*  Map packs ship POSE skins — "Landed", "TuckedUp", "Breached Stage 2",    */
  /*  "Original Deployed" — that carry an exterior and no interior at all, and */
  /*  a handful of colour skins that are simply missing an upper deck. Picking */
  /*  one of those at spawn used to mean the party physically could not board  */
  /*  that ship: buildDeckScene found no decks and gave up with a warning.     */
  /*                                                                          */
  /*  A ship's interior does not change because it is painted differently, so  */
  /*  the missing decks are borrowed from whichever skin actually has them     */
  /*  ("Original" winning ties). Every skin of every hull is boardable.        */
  /* ---------------------------------------------------------------------- */

  /**
   * The deck plan for one skin, with gaps filled from a donor skin.
   * Returns `{ decks, borrowed, donor, complete }` — `decks` keyed by deck
   * number exactly like the raw skin record, so callers substitute it directly.
   */
  S.decksForSkin = function (hull, skin) {
    const skins = (hull && hull.skins) || {};
    const want = Math.max(1, Number(hull && hull.decks) || 1);
    const own = (skins[skin] && skins[skin].decks) || {};

    let donor = null, donorName = "", best = -1;
    for (const [name, sk] of Object.entries(skins)) {
      const n = Object.keys((sk && sk.decks) || {}).length;
      // Strictly better, or equally good and canonically named.
      if (n > best || (n === best && name === "Original")) { best = n; donor = sk; donorName = name; }
    }

    const decks = {};
    let borrowed = 0;
    for (let d = 1; d <= want; d++) {
      const k = String(d);
      if (own[k]) decks[k] = own[k];
      else if (donor && donor.decks && donor.decks[k]) { decks[k] = { ...donor.decks[k], borrowedFrom: donorName }; borrowed++; }
    }
    const keys = Object.keys(decks);
    return { decks, borrowed, donor: borrowed ? donorName : "", complete: keys.length >= want, count: keys.length };
  };

  S.DOCTRINES = {
    brawler:   { name: "Brawler",   hint: "Close to 1-2 and hold there. Fire every round." },
    sniper:    { name: "Sniper",    hint: "Stay at long range. Called Shot the engines first." },
    ambusher:  { name: "Ambusher",  hint: "Stay unresolved until they are within 3, then alpha strike." },
    boarder:   { name: "Boarder",   hint: "Close to 1 and launch pods. The guns are a distraction." },
    turtle:    { name: "Turtle",    hint: "Shields to the threatened arc. Repair. Outlast them." },
    escort:    { name: "Escort",    hint: "Screen the biggest friendly. Intercept boarders." },
    predator:  { name: "Predator",  hint: "Ignore the escorts. Go for the flagship." }
  };
  S.doctrine = (id) => S.DOCTRINES[id] || S.DOCTRINES.brawler;

  /* ---------------------------------------------------------------------- */
  /*  A ship record                                                          */
  /*                                                                          */
  /*  The Gull and every enemy share this shape, so one set of helpers serves  */
  /*  both. The Gull keeps its authoritative copy in the `shipState` setting;  */
  /*  combatState.ships.gull is a view over it.                                */
  /* ---------------------------------------------------------------------- */


  /* ---------------------------------------------------------------------- */
  /*  Seating an enemy crew                                                  */
  /*                                                                          */
  /*  One crew member per station, exactly as the Gull's own rule says. A role */
  /*  with more people than seats leaves the extras unassigned — they are      */
  /*  spare hands, and a boarding party's best move is still killing whoever   */
  /*  is actually sitting somewhere.                                          */
  /*                                                                          */
  /*  The seat lists also mean a bigger crew fills more of the bridge: the     */
  /*  second engineer takes Shields, the third takes Science, so a frigate can */
  /*  jam and scan while a fighter cannot.                                    */
  /* ---------------------------------------------------------------------- */
  S.ROLE_SEATS = {
    captain:  ["captain"],
    pilot:    ["pilot"],
    gunner:   ["gunner_port", "gunner_starboard"],
    engineer: ["engineer", "shields_officer", "science"],
    marine:   [],
    zealot:   []
  };

  /**
   * Turn a roster into seats. `roles` is [{role, n}]; `want` is how many are
   * actually aboard. Bridge roles are filled first so dropping the headcount
   * never leaves a warship with nobody flying it.
   * Returns [{roleId, station, index}] in seating order.
   */
  S.assignSeats = function (roles, want) {
    const order = ["captain", "pilot", "gunner", "engineer", "marine", "zealot"];
    const list = (Array.isArray(roles) ? roles : []).slice()
      .sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
    const taken = new Set(), out = [];
    let made = 0;
    const cap = Math.max(0, Number(want) || 0);
    for (const r of list) {
      const seats = S.ROLE_SEATS[r.role] || [];
      for (let i = 0; i < (Number(r.n) || 0) && made < cap; i++, made++) {
        const seat = seats.find((x) => !taken.has(x)) || "";
        if (seat) taken.add(seat);
        out.push({ roleId: r.role, station: seat, index: i });
      }
    }
    return out;
  };

  /* ---------------------------------------------------------------------- */
  /*  Driving an enemy seat                                                   */
  /*                                                                          */
  /*  The GM's requirement is speed: pick a chair, press a button, move on.    */
  /*  So the action list per seat is short, every entry does one legible thing */
  /*  to numbers the model already holds, and gunners get one button per gun   */
  /*  rather than a gun picker plus a fire button.                            */
  /*                                                                          */
  /*  Pure on purpose — the selftest holds every seat to producing at least    */
  /*  one action, so a hull can never present an empty chair.                  */
  /* ---------------------------------------------------------------------- */

  S.ENEMY_SEAT_ACTIONS = {
    captain: [
      { id: "e_rally", label: "Rally", hint: "Shake off one status and steady the crew." },
      { id: "e_focus", label: "Focus fire", hint: "Every gunner aboard gets +2 to hit until this ship's next turn." },
      { id: "e_ram", label: "Ram", hint: "Commit to a collision. Both hulls take it." }
    ],
    pilot: [
      { id: "e_close", label: "Close", hint: "Burn toward the Gull — one range band." },
      { id: "e_open", label: "Open range", hint: "Fall back a band and present a fresh arc." },
      { id: "e_about", label: "Come about", hint: "Rotate 90° to bring the shielded facing round." },
      { id: "e_evade", label: "Evade", hint: "Evasive: +4 AC until this ship's next turn." }
    ],
    engineer: [
      { id: "e_repair", label: "Repair", hint: "Bring the worst-hurt system back by 2." },
      { id: "e_reroute", label: "Reroute", hint: "+2 to hit on this ship's next shot." }
    ],
    shields_officer: [
      { id: "e_shield", label: "Shields to the threat", hint: "Move the shield to the arc the Gull is actually on." },
      { id: "e_jam", label: "Jam", hint: "The Gull's next gunnery roll has disadvantage." }
    ],
    science: [
      { id: "e_lock", label: "Sensor lock", hint: "+2 to this ship's next attack roll." },
      { id: "e_cm", label: "Countermeasures", hint: "The Gull's next scan of this hull has disadvantage." }
    ],
    "": [
      { id: "e_brace", label: "Brace", hint: "A spare hand shores up a bulkhead — +2 AC this round." }
    ]
  };

  /**
   * The buttons for one enemy seat, given the ship's actual guns and condition.
   * Gunners get one button per gun that is still online; a dead crew member and
   * an unmanned chair both return nothing.
   */
  S.enemySeatActions = function (ship, crew) {
    if (!ship || !crew || crew.dead) return [];
    const st = crew.station || "";
    if (st === "gunner_port" || st === "gunner_starboard") {
      const guns = (ship.guns || []).filter((g) => g && g.id && S.gunOnline(ship, g.id));
      if (!guns.length) return [{ id: "e_nogun", label: "No gun online", hint: "Every mount this ship has is down.", disabled: true }];
      return guns.map((g) => ({
        id: `e_fire:${g.id}`, label: `Fire — ${g.label || g.id}`,
        hint: `${g.damage || "?"} damage, +${g.toHit ?? 0} to hit, ${g.shortMax ?? 0}–${g.longMax ?? 0} squares, ${g.arc || "fore"} arc.`
      }));
    }
    const list = S.ENEMY_SEAT_ACTIONS[st] || S.ENEMY_SEAT_ACTIONS[""];
    return list.map((a) => ({ ...a }));
  };

  /**
   * What this ship would do on its own, from its doctrine and the range it is at.
   * Returned as an ordered list of the same action ids the seats use, so `▶ Run`
   * and hand-driving go down exactly one code path.
   */
  S.enemyStandingOrders = function (ship, { distance = 4 } = {}) {
    if (!ship) return [];
    const doc = String(ship.doctrine || "brawler");
    const seatOf = (station) => S.liveCrew(ship).find((c) => c.station === station) || null;
    const out = [];
    const want = { brawler: 2, sniper: 8, ambusher: 3, boarder: 1, turtle: 4, escort: 3, predator: 2 }[doc] ?? 3;
    const d = Number.isFinite(Number(distance)) ? Number(distance) : 4;

    const pilot = seatOf("pilot");
    if (pilot) {
      if (d > want + 1) out.push({ crewId: pilot.id, action: "e_close", why: `${doc} — wants ${want} squares, is at ${d}` });
      else if (d < want - 1) out.push({ crewId: pilot.id, action: "e_open", why: `${doc} — wants ${want} squares, is at ${d}` });
      else out.push({ crewId: pilot.id, action: "e_about", why: `${doc} — in position, presenting a fresh arc` });
    }
    // The captain was the one seat the plan never used, so a captain-only hull
    // produced an empty turn and `▶ Run` did nothing at all.
    const cap = seatOf("captain");
    if (cap) {
      const bad = (ship.statuses || []).find((x) => S.STATUSES[x.id]?.kind === "bad");
      out.push({ crewId: cap.id, action: bad ? "e_rally" : "e_focus",
                 why: bad ? `shake off ${S.STATUSES[bad.id].label}` : "call the target before the guns speak" });
    }
    const shields = seatOf("shields_officer");
    if (shields) out.push({ crewId: shields.id, action: "e_shield", why: "cover the arc the Gull is on" });

    // An engineer with something broken fixes it; otherwise they overcharge a gun.
    const eng = seatOf("engineer");
    if (eng) {
      const hurt = Object.entries(ship.systemHp || {}).some(([, hp]) => hp && hp.cur < hp.max);
      out.push({ crewId: eng.id, action: hurt ? "e_repair" : "e_reroute", why: hurt ? "something aboard is broken" : "nothing to fix — overcharge a mount" });
    }
    const sci = seatOf("science");
    if (sci) out.push({ crewId: sci.id, action: "e_lock", why: "lay a lock before the guns speak" });

    // The pilot's order lands before the guns do, so judge BOTH range and arc from
    // where the ship will be pointing afterwards, not where it is now. Closing and
    // coming about put the nose on the target; opening the range turns the stern
    // to them, which is what puts a fore mount out of the fight.
    const pilotOrder = out.find((o) => ["e_close", "e_open", "e_about"].includes(o.action));
    const moved = pilotOrder?.action === "e_close" ? Math.max(0, d - 1)
                : pilotOrder?.action === "e_open" ? d + 1 : d;
    const bearing = pilotOrder?.action === "e_open" ? "aft" : "fore";
    const bears = (x) => {
      const arc = String(x.arc || "fore");
      return arc === "all" || arc === "turret" || arc === bearing;
    };
    const usable = (ship.guns || []).filter((x) => x && x.id && S.gunOnline(ship, x.id)
      && moved <= (Number(x.longMax) || 0) && bears(x));
    let n = 0;
    for (const st of ["gunner_port", "gunner_starboard"]) {   // eslint-disable-line
      const g = seatOf(st); if (!g) continue;
      // Give each gunner a different mount where the hull has one, so a frigate
      // with four guns does not fire the same one twice.
      const gun = usable[n] || usable[0];
      if (gun) { out.push({ crewId: g.id, action: `e_fire:${gun.id}`, why: `${gun.label || gun.id} bears at ${moved} squares` }); n++; }
      else out.push({ crewId: g.id, action: "", skipped: true,
                      why: (ship.guns || []).some((x) => moved <= (Number(x.longMax) || 0))
                        ? `no mount bears on their ${bearing === "aft" ? "stern chase" : "bow"} at ${moved} squares`
                        : `nothing aboard reaches ${moved} squares` });
    }
    return out;
  };

  S.DISPOSITIONS = ["hostile", "neutral", "ally"];

  S.defaultShip = function (over = {}) {
    return {
      id: over.id || "ship",
      profileId: over.profileId || "",
      name: over.name || "Unknown Vessel",
      faction: over.faction || "",
      cls: over.cls || "corvette",
      doctrine: over.doctrine || "brawler",
      disposition: S.DISPOSITIONS.includes(over.disposition) ? over.disposition : "hostile",
      hull: { cur: 120, max: 120 },
      ac: { base: 13 },
      armour: 0,
      resist: {},
      systems: {}, systemHp: {},
      shield: { on: true, facing: "fore", secondary: null },
      guns: [],
      abilities: [],
      statuses: [],
      crew: {},
      boardingParty: 0,
      // Focus Fire / Sensor Lock / Reroute all lay a to-hit bonus on this ship's
      // next shot. It lives on the ship, not the seat, because any gunner spends it.
      aimBonus: 0,
      morale: { cur: 4, max: 4 },      // Resolve. cur === null means it never breaks.
      revealed: { ac: false, shields: false, systems: false, crew: false, deckmap: 0 },
      // The documents and art this record is bound to. actorId in particular is
      // load-bearing: without it nothing can delete the actor when the ship goes,
      // and every fight leaves a folder of orphans behind.
      actorId: "", tokenId: "", sceneId: "", combatantId: "",
      skin: "", art: "",
      sizeSq: [20, 30],
      outcome: ""                      // "" | derelict | destroyed | disabled | surrendered | fled
    };
  };

  S.normalizeShip = function (stored) {
    const d = S.defaultShip(stored || {});
    if (!stored || typeof stored !== "object") return d;
    const num = (v, f) => (Number.isFinite(Number(v)) ? Number(v) : f);
    const out = {
      ...d,
      id: String(stored.id || d.id),
      profileId: String(stored.profileId || ""),
      name: String(stored.name || d.name),
      faction: S.faction(stored.faction) ? stored.faction : "",
      cls: S.shipClass(stored.cls) ? stored.cls : d.cls,
      doctrine: S.DOCTRINES[stored.doctrine] ? stored.doctrine : d.doctrine,
      disposition: S.DISPOSITIONS.includes(stored.disposition) ? stored.disposition : d.disposition,
      // A stored max of 0 is ABSENT, not "a ship with one hit point" — clamping it
      // up to 1 is what let the Platanus onto the board at 0/1.
      hull: { max: num(stored.hull?.max, 0) > 0 ? num(stored.hull.max, d.hull.max) : 0,
              cur: num(stored.hull?.cur, d.hull.cur) },
      ac: { base: Math.max(1, num(stored.ac?.base, d.ac.base)) },
      armour: Math.max(0, num(stored.armour, 0)),
      resist: (stored.resist && typeof stored.resist === "object") ? { ...stored.resist } : {},
      systems: {}, systemHp: {},
      shield: {
        on: !!stored.shield?.on,
        facing: S.FACINGS.includes(stored.shield?.facing) ? stored.shield.facing : "fore",
        secondary: S.FACINGS.includes(stored.shield?.secondary) ? stored.shield.secondary : null
      },
      guns: Array.isArray(stored.guns) ? stored.guns.filter((g) => g && g.id).map((g) => ({ ...g })) : [],
      abilities: Array.isArray(stored.abilities) ? stored.abilities.map(String) : [],
      statuses: S.normalizeStatuses(stored.statuses),
      crew: {},
      boardingParty: Math.max(0, num(stored.boardingParty, 0)),
      aimBonus: Math.max(0, Math.min(20, num(stored.aimBonus, 0))),
      morale: stored.morale && stored.morale.cur === null
        ? { cur: null, max: null }
        : { max: Math.max(1, num(stored.morale?.max, d.morale.max)), cur: num(stored.morale?.cur, d.morale.max) },
      revealed: {
        ac: !!stored.revealed?.ac, shields: !!stored.revealed?.shields,
        systems: !!stored.revealed?.systems, crew: !!stored.revealed?.crew,
        deckmap: Math.max(0, Math.min(3, num(stored.revealed?.deckmap, 0)))
      },
      actorId: String(stored.actorId || ""),
      tokenId: String(stored.tokenId || ""), sceneId: String(stored.sceneId || ""),
      combatantId: String(stored.combatantId || ""),
      skin: String(stored.skin || ""), art: String(stored.art || ""),
      sizeSq: Array.isArray(stored.sizeSq) && stored.sizeSq.length === 2
        ? [num(stored.sizeSq[0], 20), num(stored.sizeSq[1], 30)] : d.sizeSq,
      outcome: ["", "derelict", "destroyed", "disabled", "surrendered", "fled"].includes(stored.outcome) ? stored.outcome : ""
    };
    // Systems: an enemy hull carries its own list, which is usually not the Gull's eight.
    const ids = Object.keys(stored.systemHp || stored.systems || {});
    for (const id of (ids.length ? ids : S.SYSTEMS.map((x) => x.id))) {
      const M = S.SYSTEM_HP_MAX;
      const cur = Math.max(0, Math.min(num(stored.systemHp?.[id]?.cur, M), M));
      out.systemHp[id] = { cur, max: M };
      out.systems[id] = S.systemState(out.systemHp[id]);
    }
    // A zero or negative MAX is a malformed record — it would divide by zero in
    // every hull bar, and it is how the Platanus shipped, spawning already at 0
    // and therefore derelict on the first shot. Repair the maximum from the
    // class band and refloat her.
    //
    // A zero CUR with a valid max is not malformed: that is a derelict, and it
    // must stay one. Resetting it here would refloat every wreck on reload.
    if (!(out.hull.max > 0)) {
      const band = S.shipClass(out.cls)?.hull;
      out.hull.max = (band && band[1] > 0) ? Math.round((band[0] + band[1]) / 2) : d.hull.max;
      out.hull.cur = out.hull.max;
    }
    if (!Number.isFinite(out.hull.cur)) out.hull.cur = out.hull.max;
    out.hull.cur = Math.max(0, Math.min(out.hull.cur, out.hull.max));
    if (out.morale.cur !== null) out.morale.cur = Math.max(0, Math.min(out.morale.cur, out.morale.max));
    for (const [cid, c] of Object.entries(stored.crew || {})) {
      if (!c || !c.name) continue;
      out.crew[cid] = {
        id: cid, name: String(c.name), roleId: String(c.roleId || ""),
        station: c.station && S.station(c.station) ? c.station : "",
        action: !!c.action, bonus: !!c.bonus,
        granted: Math.max(0, num(c.granted, 0)),
        maneuver: S.MANEUVERS[c.maneuver] ? c.maneuver : null,
        mp: Math.max(0, num(c.mp, 0)), mpMax: Math.max(0, num(c.mpMax, 0)),
        navMult: Math.max(1, num(c.navMult, 1)),
        gun: c.gun || null, target: String(c.target || ""),
        actorId: String(c.actorId || ""), tokenId: String(c.tokenId || ""),
        deck: Math.max(1, num(c.deck, 1)),
        // Which SRD stat block this seat resolves to when they are boarded, and
        // at which tier. Set at spawn; dropping it here left every enemy crew
        // member with no stat block to instantiate from.
        block: String(c.block || ""), tier: Math.max(1, Math.min(4, num(c.tier, 1))),
        hp: c.hp && typeof c.hp === "object" ? { cur: num(c.hp.cur, 0), max: num(c.hp.max, 0) } : null,
        dead: !!c.dead
      };
    }
    return out;
  };

  S.normalizeShips = function (stored) {
    const out = {};
    for (const [id, sh] of Object.entries(stored || {})) {
      if (!sh || typeof sh !== "object") continue;
      out[id] = S.normalizeShip({ ...sh, id });
    }
    return out;
  };

  /** Crew still able to work a station. */
  S.liveCrew = (ship) => Object.values(ship?.crew || {}).filter((c) => !c.dead);
  /** A station is offline if nobody living is sitting at it. */
  S.stationManned = (ship, station) => S.liveCrew(ship).some((c) => c.station === station);
  /** A gun is offline once its gunner is dead — the rule from ship-combat.md, automatic. */
  S.gunOnline = function (ship, gunId) {
    if (S.hasStatus(ship, "weapon_offline")) {
      const st = S.getStatus(ship, "weapon_offline");
      if (!st.data?.gun || st.data.gun === gunId) return false;
    }
    if (!S.systemWorks(ship, "weapons")) return false;
    return true;
  };


  /* ---------------------------------------------------------------------- */
  /*  Scanning                                                               */
  /*                                                                          */
  /*  Mapped onto the three bands the printed rules already have (DC 15;      */
  /*  beat by 3+; beat by 10+) rather than inventing a new subsystem. The     */
  /*  deck map is the repeat-scan / Quick-Ping payoff on top.                 */
  /*                                                                          */
  /*  The important half is the FAILURE. Session 5's scan rolled a 5 and      */
  /*  returned literally nothing, which is the worst thing a station can do.  */
  /*  A failed scan here still names the hull's class and allegiance and      */
  /*  leaves the target PAINTED, so the next scan of it has advantage — the   */
  /*  officer always moves something.                                        */
  /* ---------------------------------------------------------------------- */

  S.SCAN_DC = 15;
  S.SCAN_TIERS = [
    { key: "silhouette", margin: -99, label: "SILHOUETTE",
      gives: "Class, allegiance, and which arc is hot. Target is Painted — the next scan of it has advantage." },
    { key: "vitals", margin: 0, label: "VITALS",
      gives: "Hull, armour, resistances and the shield facing." },
    { key: "systems", margin: 3, label: "SYSTEMS",
      gives: "Every system and its condition. One gunner gets advantage against this hull." },
    { key: "manifest", margin: 10, label: "MANIFEST",
      gives: "Crew count and roles. Both gunners get advantage." }
  ];

  /** What a scan of this margin reveals. `margin` = roll − DC. */
  S.scanResult = function (margin) {
    const m = Number(margin) || 0;
    const tiers = S.SCAN_TIERS.filter((t) => m >= t.margin);
    const top = tiers[tiers.length - 1] || S.SCAN_TIERS[0];
    return {
      margin: m,
      tier: top.key,
      label: top.label,
      tiers: tiers.map((t) => t.key),
      // A confidence rating, in ASTRA's own idiom. Never 0 and never 100 —
      // she has never once claimed certainty.
      confidence: clamp(Math.round(38 + m * 4.5), 12, 97),
      reveal: {
        ac: m >= 0, shields: m >= 0, systems: m >= 3, crew: m >= 10,
        deckmap: m >= 10 ? 1 : 0
      },
      gunnerAdvantage: m >= 10 ? 2 : m >= 3 ? 1 : 0,
      painted: m < 0
    };
  };

  /** Merge a scan into a ship's revealed record. Never un-reveals. */
  S.applyScan = function (ship, result) {
    if (!ship || !result) return ship;
    const r = ship.revealed || (ship.revealed = { ac: false, shields: false, systems: false, crew: false, deckmap: 0 });
    for (const k of ["ac", "shields", "systems", "crew"]) if (result.reveal[k]) r[k] = true;
    r.deckmap = Math.max(r.deckmap || 0, result.reveal.deckmap || 0);
    return ship;
  };

  /* ---------------------------------------------------------------------- */
  /*  The reveal boundary                                                    */
  /*                                                                          */
  /*  ONE function decides what a given viewer may see of a ship. Renderers    */
  /*  are handed the result and never the record, so they cannot leak; the     */
  /*  selftest asserts a player view carries no unrevealed key. Secrecy is     */
  /*  UI-level by design — but keeping it to one chokepoint means it can be    */
  /*  upgraded to a real GM-side vault later without touching a renderer.      */
  /* ---------------------------------------------------------------------- */

  S.SHIP_PUBLIC_KEYS = ["id", "name", "faction", "cls", "disposition", "outcome",
                        "sizeSq", "tokenId", "sceneId", "combatantId", "statuses", "known", "unresolved"];

  S.shipView = function (ship, { isGM = false, own = false } = {}) {
    if (!ship) return null;
    const full = { ...ship, own: !!own, known: { ac: true, shields: true, systems: true, crew: true, hull: true, deckmap: 3 } };
    if (isGM || own) return full;
    const r = ship.revealed || {};
    // A rift vessel does not resolve. Its class is a tell — a "Corvette" label on
    // something that ignores shields and AC would quietly reassure the crew — so
    // it is withheld along with everything else until a scan gets through.
    const unresolved = ship.faction === "rift" && !r.ac;
    const view = {
      id: ship.id, name: ship.name, faction: ship.faction, cls: unresolved ? "" : ship.cls,
      unresolved,
      disposition: ship.disposition, outcome: ship.outcome, sizeSq: ship.sizeSq,
      tokenId: ship.tokenId, sceneId: ship.sceneId, combatantId: ship.combatantId,
      // Statuses are things you can SEE happening — a ship on fire is on fire.
      statuses: (ship.statuses || []).filter((s) => S.STATUSES[s.id]?.kind !== "good" || s.id === "cloaked"),
      known: { ac: !!r.ac, shields: !!r.shields, systems: !!r.systems, crew: !!r.crew, hull: !!r.ac, deckmap: r.deckmap || 0 }
    };
    if (r.ac) { view.ac = { base: ship.ac.base }; view.armour = ship.armour; view.resist = { ...ship.resist }; view.hull = { ...ship.hull }; }
    if (r.shields) view.shield = { ...ship.shield };
    if (r.systems) { view.systems = { ...ship.systems }; view.systemHp = JSON.parse(JSON.stringify(ship.systemHp || {})); }
    if (r.crew) {
      view.crew = {};
      for (const [cid, c] of Object.entries(ship.crew || {})) {
        view.crew[cid] = { id: cid, name: c.name, roleId: c.roleId, station: c.station, dead: c.dead,
                           ...(r.deckmap >= 3 ? { deck: c.deck, tokenId: c.tokenId } : {}) };
      }
    }
    return view;
  };

  /**
   * A qualitative read on how a hull is holding up, for the chat line the
   * PLAYERS see when they have not earned the numbers.
   *
   * The rule the whole module follows: redaction keeps the SHAPE of what is
   * missing. "She is opening up" tells the crew the fight is going their way
   * without handing them a hull total they never scanned for.
   */
  S.HULL_WORDS = [
    { at: 0.00, word: "coming apart" },
    { at: 0.15, word: "burning through" },
    { at: 0.35, word: "opening up" },
    { at: 0.60, word: "marked" },
    { at: 0.85, word: "barely scratched" }
  ];
  S.hullWord = function (cur, max) {
    const m = Number(max) > 0 ? Number(max) : 1;
    const f = Math.max(0, Math.min(1, (Number(cur) || 0) / m));
    let word = S.HULL_WORDS[0].word;
    for (const b of S.HULL_WORDS) if (f >= b.at) word = b.word;
    return word;
  };
  /** How hard a hit felt, as a fraction of the target's maximum hull. */
  S.HIT_WORDS = [
    { at: 0, word: "a graze" }, { at: 0.04, word: "a solid hit" },
    { at: 0.10, word: "a heavy hit" }, { at: 0.20, word: "a devastating hit" }
  ];
  S.hitWord = function (dmg, max) {
    const m = Number(max) > 0 ? Number(max) : 1;
    const f = Math.max(0, (Number(dmg) || 0) / m);
    let word = S.HIT_WORDS[0].word;
    for (const b of S.HIT_WORDS) if (f >= b.at) word = b.word;
    return word;
  };

  /* ---------------------------------------------------------------------- */
  /*  Default state (seeded into the world setting on first GM load)        */
  /* ---------------------------------------------------------------------- */

  S.defaultState = function () {
    const systems = {}, systemHp = {};
    for (const sys of S.SYSTEMS) {
      systems[sys.id] = sys.installed === false ? "offline" : "working";
      systemHp[sys.id] = { cur: S.SYSTEM_HP_MAX, max: S.SYSTEM_HP_MAX };
    }
    return {
      name: "SSV Silver Gull",
      plating: "Titanium-Aegis Matrix Plating",
      hull: { cur: 150, max: 150 },
      ship: "auto", // auto | intact | damaged | cloaked
      systems,
      systemHp,   // { [id]: { cur, max } } — drives the systems[] status strings above
      // Main directional shield (on/off + facing) plus an optional smaller SECONDARY
      // facing (the Shields Officer's Micro-Adjust bonus, +2 AC, cleared each turn).
      shield: { on: true, facing: "fore", secondary: null },
      // Base ship AC (GM-editable). Effective per-facing AC adds maneuver + shield bonuses.
      ac: { base: 13 },
      // Ship resources for the inventory screen (GM-tunable).
      fuel:  { cur: 500, max: 500 },   // baseline tank; GM can raise it (upgrades) via Tune
      power: { cur: 500, max: 500 },
      tuning: { fuelPerItem: 25, powerPerItem: 25, convertFuel: 10, convertPower: 50 },
      // The six rebuildable turrets. `built` is driven by the journal module's
      // "Rebuild Turrets" quest; each has its own HP pool, and at 0 an Emergency
      // Overdrive keeps it at 1 until the Engineer gets to it.
      turrets: {},
      // The Gull carries statuses exactly like every enemy does — S.statusMods,
      // S.expireStatuses and S.resolveDamage all read this. Leaving it out of the
      // ship's own state meant the player ship could not catch fire, be boarded,
      // go evasive or lose its shields, while every enemy could.
      statuses: [],
      armour: 0,
      resist: {},
      outcome: "",
      adriftCrew: [],       // user ids in open space — see endCombat
      phaseCharges: 0,      // banked Phase Shifts (Cloaking Officer)
      decoys: 0,            // decoys running (Cloaking Officer)
      // Ghost Their Sensors: the next enemy sensor lock on the Gull fizzles.
      // It used to be written by gmCloak and thrown away by this normalizer, so
      // the action did nothing at all.
      scanBlock: false,
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
      systemHp: {},
      ac: { base: Number.isFinite(Number(stored.ac?.base)) ? Number(stored.ac.base) : d.ac.base },
      shield: { ...d.shield },
      fuel:  { max: Number(stored.fuel?.max  ?? d.fuel.max),  cur: Number(stored.fuel?.cur  ?? d.fuel.cur)  },
      power: { max: Number(stored.power?.max ?? d.power.max), cur: Number(stored.power?.cur ?? d.power.cur) },
      tuning: {
        fuelPerItem:  Number(stored.tuning?.fuelPerItem  ?? d.tuning.fuelPerItem),
        powerPerItem: Number(stored.tuning?.powerPerItem ?? d.tuning.powerPerItem),
        convertFuel:  Number(stored.tuning?.convertFuel  ?? d.tuning.convertFuel),
        convertPower: Number(stored.tuning?.convertPower ?? d.tuning.convertPower)
      },
      turrets: (() => {
        const out = {};
        for (const t of S.TURRETS) {
          const st = stored.turrets?.[t.id] || {};
          const M = S.TURRET_HP_MAX;
          out[t.id] = { built: !!st.built,
            hp: { cur: Math.max(0, Math.min(Number(st.hp?.cur ?? (st.built ? M : 0)), M)), max: M },
            mode: st.mode === "detached" ? "detached" : "attached" };
        }
        return out;
      })(),
      statuses: S.normalizeStatuses(stored.statuses),
      armour: Math.max(0, Number(stored.armour) || 0),
      resist: (stored.resist && typeof stored.resist === "object") ? { ...stored.resist } : {},
      outcome: ["", "derelict", "destroyed", "disabled", "surrendered", "fled"].includes(stored.outcome) ? stored.outcome : "",
      // Who is in open space. Combat is not allowed to quietly end on top of them.
      adriftCrew: Array.isArray(stored.adriftCrew) ? stored.adriftCrew.map(String) : [],
      phaseCharges: Math.max(0, Math.min(3, Number(stored.phaseCharges) || 0)),
      decoys: Math.max(0, Math.min(3, Number(stored.decoys) || 0)),
      scanBlock: !!stored.scanBlock,
      actorId: String(stored.actorId ?? d.actorId)
    };
    // Per-system HP drives the status string. Use stored HP if present, else migrate from the old string.
    const strToHp = { working: S.SYSTEM_HP_MAX, damaged: 3, destroyed: 0 };
    for (const sys of S.SYSTEMS) {
      const M = S.SYSTEM_HP_MAX;
      if (sys.installed === false) { out.systemHp[sys.id] = { cur: M, max: M }; out.systems[sys.id] = "offline"; continue; }
      const sh = stored.systemHp?.[sys.id];
      let cur = Number.isFinite(Number(sh?.cur)) ? Number(sh.cur)
        : (S.SYSTEM_STATES.includes(stored.systems?.[sys.id]) ? strToHp[stored.systems[sys.id]] : M);
      cur = Math.max(0, Math.min(cur, M));
      out.systemHp[sys.id] = { cur, max: M };
      out.systems[sys.id] = S.systemState(out.systemHp[sys.id]);
    }
    const sh = stored.shield;
    if (sh && typeof sh === "object") {
      out.shield.on = !!sh.on;
      if (S.FACINGS.includes(sh.facing)) out.shield.facing = sh.facing;
      out.shield.secondary = S.FACINGS.includes(sh.secondary) ? sh.secondary : null;
    }
    // A zero or negative max would divide by zero in every hull bar that reads it.
    if (!(out.hull.max > 0)) out.hull.max = d.hull.max;
    if (!Number.isFinite(out.hull.cur)) out.hull.cur = out.hull.max;
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


  /* ---------------------------------------------------------------------- */
  /*  Fleet Command styles                                                   */
  /*                                                                          */
  /*  The visual language is ASTRA's nav scan (maps/nav-scan-day4-post-rift): */
  /*  bracketed corner ticks, a "//"-separated header rule, dashed range      */
  /*  rings, leader-lined callout cards, cyan "?" for unresolved contacts and */
  /*  magenta hatching for sensor blackout. The players have been looking at  */
  /*  that readout all campaign, so the fleet board is not a new invention —  */
  /*  it is the thing they already know ASTRA produces, live.                 */
  /* ---------------------------------------------------------------------- */

  S.FLEET_CSS = `
.sgfleet{position:fixed;inset:0;z-index:72;display:flex;flex-direction:column;overflow:hidden;
  font-family:'Courier New',monospace;color:#cfeef0;
  background:radial-gradient(1200px 700px at 50% -10%,rgba(29,106,134,.22),transparent 60%),
             radial-gradient(900px 600px at 80% 110%,rgba(176,107,240,.10),transparent 55%),#03070d;}
.sgfleet *{box-sizing:border-box;}
.sgfleet button{font-family:inherit;color:inherit;cursor:pointer;background:none;border:none;margin:0;
  line-height:1.2;text-align:left;white-space:normal;text-shadow:none;box-shadow:none;height:auto;min-height:0;}

/* --- header rule -------------------------------------------------------- */
.sgfleet .fl-head{flex:0 0 auto;display:flex;align-items:center;gap:14px;padding:10px 16px;
  border-bottom:1px solid #12455a;background:rgba(4,10,18,.72);}
.sgfleet .fl-brand{font-size:14px;font-weight:700;letter-spacing:2.5px;color:#38e1c4;
  text-shadow:0 0 12px rgba(56,225,196,.4);white-space:nowrap;}
.sgfleet .fl-sep{color:#2a5f70;letter-spacing:1px;}
.sgfleet .fl-meta{font-size:12px;color:#6f97a6;letter-spacing:1px;white-space:nowrap;}
.sgfleet .fl-meta b{color:#cfeef0;}
.sgfleet .fl-spacer{flex:1 1 auto;}
.sgfleet .fl-btn{font-size:12px;font-weight:700;letter-spacing:1px;color:#cfeef0;background:#0a1c26;
  border:1px solid #1d6a86;border-radius:8px;padding:7px 12px;white-space:nowrap;
  transition:border-color .12s,box-shadow .12s,color .12s;}
.sgfleet .fl-btn:hover{border-color:#38e1c4;color:#38e1c4;box-shadow:0 0 12px rgba(56,225,196,.28);}
.sgfleet .fl-btn.warn{border-color:#6b3238;}
.sgfleet .fl-btn.warn:hover{border-color:#e0454d;color:#e0454d;box-shadow:0 0 12px rgba(224,69,77,.28);}
.sgfleet .fl-btn[disabled]{opacity:.35;cursor:not-allowed;border-style:dashed;box-shadow:none;}
.sgfleet .fl-x{font-size:16px;color:#6f97a6;padding:4px 8px;}
.sgfleet .fl-x:hover{color:#f2b03d;}

/* --- initiative strip ---------------------------------------------------- */
.sgfleet .fl-init{flex:0 0 auto;display:flex;align-items:stretch;gap:0;padding:0 16px;height:38px;
  border-bottom:1px solid #0e3444;background:rgba(4,10,18,.5);overflow-x:auto;}
.sgfleet .fl-init-lbl{display:flex;align-items:center;font-size:10px;letter-spacing:2px;color:#4b7688;
  padding-right:12px;white-space:nowrap;}
.sgfleet .fl-chip{position:relative;display:flex;align-items:center;gap:7px;padding:0 16px 0 20px;
  margin-right:-9px;font-size:11px;letter-spacing:1px;color:#8fb2c0;white-space:nowrap;cursor:pointer;
  background:#081521;border:1px solid #143d4e;
  clip-path:polygon(9px 0,100% 0,calc(100% - 9px) 100%,0 100%);}
.sgfleet .fl-chip:hover{color:#cfeef0;}
.sgfleet .fl-chip.now{background:#0f3b44;border-color:#38e1c4;color:#cfeef0;font-weight:700;}
.sgfleet .fl-chip.now::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;background:#38e1c4;
  box-shadow:0 0 10px rgba(56,225,196,.8);}
.sgfleet .fl-chip.done{opacity:.42;}
.sgfleet .fl-chip .fl-roll{font-size:10px;color:#4b7688;}
.sgfleet .fl-chip .fl-dot{width:7px;height:7px;border-radius:50%;flex:none;}

/* --- body ---------------------------------------------------------------- */
.sgfleet .fl-body{flex:1 1 auto;display:grid;grid-template-columns:1fr minmax(300px,368px);
  gap:0;min-height:0;}
.sgfleet .fl-board{position:relative;overflow:auto;padding:16px;min-height:0;}
.sgfleet .fl-side{border-left:1px solid #12455a;background:rgba(4,10,18,.55);overflow:auto;
  padding:14px 14px 22px;min-height:0;}
@media (max-width:900px){.sgfleet .fl-body{grid-template-columns:1fr;}
  .sgfleet .fl-side{border-left:none;border-top:1px solid #12455a;}}

.sgfleet .fl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:14px;align-content:start;}

/* --- a ship card --------------------------------------------------------- */
.sgfleet .fl-card{position:relative;display:grid;grid-template-columns:92px 1fr;gap:11px;
  padding:10px 12px 10px 14px;min-height:118px;
  background:linear-gradient(180deg,rgba(12,32,46,.72),rgba(6,16,24,.72));
  border:1px solid #14455a;border-radius:10px;cursor:pointer;
  transition:border-color .14s,box-shadow .14s,transform .14s;}
.sgfleet .fl-card:hover{border-color:#1d6a86;box-shadow:0 0 16px rgba(29,106,134,.4);}
.sgfleet .fl-card.sel{border-color:#38e1c4;box-shadow:0 0 20px rgba(56,225,196,.35);}
.sgfleet .fl-card.active{border-color:#38e1c4;}
.sgfleet .fl-card.active::after{content:"";position:absolute;inset:-2px;border-radius:11px;pointer-events:none;
  border:2px solid transparent;
  background:conic-gradient(transparent 0 62%,rgba(56,225,196,.95) 78%,transparent 88% 100%) border-box;
  -webkit-mask:linear-gradient(#000 0 0) padding-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;
  animation:fl-chase 2.4s linear infinite;}
/* A bare custom property is NOT animatable without @property, so the old
   --sweep keyframe never moved and the active-ship ring sat still.
   Rotate the element itself instead. */
@keyframes fl-chase{to{transform:rotate(360deg);}}
@supports not (background:conic-gradient(from 0deg,red,blue)){
  .sgfleet .fl-card.active::after{background:none;border-color:#38e1c4;animation:fl-pulse 1.6s ease-in-out infinite;}}
@keyframes fl-pulse{0%,100%{opacity:.45;}50%{opacity:1;}}
.sgfleet .fl-card.out{opacity:.5;filter:grayscale(.5);}
/* Disposition is a left rail, never the border colour — otherwise "hostile"
   and "selected" fight over the same channel and neither reads. */
.sgfleet .fl-card .fl-rail{position:absolute;left:0;top:8px;bottom:8px;width:3px;border-radius:3px;}
.sgfleet .fl-card.d-hostile .fl-rail{background:#e0454d;}
.sgfleet .fl-card.d-neutral .fl-rail{background:#6f97a6;}
.sgfleet .fl-card.d-ally    .fl-rail{background:#42d16a;}

.sgfleet .fl-art{position:relative;width:92px;height:auto;display:flex;align-items:center;justify-content:center;}
.sgfleet .fl-art img{max-width:100%;max-height:112px;object-fit:contain;filter:drop-shadow(0 0 8px rgba(29,106,134,.6));}
.sgfleet .fl-art .fl-unknown{width:56px;height:56px;border:1.5px dashed #2a5f70;border-radius:50%;
  display:flex;align-items:center;justify-content:center;font-size:26px;color:#38e1c4;opacity:.8;}

.sgfleet .fl-name{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:700;color:#dff3f6;line-height:1.15;}
.sgfleet .fl-crest{width:18px;height:18px;flex:none;border-radius:50%;overflow:hidden;object-fit:contain;display:inline-block;}
.sgfleet .fl-crest svg{width:100%;height:100%;display:block;}
.sgfleet .fl-crest.none{border:1.5px dashed #46606e;border-radius:50%;}
.sgfleet .fl-crest.own{display:flex;align-items:center;justify-content:center;color:#38e1c4;font-size:13px;}
.sgfleet .fl-sub{font-size:10px;letter-spacing:1px;color:#6f97a6;margin:2px 0 5px;text-transform:uppercase;}
.sgfleet .fl-sub.unres{color:#c98bff;}

.sgfleet .fl-hp{position:relative;height:11px;border-radius:6px;background:#0a1c26;border:1px solid #12455a;overflow:hidden;}
.sgfleet .fl-hp i{position:absolute;left:0;top:0;bottom:0;border-radius:6px;transition:width .45s cubic-bezier(.2,.7,.2,1);}
/* the damage ghost: what was just lost, held bright for a beat */
.sgfleet .fl-hp u{position:absolute;top:0;bottom:0;background:#ff5b62;box-shadow:0 0 10px rgba(255,91,98,.9);
  animation:fl-ghost .75s ease-out forwards;}
@keyframes fl-ghost{0%{opacity:1;}70%{opacity:.85;}100%{opacity:0;}}
.sgfleet .fl-hp::after{content:"";position:absolute;inset:0;pointer-events:none;opacity:.4;
  background:repeating-linear-gradient(90deg,transparent 0 11px,rgba(0,0,0,.5) 11px 12px);}
.sgfleet .fl-hptxt{display:flex;justify-content:space-between;font-size:10px;color:#6f97a6;margin-top:3px;letter-spacing:.5px;}
.sgfleet .fl-hptxt b{color:#cfeef0;}

.sgfleet .fl-arcs{display:flex;gap:4px;margin-top:6px;}
.sgfleet .fl-arc{flex:1;text-align:center;font-size:9px;letter-spacing:.5px;color:#6f97a6;
  border:1px solid #12455a;border-radius:5px;padding:2px 0;background:#081521;}
.sgfleet .fl-arc b{display:block;font-size:11px;color:#cfeef0;}
.sgfleet .fl-arc.sh{border-color:#38e1c4;color:#04121c;background:#2ec2aa;}
.sgfleet .fl-arc.sh b{color:#04121c;}
.sgfleet .fl-arc.mi{border-color:#b06bf0;color:#e6d5ff;}
.sgfleet .fl-arc.unk{border-style:dashed;border-color:#46606e;color:#46606e;
  background:repeating-linear-gradient(135deg,rgba(26,58,72,.55) 0 4px,rgba(13,37,49,.55) 4px 8px);}
.sgfleet .fl-arc.unk b{color:#5d7c8a;}

.sgfleet .fl-pips{display:flex;flex-wrap:wrap;gap:3px;margin-top:6px;}
.sgfleet .fl-pip{width:9px;height:9px;border-radius:2px;background:#38e1c4;opacity:.9;}
.sgfleet .fl-pip.dmg{background:#f2b03d;}
.sgfleet .fl-pip.dead{background:#e0454d;opacity:.55;}
.sgfleet .fl-pip.unk{background:none;border:1px dashed #46606e;}

.sgfleet .fl-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;}
.sgfleet .fl-st{font-size:9px;letter-spacing:.5px;padding:1px 6px;border-radius:9px;border:1px solid currentColor;white-space:nowrap;}
.sgfleet .fl-st.good{color:#42d16a;} .sgfleet .fl-st.bad{color:#e0454d;} .sgfleet .fl-st.warn{color:#f2b03d;}
.sgfleet .fl-st.pulse{animation:fl-pulse 1.4s ease-in-out infinite;}

.sgfleet .fl-foot{display:flex;justify-content:space-between;align-items:center;margin-top:7px;font-size:10px;color:#6f97a6;}
.sgfleet .fl-foot .fl-crew b{color:#cfeef0;}
.sgfleet .fl-outcome{font-size:10px;font-weight:700;letter-spacing:1.5px;padding:1px 7px;border-radius:9px;border:1px solid currentColor;}
.sgfleet .fl-outcome.derelict{color:#7fb4c8;} .sgfleet .fl-outcome.destroyed{color:#e0454d;}
.sgfleet .fl-outcome.disabled{color:#6f97a6;} .sgfleet .fl-outcome.surrendered{color:#f2b03d;}
.sgfleet .fl-outcome.fled{color:#b06bf0;}

/* redaction: keep the SHAPE of what you don't know, so it reads as a gap */
.sgfleet .fl-redact{display:inline-block;min-width:26px;height:11px;border-radius:3px;vertical-align:-1px;
  background:repeating-linear-gradient(135deg,#1a3a48 0 4px,#0d2531 4px 8px);
  border:1px solid #24596e;}

/* --- the crew panel ------------------------------------------------------ */
.sgfleet .fl-sh{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;letter-spacing:2px;
  color:#38e1c4;padding-bottom:8px;border-bottom:1px solid #12455a;margin-bottom:10px;}
.sgfleet .fl-hint{font-size:11px;color:#8fb2c0;line-height:1.45;background:rgba(56,225,196,.06);
  border-left:2px solid #1d6a86;padding:7px 9px;border-radius:0 6px 6px 0;margin-bottom:12px;}
.sgfleet .fl-hint b{color:#f2b03d;letter-spacing:1px;}
.sgfleet .fl-crewrow{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;
  padding:7px 9px;border:1px solid #12455a;border-radius:8px;background:rgba(10,28,38,.55);margin-bottom:6px;cursor:pointer;}
.sgfleet .fl-crewrow:hover{border-color:#1d6a86;}
.sgfleet .fl-crewrow.dead{opacity:.42;}
.sgfleet .fl-crewrow.dead .fl-cname{text-decoration:line-through;}
.sgfleet .fl-cname{font-size:12px;color:#dff3f6;font-weight:700;}
.sgfleet .fl-crole{font-size:10px;color:#6f97a6;letter-spacing:1px;text-transform:uppercase;}
.sgfleet .fl-cst{font-size:10px;color:#8fb2c0;}
.sgfleet .fl-empty{font-size:11px;color:#5a7c8a;font-style:italic;padding:10px 2px;}

/* --- the spawn browser (lives inside a Foundry dialog) ------------------- */
.sgsb{display:flex;flex-direction:column;gap:10px;height:100%;min-height:0;font-family:'Courier New',monospace;color:#cfeef0;}
.sgsb-head{display:flex;gap:8px;flex:0 0 auto;align-items:stretch;}
/* Foundry's own input/select rules leak in and set width:100%, which blew this
   row apart — the search collapsed to 22px and each select stretched to 946px.
   Pin the widths and allow the search to shrink. */
.sgsb-q{flex:1 1 auto;min-width:0;width:auto;font-family:inherit;font-size:13px;color:#cfeef0;
  background:#0a1c26;border:1px solid #1d6a86;border-radius:8px;padding:7px 10px;height:34px;}
.sgsb-q:focus{outline:none;border-color:#38e1c4;box-shadow:0 0 12px rgba(56,225,196,.25);}
.sgsb-ff,.sgsb-cf{flex:0 0 auto;width:170px;min-width:170px;max-width:170px;height:34px;
  font-family:inherit;font-size:12px;color:#cfeef0;background:#0a1c26;
  border:1px solid #1d6a86;border-radius:8px;padding:6px 8px;}
.sgsb-grid{flex:1 1 auto;overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));
  gap:10px;align-content:start;padding-right:4px;min-height:0;}
.sgsb-tile{display:grid;grid-template-columns:84px 1fr;gap:10px;padding:9px 11px;cursor:pointer;
  background:linear-gradient(180deg,rgba(12,32,46,.7),rgba(6,16,24,.7));
  border:1px solid #14455a;border-radius:9px;transition:border-color .12s,box-shadow .12s,transform .12s;}
.sgsb-tile:hover{border-color:#38e1c4;box-shadow:0 0 16px rgba(56,225,196,.28);transform:translateY(-1px);}
.sgsb-tile.rift{border-color:#6b2f8a;}
.sgsb-tile.rift:hover{border-color:#ff4fd8;box-shadow:0 0 18px rgba(255,79,216,.35);}
.sgsb-art{display:flex;align-items:center;justify-content:center;}
.sgsb-art img{max-width:84px;max-height:92px;object-fit:contain;filter:drop-shadow(0 0 7px rgba(29,106,134,.65));}
.sgsb-name{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:700;color:#dff3f6;line-height:1.15;}
.sgsb-crest{width:17px;height:17px;flex:none;border-radius:50%;overflow:hidden;display:inline-block;object-fit:contain;}
.sgsb-crest.none{border:1.5px dashed #46606e;}
.sgsb-sub{font-size:10px;letter-spacing:1px;color:#6f97a6;text-transform:uppercase;margin:2px 0 5px;}
.sgsb-stats{display:flex;flex-wrap:wrap;gap:8px;font-size:10px;color:#6f97a6;letter-spacing:.5px;}
.sgsb-stats b{color:#cfeef0;font-size:11px;}
.sgsb-blurb{font-size:11px;color:#8fb2c0;line-height:1.35;margin-top:5px;}
.sgsb-flags{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;}
.sgsb-f{font-size:9px;font-weight:700;letter-spacing:.5px;padding:1px 6px;border-radius:9px;border:1px solid currentColor;}
.sgsb-f.brd{color:#f2b03d;} .sgsb-f.clk{color:#7fd4e8;} .sgsb-f.arm{color:#8a939c;}
.sgsb-f.canon{color:#42d16a;} .sgsb-f.rift{color:#ff4fd8;}
`;

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
.sgsc .sc-hp{margin-left:6px;font-size:11px;font-weight:700;letter-spacing:.5px;opacity:.9;}
.sgsc .sc-ac{position:relative;z-index:2;text-align:center;font-size:12px;color:var(--muted);letter-spacing:1px;margin:-6px 0 8px;}
.sgsc .sc-ac span{display:inline-block;margin:0 5px;}
.sgsc .sc-ac b{color:var(--ink);font-size:13px;}
.sgsc .sc-ac em{display:block;font-size:10px;opacity:.6;font-style:normal;margin-top:1px;letter-spacing:.5px;}
.sgsc .sc-ac.gm{cursor:pointer;}
.sgsc .sc-ac.gm:hover b{color:var(--teal);}
.sgsc .sc-acdir{position:absolute;z-index:4;min-width:24px;text-align:center;font-size:13px;font-weight:700;color:var(--ink);
  background:rgba(4,10,18,.78);border:1px solid var(--edge2);border-radius:9px;padding:1px 6px;pointer-events:none;transform:translate(-50%,-50%);}
.sgsc .sc-acdir.shielded{color:#04121c;background:var(--teal);border-color:var(--teal);box-shadow:0 0 10px rgba(56,225,196,.55);}
.sgsc .sc-acdir.micro{border-color:#b06bf0;box-shadow:0 0 8px rgba(176,107,240,.45);}
.sgsc .sc-acdir .sc-dr{display:block;font-size:9px;font-style:normal;font-weight:700;line-height:1;opacity:.85;letter-spacing:0;}
.sgsc .sc-acdir.micro .sc-dr{color:#c9a0ff;}
.sgsc .sc-acdir.pos-fore{top:14%;left:50%;}
.sgsc .sc-acdir.pos-aft{top:86%;left:50%;}
.sgsc .sc-acdir.pos-port{top:52%;left:27%;}
.sgsc .sc-acdir.pos-starboard{top:52%;left:73%;}
/* Ship + shield sit BEHIND the panels, confined to the central band (clear of the title & hull bar). */
.sgsc .sc-shipbg{position:absolute;top:-55px;bottom:0;left:-78%;right:-78%;z-index:1;display:flex;align-items:center;justify-content:center;pointer-events:none;}
.sgsc .sc-shipwrap{position:relative;height:112%;aspect-ratio:1218/1620;pointer-events:auto;}
.sgsc .sc-shipwrap img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;}
.sgsc .sc-shipimg{filter:drop-shadow(0 0 20px rgba(29,106,134,.5));}
/* will-change promotes these to their own layer so the forever-running opacity animation
   recomposites a cached layer instead of re-running the drop-shadow/sepia filter chain
   over the full-size ship art every frame. A rendering hint only — nothing looks different. */
.sgsc .sc-shieldimg{z-index:2;filter:drop-shadow(0 0 8px rgba(72,232,226,.75)) drop-shadow(0 0 22px rgba(72,232,226,.5));
  will-change:opacity;animation:sgsc-pulse 2.6s ease-in-out infinite;}
.sgsc .sc-shieldimg.dmg{filter:sepia(1) saturate(9) hue-rotate(-38deg) brightness(1) contrast(1.1)
  drop-shadow(0 0 8px rgba(235,60,60,.9)) drop-shadow(0 0 22px rgba(235,60,60,.55));will-change:opacity;animation:sgsc-flicker .5s steps(2,end) infinite;}
/* Secondary shield (Micro-Adjust): a thin violet arc hugging the allocated side —
   a slimmer, inward-scaled copy of that side's main shield, tinted distinct from the cyan primary. */
/* Sits at scale 1.0 (same footprint as that side's main shield) so it aligns with the hull;
   distinguished purely by being violet + much fainter than the cyan primary. */
.sgsc .sc-shield2img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:3;pointer-events:none;
  filter:hue-rotate(92deg) saturate(1.2) brightness(.72) drop-shadow(0 0 2px rgba(176,107,240,.45));
  opacity:.42;will-change:opacity;animation:sgsc-pulse2 2.6s ease-in-out infinite;}
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
/* Pilot: seat + inline movement panel stacked in a full-width column. */
.sgct .ct-seatwrap{display:flex;flex-direction:column;gap:6px;flex-basis:100%;align-items:stretch;}
.sgct .ct-seatwrap.mine .ct-seat{border-color:var(--teal);box-shadow:0 0 12px rgba(56,225,196,.25);}
.sgct .ct-move,.sgct .ct-gun{display:flex;align-items:center;gap:7px;flex-wrap:wrap;justify-content:center;padding:6px 10px;
  border:1px solid var(--edge);border-radius:9px;background:rgba(10,28,38,.55);}
.sgct .ct-gun .pm-h{font-size:11px;font-weight:700;letter-spacing:1px;color:var(--muted);text-transform:uppercase;text-align:center;line-height:1.35;}
.sgct .ct-gun .pm-h small{font-size:10px;color:var(--teal);letter-spacing:.5px;text-transform:none;}
.sgct .ct-gun .gc-fire{border-color:#e0885a;color:#ffb98f;}
.sgct .ct-gun .gc-fire:hover:not([disabled]){border-color:#ff8a4c;box-shadow:0 0 9px rgba(255,138,76,.45);color:#ffb98f;}
.sgct .ct-move .pm-h{font-size:11px;font-weight:700;letter-spacing:1px;color:var(--muted);text-transform:uppercase;}
.sgct .ct-move .pm-mp{font-size:13px;font-weight:700;color:var(--teal);background:#0a1c26;border:1px solid var(--edge2);border-radius:9px;padding:2px 9px;white-space:nowrap;}
.sgct .ct-move .pm-nav{font-size:11px;font-weight:700;color:#0a1c26;background:#f2b03d;border-radius:8px;padding:2px 7px;white-space:nowrap;letter-spacing:.5px;box-shadow:0 0 8px rgba(242,176,61,.4);}
.sgct .ct-move .pm-mp.bonus{color:var(--amber);border-color:var(--amber);}
.sgct .pm-tgt{border-color:#f2b03d;color:#ffd98a;}
.sgct .pm-warn{font-size:10px;letter-spacing:.5px;color:#e0454d;align-self:center;padding:0 4px;}
.sgct .pm-warn.long{color:#f2b03d;}
.sgct .pm-btn{font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;color:var(--ink);background:#0a1c26;
  border:1px solid var(--edge2);border-radius:7px;padding:4px 9px;white-space:nowrap;}
.sgct .pm-btn:hover:not([disabled]){border-color:var(--teal);box-shadow:0 0 8px rgba(56,225,196,.35);color:var(--teal);}
.sgct .pm-btn b{color:var(--teal);}
.sgct .pm-btn[disabled]{opacity:.4;cursor:not-allowed;}
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
.sgcon .ig.over{box-shadow:0 0 16px rgba(242,176,61,.55);border-color:#f2b03d;}
.sgcon .ig.over .ig-track{box-shadow:0 0 10px rgba(242,176,61,.8) inset;}
.sgcon .ig.over .ig-val{color:#ffd987;}
.sgcon .ig.over .ig-ico{animation:ig-blink 1.1s steps(2,end) infinite;}
.sgcon .inv-convert{flex:0 1 210px;min-width:150px;display:flex;flex-direction:column;gap:6px;}
.sgcon .inv-convert .con-btn{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;font-size:12px;padding:6px 10px;
  border-radius:10px;background:linear-gradient(180deg,rgba(14,34,48,.65),rgba(8,20,30,.65));}
/* Add-item browser (searchable, world + compendiums) */
.sgib-overlay{position:fixed;inset:0;z-index:95;background:rgba(2,6,12,.72);display:flex;align-items:center;justify-content:center;
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
.sgcon .inv-list{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:10px;padding:6px 2px;border-radius:10px;}
.sgcon .inv-list.inv-drop{outline:2px dashed #38e1c4;outline-offset:-6px;background:rgba(56,225,196,.05);}
.sgcon .inv-sec{display:flex;flex-direction:column;}
.sgcon .inv-sec-head{display:flex;align-items:center;gap:9px;cursor:pointer;padding:8px 11px;border:1px solid #163b4e;border-radius:9px;user-select:none;
  background:linear-gradient(180deg,rgba(20,44,60,.7),rgba(10,24,34,.6));transition:border-color .12s,box-shadow .12s;}
.sgcon .inv-sec-head:hover{border-color:#2b7d99;box-shadow:0 0 12px rgba(56,225,196,.15);}
.sgcon .inv-caret{color:#38e1c4;font-size:11px;line-height:1;transition:transform .15s;}
.sgcon .inv-sec.collapsed .inv-caret{transform:rotate(-90deg);}
.sgcon .inv-sec-name{font-size:12px;font-weight:700;letter-spacing:1.5px;color:#cfeef0;text-transform:uppercase;}
.sgcon .inv-sec-count{margin-left:auto;font-size:11px;font-weight:700;color:#7fa6b4;background:#0a1c26;border:1px solid #12455a;border-radius:10px;padding:1px 9px;}
.sgcon .inv-sec-body{display:grid;grid-template-columns:repeat(auto-fill,minmax(108px,1fr));gap:12px;padding:10px 4px 6px;}
.sgcon .inv-sec.collapsed .inv-sec-body{display:none;}
.sgcon .inv-tile{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;padding:8px 8px 8px;border:1px solid #1d6a86;border-radius:13px;
  background:linear-gradient(180deg,rgba(22,48,64,.65),rgba(9,22,32,.65));transition:border-color .12s,box-shadow .12s,transform .12s;}
.sgcon .inv-tile:hover{border-color:#38e1c4;box-shadow:0 0 16px rgba(56,225,196,.35);transform:translateY(-2px);}
.sgcon .inv-tile .it-imgwrap{position:relative;margin-top:2px;}
.sgcon .inv-tile .it-imgwrap img{display:block;width:56px;height:56px;object-fit:contain;border-radius:9px;filter:drop-shadow(0 0 5px rgba(0,0,0,.55));background:rgba(4,10,18,.35);}
.sgcon .inv-tile .it-qty{position:absolute;top:-9px;left:50%;transform:translateX(-50%);font-size:12px;font-weight:700;color:#04121c;
  background:#38e1c4;border-radius:9px;padding:1px 8px;box-shadow:0 0 8px rgba(56,225,196,.55);white-space:nowrap;}
.sgcon .inv-tile .it-name{font-size:11px;line-height:1.2;text-align:center;color:#cfeef0;max-height:2.5em;overflow:hidden;}
.sgcon .inv-tile .it-tier{font-size:8.5px;font-weight:700;letter-spacing:1px;text-transform:uppercase;border:1px solid;border-radius:5px;padding:0 5px;margin-top:2px;opacity:.9;}
.sgcon .inv-tile .it-ib.over{border-color:#f2b03d;color:#ffd987;box-shadow:0 0 8px rgba(242,176,61,.5);}
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
.sgcon-invpop .ip-prov{font-size:12px;color:#cfeef0;margin:0 0 7px;}
.sgcon-invpop .ip-prov b{color:#38e1c4;}
.sgcon-invpop .ip-prov .ip-over{display:block;color:#f2b03d;font-size:11px;margin-top:1px;}
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
.sgcon .con-pw{display:inline-block;margin-left:6px;font-size:11px;font-weight:700;color:#38e1c4;background:rgba(56,225,196,.14);border:1px solid rgba(56,225,196,.4);border-radius:7px;padding:0 5px;vertical-align:middle;}
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
/* ===== Repair puzzle overlay ===== */
.srp-overlay{position:fixed;inset:0;z-index:105;background:rgba(2,6,12,.8);display:flex;align-items:center;justify-content:center;
  font-family:'Courier New',monospace;color:#cfeef0;}
.srp{width:min(560px,94vw);border:1px solid #1d6a86;border-radius:16px;overflow:hidden;background:linear-gradient(180deg,#0c2334,#081521);box-shadow:0 26px 74px rgba(0,0,0,.75);}
.srp-head{padding:13px 16px 8px;}
.srp-title{font-weight:700;letter-spacing:2px;color:#38e1c4;text-shadow:0 0 10px rgba(56,225,196,.4);}
.srp-timerwrap{height:8px;margin:2px 16px 0;background:#07141d;border:1px solid #103042;border-radius:6px;overflow:hidden;}
.srp-timer{height:100%;width:100%;border-radius:6px;background:#42d16a;transition:background .3s;}
.srp-body{padding:14px 16px;min-height:220px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;}
.srp-foot{display:flex;align-items:center;gap:12px;justify-content:space-between;padding:10px 16px;border-top:1px solid #12455a;}
.srp-msg{flex:1;font-size:12px;color:#9fc0cc;}
.srp-x{cursor:pointer;font-family:inherit;font-weight:700;font-size:12px;color:#cfeef0;background:#0a1c26;border:1px solid #1d6a86;border-radius:8px;padding:5px 12px;}
.srp-x:hover{border-color:#e0454d;color:#e0454d;}
/* shared puzzle bits */
.srp-btn{cursor:pointer;font-family:inherit;font-weight:700;color:#cfeef0;background:#0a1c26;border:1px solid #1d6a86;border-radius:8px;padding:7px 12px;}
.srp-btn:hover:not([disabled]){border-color:#38e1c4;color:#38e1c4;box-shadow:0 0 8px rgba(56,225,196,.3);}
.srp-btn[disabled]{opacity:.4;cursor:not-allowed;}
.srp-row{display:flex;gap:8px;align-items:center;justify-content:center;flex-wrap:wrap;}
.srp-canvas{border:1px solid #163b4e;border-radius:10px;background:#07141d;touch-action:none;}
/* flow (pipes) */
.srp-grid{display:grid;gap:4px;}
.srp-tile{width:52px;height:52px;background:#0a1c26;border:1px solid #163b4e;border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .15s;position:relative;}
.srp-tile:hover{border-color:#2b7d99;}
.srp-tile.lit{border-color:#38e1c4;box-shadow:0 0 10px rgba(56,225,196,.4) inset;}
.srp-tile.src{border-color:#f2b03d;}
.srp-tile.core{border-color:#e0454d;}
.srp-tile svg{width:100%;height:100%;display:block;}
/* simon coils */
.srp-coil{width:64px;height:64px;border-radius:14px;background:#0a1c26;border:2px solid #163b4e;cursor:pointer;transition:all .12s;}
.srp-coil.on{box-shadow:0 0 22px 4px currentColor;transform:scale(1.06);}
/* phase / lights-out */
.srp-cell{width:46px;height:46px;border-radius:8px;background:#0a1c26;border:1px solid #163b4e;cursor:pointer;transition:all .12s;}
.srp-cell.on{background:#0f6f66;border-color:#38e1c4;box-shadow:0 0 12px rgba(56,225,196,.5) inset;}
/* sliders (waveform/valves) */
.srp-slider{display:flex;flex-direction:column;align-items:center;gap:4px;font-size:11px;color:#7fa6b4;}
.srp-slider input[type=range]{writing-mode:vertical-lr;direction:rtl;width:22px;height:120px;accent-color:#38e1c4;}
.srp-gauge{width:26px;height:120px;border:1px solid #163b4e;border-radius:6px;background:#07141d;position:relative;overflow:hidden;}
.srp-gauge .fill{position:absolute;left:0;right:0;bottom:0;background:#38e1c4;transition:height .1s,background .1s;}
.srp-gauge .band{position:absolute;left:0;right:0;background:rgba(66,209,106,.22);border-top:1px solid #42d16a;border-bottom:1px solid #42d16a;}
/* ── Nav Support mini-game ── */
.sng-overlay{position:fixed;inset:0;z-index:105;background:rgba(2,6,12,.8);display:flex;align-items:center;justify-content:center;font-family:'Courier New',monospace;color:#cfeef0;}
.sng{width:min(600px,95vw);border:1px solid #1d6a86;border-radius:16px;overflow:hidden;background:linear-gradient(180deg,#0c2334,#081521);box-shadow:0 26px 74px rgba(0,0,0,.75);}
.sng-head{display:flex;align-items:baseline;justify-content:space-between;padding:13px 16px 10px;}
.sng-title{font-weight:700;letter-spacing:2px;color:#38e1c4;text-shadow:0 0 10px rgba(56,225,196,.4);}
.sng-score{font-weight:700;font-size:16px;color:#f2b03d;letter-spacing:1px;}
.sng-body{padding:12px 16px;display:flex;align-items:center;justify-content:center;min-height:240px;}
.sng-foot{display:flex;align-items:center;gap:12px;justify-content:space-between;padding:10px 16px;border-top:1px solid #12455a;}
.sng-msg{flex:1;font-size:12px;color:#9fc0cc;}
.sng-x{cursor:pointer;font-family:inherit;font-weight:700;font-size:12px;color:#cfeef0;background:#0a1c26;border:1px solid #1d6a86;border-radius:8px;padding:5px 12px;}
.sng-x:hover{border-color:#e0454d;color:#e0454d;}
.sng-field{position:relative;border:1px solid #163b4e;border-radius:12px;background:radial-gradient(circle at 50% 40%,#0b2130,#06121b);overflow:hidden;}
.sng-lines{position:absolute;inset:0;pointer-events:none;}
.sng-lines line.on{stroke:#38e1c4;stroke-width:3;stroke-linecap:round;filter:drop-shadow(0 0 4px rgba(56,225,196,.6));}
.sng-node{position:absolute;transform:translate(-50%,-50%);width:38px;height:38px;border-radius:50%;cursor:pointer;font-family:inherit;font-weight:700;font-size:15px;color:#cfeef0;background:#0a1c26;border:2px solid #2b7d99;box-shadow:0 0 0 3px rgba(10,28,38,.6);transition:transform .1s,border-color .1s,background .1s;}
.sng-node:hover{border-color:#38e1c4;}
.sng-node.hit{background:#0f6f66;border-color:#38e1c4;color:#eafffb;box-shadow:0 0 12px rgba(56,225,196,.55);}
.sng-node.miss{border-color:#e0454d;background:#3a1114;animation:sngshake .22s;}
@keyframes sngshake{0%,100%{transform:translate(-50%,-50%)}25%{transform:translate(-58%,-50%)}75%{transform:translate(-42%,-50%)}}
.sng-chan canvas{display:block;cursor:crosshair;}
`;
    st.textContent += S.FLEET_CSS;   // Fleet Command shares the sheet and the palette
    st.textContent += S.SCAN_CSS;
    st.textContent += S.DECK_CSS;
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
  const ITEM_COLLATOR = new Intl.Collator(undefined, { sensitivity: "base" });

  function iconEl(ctx, sys, st) {
    // -sm is the 128px variant: these render into a 52px slot, so shipping the 1024px
    // master here cost ~4MB of decoded bitmap per icon (x8 on screen) for no visible gain.
    const file = ctx.assetUrl(`assets/systems/${sys.icon}-${st === "offline" ? "destroyed" : st}-sm.webp`);
    return `<div class="sc-ico"><span class="ph" style="color:${S.STATE_META[st]?.c || "#5a6b7a"}"></span>` +
      `<img src="${file}" alt="" width="52" height="52" decoding="async" onload="this.previousElementSibling.style.display='none'" onerror="this.style.display='none'"></div>`;
  }

  function systemCard(ctx, sys, state) {
    const st = state.systems[sys.id];
    const meta = S.STATE_META[st] || S.STATE_META.working;
    const gm = ctx.isGM && sys.installed !== false ? "gm" : "";
    const hp = state.systemHp?.[sys.id];
    const hpTxt = (hp && sys.installed !== false) ? `<span class="sc-hp" style="color:${meta.c}">${hp.cur} / ${hp.max}</span>` : "";
    const info = `<div class="sc-info"><div class="sc-name">${esc(sys.label)}</div>` +
      `<span class="sc-pill" style="color:${meta.c}">${meta.label}</span>${hpTxt}</div>`;
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
      const file = ctx.assetUrl(`assets/shields/shield-${state.shield.facing}.webp`);
      const cls = "sc-shieldimg" + (gen === "damaged" ? " dmg" : "");
      html += `<img class="${cls}" src="${file}" alt="" onerror="this.style.display='none'">`;
    }
    // Secondary facing (Micro-Adjust): a thin violet arc hugging that side.
    if (state.shield.secondary) {
      const f2 = ctx.assetUrl(`assets/shields/shield-${state.shield.secondary}.webp`);
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
    const shipFile = ctx.assetUrl(`assets/ship/ship-${S.shipVariant(state)}.webp`);

    const hullPct = state.hull.max ? clamp(state.hull.cur / state.hull.max, 0, 1) * 100 : 0;
    const hullColor = hullPct > 50 ? "var(--teal)" : hullPct > 20 ? "var(--amber)" : "var(--red)";

    // Per-facing ship AC (base + pilot maneuver + directional shields).
    const ac = S.shipAC(state, ctx.getCombat ? ctx.getCombat() : null);
    // AC is one number for the whole ship now; what differs per facing is the
    // shield DR, so each badge shows AC with the reduction underneath it.
    const drTag = (f) => { const d = ac.dr[f]; return d.half ? "½" : d.flat ? `−${d.flat}` : ""; };
    const acDir = (f, lbl) => {
      const d = ac.dr[f], tag = drTag(f);
      const cls = d.half ? " shielded" : d.flat ? " micro" : "";
      const tip = `${lbl} — AC ${ac[f]}${d.half ? " · shields halve damage from here" : d.flat ? ` · micro-adjust takes ${d.flat} off` : " · unshielded"}`;
      return `<div class="sc-acdir pos-${f}${cls}" title="${tip}">${ac[f]}${tag ? `<i class="sc-dr">${tag}</i>` : ""}</div>`;
    };
    const acLine = `<div class="sc-ac${ctx.isGM ? " gm" : ""}" data-ac title="${ctx.isGM ? "Click to set base AC" : ""}">AC <b>${ac.fore}</b> · ` +
      `<span>F ${drTag("fore") || "—"}</span><span>S ${drTag("starboard") || "—"}</span><span>A ${drTag("aft") || "—"}</span><span>P ${drTag("port") || "—"}</span>` +
      `<em>base ${ac.base}${ac.maneuver ? ` · ${esc(ac.maneuverLabel)} ${ac.maneuver >= 0 ? "+" : ""}${ac.maneuver}` : ""}` +
      `${ac.status ? ` · status ${ac.status >= 0 ? "+" : ""}${ac.status}` : ""} · shields reduce damage, not AC</em></div>`;

    root.className = `sgsc ${ctx.isGM ? "gm" : ""}`;
    root.innerHTML = `
      <div class="sc-title">${esc(state.name)} — SHIP OVERVIEW</div>
      <div class="sc-sub">SYSTEMS · HULL INTEGRITY · SHIELD: <b style="color:${shieldStatus(state).color}">${shieldStatus(state).label}</b></div>
      ${acLine}
      <div class="sc-grid">
        <div class="sc-col">${left.map((s) => systemCard(ctx, s, state)).join("")}</div>
        <div class="sc-col sc-center">
          <div class="sc-shipbg"><div class="sc-shipwrap">
            <span class="sc-shipph">SSV SILVER GULL</span>
            <img class="sc-shipimg" src="${shipFile}" alt="SSV Silver Gull" onload="this.previousElementSibling.style.display='none'" onerror="this.style.display='none'">
            ${shieldEl(ctx, state)}
            ${acDir("fore", "Fore")}${acDir("aft", "Aft")}${acDir("port", "Port")}${acDir("starboard", "Starboard")}
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
      <div class="sc-foot">${ctx.isGM ? "GM: click a system to change its status · click the hull bar to set HP · shields via ⚙ GM Actions" : "Press S to toggle · read-only"}</div>
    `;

    if (!ctx.isGM) return;

    // GM: click a system to set its HP (0–5). HP drives working / damaged / destroyed.
    root.querySelectorAll(".sc-card.gm").forEach((el) => {
      el.onclick = async () => {
        const id = el.dataset.sys;
        if (!ctx.promptNumber) return;
        const cur = S.normalize(ctx.getState()).systemHp?.[id]?.cur ?? S.SYSTEM_HP_MAX;
        const v = await ctx.promptNumber(`${S.SYSTEMS.find((s) => s.id === id)?.label || id} HP`, `0–${S.SYSTEM_HP_MAX}`, cur, S.SYSTEM_HP_MAX);
        if (v == null || isNaN(v)) return;
        const next = S.normalize(ctx.getState());
        next.systemHp[id] = { cur: Math.max(0, Math.min(Number(v), S.SYSTEM_HP_MAX)), max: S.SYSTEM_HP_MAX };
        next.systems[id] = S.systemState(next.systemHp[id]);
        await ctx.setState(next);
      };
    });
    // GM: click the AC readout to set the base AC.
    const acEl = root.querySelector("[data-ac].gm");
    if (acEl && ctx.promptNumber) acEl.onclick = async () => {
      const cur = S.normalize(ctx.getState()).ac.base;
      const v = await ctx.promptNumber("Base ship AC", "e.g. 13", cur, null);
      if (v == null || isNaN(v)) return;
      const next = S.normalize(ctx.getState()); next.ac.base = Math.max(1, Math.round(Number(v)));
      await ctx.setState(next);
    };
    // (Clicking the ship no longer moves the shield — the GM uses the ⚙ GM Actions toggles,
    //  and the crew aim shields via their station actions.)
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

  // Action = green circle, Bonus = orange triangle. state: false = ready (filled), true = used (outline),
  // "half" = partly spent (half-filled circle — the pilot's Movement pool draining).
  function token(kind, state, clickable) {
    const c = kind === "action" ? "#42d16a" : "#f2a03d";
    const used = state === true, half = state === "half";
    let shape;
    if (kind === "action") {
      shape = used ? `<circle cx="12" cy="12" r="8" fill="none" stroke="${c}" stroke-width="2.6"/>`
        : half ? `<circle cx="12" cy="12" r="9" fill="none" stroke="${c}" stroke-width="2.2"/><path d="M12 3 A9 9 0 0 0 12 21 Z" fill="${c}"/>`
        : `<circle cx="12" cy="12" r="9" fill="${c}"/>`;
    } else {
      shape = used ? `<polygon points="12,3 22,21 2,21" fill="none" stroke="${c}" stroke-width="2.6" stroke-linejoin="round"/>`
        : `<polygon points="12,3 22,21 2,21" fill="${c}"/>`;
    }
    const stateTxt = used ? "used" : half ? "in use" : "ready";
    const label = (kind === "action" ? "Action" : "Bonus action") + " — " + stateTxt + (clickable ? " (click to toggle)" : "");
    return `<span class="ct-tok${clickable ? " click" : ""}" data-tok="${kind}" title="${label}">` +
      `<svg width="22" height="22" viewBox="0 0 24 24">${shape}</svg></span>`;
  }
  // The Main action-token state for a crew (pilot shows half/empty as Movement Points drain).
  function actionState(c) {
    if (c.station === "pilot" && c.maneuver) return c.mp > 0 ? "half" : true;
    return c.action;
  }
  // Inline pilot movement panel (under the seat): pick a maneuver, then spend Movement Points to move/rotate.
  function pilotPanel(c) {
    if (c.station !== "pilot") return "";
    const nav = Number(c.navMult) > 1 ? Number(c.navMult) : 1;
    const navBadge = nav > 1 ? `<span class="pm-nav" title="Navigation Support: Movement Points ×${nav} this turn">×${nav} nav</span>` : "";
    if (!c.maneuver) {
      const btns = Object.entries(S.MANEUVERS).map(([k, v]) => `<button class="pm-btn" data-man="${k}">${v.label} <b>${Math.round(v.mp * nav)}</b></button>`).join("");
      return `<div class="ct-move" data-crew="${c.id}"><span class="pm-h">Maneuver</span>${navBadge}${btns}</div>`;
    }
    const remaining = c.mp > 0 ? c.mp : (!c.bonus ? 1 : 0);
    const onBonus = c.mp <= 0 && !c.bonus;
    const dis = remaining <= 0 ? " disabled" : "";
    const man = S.MANEUVERS[c.maneuver]?.label || c.maneuver;
    const mv = (k, t, lbl) => `<button class="pm-btn pm-mv"${dis} data-move="${k}" title="${t}">${lbl}</button>`;
    return `<div class="ct-move" data-crew="${c.id}"><span class="pm-h">${esc(man)}</span>${navBadge}` +
      `<span class="pm-mp${onBonus ? " bonus" : ""}" title="Movement Points left${onBonus ? " (bonus action)" : ""}">${remaining} MP${onBonus ? " ⚡" : ""}</span>` +
      mv("rotL90", "Rotate 90° left — 1 MP · 2 fuel", "⟲90") + mv("rotL45", "Rotate 45° left — 1 MP · 1 fuel", "⟲45") +
      mv("forward", "Move forward 1 space — 1 MP · 4 fuel", "↑ Fwd") +
      mv("rotR45", "Rotate 45° right — 1 MP · 1 fuel", "⟳45") + mv("rotR90", "Rotate 90° right — 1 MP · 2 fuel", "⟳90") +
      `</div>`;
  }
  // Inline gunner panel (under the seat): pick a gun → Back / Fire / Called Shot / Boarding Fire.
  // The firing-arc cone itself is drawn on the ship TOKEN on the map (drawGunCone), not here.
  function gunnerPanel(c, cctx) {
    if (c.station !== "gunner_port" && c.station !== "gunner_starboard") return "";
    if (!c.gun) {
      const btns = S.GUNS.map((g) => `<button class="pm-btn" data-gun="${g.id}" title="${g.longNote} at long range — arc shows on the ship token">${esc(g.label)} <b>+${g.toHit}</b> · <b>${g.damage}</b></button>`).join("");
      return `<div class="ct-gun" data-crew="${c.id}"><span class="pm-h">Gun</span>${btns}</div>`;
    }
    const g = S.gun(c.gun) || S.GUNS[0];
    // Targets come through cctx already redacted, and each carries the range and
    // facing worked out from the two tokens — so the gunner can see, before
    // spending an action, whether the shot is even in range and which arc it hits.
    // Keyed by gun id — this gunner's own mount, not whichever gun happened to be
    // first in the crew map. (Tolerates the old flat-array shape.)
    const tset = cctx?.targets;
    const mine = Array.isArray(tset) ? tset : (tset?.[c.gun] || tset?.any || []);
    const targets = mine.filter((t) => !t.outcome);
    const cur = targets.find((t) => t.id === c.target);
    const tgtBtn = targets.length
      ? `<button class="pm-btn ${cur ? "pm-tgt" : ""}" data-target title="Pick which contact this gun is laid on">` +
        (cur ? `🎯 ${esc(cur.name)}${cur.band ? ` <small>${esc(cur.band)}</small>` : ""}` : `🎯 No target`) + `</button>`
      : "";
    const rangeNote = cur && cur.band === "out"
      ? `<span class="pm-warn" title="Out of range for this gun">out of range</span>`
      : cur && cur.band === "long" ? `<span class="pm-warn long" title="Long range: ${esc(g.longNote)}">long · ${esc(g.longNote)}</span>` : "";
    return `<div class="ct-gun open" data-crew="${c.id}"><span class="pm-h">${esc(g.label)} <small>+${g.toHit} · ${g.damage} · <b style="color:#42d16a">close ${g.shortMax}</b>/<b style="color:#e0454d">far ${g.longMax}</b></small></span>` +
      `<button class="pm-btn" data-gunback title="Pick a different gun">← Back</button>` +
      tgtBtn + rangeNote +
      `<button class="pm-btn gc-fire" data-fire title="Fire — to-hit + damage (gun bonus + STR + bonuses)">🔥 Fire</button>` +
      `<button class="pm-btn" data-called title="Called Shot — target an enemy system">🎯 Called Shot</button>` +
      `<button class="pm-btn" data-board title="Fire a crewmate at the enemy hull (spends your action)">🚀 Boarding Fire</button></div>`;
  }
  // The inline turn-bar panel for a seat: pilot maneuvers, or gunner guns. Empty for other stations.
  function seatPanel(c, cctx) { return pilotPanel(c) || gunnerPanel(c, cctx); }
  // Wire the pilot maneuver/move panels AND the gunner gun panels — shared by GM and player views.
  function wirePilotPanels(root, cctx) {
    root.querySelectorAll(".ct-move").forEach((el) => {
      const id = el.dataset.crew;
      el.querySelectorAll("[data-man]").forEach((b) => { b.onclick = () => cctx.pilotManeuver(id, b.dataset.man); });
      el.querySelectorAll("[data-move]").forEach((b) => { if (!b.disabled) b.onclick = () => cctx.pilotMove(id, b.dataset.move); });
    });
    root.querySelectorAll(".ct-gun").forEach((el) => {
      const id = el.dataset.crew;
      el.querySelectorAll("[data-gun]").forEach((b) => { b.onclick = () => cctx.selectGun(id, b.dataset.gun); });
      const back = el.querySelector("[data-gunback]"); if (back) back.onclick = () => cctx.selectGun(id, null);
      const fire = el.querySelector("[data-fire]"); if (fire) fire.onclick = () => cctx.gunFire(id);
      const called = el.querySelector("[data-called]"); if (called) called.onclick = () => cctx.calledShot(id);
      const board = el.querySelector("[data-board]"); if (board) board.onclick = () => cctx.boardingFire(id);
      const tgt = el.querySelector("[data-target]"); if (tgt) tgt.onclick = () => cctx.pickTarget && cctx.pickTarget(id);
    });
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
        const seat = `<div class="ct-seat" data-crew="${c.id}">` +
          `<div><div class="ct-name">${esc(c.name)}</div><div class="ct-sub">owner: ${esc(c.ownerUserId ? nameOf(cctx, c.ownerUserId) : "—")}</div></div>` +
          `<select class="ct-sel" data-station title="Station">${stationOpts(c.station)}</select>` +
          `<div class="ct-toks">${token("action", actionState(c), true)}${token("bonus", c.bonus, true)}${grantedTokens(c.granted)}</div>` +
          `<div class="ct-ctrl"><select class="ct-sel" data-ctrl title="Controlled by">${ctrlOpts}</select>` +
          `<span class="ct-x" data-remove title="Exclude from combat">✕</span></div></div>`;
        const panel = seatPanel(c, cctx);
        return panel ? `<div class="ct-seatwrap">${seat}${panel}</div>` : seat;
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
      wirePilotPanels(root, cctx);
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
      const seat = `<div class="ct-seat mine" data-crew="${c.id}">` +
        `<div><div class="ct-name">${esc(c.name)}</div><div class="ct-sub">${stLabel}</div>${sub}</div>` +
        `<div class="ct-toks">${token("action", actionState(c), true)}${token("bonus", c.bonus, true)}${grantedTokens(c.granted)}</div>${btn}</div>`;
      const panel = seatPanel(c, cctx);
      return panel ? `<div class="ct-seatwrap mine">${seat}${panel}</div>` : seat;
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
    wirePilotPanels(root, cctx);
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
    const shipFile = ctx.assetUrl(`assets/ship/ship-${S.shipVariant(state)}.webp`);
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
    // (Ship-click no longer changes the shield — GM uses ⚙ GM Actions; crew aim via station actions.)
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
    // Measure the tile before touching the popup: its geometry does not depend on the
    // popup's content, so reading it first avoids one of the two forced layouts this
    // used to trigger on every tile hover.
    const r = tileEl.getBoundingClientRect();
    const meta = [it.qty > 1 ? `Qty ${it.qty}` : "", it.weight ? `${it.weight} lb` : ""].filter(Boolean).join(" · ");
    const provides = it.resKind
      ? `<div class="ip-prov">Provides <b>+${it.resAmount} ${it.resKind === "fuel" ? "⛽ Fuel" : "⚡ Power"}</b>${it.overcharge ? ' <span class="ip-over">⚡ overcharges past max</span>' : ""}</div>`
      : "";
    p.innerHTML =
      `<img src="${esc(it.img || DEFAULT_ITEM_IMG)}" alt="" onerror="this.style.display='none'">` +
      `<div class="ip-name">${esc(it.name)}</div><div class="ip-type">${esc(it.type || "item")}</div>` +
      (meta ? `<div class="ip-meta">${esc(meta)}</div>` : "") + provides +
      `<div class="ip-desc">${esc(it.desc || "No description.")}</div>`;
    p.classList.add("show");
    const pw = 240, ph = p.offsetHeight || 180, gap = 12;
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

  /* ===== Repair puzzle engine + mini-games (environment-agnostic, exposed on S) ===== */
  const _rnd = (n) => Math.floor(Math.random() * n);
  const _shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = _rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const SYS_PUZZLE = { reactor: "flow", engine: "simon", shields: "waveform", weapons: "targeting", sensors: "signal", lifesupport: "valves", cloak: "phase", thrusters: "sync" };
  const PUZZLE_HINT = {
    flow: "Rotate the conduits to link the amber source to the red core.",
    simon: "Repeat the fold-coil sequence — it grows by one each round.",
    waveform: "Match the dashed target wave with the three sliders.",
    targeting: "Destroy every target before time runs out.",
    signal: "Move the probe to find the hidden signal, then LOCK while it's HOT.",
    valves: "Balance the valves so every gauge sits in its green band at once.",
    phase: "Toggle emitters (each flips itself + its neighbours) until all are lit.",
    sync: "Lock each thruster bar while its marker is in the green zone."
  };
  const PUZZLES = {};
  let _rpCleanups = [];
  let _rpFinish = null;
  /** Abort the running repair puzzle through its own fail path. */
  S.abortRepairPuzzle = function () { if (_rpFinish) _rpFinish(false); else closeRepairPuzzle(); };
  function closeRepairPuzzle() {
    _rpCleanups.forEach((fn) => { try { fn(); } catch (e) {} });
    _rpCleanups = [];
    const o = document.getElementById("ssv-repair-puzzle"); if (o) o.remove();
  }
  S.closeRepairPuzzle = closeRepairPuzzle;
  S.openRepairPuzzle = function (systemId, opts) {
    opts = opts || {};
    closeRepairPuzzle();
    S.ensureStyles();
    const sys = S.SYSTEMS.find((s) => s.id === systemId) || { label: systemId };
    const key = SYS_PUZZLE[systemId] || "flow";
    const ov = document.createElement("div"); ov.id = "ssv-repair-puzzle"; ov.className = "srp-overlay";
    ov.innerHTML =
      `<div class="srp"><div class="srp-head"><span class="srp-title">REPAIRING — ${esc(String(sys.label).toUpperCase())}</span></div>` +
      `<div class="srp-timerwrap"><div class="srp-timer" data-timer></div></div>` +
      `<div class="srp-body" data-body></div>` +
      `<div class="srp-foot"><span class="srp-msg" data-msg>${PUZZLE_HINT[key] || ""}</span><button class="srp-x" data-x>Abort</button></div></div>`;
    document.body.appendChild(ov);
    const bodyEl = ov.querySelector("[data-body]"), timerEl = ov.querySelector("[data-timer]"), msgEl = ov.querySelector("[data-msg]");
    let done = false;
    const finish = (win) => { if (done) return; done = true; _rpFinish = null; closeRepairPuzzle(); if (win) opts.onSolve && opts.onSolve(); else opts.onFail && opts.onFail(); };
    // Esc has to be able to FAIL the puzzle, not merely remove it: the action is
    // already spent by the time this opens, so a silent teardown ate the repair.
    _rpFinish = finish;
    const api = {
      win: () => { if (done) return; msgEl.textContent = "✓ SYSTEM RESTORED"; msgEl.style.color = "#42d16a"; setTimeout(() => finish(true), 450); },
      fail: () => { if (done) return; msgEl.textContent = "✗ REPAIR FAILED"; msgEl.style.color = "#e0454d"; setTimeout(() => finish(false), 450); },
      setHint: (t) => { if (!done) msgEl.textContent = t; },
      addCleanup: (fn) => _rpCleanups.push(fn)
    };
    ov.querySelector("[data-x]").onclick = () => finish(false);
    ov.onclick = (e) => { if (e.target === ov) finish(false); };
    const total = Math.max(3000, opts.timeMs || 15000);
    const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    const start = now();
    // setInterval (not rAF) so the countdown keeps running even if the player's tab is backgrounded.
    const iv = setInterval(() => {
      if (done) return;
      const frac = Math.max(0, 1 - (now() - start) / total);
      timerEl.style.width = (frac * 100) + "%";
      timerEl.style.background = frac > 0.5 ? "#42d16a" : frac > 0.2 ? "#f2b03d" : "#e0454d";
      if (frac <= 0) { msgEl.textContent = "✗ OUT OF TIME"; msgEl.style.color = "#e0454d"; finish(false); }
    }, 100);
    api.addCleanup(() => clearInterval(iv));
    (PUZZLES[key] || PUZZLES.flow)(bodyEl, api);
  };

  // ── Navigation Support mini-game (Science action) — graded, never fails.
  //    Calls opts.onDone(perf 0..1) on completion, opts.onCancel() on abort. Two random variants. ──
  const _nowMs = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  const _clamp01 = (x) => Math.max(0, Math.min(1, x));
  let _ngCleanups = [];
  let _ngFinish = null;
  /** Abort the running nav game through its own fail path. */
  S.abortNavGame = function () { if (_ngFinish) _ngFinish(); else closeNavGame(); };
  function closeNavGame() {
    _ngCleanups.forEach((fn) => { try { fn(); } catch (e) {} });
    _ngCleanups = [];
    const o = document.getElementById("ssv-nav-game"); if (o) o.remove();
  }
  S.closeNavGame = closeNavGame;
  S.openNavGame = function (opts) {
    opts = opts || {};
    closeNavGame();
    S.ensureStyles();
    const variant = opts.variant || (_rnd(2) === 0 ? "course" : "gates");
    const titles = { course: "PLOT THE COURSE", gates: "THREAD THE GATES" };
    const hints = { course: "Click the nav beacons in order — 1 → last — fast and clean.", gates: "Move your mouse to steer. Fly the marker through each gate's gap." };
    const ov = document.createElement("div"); ov.id = "ssv-nav-game"; ov.className = "sng-overlay";
    ov.innerHTML =
      `<div class="sng"><div class="sng-head"><span class="sng-title">NAV SUPPORT — ${titles[variant]}</span>` +
      `<span class="sng-score" data-score></span></div>` +
      `<div class="sng-body" data-body></div>` +
      `<div class="sng-foot"><span class="sng-msg" data-msg>${hints[variant]}</span><button class="sng-x" data-x>Abort</button></div></div>`;
    document.body.appendChild(ov);
    const bodyEl = ov.querySelector("[data-body]"), scoreEl = ov.querySelector("[data-score]"), msgEl = ov.querySelector("[data-msg]");
    let done = false;
    const api = {
      setScore: (t) => { if (!done) scoreEl.textContent = t; },
      setHint: (t) => { if (!done) msgEl.textContent = t; },
      addCleanup: (fn) => _ngCleanups.push(fn)
    };
    const finish = (perf) => {
      if (done) return; done = true;
      const p = _clamp01(perf), mult = Math.round((1.5 + p) * 100) / 100;   // 1.5 (rough) … 2.5 (perfect)
      _ngCleanups.forEach((fn) => { try { fn(); } catch (e) {} }); _ngCleanups = [];
      scoreEl.textContent = `${Math.round(p * 100)}%`;
      msgEl.textContent = `Course locked — Pilot Movement Points ×${mult}`; msgEl.style.color = "#38e1c4";
      setTimeout(() => { const o = document.getElementById("ssv-nav-game"); if (o) o.remove(); opts.onDone && opts.onDone(p); }, 950);
    };
    const cancel = () => { if (done) return; done = true; _ngFinish = null; closeNavGame(); opts.onCancel && opts.onCancel(); };
    // Esc routes here, so an aborted nav run reports as cancelled instead of
    // silently vanishing with the action already spent.
    _ngFinish = cancel;
    ov.querySelector("[data-x]").onclick = cancel;
    ov.onclick = (e) => { if (e.target === ov) cancel(); };
    (variant === "gates" ? navGates : navCourse)(bodyEl, api, finish);
  };

  // Variant A — Plot the Course: click numbered beacons 1→N in order; graded on completion, speed, mistakes.
  function navCourse(root, api, finish) {
    const W = 560, Hh = 350, N = 7, T = 13000;
    root.innerHTML = `<div class="sng-field" style="width:${W}px;height:${Hh}px;"><svg class="sng-lines" viewBox="0 0 ${W} ${Hh}"></svg></div>`;
    const field = root.querySelector(".sng-field"), svg = root.querySelector(".sng-lines");
    const pts = []; let guard = 0;
    while (pts.length < N && guard++ < 3000) {
      const x = 40 + _rnd(W - 80), y = 40 + _rnd(Hh - 80);
      if (pts.every((p) => Math.hypot(p.x - x, p.y - y) > 78)) pts.push({ x, y });
    }
    let next = 0, mistakes = 0; const startT = _nowMs();
    pts.forEach((p, i) => {
      const b = document.createElement("button");
      b.className = "sng-node"; b.textContent = String(i + 1);
      b.style.left = p.x + "px"; b.style.top = p.y + "px";
      field.appendChild(b);
      b.onclick = () => {
        if (done0()) return;
        if (i === next) {
          b.classList.add("hit");
          if (next > 0) {
            const a = pts[next - 1], ln = document.createElementNS("http://www.w3.org/2000/svg", "line");
            ln.setAttribute("x1", a.x); ln.setAttribute("y1", a.y); ln.setAttribute("x2", p.x); ln.setAttribute("y2", p.y); ln.setAttribute("class", "on");
            svg.appendChild(ln);
          }
          next++; api.setScore(`${next}/${N}`);
          if (next >= N) { stop(); const speed = _clamp01(1 - (_nowMs() - startT) / T); finish(_clamp01(1 - 0.06 * mistakes) * (0.7 + 0.3 * speed)); }
        } else {
          mistakes++; b.classList.add("miss"); setTimeout(() => b.classList.remove("miss"), 220);
          api.setHint(`Wrong beacon — follow the numbers (${mistakes} slip${mistakes > 1 ? "s" : ""}).`);
        }
      };
    });
    api.setScore(`0/${N}`);
    let ended = false; const done0 = () => ended;
    const iv = setInterval(() => {
      const el = _nowMs() - startT;
      if (el >= T) { stop(); finish(_clamp01((next / N) * (1 - 0.06 * mistakes))); }
      else if (mistakes === 0) api.setHint(`${Math.ceil((T - el) / 1000)}s left — reach beacon ${next + 1}.`);
    }, 250);
    function stop() { ended = true; clearInterval(iv); }
    api.addCleanup(stop);
  }

  // Variant B — Thread the Gates: steer a marker (mouse) so it passes through each scrolling gate's gap.
  function navGates(root, api, finish) {
    const W = 520, Hh = 380, G = 8, shipY = Hh - 46, shipR = 14, gap = 96, speed = 155, spacing = 150;
    root.innerHTML = `<div class="sng-field sng-chan" style="width:${W}px;height:${Hh}px;"><canvas width="${W}" height="${Hh}"></canvas></div>`;
    const field = root.querySelector(".sng-field"), cv = root.querySelector("canvas"), cx = cv.getContext("2d");
    let shipX = W / 2;
    const onMove = (e) => { const r = cv.getBoundingClientRect(); shipX = Math.max(shipR, Math.min(W - shipR, (e.clientX - r.left) * (W / r.width))); };
    field.addEventListener("mousemove", onMove);
    api.addCleanup(() => field.removeEventListener("mousemove", onMove));
    const gates = [];
    for (let i = 0; i < G; i++) gates.push({ y: -60 - i * spacing, gx: 40 + gap / 2 + _rnd(W - 80 - gap), judged: false, passed: false });
    let passed = 0, judged = 0, raf = 0, last = _nowMs(), ended = false;
    api.setScore(`0/${G}`);
    const step = () => {
      if (ended) return;
      const t = _nowMs(), dt = Math.min(0.05, (t - last) / 1000); last = t;
      cx.clearRect(0, 0, W, Hh);
      cx.strokeStyle = "rgba(56,225,196,.22)"; cx.lineWidth = 2; cx.beginPath(); cx.moveTo(0, shipY); cx.lineTo(W, shipY); cx.stroke();
      for (const g of gates) {
        g.y += speed * dt;
        cx.fillStyle = g.judged ? (g.passed ? "rgba(66,209,106,.55)" : "rgba(224,69,77,.55)") : "#6fb2d6";
        cx.fillRect(0, g.y - 5, g.gx - gap / 2, 10);
        cx.fillRect(g.gx + gap / 2, g.y - 5, W - (g.gx + gap / 2), 10);
        if (!g.judged && g.y >= shipY) {
          g.judged = true; g.passed = Math.abs(shipX - g.gx) <= gap / 2 - 4; if (g.passed) passed++; judged++;
          api.setScore(`${passed}/${G}`);
          if (judged >= G) { ended = true; cancelAnimationFrame(raf); return finish(passed / G); }
        }
      }
      cx.fillStyle = "#38e1c4"; cx.shadowColor = "rgba(56,225,196,.7)"; cx.shadowBlur = 10;
      cx.beginPath(); cx.moveTo(shipX, shipY - shipR); cx.lineTo(shipX - shipR * 0.72, shipY + shipR * 0.72); cx.lineTo(shipX + shipR * 0.72, shipY + shipR * 0.72); cx.closePath(); cx.fill();
      cx.shadowBlur = 0;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    api.addCleanup(() => { ended = true; cancelAnimationFrame(raf); });
  }

  // 1) reactor — Power Routing: rotate pipe tiles to connect source → core (flood-fill).
  PUZZLES.flow = (root, api) => {
    const N = 5, U = 1, R = 2, D = 4, L = 8;
    const nb = [{ b: U, dr: -1, dc: 0, opp: D }, { b: R, dr: 0, dc: 1, opp: L }, { b: D, dr: 1, dc: 0, opp: U }, { b: L, dr: 0, dc: -1, opp: R }];
    const rot = (m) => ((m << 1) & 15) | ((m >> 3) & 1);
    const ix = (r, c) => r * N + c;
    const src = { r: _rnd(N), c: 0 }, core = { r: _rnd(N), c: N - 1 };
    const base = new Array(N * N).fill(0), path = [], seen = new Set();
    const dfs = (r, c) => {
      path.push({ r, c }); seen.add(ix(r, c));
      if (r === core.r && c === core.c) return true;
      for (const d of _shuffle(nb.slice())) { const nr = r + d.dr, nc = c + d.dc; if (nr < 0 || nr >= N || nc < 0 || nc >= N || seen.has(ix(nr, nc))) continue; if (dfs(nr, nc)) return true; }
      path.pop(); seen.delete(ix(r, c)); return false;
    };
    dfs(src.r, src.c);
    for (let i = 0; i < path.length; i++) { const cur = path[i]; let m = 0;
      if (i > 0) for (const d of nb) if (path[i - 1].r === cur.r + d.dr && path[i - 1].c === cur.c + d.dc) m |= d.b;
      if (i < path.length - 1) for (const d of nb) if (path[i + 1].r === cur.r + d.dr && path[i + 1].c === cur.c + d.dc) m |= d.b;
      base[ix(cur.r, cur.c)] = m; }
    const shapes = [U | D, U | R, U | R | D];
    for (let i = 0; i < N * N; i++) if (!base[i]) base[i] = shapes[_rnd(shapes.length)];
    const cell = base.map((m) => { let k = 1 + _rnd(3), mm = m; while (k--) mm = rot(mm); return mm; });
    const grid = document.createElement("div"); grid.className = "srp-grid"; grid.style.gridTemplateColumns = `repeat(${N},52px)`; root.appendChild(grid);
    const svg = (m, lit) => { const col = lit ? "#38e1c4" : "#5f7b88"; let p = "";
      if (m & U) p += `<line x1="26" y1="26" x2="26" y2="0"/>`; if (m & R) p += `<line x1="26" y1="26" x2="52" y2="26"/>`;
      if (m & D) p += `<line x1="26" y1="26" x2="26" y2="52"/>`; if (m & L) p += `<line x1="26" y1="26" x2="0" y2="26"/>`;
      return `<svg viewBox="0 0 52 52"><g stroke="${col}" stroke-width="6" stroke-linecap="round">${p}</g><circle cx="26" cy="26" r="4" fill="${col}"/></svg>`; };
    const powered = () => { const lit = new Array(N * N).fill(false); const q = [ix(src.r, src.c)]; lit[q[0]] = true;
      while (q.length) { const i = q.pop(), r = (i / N | 0), c = i % N;
        for (const d of nb) { const nr = r + d.dr, nc = c + d.dc; if (nr < 0 || nr >= N || nc < 0 || nc >= N) continue; const j = ix(nr, nc);
          if (!lit[j] && (cell[i] & d.b) && (cell[j] & d.opp)) { lit[j] = true; q.push(j); } } }
      return lit; };
    const draw = () => { const lit = powered(); grid.innerHTML = "";
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) { const i = ix(r, c);
        const t = document.createElement("div"); t.className = "srp-tile" + (lit[i] ? " lit" : "");
        if (r === src.r && c === src.c) t.classList.add("src"); if (r === core.r && c === core.c) t.classList.add("core");
        t.innerHTML = svg(cell[i], lit[i]); t.onclick = () => { cell[i] = rot(cell[i]); draw(); }; grid.appendChild(t); }
      if (lit[ix(core.r, core.c)]) api.win(); };
    draw();
  };

  // 2) engine — Fold Sequence (Simon): repeat the growing sequence.
  PUZZLES.simon = (root, api) => {
    const cols = ["#e0454d", "#42d16a", "#38e1c4", "#f2b03d"];
    const target = 4 + _rnd(2);
    const seq = []; let idx = 0, accepting = false;
    const wrap = document.createElement("div"); wrap.className = "srp-row"; wrap.style.gap = "14px"; root.appendChild(wrap);
    const coils = cols.map((c) => { const d = document.createElement("div"); d.className = "srp-coil"; d.style.color = c; d.style.borderColor = c; wrap.appendChild(d); return d; });
    const flash = (i, ms) => new Promise((res) => { const c = coils[i]; c.classList.add("on"); c.style.background = cols[i]; setTimeout(() => { c.classList.remove("on"); c.style.background = "#0a1c26"; setTimeout(res, 120); }, ms || 360); });
    const play = async () => { accepting = false; api.setHint("Watch the sequence…"); await new Promise((r) => setTimeout(r, 350)); for (const i of seq) await flash(i); accepting = true; idx = 0; api.setHint("Your turn — repeat it."); };
    const next = async () => { seq.push(_rnd(4)); await play(); };
    coils.forEach((c, i) => c.onclick = async () => {
      if (!accepting) return;
      c.classList.add("on"); c.style.background = cols[i]; setTimeout(() => { c.classList.remove("on"); c.style.background = "#0a1c26"; }, 150);
      if (i === seq[idx]) { idx++; if (idx >= seq.length) { if (seq.length >= target) api.win(); else { accepting = false; setTimeout(next, 350); } } }
      else api.fail();
    });
    next();
  };

  // 3) shields — Waveform Match: 3 sliders overlay the target sine.
  PUZZLES.waveform = (root, api) => {
    const W = 440, H = 170;
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H; cv.className = "srp-canvas"; root.appendChild(cv);
    const ctx = cv.getContext("2d");
    const tgt = { amp: 18 + _rnd(48), freq: 1 + _rnd(4), phase: _rnd(100) }, cur = { amp: 40, freq: 3, phase: 50 };
    const wave = (o, col, dash) => { ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.setLineDash(dash || []); ctx.beginPath();
      for (let x = 0; x <= W; x++) { const t = x / W, y = H / 2 - o.amp * Math.sin(2 * Math.PI * o.freq * t + o.phase / 100 * 2 * Math.PI); x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      ctx.stroke(); ctx.setLineDash([]); };
    const draw = () => { ctx.clearRect(0, 0, W, H); ctx.strokeStyle = "#12303f"; ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
      wave(tgt, "#f2b03d", [6, 5]); wave(cur, "#38e1c4");
      const pd = Math.abs(cur.phase - tgt.phase), ph = Math.min(pd, 100 - pd);
      if (Math.abs(cur.amp - tgt.amp) <= 6 && cur.freq === tgt.freq && ph <= 8) api.win(); };
    const row = document.createElement("div"); row.className = "srp-row"; row.style.cssText = "gap:20px;margin-top:8px"; root.appendChild(row);
    const mk = (label, min, max, key) => { const w = document.createElement("label"); w.className = "srp-slider"; const inp = document.createElement("input"); inp.type = "range"; inp.min = min; inp.max = max; inp.value = cur[key]; inp.oninput = () => { cur[key] = Number(inp.value); draw(); }; const t = document.createElement("span"); t.textContent = label; w.appendChild(inp); w.appendChild(t); row.appendChild(w); };
    mk("AMP", 5, 80, "amp"); mk("FREQ", 1, 6, "freq"); mk("PHASE", 0, 99, "phase");
    draw();
  };

  // 4) weapons — Targeting: destroy every moving target.
  PUZZLES.targeting = (root, api) => {
    const W = 440, H = 210;
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H; cv.className = "srp-canvas"; root.appendChild(cv);
    const ctx = cv.getContext("2d");
    const total = 5 + _rnd(3), targets = [];
    for (let i = 0; i < total; i++) targets.push({ x: 24 + _rnd(W - 48), y: 24 + _rnd(H - 48), r: 15, vx: (Math.random() - 0.5) * 1.8, vy: (Math.random() - 0.5) * 1.8, dead: false });
    let hits = 0; api.setHint(`0 / ${total} destroyed`);
    cv.onclick = (e) => { const b = cv.getBoundingClientRect(), mx = (e.clientX - b.left) * W / b.width, my = (e.clientY - b.top) * H / b.height;
      for (const t of targets) { if (t.dead) continue; if ((mx - t.x) ** 2 + (my - t.y) ** 2 <= (t.r + 3) ** 2) { t.dead = true; hits++; api.setHint(`${hits} / ${total} destroyed`); if (hits >= total) api.win(); break; } } };
    let raf; const loop = () => { ctx.clearRect(0, 0, W, H);
      for (const t of targets) { if (t.dead) continue; t.x += t.vx; t.y += t.vy; if (t.x < t.r || t.x > W - t.r) t.vx *= -1; if (t.y < t.r || t.y > H - t.r) t.vy *= -1;
        ctx.strokeStyle = "#e0454d"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(t.x, t.y, t.r, 0, 7); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(t.x - t.r, t.y); ctx.lineTo(t.x + t.r, t.y); ctx.moveTo(t.x, t.y - t.r); ctx.lineTo(t.x, t.y + t.r); ctx.stroke(); }
      raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop); api.addCleanup(() => cancelAnimationFrame(raf));
  };

  // 5) sensors — Signal Lock: hot/cold search for a hidden point, then LOCK.
  PUZZLES.signal = (root, api) => {
    const W = 440, H = 200, lockR = 28;
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H; cv.className = "srp-canvas"; root.appendChild(cv);
    const ctx = cv.getContext("2d");
    const tx = 40 + _rnd(W - 80), ty = 40 + _rnd(H - 80); let px = W / 2, py = H / 2;
    const dist = () => Math.hypot(px - tx, py - ty);
    const draw = () => { const d = dist(), hot = d < lockR, near = Math.max(0, 1 - d / 320);
      ctx.clearRect(0, 0, W, H); ctx.fillStyle = `rgba(${Math.round(60 + 190 * near)},${Math.round(120 * (1 - near))},60,0.12)`; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = hot ? "#42d16a" : near > 0.6 ? "#f2b03d" : "#38e1c4"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, 9, 0, 7); ctx.stroke(); ctx.globalAlpha = .3; ctx.beginPath(); ctx.arc(px, py, lockR, 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
      api.setHint(hot ? "SIGNAL HOT — press LOCK!" : near > 0.6 ? "warmer…" : near > 0.3 ? "cold…" : "very cold…"); };
    cv.onpointerdown = (e) => { const b = cv.getBoundingClientRect(); px = (e.clientX - b.left) * W / b.width; py = (e.clientY - b.top) * H / b.height; draw(); };
    const btn = document.createElement("button"); btn.className = "srp-btn"; btn.textContent = "LOCK SIGNAL"; btn.style.marginTop = "8px";
    btn.onclick = () => { if (dist() < lockR) api.win(); else api.setHint("No lock — reposition the probe."); };
    root.appendChild(btn); draw();
  };

  // 6) lifesupport — Valve Balance: cross-coupled sliders, all gauges into the green band.
  PUZZLES.valves = (root, api) => {
    const n = 3, s = [50, 50, 50], centers = []; for (let i = 0; i < n; i++) centers.push(30 + _rnd(40));
    const band = 12, fills = [];
    const wrap = document.createElement("div"); wrap.className = "srp-row"; wrap.style.cssText = "gap:22px;align-items:flex-end"; root.appendChild(wrap);
    const gval = (i) => Math.max(0, Math.min(100, s[i] - 0.45 * s[(i + n - 1) % n] + 22.5));
    for (let i = 0; i < n; i++) {
      const col = document.createElement("div"); col.style.cssText = "display:flex;flex-direction:row;gap:6px;align-items:flex-end";
      const inp = document.createElement("input"); inp.type = "range"; inp.min = 0; inp.max = 100; inp.value = s[i]; inp.oninput = () => { s[i] = Number(inp.value); draw(); };
      inp.style.cssText = "writing-mode:vertical-lr;direction:rtl;width:22px;height:120px;accent-color:#38e1c4";
      const g = document.createElement("div"); g.className = "srp-gauge"; const bd = document.createElement("div"); bd.className = "band"; bd.style.bottom = (centers[i] - band / 2) + "%"; bd.style.height = band + "%";
      const fill = document.createElement("div"); fill.className = "fill"; g.appendChild(bd); g.appendChild(fill); fills.push(fill);
      col.appendChild(inp); col.appendChild(g); wrap.appendChild(col);
    }
    const draw = () => { let ok = true; for (let i = 0; i < n; i++) { const v = gval(i); fills[i].style.height = v + "%"; const good = Math.abs(v - centers[i]) <= band / 2; fills[i].style.background = good ? "#42d16a" : "#38e1c4"; if (!good) ok = false; } if (ok) api.win(); };
    draw();
  };

  // 7) cloak — Phase Grid (lights-out): flip cells until all lit.
  PUZZLES.phase = (root, api) => {
    const M = 3, on = new Array(M * M).fill(true);
    const toggle = (r, c) => [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([dr, dc]) => { const nr = r + dr, nc = c + dc; if (nr >= 0 && nr < M && nc >= 0 && nc < M) on[nr * M + nc] = !on[nr * M + nc]; });
    for (let k = 0, p = 3 + _rnd(4); k < p; k++) toggle(_rnd(M), _rnd(M));
    const grid = document.createElement("div"); grid.className = "srp-grid"; grid.style.gridTemplateColumns = `repeat(${M},46px)`; root.appendChild(grid);
    const draw = () => { grid.innerHTML = ""; for (let r = 0; r < M; r++) for (let c = 0; c < M; c++) { const cell = document.createElement("div"); cell.className = "srp-cell" + (on[r * M + c] ? " on" : ""); cell.onclick = () => { toggle(r, c); draw(); }; grid.appendChild(cell); } if (on.every((v) => v)) api.win(); };
    draw();
  };

  // 8) thrusters — Sync Timing: lock each bar while its marker is in the green zone.
  PUZZLES.sync = (root, api) => {
    const n = 3 + _rnd(2), bars = [];
    const wrap = document.createElement("div"); wrap.style.cssText = "width:100%;display:flex;flex-direction:column;gap:12px"; root.appendChild(wrap);
    for (let i = 0; i < n; i++) {
      const gz = 15 + _rnd(52), gw = 18;
      const el = document.createElement("div"); el.style.cssText = "position:relative;height:26px;border-radius:8px;background:#07141d;border:1px solid #163b4e;cursor:pointer;overflow:hidden";
      const green = document.createElement("div"); green.style.cssText = `position:absolute;top:0;bottom:0;left:${gz}%;width:${gw}%;background:rgba(66,209,106,.25);border-left:1px solid #42d16a;border-right:1px solid #42d16a`; el.appendChild(green);
      const marker = document.createElement("div"); marker.style.cssText = "position:absolute;top:2px;bottom:2px;width:6px;border-radius:3px;background:#38e1c4"; el.appendChild(marker);
      const bar = { el, marker, gz, gw, pos: _rnd(100), dir: Math.random() < .5 ? 1 : -1, speed: 0.6 + Math.random() * 1.2, locked: false };
      el.onclick = () => { if (bar.locked) return;
        if (bar.pos >= bar.gz && bar.pos <= bar.gz + bar.gw) { bar.locked = true; marker.style.background = "#42d16a"; el.style.borderColor = "#42d16a"; if (bars.every((b) => b.locked)) api.win(); }
        else { el.style.borderColor = "#e0454d"; setTimeout(() => { if (!bar.locked) el.style.borderColor = "#163b4e"; }, 200); } };
      wrap.appendChild(el); bars.push(bar);
    }
    let raf; const loop = () => { for (const b of bars) { if (b.locked) continue; b.pos += b.dir * b.speed; if (b.pos <= 0) { b.pos = 0; b.dir = 1; } if (b.pos >= 100) { b.pos = 100; b.dir = -1; } b.marker.style.left = `calc(${b.pos}% - 3px)`; } raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop); api.addCleanup(() => cancelAnimationFrame(raf));
  };

  // Sort items into navigable sections (by dnd5e type + a little name matching).
  const invCollapsedSecs = new Set();   // collapsed inventory section labels (per-client, this session)
  // The search text, kept across re-renders. refreshUI is bound to the onChange of
  // BOTH world settings, so anything anyone does mid-combat re-rendered the console
  // and wiped whatever the quartermaster was halfway through typing.
  let invSearchText = "";
  let invSearchHadFocus = false;
  const INV_SECTIONS = ["Weapons", "Ammunition", "Explosives", "Medical", "Food", "Gobby's Bar",
    "Tools", "Gear & Supplies", "Apparel", "Materials", "Containers", "Valuables", "Other"];
  // Memoised: the result depends only on type+name, but the regex chain below used to be
  // re-run for every item on every inventory render.
  const _catCache = new Map();
  function invCategory(it) {
    const key = `${it.type}|${it.name}`;
    const hit = _catCache.get(key);
    if (hit !== undefined) return hit;
    const out = _invCategory(it);
    _catCache.set(key, out);
    return out;
  }
  function _invCategory(it) {
    const t = it.type, n = (it.name || "").toLowerCase();
    if (t === "weapon") return "Weapons";
    if (t === "tool") return "Tools";
    if (t === "container") return "Containers";
    if (t === "equipment") return "Apparel";
    if (t === "loot") return /ore|scrap|crystal|ferrocrystal|verdite|polymer|relay|thermite|titanium|alloy|shard|ingot|fuel|cell/.test(n) ? "Materials" : "Valuables";
    if (t === "consumable") {
      if (/bullet|arrow|bolt|needle|cartridge|energy cell|gunpowder|\bammo\b/.test(n)) return "Ammunition";
      if (/grenade|bomb|explos|dynamite|acid|alchemist.?s fire|incend|thermite/.test(n)) return "Explosives";
      if (/potion|healer|antitoxin|stim|medkit|med-gel|bandage|medic/.test(n)) return "Medical";
      if (/tequila|rum|sake|vodka|wine|whisk|\bale\b|lager|cider|brandy|grog|mead|moonshine|fizz|beer|liquor|booze|spirit/.test(n)) return "Gobby's Bar";
      if (/ration|paste|meal|nutrient|stew|fruit|caf|coffee|greens|bread|cheese|jerky|snack|\bfood\b|tack|banana/.test(n)) return "Food";
      if (/torch|candle|oil|lantern|rope|chalk|ink|waterskin|soap|climber|whetstone|tinder|flare|fishing/.test(n)) return "Gear & Supplies";
      return "Other";
    }
    return "Other";
  }

  // Ship inventory panel (right column, when kctx.invMode) — game-style grid with item pictures,
  // search, ship/you tabs, collapsible sections, hover popup, per-tile move/use, GM add-item + drag-drop.
  function renderInventoryPanel(rightEl, kctx) {
    const st = kctx.getState();
    const t = st.tuning;
    const ratio = t.convertFuel > 0 ? Math.round(t.convertPower / t.convertFuel) : 5;   // power per 1 fuel
    const ship = kctx.shipItems || [], mine = kctx.playerItems || [];
    const tab = kctx.invTab === "you" ? "you" : "ship";
    const gauge = (label, g, cls, ico) => {
      const over = g.cur > g.max;                       // overcharged / over-fuelled past max
      const pct = g.max > 0 ? Math.max(0, Math.min(1, g.cur / g.max)) * 100 : 0;
      const low = pct <= 20 && !over;
      return `<div class="ig ${cls}${low ? " low" : ""}${over ? " over" : ""}${kctx.isGM ? " gm" : ""}" ${kctx.isGM ? `data-edit="${cls}"` : ""} title="${over ? `Over max — running hot (${g.cur}/${g.max})` : kctx.isGM ? "Click to set" : ""}">` +
        `<div class="ig-top"><span class="ig-ico">${ico}</span><span class="ig-label">${label}</span>` +
        `<span class="ig-val">${g.cur}<small> / ${g.max}${over ? " ⚡" : ""}</small></span></div>` +
        `<div class="ig-track"><div class="ig-fill" style="width:${pct}%"></div></div></div>`;
    };
    const RARITY = { common: { t: "Common", c: "#9fb2bd" }, uncommon: { t: "Uncommon", c: "#42d16a" }, rare: { t: "Rare", c: "#3aa0ff" }, veryRare: { t: "Very Rare", c: "#b06bf0" }, legendary: { t: "Legendary", c: "#f2b03d" }, artifact: { t: "Exotic", c: "#ff8a4c" } };
    const tile = (it, isShip) => {
      // Top corners: GM delete (TL) + edit (TR), ship items only.
      const corners = (isShip && kctx.isGM)
        ? `<button class="it-ib it-tl danger" data-del title="Delete from ship">🗑</button>` +
          `<button class="it-ib it-tr" data-qty title="Edit item">✏</button>`
        : "";
      // Bottom-left: resource-use icon, only for a fuel/power item. Bottom-right: move.
      const resIco = it.resKind === "fuel" ? "⛽" : it.resKind === "power" ? "⚡" : "";
      const resBtn = (isShip && it.resKind)
        ? `<button class="it-ib${it.overcharge ? " over" : ""}" data-res title="Use as ${it.resKind} (+${it.resAmount} ${it.resKind}${it.overcharge ? " · ⚡ overcharges past max" : ""})">${resIco}</button>`
        : "";
      const moveBtn = isShip
        ? `<button class="it-ib" data-move title="Move to your inventory">→</button>`
        : `<button class="it-ib" data-move title="Move to the ship">→</button>`;
      const r = RARITY[it.rarity];
      const tierBadge = r ? `<span class="it-tier" style="color:${r.c};border-color:${r.c}">${r.t}</span>` : "";
      return `<div class="inv-tile" data-id="${it.id}" data-name="${esc(it.name)}">` +
        corners +
        `<div class="it-imgwrap"><img src="${esc(it.img || DEFAULT_ITEM_IMG)}" alt="" onerror="this.src='${DEFAULT_ITEM_IMG}'">` +
          (it.qty > 1 ? `<span class="it-qty">×${it.qty}</span>` : "") + `</div>` +
        `<span class="it-name">${esc(it.name)}</span>${tierBadge}` +
        `<div class="it-bottom"><span class="it-bl">${resBtn}</span><span class="it-br">${moveBtn}</span></div>` +
      `</div>`;
    };
    const list = tab === "ship" ? ship : mine;
    const isShipTab = tab === "ship";
    // Group items into ordered sections; render each as a collapsible block.
    const groups = {};
    for (const it of list) { const c = invCategory(it); (groups[c] = groups[c] || []).push(it); }
    const sectionsHtml = INV_SECTIONS.filter((s) => groups[s]?.length).map((s) => {
      const collapsed = invCollapsedSecs.has(s);
      const body = groups[s].map((it) => tile(it, isShipTab)).join("");
      return `<div class="inv-sec${collapsed ? " collapsed" : ""}" data-sec="${esc(s)}">` +
        `<div class="inv-sec-head"><span class="inv-caret">▾</span><span class="inv-sec-name">${esc(s)}</span>` +
        `<span class="inv-sec-count">${groups[s].length}</span></div>` +
        `<div class="inv-sec-body">${body}</div></div>`;
    }).join("");
    const gridInner = (tab === "you" && !kctx.hasPlayerActor)
      ? `<div class="inv-empty">No character is assigned to you.</div>`
      : (list.length ? sectionsHtml : `<div class="inv-empty">— empty —</div>`);
    const gmBtns = kctx.isGM
      ? `<button class="con-inv" data-act="additem" title="Add any item to the ship">＋ Add item</button>` +
        `<button class="con-inv" data-act="tune" title="Set fuel/power maximums">Max</button>` +
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
          `<div class="inv-search"><span>🔎</span><input type="text" placeholder="Search inventory…" data-search="1" value="${esc(invSearchText)}"></div>${gmBtns}</div>` +
        `<div class="inv-list${tab === "ship" ? " drop-ok" : ""}" data-tab="${tab}">${gridInner}</div>` +
      `</div>`;

    rightEl.querySelector(".con-x").onclick = () => { hideInvPop(); kctx.close(); };
    rightEl.querySelector('[data-act="stations"]').onclick = () => { hideInvPop(); kctx.toggleInv(); };
    rightEl.querySelectorAll("[data-convert]").forEach((b) => { b.onclick = () => kctx.convert(Number(b.dataset.convert)); });
    const tuneB = rightEl.querySelector('[data-act="tune"]'); if (tuneB) tuneB.onclick = () => kctx.tune();
    const actorB = rightEl.querySelector('[data-act="actor"]'); if (actorB) actorB.onclick = () => kctx.setActor();
    const addB = rightEl.querySelector('[data-act="additem"]'); if (addB) addB.onclick = () => kctx.addItem();
    if (kctx.isGM) rightEl.querySelectorAll(".ig.gm").forEach((g) => { g.onclick = () => (g.dataset.edit === "fuel" ? kctx.editFuel() : kctx.editPower()); });
    rightEl.querySelectorAll(".inv-tab").forEach((b) => { b.onclick = () => { hideInvPop(); kctx.setInvTab(b.dataset.tab); }; });

    // Collapsible sections — toggle the section (DOM + remembered state), no re-render needed.
    rightEl.querySelectorAll(".inv-sec-head").forEach((h) => {
      h.onclick = () => {
        const sec = h.closest(".inv-sec"), label = sec.dataset.sec;
        if (invCollapsedSecs.has(label)) { invCollapsedSecs.delete(label); sec.classList.remove("collapsed"); }
        else { invCollapsedSecs.add(label); sec.classList.add("collapsed"); }
      };
    });

    // Search: filter tiles in-place (no re-render → keeps input focus); hide empty sections.
    const search = rightEl.querySelector("[data-search]");
    const grid = rightEl.querySelector(".inv-list");
    const applyFilter = () => {
      if (!grid) return;
      const q = invSearchText.trim().toLowerCase();
      grid.querySelectorAll(".inv-tile").forEach((tl) => {
        tl.style.display = (!q || (tl.dataset.name || "").toLowerCase().includes(q)) ? "" : "none";
      });
      grid.querySelectorAll(".inv-sec").forEach((sec) => {
        const anyVisible = [...sec.querySelectorAll(".inv-tile")].some((t) => t.style.display !== "none");
        sec.style.display = anyVisible ? "" : "none";
      });
    };
    if (search && grid) {
      search.oninput = () => { invSearchText = search.value; applyFilter(); };
      // Re-apply after a re-render, and put the caret back where it was: the
      // console re-renders on every world write, which used to drop both.
      if (invSearchText) {
        applyFilter();
        if (invSearchHadFocus) {
          try { search.focus(); search.setSelectionRange(invSearchText.length, invSearchText.length); } catch (e) {}
        }
      }
      search.onfocus = () => { invSearchHadFocus = true; };
      search.onblur = () => { invSearchHadFocus = false; };
    }

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

  // GM Actions panel: direct, GM-only controls (no crew action economy). Extensible.
  // Shields are simple ON/OFF toggles here — the crew set which side they face via their station actions.
  function renderGMPanel(rightEl, kctx) {
    const st = kctx.getState();
    const curMain = st.shield.on ? st.shield.facing : null, curSec = st.shield.secondary;
    const lbl = (f) => f ? esc(S.FACING_LABEL[f].toUpperCase()) : "OFF";
    const armed = kctx.armed;   // 'main' | 'secondary' | null
    rightEl.innerHTML =
      `<div class="con-head"><span class="con-title">GM ACTIONS</span><button class="con-inv" data-act="stations" title="Back to stations">⚔ Stations</button><button class="con-x" title="Close (Esc)">✕</button></div>` +
      `<div class="con-sec"><div class="con-h">SHIELDS</div><div class="con-btns">` +
        `<button class="con-btn${armed === "main" ? " armed" : ""}" data-arm="main">Shield — ${lbl(curMain)}${armed === "main" ? " · pick a side" : ""}</button>` +
        `<button class="con-btn${armed === "secondary" ? " armed" : ""}" data-arm="secondary">Secondary Shield — ${curSec ? lbl(curSec) : "OFF"}${armed === "secondary" ? " · pick a side" : ""}</button>` +
      `</div></div>` +
      (armed
        ? `<div class="con-hint">Click a ${armed === "main" ? "red" : "green"} circle on the ship to place the shield — click the lit side again to switch it off, or the button again to cancel.</div>`
        : `<div class="con-hint">Click a shield, then a side of the ship to allocate it. Free, no action cost, announced in chat.</div>`) +
      `<div class="con-sec"><div class="con-h">CREW</div><div class="con-btns">` +
        `<button class="con-btn" data-act="prof">Proficiency…</button></div>` +
        `<div class="con-hint">Tick which rolls each crew member is proficient in — adds their character's proficiency bonus to that roll.</div></div>` +
      // The six blueprints sheared off in the crash. Building one brings its
      // station online, adds its gun to the gunners' list, and — because the map
      // pack ships one PNG per mount — puts it on the ship's own art.
      `<div class="con-sec"><div class="con-h">TURRETS</div><div class="con-btns">` +
        S.TURRETS.map((t) => {
          const b = S.turretBuilt(st, t.id), hp = S.turretHp(st, t.id);
          const state = !b ? "not built" : hp.cur <= 0 ? "wrecked" : hp.cur < hp.max ? `${hp.cur}/${hp.max}` : "online";
          return `<button class="con-btn${b && hp.cur > 0 ? " armed" : ""}" data-turret="${t.id}" title="${esc(t.blurb)}">` +
                 `${t.num}. ${esc(t.name)} <small>· ${state}</small></button>`;
        }).join("") +
      `</div><div class="con-hint">Click to build or scrap a turret. A built mount joins the gunners' gun list and unlocks its own station.</div></div>`;
    rightEl.querySelector(".con-x").onclick = () => kctx.close();
    rightEl.querySelector('[data-act="stations"]').onclick = () => kctx.toggleGM();
    rightEl.querySelectorAll("[data-arm]").forEach((b) => { b.onclick = () => kctx.armShield(b.dataset.arm); });
    rightEl.querySelector('[data-act="prof"]').onclick = () => kctx.openProficiency();
    rightEl.querySelectorAll("[data-turret]").forEach((b) => { b.onclick = () => kctx.toggleTurret && kctx.toggleTurret(b.dataset.turret); });
  }


  /* ---------------------------------------------------------------------- */
  /*  The SPACE ⇄ DECKS toggle                                               */
  /*                                                                          */
  /*  One switch in the ship console. SPACE is the battle; DECKS is the hull  */
  /*  you are standing in — the Gull by default, and whatever you have boarded */
  /*  once you breach. A deck strip stacks bottom-to-top like a cross-section, */
  /*  so "which deck am I on" is a glance rather than a label.                 */
  /* ---------------------------------------------------------------------- */

  S.DECK_CSS = `
.sgcon .dk-wrap{display:flex;flex-direction:column;gap:12px;padding:2px 0;}
.sgcon .dk-toggle{display:flex;position:relative;background:#0a1c26;border:1px solid #1d6a86;border-radius:9px;padding:3px;}
.sgcon .dk-toggle button{flex:1;position:relative;z-index:2;font-family:inherit;font-size:12px;font-weight:700;
  letter-spacing:2px;color:#6f97a6;background:none;border:none;padding:7px 0;cursor:pointer;transition:color .18s;text-align:center;}
.sgcon .dk-toggle button.on{color:#04121c;}
.sgcon .dk-thumb{position:absolute;top:3px;bottom:3px;left:3px;width:calc(50% - 3px);border-radius:7px;
  background:#2ec2aa;box-shadow:0 0 14px rgba(56,225,196,.45);transition:transform .22s cubic-bezier(.2,.75,.25,1);}
.sgcon .dk-toggle.decks .dk-thumb{transform:translateX(100%);}

/* where you are: calm teal aboard your own hull, a slow red breath aboard someone else's */
.sgcon .dk-aboard{display:flex;align-items:center;gap:9px;padding:8px 11px;border-radius:9px;font-size:12px;
  border:1px solid #1d6a86;background:rgba(10,28,38,.6);}
.sgcon .dk-aboard b{color:#dff3f6;}
.sgcon .dk-aboard.enemy{border-color:#7a2b30;background:rgba(58,17,20,.5);animation:dk-breathe 3.2s ease-in-out infinite;}
@keyframes dk-breathe{0%,100%{box-shadow:0 0 0 rgba(224,69,77,0);}50%{box-shadow:0 0 16px rgba(224,69,77,.45);}}
.sgcon .dk-aboard .dk-dot{width:8px;height:8px;border-radius:50%;background:#38e1c4;flex:none;}
.sgcon .dk-aboard.enemy .dk-dot{background:#e0454d;}

/* the deck strip reads as a cross-section: deck 1 at the bottom */
.sgcon .dk-strip{display:flex;flex-direction:column-reverse;gap:6px;}
.sgcon .dk-deck{display:flex;align-items:center;gap:10px;padding:9px 11px;border:1px solid #14455a;border-radius:9px;
  background:rgba(8,21,33,.65);cursor:pointer;transition:border-color .14s,box-shadow .14s;}
.sgcon .dk-deck:hover{border-color:#1d6a86;box-shadow:0 0 12px rgba(29,106,134,.35);}
.sgcon .dk-deck.here{border-color:#38e1c4;box-shadow:0 0 16px rgba(56,225,196,.32);}
.sgcon .dk-num{width:26px;height:26px;flex:none;border-radius:7px;display:flex;align-items:center;justify-content:center;
  font-size:12px;font-weight:700;color:#6f97a6;border:1px solid #1d6a86;background:#081521;}
.sgcon .dk-deck.here .dk-num{color:#04121c;background:#2ec2aa;border-color:#38e1c4;}
.sgcon .dk-name{font-size:12px;color:#dff3f6;}
.sgcon .dk-sub{font-size:10px;color:#6f97a6;letter-spacing:1px;}
.sgcon .dk-count{margin-left:auto;font-size:10px;letter-spacing:1px;color:#f2b03d;}
.sgcon .dk-count.none{color:#5a7c8a;}
.sgcon .dk-note{font-size:11px;color:#8fb2c0;line-height:1.5;background:rgba(56,225,196,.06);
  border-left:2px solid #1d6a86;padding:8px 10px;border-radius:0 6px 6px 0;}
.sgcon .dk-note b{color:#f2b03d;}
.sgcon .dk-btn{font-family:inherit;font-size:12px;font-weight:700;letter-spacing:1px;color:#cfeef0;background:#0a1c26;
  border:1px solid #1d6a86;border-radius:8px;padding:9px 12px;cursor:pointer;}
.sgcon .dk-btn:hover{border-color:#38e1c4;color:#38e1c4;box-shadow:0 0 12px rgba(56,225,196,.28);}
.sgcon .dk-btn.warn{border-color:#6b3238;}
.sgcon .dk-btn.warn:hover{border-color:#e0454d;color:#e0454d;}

/* --- "we are being hit" --------------------------------------------------
   Four tiers keyed to the FRACTION of max hull, so a scratch on a capital and
   a scratch on a corvette read the same. Tier 1 is a whisper on purpose: a long
   firefight is mostly tier 1, and it has to stay tolerable. */
#ssv-alert{position:fixed;inset:0;z-index:200;pointer-events:none;display:none;}
#ssv-alert.t1{box-shadow:inset 0 0 90px rgba(224,69,77,.20);animation:ssv-alert-in .5s ease both;}
#ssv-alert.t2{box-shadow:inset 0 0 150px rgba(224,69,77,.38);animation:ssv-alert-in .7s ease both;}
#ssv-alert.t3{box-shadow:inset 0 0 220px rgba(224,69,77,.60);animation:ssv-alert-hard .9s ease both;}
@keyframes ssv-alert-in{0%{opacity:0;}18%{opacity:1;}100%{opacity:0;}}
@keyframes ssv-alert-hard{0%{opacity:0;}10%{opacity:1;}45%{opacity:.55;}70%{opacity:1;}100%{opacity:0;}}
@media (prefers-reduced-motion:reduce){#ssv-alert{animation:none!important;}}
`;

  /**
   * The DECKS panel.
   *
   * dctx = { isGM, hullName, isOwnShip, decks:[{n,name,crew,here}], deck,
   *          canReturn, goDeck(n), returnToShip(), buildDecks(), breachInfo }
   */
  S.renderDecks = function (rightEl, kctx) {
    const d = kctx.decks;
    const head = `<div class="con-head"><span class="con-title">DECKS</span>` +
      `${kctx.isGM ? `<button class="con-inv" data-gm="1" title="GM actions">⚙ GM</button>` : ""}` +
      `<button class="con-inv" data-inv="1" title="Ship inventory">📦 Inventory</button>` +
      `<button class="con-x" title="Close (Esc)">✕</button></div>`;

    if (!d || !d.decks?.length) {
      rightEl.innerHTML = head + `<div class="dk-wrap">${spaceDecksToggle(true)}` +
        `<div class="con-empty">${kctx.isGM
          ? "No deck plan built for this hull yet. Build one from ⚙ GM → Decks, or board a ship to generate it."
          : "No deck plan for this hull — the Science officer may need to scan it first."}</div></div>`;
      wireDeckHead(rightEl, kctx);
      return;
    }

    const strip = d.decks.map((k) => `
      <div class="dk-deck${k.here ? " here" : ""}" data-deck="${k.n}">
        <span class="dk-num">${k.n}</span>
        <span><span class="dk-name">${esc(k.name)}</span><br><span class="dk-sub">${k.here ? "YOU ARE HERE" : "deck " + k.n}</span></span>
        <span class="dk-count${k.crew ? "" : " none"}">${k.crew == null ? "?" : k.crew ? `${k.crew} aboard` : "clear"}</span>
      </div>`).join("");

    rightEl.innerHTML = head + `<div class="dk-wrap">
      ${spaceDecksToggle(true)}
      <div class="dk-aboard${d.isOwnShip ? "" : " enemy"}">
        <span class="dk-dot"></span>
        <span>${d.isOwnShip ? "Aboard <b>" + esc(d.hullName) + "</b> — your own hull."
                            : "Aboard <b>" + esc(d.hullName) + "</b> — this is not your ship."}</span>
      </div>
      <div class="dk-strip">${strip}</div>
      ${d.breachInfo ? `<div class="dk-note">${d.breachInfo}</div>` : ""}
      ${!d.isOwnShip && d.canReturn ? `<button class="dk-btn warn" data-return>⟵ Back to the Gull</button>` : ""}
      ${d.isOwnShip && kctx.isGM ? `<button class="dk-btn" data-rebuild>⟳ Rebuild this deck plan</button>` : ""}
    </div>`;
    wireDeckHead(rightEl, kctx);
    rightEl.querySelectorAll("[data-deck]").forEach((el) => { el.onclick = () => kctx.goDeck(Number(el.dataset.deck)); });
    const back = rightEl.querySelector("[data-return]"); if (back) back.onclick = () => kctx.returnToShip();
    const rb = rightEl.querySelector("[data-rebuild]"); if (rb) rb.onclick = () => kctx.buildDecks(true);
  };

  function spaceDecksToggle(onDecks) {
    return `<div class="dk-toggle${onDecks ? " decks" : ""}"><span class="dk-thumb"></span>` +
      `<button data-view="space" class="${onDecks ? "" : "on"}">SPACE</button>` +
      `<button data-view="decks" class="${onDecks ? "on" : ""}">DECKS</button></div>`;
  }
  S.spaceDecksToggle = spaceDecksToggle;

  function wireDeckHead(rightEl, kctx) {
    rightEl.querySelector(".con-x").onclick = () => kctx.close();
    const inv = rightEl.querySelector("[data-inv]"); if (inv) inv.onclick = () => kctx.toggleInv();
    const gm = rightEl.querySelector("[data-gm]"); if (gm) gm.onclick = () => kctx.toggleGM();
    rightEl.querySelectorAll("[data-view]").forEach((b) => { b.onclick = () => kctx.setView(b.dataset.view); });
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
    if (kctx.deckMode) { S.renderDecks(rightEl, kctx); return; }

    // Right column = station action panel.
    const stId = kctx.station, crew = kctx.crew;
    const acts = stId ? S.stationActions(stId) : { main: [], bonus: [] };
    const stName = stId ? (S.station(stId)?.name || stId) : "STATION";
    const picker = (kctx.stationOptions?.length > 1)
      ? `<select class="con-sel" title="${kctx.isGM ? "Drive which station" : "Switch which of your crew"}">${kctx.stationOptions.map((o) => `<option value="${o.crewId}" ${o.crewId === kctx.currentCrewId ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`
      : "";

    if (!stId || !crew) {
      rightEl.innerHTML = `<div class="con-head"><span class="con-title">STATION</span>${picker}${kctx.isGM ? `<button class="con-inv" data-gm="1" title="GM actions">⚙ GM</button>` : ""}<button class="con-inv" data-inv="1" title="Ship inventory">📦 Inventory</button><button class="con-x" title="Close (Esc)">✕</button></div>` +
        // The DECKS switch belongs here too: walking around the ship is a normal
        // thing to do, and it should not require being in a fight to reach it.
        `<div style="padding:0 0 10px">${spaceDecksToggle(false)}</div>` +
        `<div class="con-empty">${kctx.isGM ? "No station selected — pick a manned station to drive it, or switch to DECKS to walk the ship." : "You're not manning a station yet. Join combat and pick a station to see its controls here — or switch to DECKS to walk the ship."}</div>`;
      rightEl.querySelector(".con-x").onclick = () => kctx.close();
      rightEl.querySelectorAll("[data-view]").forEach((b) => { b.onclick = () => kctx.setView(b.dataset.view); });
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
      const pw = S.actionPower(a);
      const pwBadge = pw ? ` <span class="con-pw" title="Draws ${pw} power">⚡${pw}</span>` : "";
      return `<div class="con-act">` +
        `<div class="con-btnrow">` +
          `<button class="con-btn${disabled ? " used" : ""}${armedThis ? " armed" : ""}" data-act="${a.id}" ${disabled ? "disabled" : ""} title="${esc(a.text)}">${esc(a.name)}${pwBadge}${armedThis ? " · pick a side" : star}</button>` +
          `<span class="con-i" data-info="${a.id}" title="What does this do?" role="button">i</span>` +
        `</div>` +
        `<div class="con-desc" data-desc="${a.id}" hidden>${esc(a.text)}</div>` +
      `</div>`;
    };
    rightEl.innerHTML =
      `<div class="con-head"><span class="con-title">${esc(stName)}</span>${picker}${kctx.isGM ? `<button class="con-inv" data-gm="1" title="GM actions">⚙ GM</button>` : ""}<button class="con-inv" data-inv="1" title="Ship inventory">📦 Inventory</button><button class="con-x" title="Close (Esc)">✕</button></div>` +
      // The same switch the DECKS panel carries, so the crew can flip to the deck
      // they are standing on from wherever they are.
      `<div style="padding:0 0 10px">${spaceDecksToggle(false)}</div>` +
      `<div class="con-crew"><span class="con-cname">${esc(crew.name)}</span>` +
      `<span class="con-toks">${token("action", crew.action, false)}${token("bonus", crew.bonus, false)}${grantedTokens(crew.granted)}</span></div>` +
      `<div class="con-sec"><div class="con-h">MAIN ACTION${crew.action ? " · used" : ""}</div><div class="con-btns">${acts.main.map((a) => btn(a, false)).join("") || `<span class="con-empty">— none —</span>`}</div></div>` +
      `<div class="con-sec"><div class="con-h">BONUS ACTION${crew.bonus ? " · used" : ""}</div><div class="con-btns">${acts.bonus.map((a) => btn(a, true)).join("") || `<span class="con-empty">— none —</span>`}</div></div>` +
      (kctx.armed ? `<div class="con-hint">Click a ${kctx.armed === "main" ? "red" : "green"} circle on the ship to allocate — or click the button again to cancel.</div>` : "");

    rightEl.querySelector(".con-x").onclick = () => kctx.close();
    const invBtn = rightEl.querySelector("[data-inv]"); if (invBtn) invBtn.onclick = () => kctx.toggleInv();
    const gmBtn = rightEl.querySelector("[data-gm]"); if (gmBtn) gmBtn.onclick = () => kctx.toggleGM();
    const sel = rightEl.querySelector(".con-sel"); if (sel) sel.onchange = () => kctx.selectStation(sel.value);
    rightEl.querySelectorAll("[data-view]").forEach((b) => { b.onclick = () => kctx.setView(b.dataset.view); });
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

  /* ---------------------------------------------------------------------- */
  /*  Exposed for the Foundry wiring half (scripts/ship-combat.js) and the   */
  /*  standalone preview. This file must stay PURE — see the release-gate grep */
  /*  in MAINTAINING.md; nothing here may reach into the Foundry runtime.       */
  /* ---------------------------------------------------------------------- */

  S.esc = esc;
  S.clamp = clamp;
  S.stripHtml = stripHtml;
  S.token = token;
  S.grantedTokens = grantedTokens;
  S.stationName = stationName;
  S.hideInvPop = hideInvPop;
  S.DEFAULT_ITEM_IMG = DEFAULT_ITEM_IMG;
  S.ITEM_COLLATOR = ITEM_COLLATOR;
  // (openItemBrowser/closeItemBrowser, openRepairPuzzle/closeRepairPuzzle and
  //  openNavGame/closeNavGame are already attached to S above.)


  /* ---------------------------------------------------------------------- */
  /*  Fleet Command (key F) — environment-agnostic renderer                   */
  /*                                                                          */
  /*  fctx = {                                                                */
  /*    isGM, userId,                                                         */
  /*    ships: [shipView],          // ALREADY through S.shipView — this       */
  /*                                //  renderer never sees a raw record, so   */
  /*                                //  it cannot leak one                     */
  /*    round, activeShip, initiative:[{shipId,roll}],                        */
  /*    selectedId, select(id),                                               */
  /*    crest(factionId) -> svg string | "",                                  */
  /*    artUrl(path) -> url,                                                  */
  /*    spawn(), rollInitiative(), endShipTurn(), reveal(id), removeShip(id), */
  /*    runShip(id), driveCrew(shipId, crewId), close()                       */
  /*  }                                                                       */
  /* ---------------------------------------------------------------------- */

  const OUTCOME_LABEL = { derelict: "DERELICT", destroyed: "DESTROYED", disabled: "DISABLED",
                          surrendered: "SURRENDERED", fled: "FLED" };

  // The crest is an <img>, not inline <svg>: Foundry's dialog content pipeline
  // does not reliably keep inline SVG, and an image is cacheable besides.
  function crestEl(fctx, factionId) {
    const url = fctx.crest ? fctx.crest(factionId || "unaligned") : "";
    const f = S.faction(factionId);
    const title = f ? f.name : "Unaligned — no faction, no standing consequence";
    if (!url) return `<span class="fl-crest none" title="${esc(title)}"></span>`;
    return `<img class="fl-crest" src="${esc(url)}" alt="" title="${esc(title)}" onerror="this.className='fl-crest none';this.removeAttribute('src')">`;
  }

  function hullBar(v) {
    if (!v.known?.hull || !v.hull) {
      return `<div class="fl-hp" title="Not scanned"><i style="width:100%;background:repeating-linear-gradient(135deg,#1a3a48 0 5px,#0d2531 5px 10px)"></i></div>` +
             `<div class="fl-hptxt"><span>HULL</span><span class="fl-redact" title="Scan to reveal"></span></div>`;
    }
    const pct = v.hull.max ? clamp(v.hull.cur / v.hull.max, 0, 1) * 100 : 0;
    const col = pct > 50 ? "#38e1c4" : pct > 25 ? "#f2b03d" : "#e0454d";
    const ghost = v._ghost > 0 && v.hull.max
      ? `<u style="left:${pct}%;width:${clamp(v._ghost / v.hull.max, 0, 1) * 100}%"></u>` : "";
    return `<div class="fl-hp"><i style="width:${pct}%;background:${col};box-shadow:0 0 10px ${col}"></i>${ghost}</div>` +
           `<div class="fl-hptxt"><span>HULL</span><span><b>${v.hull.cur}</b> / ${v.hull.max}</span></div>`;
  }

  function arcRow(v) {
    // Redaction keeps the SHAPE of the missing data: four hatched cells, so the
    // reader sees that there ARE four facings and that none of them is known —
    // and so the card does not change height the moment it is scanned.
    if (!v.known?.ac) {
      return `<div class="fl-arcs">${["Fore", "Starboard", "Aft", "Port"].map((f) =>
        `<div class="fl-arc unk" title="${f} — not scanned"><b>?</b>—</div>`).join("")}</div>`;
    }
    const ac = S.shipAC(v, S.crewList(v.crew || {}));
    const cell = (f, lbl) => {
      const d = v.known.shields ? ac.dr[f] : { half: false, flat: 0 };
      const cls = !v.known.shields ? "" : d.half ? " sh" : d.flat ? " mi" : "";
      const tag = !v.known.shields ? "?" : d.half ? "½" : d.flat ? `−${d.flat}` : "—";
      return `<div class="fl-arc${cls}" title="${lbl} — AC ${ac[f]}${v.known.shields ? "" : " · shields unscanned"}"><b>${ac[f]}</b>${tag}</div>`;
    };
    return `<div class="fl-arcs">${cell("fore", "Fore")}${cell("starboard", "Starboard")}${cell("aft", "Aft")}${cell("port", "Port")}</div>`;
  }

  function pipRow(v) {
    if (!v.known?.systems || !v.systems) {
      return `<div class="fl-pips" title="Systems not scanned">${'<span class="fl-pip unk"></span>'.repeat(6)}</div>`;
    }
    const pips = Object.entries(v.systems).map(([id, st]) => {
      const cls = st === "working" ? "" : st === "damaged" ? " dmg" : " dead";
      return `<span class="fl-pip${cls}" title="${esc(id)}: ${esc(st)}"></span>`;
    }).join("");
    return `<div class="fl-pips">${pips}</div>`;
  }

  function statusChips(v) {
    const list = (v.statuses || []).slice(0, 6);
    if (!list.length) return "";
    return `<div class="fl-chips">${list.map((s) => {
      const def = S.STATUSES[s.id]; if (!def) return "";
      const pulse = (s.id === "on_fire" || s.id === "cloaked" || s.id === "boarded") ? " pulse" : "";
      return `<span class="fl-st ${def.kind}${pulse}" title="${esc(def.blurb)}">${esc(def.label)}</span>`;
    }).join("")}</div>`;
  }

  function shipCard(fctx, v) {
    const f = S.faction(v.faction);
    const cls = S.shipClass(v.cls);
    const sel = v.id === fctx.selectedId ? " sel" : "";
    const act = v.id === fctx.activeShip && !v.outcome ? " active" : "";
    const out = v.outcome ? " out" : "";
    const art = v.art ? `<img src="${fctx.artUrl ? fctx.artUrl(v.art) : v.art}" alt="" onerror="this.style.display='none'">`
                      : `<span class="fl-unknown">?</span>`;
    const total = v.crew ? Object.keys(v.crew).length : 0;
    const crewTxt = !v.known?.crew || !v.crew
      ? `<span class="fl-crew">CREW <span class="fl-redact"></span></span>`
      : total
        ? `<span class="fl-crew">CREW <b>${Object.values(v.crew).filter((c) => !c.dead).length}</b>/${total}</span>`
        : `<span class="fl-crew">${v.own ? "NO STATIONS MANNED" : "CREWLESS"}</span>`;
    const outcome = v.outcome ? `<span class="fl-outcome ${v.outcome}">${OUTCOME_LABEL[v.outcome] || v.outcome}</span>` : "";
    return `<div class="fl-card d-${esc(v.disposition || "hostile")}${sel}${act}${out}" data-ship="${esc(v.id)}">
      <span class="fl-rail"></span>
      <div class="fl-art">${art}</div>
      <div>
        <div class="fl-name">${v.own ? `<span class="fl-crest own" title="Your ship">⬢</span>` : crestEl(fctx, v.faction)}<span>${esc(v.name)}</span></div>
        <div class="fl-sub${v.unresolved ? " unres" : ""}">${v.unresolved ? "[UNRESOLVED]" : esc(cls ? cls.name : v.cls)}${v.own ? " · YOUR SHIP" : f ? ` · ${esc(f.short)}` : " · Unaligned"}</div>
        ${hullBar(v)}
        ${arcRow(v)}
        ${pipRow(v)}
        ${statusChips(v)}
        <div class="fl-foot">${crewTxt}${outcome}</div>
      </div>
    </div>`;
  }

  function crewPanel(fctx, v) {
    if (!v) return `<div class="fl-empty">Pick a contact on the board to drive it.</div>`;
    const f = S.faction(v.faction);
    const doc = S.doctrine(v.doctrine);
    const head = `<div class="fl-sh">${crestEl(fctx, v.faction)}<span>${esc(v.name)}</span></div>`;
    // The GM should be able to play an enemy from three lines of text.
    const hint = fctx.isGM
      ? `<div class="fl-hint"><b>${esc(doc.name.toUpperCase())}</b> — ${esc(doc.hint)}` +
        (f ? `<br><b>WANTS</b> ${esc(f.wants)}<br><b>SIGNATURE</b> ${esc(f.signature)}` : "") + `</div>`
      : "";
    if (!v.known?.crew || !v.crew) {
      return head + hint + `<div class="fl-empty">Crew unknown — the Science officer has not scanned this hull deeply enough.</div>`;
    }
    const rows = Object.values(v.crew);
    if (!rows.length) {
      return head + hint + `<div class="fl-empty">${v.own
        ? "No stations manned yet — start ship combat and pick your seats."
        : "No crew aboard. Nothing to board, nothing to break."}</div>`;
    }
    const body = rows.map((c) => {
      const st = c.station ? (S.station(c.station)?.name || c.station) : "unassigned";
      const open = fctx.isGM && !v.own && c.id === fctx.crewId && !c.dead;
      const spent = c.action ? ` <span class="fl-spent" title="Has already acted this round">●</span>` : "";
      // The action strip only exists for the GM driving an enemy seat. A player
      // never receives this markup at all — it is a data branch, not a CSS one.
      const strip = open
        ? `<div class="fl-acts">${S.enemySeatActions(v, c).map((a) =>
            `<button class="fl-actbtn" data-crewact="${esc(a.id)}" data-crewfor="${esc(c.id)}"
               title="${esc(a.hint || "")}"${a.disabled ? " disabled" : ""}>${esc(a.label)}</button>`).join("")}</div>`
        : "";
      return `<div class="fl-crewwrap">
        <div class="fl-crewrow${c.dead ? " dead" : ""}${open ? " open" : ""}" data-crew="${esc(c.id)}" title="${c.dead ? "Killed — this station is offline" : "Drive this seat"}">
          <div><div class="fl-cname">${esc(c.name)}${spent}</div><div class="fl-crole">${esc(c.roleId || "crew")}</div></div>
          <div class="fl-cst">${esc(st)}</div></div>${strip}</div>`;
    }).join("");
    return head + hint + body;
  }

  S.renderFleet = function (root, fctx) {
    S.ensureStyles();
    const ships = (fctx.ships || []).filter(Boolean);
    const sel = ships.find((s) => s.id === fctx.selectedId) || ships.find((s) => s.id === fctx.activeShip) || ships[0] || null;
    const live = ships.filter((s) => !s.outcome);
    const activeName = ships.find((s) => s.id === fctx.activeShip)?.name || "—";

    const initOrder = (fctx.initiative || []).map((e) => ({ e, s: ships.find((x) => x.id === e.shipId) })).filter((x) => x.s);
    const activeIdx = initOrder.findIndex((x) => x.e.shipId === fctx.activeShip);
    const initStrip = initOrder.length
      ? initOrder.map((x, i) => {
          const f = S.faction(x.s.faction);
          const cls = x.e.shipId === fctx.activeShip ? " now" : (activeIdx >= 0 && i < activeIdx ? " done" : "");
          return `<div class="fl-chip${cls}" data-init="${esc(x.e.shipId)}" title="Initiative ${x.e.roll}">
            <span class="fl-dot" style="background:${f ? f.color : "#6f97a6"}"></span>${esc(x.s.name)}
            <span class="fl-roll">${x.e.roll}</span></div>`;
        }).join("")
      : `<div class="fl-chip" style="cursor:default">No initiative rolled yet</div>`;

    root.className = "sgfleet";
    root.innerHTML = `
      <div class="fl-head">
        <span class="fl-brand">FLEET COMMAND</span>
        <span class="fl-sep">//</span>
        <span class="fl-meta">ROUND <b>${fctx.round || 1}</b></span>
        <span class="fl-sep">//</span>
        <span class="fl-meta">ACTIVE <b>${esc(activeName)}</b></span>
        <span class="fl-sep">//</span>
        <span class="fl-meta"><b>${live.length}</b> CONTACT${live.length === 1 ? "" : "S"}</span>
        <span class="fl-spacer"></span>
        ${fctx.isGM ? `<button class="fl-btn" data-act="spawn">＋ Spawn ship</button>
        <button class="fl-btn" data-act="init">⚔ Roll initiative</button>
        <button class="fl-btn" data-act="end" ${live.length ? "" : "disabled"}>⏭ End ship turn</button>
        <button class="fl-btn" data-act="run" ${sel && sel.id !== "gull" && !sel.outcome ? "" : "disabled"}>▶ Run ${esc(sel && sel.id !== "gull" ? sel.name : "ship")}</button>` : ""}
        <button class="fl-x" data-act="close" title="Close (Esc)">✕</button>
      </div>
      <div class="fl-init"><span class="fl-init-lbl">INITIATIVE</span>${initStrip}</div>
      <div class="fl-body">
        <div class="fl-board">${ships.length
          ? `<div class="fl-grid">${ships.map((v) => shipCard(fctx, v)).join("")}</div>`
          : `<div class="fl-empty">No ships in this engagement.${fctx.isGM ? " Use ＋ Spawn ship." : ""}</div>`}</div>
        <div class="fl-side">${crewPanel(fctx, sel)}</div>
      </div>`;

    const on = (sel_, fn) => { const e = root.querySelector(sel_); if (e) e.onclick = fn; };
    on('[data-act="close"]', () => fctx.close && fctx.close());
    on('[data-act="spawn"]', () => fctx.spawn && fctx.spawn());
    on('[data-act="init"]', () => fctx.rollInitiative && fctx.rollInitiative());
    on('[data-act="end"]', () => fctx.endShipTurn && fctx.endShipTurn());
    on('[data-act="run"]', () => sel && fctx.runShip && fctx.runShip(sel.id));
    root.querySelectorAll("[data-ship]").forEach((el) => { el.onclick = () => fctx.select && fctx.select(el.dataset.ship); });
    root.querySelectorAll("[data-init]").forEach((el) => { el.onclick = () => fctx.select && fctx.select(el.dataset.init); });
    root.querySelectorAll("[data-crew]").forEach((el) => {
      el.onclick = () => sel && fctx.driveCrew && fctx.driveCrew(sel.id, el.dataset.crew);
    });
    root.querySelectorAll("[data-crewact]").forEach((el) => {
      el.onclick = (ev) => {
        ev.stopPropagation();   // do not also collapse the row we are acting from
        if (sel && fctx.crewAct) fctx.crewAct(sel.id, el.dataset.crewfor, el.dataset.crewact);
      };
    });
  };


  /* ---------------------------------------------------------------------- */
  /*  The scan readout                                                       */
  /*                                                                          */
  /*  Styled after ASTRA's own nav scan, because that is what the crew have   */
  /*  seen her produce all campaign: a "//" header rule with a confidence     */
  /*  rating, a sweeping ring, and tiers that land one after another. Locked  */
  /*  tiers stay on screen as redaction that keeps the SHAPE of what is       */
  /*  missing — that is what makes a second scan feel worth an action.        */
  /* ---------------------------------------------------------------------- */

  S.FLEET_CSS += `
.sgfleet .fl-crewwrap{display:block}
.sgfleet .fl-crewrow.open{background:rgba(56,225,196,.10);border-color:#38e1c4}
.sgfleet .fl-spent{color:#f2b03d;font-size:10px;vertical-align:middle}
.sgfleet .fl-acts{display:flex;flex-wrap:wrap;gap:4px;padding:6px 8px 8px 8px;margin:-2px 0 6px 0;
  background:rgba(8,20,28,.6);border-left:2px solid #38e1c4;border-radius:0 0 4px 4px}
.sgfleet .fl-actbtn{font:600 11px/1.1 'Courier New',monospace;letter-spacing:.04em;color:#cfeef0;
  background:rgba(20,44,56,.9);border:1px solid #2b5d6e;border-radius:3px;padding:5px 8px;cursor:pointer;
  text-transform:uppercase;white-space:nowrap}
.sgfleet .fl-actbtn:hover:not(:disabled){background:#38e1c4;color:#04222c;border-color:#38e1c4}
.sgfleet .fl-actbtn:disabled{opacity:.4;cursor:default}
`;

  S.SCAN_CSS = `
.sgscan{position:fixed;inset:0;z-index:96;display:flex;align-items:center;justify-content:center;
  background:rgba(2,6,12,.82);font-family:'Courier New',monospace;color:#cfeef0;}
.sgscan .sn{position:relative;width:min(760px,94vw);max-height:92vh;overflow:auto;padding:0 0 18px;
  background:linear-gradient(180deg,rgba(10,28,40,.97),rgba(4,12,20,.97));
  border:1px solid #1d6a86;border-radius:12px;box-shadow:0 0 60px rgba(29,106,134,.45);}
/* corner brackets, the nav-scan frame language */
.sgscan .sn::before,.sgscan .sn::after{content:"";position:absolute;width:22px;height:22px;pointer-events:none;}
.sgscan .sn::before{top:8px;left:8px;border-top:2px solid #38e1c4;border-left:2px solid #38e1c4;}
.sgscan .sn::after{bottom:8px;right:8px;border-bottom:2px solid #38e1c4;border-right:2px solid #38e1c4;}
.sgscan .sn-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:13px 18px;
  border-bottom:1px solid #12455a;font-size:12px;letter-spacing:1.5px;color:#6f97a6;}
.sgscan .sn-brand{font-weight:700;letter-spacing:2.5px;color:#38e1c4;text-shadow:0 0 12px rgba(56,225,196,.45);}
.sgscan .sn-sep{color:#2a5f70;}
.sgscan .sn-head b{color:#cfeef0;}
.sgscan .sn-conf b{color:#f2b03d;}
.sgscan .sn-x{margin-left:auto;font-size:15px;color:#6f97a6;background:none;border:none;cursor:pointer;font-family:inherit;}
.sgscan .sn-x:hover{color:#f2b03d;}

/* the sweep: rings + a rotating wedge, one 1.4s pass before the tiers land */
.sgscan .sn-sweep{position:relative;height:150px;margin:14px auto 4px;width:150px;}
.sgscan .sn-ring{position:absolute;inset:0;border-radius:50%;border:1px dashed #1d6a86;}
.sgscan .sn-ring.r2{inset:22px;border-color:#17566e;}
.sgscan .sn-ring.r3{inset:44px;border-color:#124a5e;}
.sgscan .sn-wedge{position:absolute;inset:0;border-radius:50%;
  background:conic-gradient(from 0deg,rgba(56,225,196,.42),transparent 26%);
  animation:sn-spin 1.4s linear infinite;}
@keyframes sn-spin{to{transform:rotate(360deg);}}
.sgscan .sn-blip{position:absolute;top:50%;left:50%;width:9px;height:9px;margin:-4.5px;border-radius:50%;
  background:#f2b03d;box-shadow:0 0 12px rgba(242,176,61,.9);}
.sgscan .sn-target{text-align:center;font-size:15px;font-weight:700;color:#dff3f6;letter-spacing:1px;margin-bottom:2px;}
.sgscan .sn-sub{text-align:center;font-size:11px;color:#6f97a6;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:12px;}

.sgscan .sn-tier{margin:0 18px 9px;border:1px solid #14455a;border-radius:9px;overflow:hidden;
  background:rgba(8,21,33,.7);opacity:0;transform:translateY(6px);animation:sn-land .34s ease forwards;}
@keyframes sn-land{to{opacity:1;transform:none;}}
.sgscan .sn-tier.locked{border-style:dashed;border-color:#2a4a5a;}
.sgscan .sn-th{display:flex;align-items:center;gap:9px;padding:7px 11px;font-size:11px;letter-spacing:2px;
  border-bottom:1px solid #123b4c;color:#38e1c4;}
.sgscan .sn-tier.locked .sn-th{color:#5f8496;border-bottom-color:#1a3646;}
.sgscan .sn-th .sn-lock{margin-left:auto;font-size:10px;letter-spacing:1px;color:#5f8496;}
.sgscan .sn-body{padding:9px 11px;font-size:12px;line-height:1.6;}
.sgscan .sn-row{display:flex;justify-content:space-between;gap:12px;padding:2px 0;}
.sgscan .sn-row span:first-child{color:#6f97a6;letter-spacing:1px;}
.sgscan .sn-row b{color:#dff3f6;}
/* redaction that keeps the shape of what you do not know */
.sgscan .sn-red{display:inline-block;min-width:52px;height:12px;border-radius:3px;vertical-align:-2px;
  background:repeating-linear-gradient(135deg,#1a3a48 0 4px,#0d2531 4px 8px);border:1px solid #24596e;}
.sgscan .sn-hint{font-size:11px;color:#8fb2c0;font-style:italic;}
.sgscan .sn-pips{display:flex;flex-wrap:wrap;gap:4px;margin-top:3px;}
.sgscan .sn-pip{font-size:10px;letter-spacing:.5px;padding:1px 7px;border-radius:9px;border:1px solid currentColor;}
.sgscan .sn-pip.ok{color:#38e1c4;} .sgscan .sn-pip.dmg{color:#f2b03d;} .sgscan .sn-pip.dead{color:#e0454d;}
.sgscan .sn-foot{padding:4px 18px 0;font-size:11px;color:#6f97a6;text-align:center;}
.sgscan .sn-foot b{color:#f2b03d;}
`;

  function closeScan() { const o = document.getElementById("ssv-scan"); if (o) o.remove(); }
  S.closeScan = closeScan;

  /**
   * Show a scan result. `view` is the ship AFTER the reveal has been applied and
   * put back through S.shipView, so this renderer only ever sees what the viewer
   * is allowed to see — the reveal boundary holds even here.
   */
  S.openScan = function (view, result, opts = {}) {
    if (typeof document === "undefined") return;
    S.ensureStyles();
    closeScan();
    const root = document.createElement("div");
    root.id = "ssv-scan";
    root.className = "sgscan";

    const f = S.faction(view.faction);
    const cls = S.shipClass(view.cls);
    const red = `<span class="sn-red"></span>`;
    const got = (k) => result.tiers.includes(k);

    const tier = (key, label, bodyHtml, delayIdx) => {
      const on = got(key);
      return `<div class="sn-tier${on ? "" : " locked"}" style="animation-delay:${180 + delayIdx * 220}ms">
        <div class="sn-th"><span>${label}</span>${on ? "" : `<span class="sn-lock">◌ NOT RESOLVED</span>`}</div>
        <div class="sn-body">${on ? bodyHtml : `<span class="sn-hint">${esc(S.SCAN_TIERS.find((t) => t.key === key)?.gives || "")}</span>`}</div>
      </div>`;
    };

    const row = (k, v) => `<div class="sn-row"><span>${k}</span><b>${v}</b></div>`;
    const vitals = view.hull
      ? row("HULL", `${view.hull.cur} / ${view.hull.max}`) +
        row("ARMOUR", view.armour ? `−${view.armour} per hit` : "none") +
        row("SHIELDS", view.shield?.on ? `${S.FACING_LABEL[view.shield.facing]} — halves damage` : "down") +
        row("RESISTANCES", Object.keys(view.resist || {}).length
          ? Object.entries(view.resist).map(([t, r]) => `${t} ${r}`).join(", ") : "none detected")
      : row("HULL", red) + row("ARMOUR", red) + row("SHIELDS", red);
    const systems = view.systems
      ? `<div class="sn-pips">${Object.entries(view.systems).map(([id, st]) =>
          `<span class="sn-pip ${st === "working" ? "ok" : st === "damaged" ? "dmg" : "dead"}">${esc(S.SYSTEMS.find((x) => x.id === id)?.label || id)}</span>`).join("")}</div>`
      : row("SYSTEMS", red);
    const crew = view.crew
      ? row("COMPLEMENT", `${Object.values(view.crew).filter((c) => !c.dead).length} aboard`) +
        `<div class="sn-pips">${Object.values(view.crew).map((c) =>
          `<span class="sn-pip ${c.dead ? "dead" : "ok"}">${esc(c.roleId || "crew")}</span>`).join("")}</div>`
      : row("COMPLEMENT", red);

    root.innerHTML = `<div class="sn">
      <div class="sn-head">
        <span class="sn-brand">ASTRA SENSOR SWEEP</span><span class="sn-sep">//</span>
        <span class="sn-conf">CONFIDENCE <b>${result.confidence}%</b></span><span class="sn-sep">//</span>
        <span>${esc(result.label)}</span>
        <button class="sn-x" data-x title="Close (Esc)">✕</button>
      </div>
      <div class="sn-sweep"><div class="sn-ring"></div><div class="sn-ring r2"></div><div class="sn-ring r3"></div>
        <div class="sn-wedge"></div><div class="sn-blip"></div></div>
      <div class="sn-target">${esc(view.name)}</div>
      <div class="sn-sub">${view.unresolved ? "[UNRESOLVED]" : esc(cls ? cls.name : view.cls || "unknown class")} · ${esc(f ? f.short : "Unaligned")}</div>
      ${tier("silhouette", "SILHOUETTE", row("CLASS", view.unresolved ? "[UNRESOLVED]" : esc(cls ? cls.name : "unknown")) +
        row("ALLEGIANCE", esc(f ? f.name : "none detected")) +
        row("HOT ARC", opts.facing ? esc(S.FACING_LABEL[opts.facing]) : red), 0)}
      ${tier("vitals", "VITALS", vitals, 1)}
      ${tier("systems", "SYSTEMS", systems, 2)}
      ${tier("manifest", "MANIFEST", crew, 3)}
      <div class="sn-foot">${result.painted
        ? `Signal too weak to resolve — but she is <b>PAINTED</b> now. The next scan of her has advantage.`
        : result.gunnerAdvantage === 2 ? `Firing solution shared — <b>both gunners</b> have advantage against this hull.`
        : result.gunnerAdvantage === 1 ? `Firing solution shared — <b>one gunner</b> has advantage against this hull.`
        : `Run it again to resolve the rest.`}</div>
    </div>`;
    document.body.appendChild(root);
    root.querySelector("[data-x]").onclick = () => { closeScan(); opts.onClose && opts.onClose(); };
    root.onmousedown = (e) => { if (e.target === root) { closeScan(); opts.onClose && opts.onClose(); } };
    return root;
  };

  // Expose for the preview harness, the Foundry wiring, and external callers.
  (typeof globalThis !== "undefined" ? globalThis : window).SSVShipHUD = S;
  if (typeof module !== "undefined" && module.exports) module.exports = S;

  /* ---------------------------------------------------------------------- */
  /*  Self-test — `node scripts/ship-combat-render.js --selftest`            */
  /* ---------------------------------------------------------------------- */

  S.selftest = function selftest() {
    const fails = [];
    const ok = (cond, msg) => { if (!cond) fails.push(msg); };

    // --- normalize round-trips and forward-migrates -----------------------
    const d = S.defaultState();
    ok(d.hull.max === 150, "default hull should be 150");
    ok(S.normalize(null).hull.cur === 150, "normalize(null) returns defaults");
    const legacy = { hull: { cur: 90, max: 150 }, systems: { shields: "damaged", cloak: "destroyed" } };
    const mig = S.normalize(legacy);
    ok(mig.systemHp.shields.cur === 3, "legacy 'damaged' migrates to 3 HP");
    ok(mig.systemHp.cloak.cur === 0, "legacy 'destroyed' migrates to 0 HP");
    ok(mig.systems.shields === "damaged", "systems[] is derived from systemHp");
    ok(mig.hull.cur === 90, "stored hull survives normalize");
    // The Gull has to be able to hold a status like anything else — without this
    // the player ship could not catch fire, be boarded, or lose its shields.
    const burning = S.normalize({ statuses: [{ id: "on_fire", src: "test", expiresRound: null, data: {} }] });
    ok(S.hasStatus(burning, "on_fire"), "the Gull's own state carries statuses through normalize");
    ok(S.normalize({ statuses: [{ id: "not-real" }] }).statuses.length === 0, "…and drops unknown ones");
    const downed = S.normalize({ shield: { on: true, facing: "fore" }, statuses: [{ id: "shields_down" }] });
    ok(S.shieldDR(downed, "fore").half === false, "shields_down suppresses the Gull's own shield reduction");

    // --- system state thresholds -----------------------------------------
    ok(S.systemState({ cur: 5, max: 5 }) === "working", "5/5 is working");
    ok(S.systemState({ cur: 4, max: 5 }) === "damaged", "4/5 is damaged");
    ok(S.systemState({ cur: 0, max: 5 }) === "destroyed", "0/5 is destroyed");

    // --- directional AC: shields are DR now, never AC ---------------------
    const st = S.normalize({ ac: { base: 13 }, shield: { on: true, facing: "fore", secondary: "aft" } });
    const crewEvasive = [{ station: "pilot", maneuver: "evasive" }];
    const a1 = S.shipAC(st, { crew: crewEvasive });
    ok(a1.fore === 13 + 4, `evasive AC should be 17 on every facing, got ${a1.fore}`);
    ok(a1.fore === a1.aft && a1.aft === a1.port && a1.port === a1.starboard, "all four facings share one AC");
    ok(a1.dr.fore.half === true, "the allocated facing halves damage");
    ok(a1.dr.aft.flat === S.MICRO_DR, "the micro-adjust facing takes a flat reduction");
    ok(a1.dr.port.half === false && a1.dr.port.flat === 0, "unshielded facings get nothing");
    ok(S.shipAC(st, crewEvasive).fore === a1.fore, "shipAC accepts a bare crew array as well as a combat object");
    ok(S.shipAC(st, []).fore === 13, "an empty crew means no maneuver modifier");
    const broken = S.normalize({ ac: { base: 13 }, systemHp: { shields: { cur: 0, max: 5 } }, shield: { on: true, facing: "fore" } });
    ok(S.shieldDR(broken, "fore").half === false, "a destroyed shield generator grants no reduction");

    // --- statuses ----------------------------------------------------------
    const sh = S.normalize({ ac: { base: 13 } });
    sh.statuses = [];
    S.applyStatus(sh, "aggressive", { round: 1 });
    ok(S.shipAC(sh, []).fore === 13 - 4, "aggressive is -4 AC");
    // The maneuver's AC and its status must never both apply.
    const dbl = S.normalize({ ac: { base: 13 } });
    dbl.statuses = [];
    S.applyStatus(dbl, "evasive", { round: 1 });
    ok(S.shipAC(dbl, [{ station: "pilot", maneuver: "evasive" }]).fore === 13 + 4 + 4,
       "a maneuver AND its status stack — which is exactly why picking a maneuver must not apply one");
    S.applyStatus(sh, "shields_down", { round: 1, rounds: 2 });
    ok(S.statusMods(sh).noShield === true, "shields_down suppresses shield DR");
    S.applyStatus(sh, "shields_down", { round: 1, rounds: 2 });
    ok(sh.statuses.filter((x) => x.id === "shields_down").length === 1, "re-applying a status refreshes rather than stacks");
    ok(S.expireStatuses(sh, 2).includes("aggressive"), "a round-scoped status expires on the next round");
    ok(S.hasStatus(sh, "shields_down"), "a 2-round status survives one round");
    ok(S.expireStatuses(sh, 3).includes("shields_down"), "…and expires on the third");
    ok(S.applyStatus(sh, "not-a-status", {}) === null, "unknown statuses are refused");

    // --- facing derived from token positions -------------------------------
    const tgt = { x: 100, y: 100, rotation: 0 };            // nose up
    ok(S.facingFrom(tgt, { x: 100, y: 0 }) === "fore", "an attacker above a nose-up ship hits the bow");
    ok(S.facingFrom(tgt, { x: 100, y: 200 }) === "aft", "…below hits the stern");
    ok(S.facingFrom(tgt, { x: 200, y: 100 }) === "starboard", "…to the right hits starboard");
    ok(S.facingFrom(tgt, { x: 0, y: 100 }) === "port", "…to the left hits port");
    const spun = { x: 100, y: 100, rotation: 180 };         // nose down
    ok(S.facingFrom(spun, { x: 100, y: 0 }) === "aft", "turning the ship 180 turns the bow away");
    ok(Math.abs(S.bearing(tgt, { x: 100, y: 0 })) < 1e-9, "dead ahead is bearing 0");

    // --- the damage pipeline ----------------------------------------------
    const victim = S.normalize({ shield: { on: true, facing: "fore", secondary: "aft" } });
    ok(S.resolveDamage(victim, 20, "port").final === 20, "an unshielded facing takes it all");
    ok(S.resolveDamage(victim, 20, "fore").final === 10, "the shielded facing halves");
    ok(S.resolveDamage(victim, 20, "aft").final === 20 - S.MICRO_DR, "micro-adjust is flat");
    ok(S.resolveDamage(victim, 20, "fore", { ignoreShields: true }).final === 20, "Ram ignores the shield facing");
    victim.armour = 4;
    ok(S.resolveDamage(victim, 20, "fore").final === 10 - 4, "armour comes off after shields");
    ok(S.resolveDamage(victim, 6, "fore").final === 0, "armour can absorb a small hit entirely");
    victim.armour = 0;
    victim.resist = { energy: "half" };
    ok(S.resolveDamage(victim, 20, "port", { type: "energy" }).final === 10, "resistance halves");
    ok(S.resolveDamage(victim, 20, "port", { type: "kinetic" }).final === 20, "…only the resisted type");
    victim.statuses = []; S.applyStatus(victim, "frozen", { round: 1 });
    ok(S.resolveDamage(victim, 10, "port", { type: "kinetic" }).final === 20, "frozen doubles the next hit");
    ok(S.resolveDamage(victim, 10, "port").absorbed >= 0, "absorbed is never negative");

    // --- range bands -------------------------------------------------------
    const flak = S.gun("flak"), auto = S.gun("autocannon");
    ok(S.rangeBand(flak, 1) === "close" && S.rangeBand(flak, 3) === "long" && S.rangeBand(flak, 9) === "out",
       "flak bands: close 1-2, long 3-4, out beyond");
    ok(S.rangeBand(auto, 4) === "close" && S.rangeBand(auto, 10) === "long" && S.rangeBand(auto, 11) === "out",
       "autocannon bands: close 1-4, long 5-10, out beyond");
    ok(S.rangePenalty(flak, 3).toHit === S.LONG_TO_HIT && S.rangePenalty(flak, 3).halve === true,
       "long range costs accuracy and bite");
    // …unless the gun is authored otherwise. The Heavy Autocannon's own panel has
    // always said "no penalty" at long range; the maths used to charge it anyway.
    ok(/no penalty/i.test(auto.longNote), "the autocannon is authored as penalty-free at long range");
    ok(S.rangePenalty(auto, 8).toHit === 0 && S.rangePenalty(auto, 8).halve === false,
       "…and rangePenalty honours the gun's own longNote");
    for (const g of S.GUNS) {
      const p = S.rangePenalty(g, g.longMax);
      const free = /no penalty/i.test(String(g.longNote || ""));
      ok(p.ok && p.toHit === (free ? 0 : S.LONG_TO_HIT) && p.halve === !free,
         `${g.id}: the long-range maths must match its own longNote ("${g.longNote}")`);
    }
    ok(S.rangePenalty(auto, 99).ok === false, "out of range cannot be fired");
    for (const g of S.GUNS) for (let d = 0; d <= 12; d++) {
      ok(["close", "long", "out"].includes(S.rangeBand(g, d)), `${g.id} at ${d} produced no band`);
    }

    // --- guns / maneuvers are internally consistent -----------------------
    for (const g of S.GUNS) ok(g.shortMax < g.longMax, `${g.id}: shortMax must be < longMax`);
    for (const [k, m] of Object.entries(S.MANEUVERS)) ok(Number.isFinite(m.mp) && m.mp > 0, `maneuver ${k} needs MP`);

    // --- every station action has an id, name and text --------------------
    for (const stn of S.STATIONS) {
      const acts = S.stationActions(stn.id);
      for (const a of [...acts.main, ...acts.bonus]) {
        ok(!!a.id && !!a.name, `${stn.id}: an action is missing id/name`);
        ok(typeof a.text === "string" && a.text.length > 0, `${stn.id}.${a.id}: missing help text`);
      }
    }
    ok(S.STATIONS.length === 15, "there should be 15 stations");
    ok(S.profRoles().length === 7, "seven proficiency roles");


    // --- hull classes and token silhouettes --------------------------------
    ok(S.classFor([7, 7]).id === "fighter", "a 7x7 hull is a fighter");
    ok(S.classFor([26, 40]).id === "corvette", "the Razorbill (the Gull) is a corvette");
    ok(S.classFor([49, 37]).id === "frigate", "a 49-square hull is a frigate");
    ok(S.classFor([85, 85]).id === "cruiser", "an 85-square hull is a cruiser");
    ok(S.classFor([100, 135]).id === "capital", "the Platanus is a capital");
    // Every real hull footprint read off the packs must land in a sane token size.
    const REAL_HULLS = [[24,38],[37,49],[39,48],[36,45],[39,45],[9,14],[33,48],[25,39],[21,35],[19,30],
      [19,33],[20,48],[29,31],[19,31],[24,51],[32,20],[39,56],[31,54],[36,53],[41,33],[17,28],[30,39],
      [41,41],[27,42],[25,36],[30,35],[58,86],[20,32],[24,34],[50,50],[20,32],[31,45],[24,45],[85,85],
      [100,135],[35,55],[26,40],[17,28],[41,72],[24,36],[39,59],[63,30],[9,6],[23,23],[7,7],[7,6],
      [35,35],[11,19],[29,36],[55,80],[31,43],[27,35],[33,30],[11,11]];
    for (const sz of REAL_HULLS) {
      const t = S.tokenSizeFor(sz);
      ok(t.width >= 1 && t.height >= 1 && t.width <= 6 && t.height <= 6,
         `hull ${sz} produced a token of ${t.width}x${t.height} — outside 1..6`);
      ok(!!S.shipClass(t.cls), `hull ${sz} produced an unknown class ${t.cls}`);
    }
    ok(S.tokenSizeFor([20, 48]).height > S.tokenSizeFor([20, 48]).width, "a long hull gets a long token");
    ok(S.tokenSizeFor([63, 30]).width > S.tokenSizeFor([63, 30]).height, "a wide hull gets a wide token");

    // --- factions -----------------------------------------------------------
    ok(S.factionName("") === "Unaligned", "no faction reads as Unaligned");
    ok(S.faction("apostles-threshold").resolve === null, "the Apostles never break");
    ok(S.faction("rift").resolve === null, "rift vessels never break");
    for (const [id, f] of Object.entries(S.FACTIONS)) {
      ok(!!f.name && !!f.short && !!f.signature && !!f.wants, `faction ${id} is missing copy`);
      ok(Array.isArray(f.abilities) && f.abilities.length >= 6, `faction ${id} needs an ability pool`);
    }
    const pol = Object.values(S.FACTIONS).filter((f) => f.politics).length;
    ok(pol === 3, `exactly three factions should map to the politics module, found ${pol}`);

    // --- ship records round-trip -------------------------------------------
    const enemy = S.normalizeShip({ id: "e1", name: "Test Hull", faction: "iron-directorate", cls: "frigate",
      hull: { cur: 180, max: 200 }, armour: 3, guns: [{ id: "g1", label: "Gun", toHit: 4, damage: "2d8", shortMax: 3, longMax: 7 }],
      crew: { c1: { name: "Gunner", station: "gunner_port" }, c2: { name: "Dead One", station: "pilot", dead: true } } });
    ok(enemy.hull.cur === 180 && enemy.armour === 3, "ship fields survive normalize");
    ok(S.liveCrew(enemy).length === 1, "dead crew are not live crew");
    ok(S.stationManned(enemy, "gunner_port") === true, "a manned station reads as manned");
    ok(S.stationManned(enemy, "pilot") === false, "a dead pilot leaves the station unmanned");
    ok(S.normalizeShip({ faction: "not-real" }).faction === "", "an unknown faction normalises to unaligned");
    ok(S.normalizeShip({ hull: { cur: 999, max: 100 } }).hull.cur === 100, "hull is clamped to max");
    const bound = S.normalizeShip({ id: "b1", actorId: "AAA", tokenId: "BBB", sceneId: "CCC", skin: "Junker", art: "x/y.png" });
    ok(bound.actorId === "AAA", "actorId survives normalize — without it the enemy actor can never be deleted");
    ok(bound.tokenId === "BBB" && bound.sceneId === "CCC", "token and scene bindings survive normalize");
    ok(bound.skin === "Junker" && bound.art === "x/y.png", "the chosen skin and its art survive normalize");
    const withBlock = S.normalizeShip({ crew: { c1: { name: "G", roleId: "gunner", block: "Thug", tier: 2 } } });
    ok(withBlock.crew.c1.block === "Thug" && withBlock.crew.c1.tier === 2,
       "a crew member's stat block and tier survive normalize — they are what boarding instantiates from");


    /* ── The round-trip guard ────────────────────────────────────────────────
     * Every data-loss bug in this module so far had the same shape: the wiring
     * set a field, normalize did not carry it, and the loss was invisible until
     * something downstream quietly did nothing. (actorId — enemy actors could
     * never be deleted. statuses — the Gull alone could not catch fire. skin,
     * art, target, buff — all the same.)
     *
     * So rather than remembering to assert each new field, walk the whole shape:
     * build a record with EVERY field set to a non-default value, normalize it,
     * and require every key to survive. A new field added to defaultShip/
     * defaultState is covered the moment it exists.
     * ──────────────────────────────────────────────────────────────────────── */
    const roundTrip = (label, defaults, normalize, fill) => {
      const src = fill(JSON.parse(JSON.stringify(defaults)));
      const out = normalize(src);
      const walk = (a, b, path) => {
        for (const k of Object.keys(a)) {
          const p = path ? `${path}.${k}` : k;
          if (b === undefined || !(k in b)) { fails.push(`${label}: normalize dropped "${p}"`); continue; }
          if (a[k] && typeof a[k] === "object" && !Array.isArray(a[k])) walk(a[k], b[k], p);
          else if (Array.isArray(a[k])) {
            if (!Array.isArray(b[k])) fails.push(`${label}: "${p}" stopped being an array`);
            else if (a[k].length && !b[k].length) fails.push(`${label}: normalize emptied the array "${p}"`);
          } else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
            fails.push(`${label}: "${p}" changed on normalize (${JSON.stringify(a[k])} -> ${JSON.stringify(b[k])})`);
          }
        }
      };
      walk(src, out, "");
    };

    roundTrip("shipState", S.defaultState(), S.normalize, (d) => {
      d.name = "Test Hull"; d.plating = "Testanium"; d.ship = "damaged";
      d.hull = { cur: 77, max: 140 }; d.ac = { base: 16 };
      d.shield = { on: true, facing: "port", secondary: "aft" };
      d.fuel = { cur: 111, max: 400 }; d.power = { cur: 222, max: 400 };
      d.tuning = { fuelPerItem: 30, powerPerItem: 31, convertFuel: 8, convertPower: 44 };
      d.actorId = "ACTOR123"; d.armour = 5; d.resist = { energy: "half" }; d.outcome = "disabled";
      d.adriftCrew = ["u7"]; d.phaseCharges = 2; d.decoys = 1; d.scanBlock = true;
      d.statuses = [{ id: "on_fire", src: "test", expiresRound: 9, data: {} }];
      for (const k of Object.keys(d.systemHp)) d.systemHp[k] = { cur: 3, max: 5 };
      for (const k of Object.keys(d.systems)) d.systems[k] = "damaged";
      for (const t of S.TURRETS) d.turrets[t.id] = { built: true, hp: { cur: 12, max: S.TURRET_HP_MAX }, mode: "detached" };
      return d;
    });

    roundTrip("enemy ship", S.defaultShip({ id: "z1" }), S.normalizeShip, (d) => {
      d.profileId = "scyphozoa"; d.name = "Test"; d.faction = "sovereign-horizon";
      d.cls = "frigate"; d.doctrine = "ambusher"; d.disposition = "neutral";
      d.hull = { cur: 90, max: 200 }; d.ac = { base: 14 }; d.armour = 3;
      d.resist = { kinetic: "half" };
      d.shield = { on: true, facing: "aft", secondary: "port" };
      d.guns = [{ id: "g", label: "G", toHit: 4, damage: "2d8", shortMax: 2, longMax: 6, arc: "fore" }];
      d.abilities = ["slip"]; d.boardingParty = 4;
      d.morale = { cur: 2, max: 4 };
      d.revealed = { ac: true, shields: true, systems: true, crew: true, deckmap: 2 };
      d.actorId = "A1"; d.tokenId = "T1"; d.sceneId = "S1"; d.combatantId = "C1";
      d.skin = "Junker"; d.art = "some/path.png"; d.sizeSq = [33, 48]; d.outcome = "derelict";
      d.statuses = [{ id: "grappled", src: "x", expiresRound: 4, data: {} }];
      d.systemHp = { shields: { cur: 2, max: 5 } }; d.systems = { shields: "damaged" };
      d.crew = { c1: { id: "c1", name: "N", roleId: "gunner", station: "gunner_port", action: true,
        bonus: true, granted: 2, maneuver: null, mp: 3, mpMax: 4, navMult: 2, gun: "flak",
        target: "e9", actorId: "AA", tokenId: "TT", deck: 2, block: "Thug", tier: 3,
        hp: { cur: 5, max: 11 }, dead: true } };
      return d;
    });

    roundTrip("combatState", S.defaultCombat(), S.normalizeCombat, (d) => {
      d.active = true; d.turn = 6; d.round = 4; d.activeShip = "e1";
      d.spool = 2; d.gunBuff = "1d6";
      d.whereIs = { u1: { shipId: "e1", deck: 2 } };
      d.initiative = [{ shipId: "e1", roll: 17 }];
      d.crew = { k: { id: "k", name: "K", ownerUserId: "u1", controllerUserId: "u2", station: "captain",
        action: true, bonus: true, granted: 1, maneuver: "evasive", mp: 5, mpMax: 6, navMult: 2,
        gun: "flak", target: "e1", prof: { captain: true },
        buff: { flat: 2, adv: true, die: "1d4", turretAim: true } } };
      return d;
    });

    // --- seating an enemy crew ---------------------------------------------
    const ROSTER = [{ role: "captain", n: 1 }, { role: "pilot", n: 1 }, { role: "gunner", n: 3 },
                    { role: "engineer", n: 2 }, { role: "marine", n: 5 }];
    const seats = S.assignSeats(ROSTER, 12);
    ok(seats.length === 12, `twelve aboard means twelve seats resolved (${seats.length})`);
    const manned = seats.map((x) => x.station).filter(Boolean);
    ok(new Set(manned).size === manned.length,
       `one crew member per station — got duplicates: ${manned.join(",")}`);
    ok(manned.includes("gunner_port") && manned.includes("gunner_starboard"), "two gunners take both gun seats");
    ok(seats.filter((x) => x.roleId === "gunner" && !x.station).length === 1, "the third gunner is a spare hand");
    ok(manned.includes("shields_officer"), "a second engineer takes the shields seat");
    ok(seats.every((x) => x.roleId !== "marine" || !x.station), "marines hold no station — they are the boarding party");
    // dropping the headcount must thin the marines, not the bridge
    const small = S.assignSeats(ROSTER, 4);
    ok(small.length === 4, "a reduced crew seats only that many");
    ok(small.map((x) => x.roleId).join(",") === "captain,pilot,gunner,gunner", "…and fills the bridge first");
    ok(S.assignSeats(ROSTER, 0).length === 0, "a crewless hull seats nobody");
    ok(S.assignSeats(null, 5).length === 0, "a missing roster seats nobody rather than throwing");

    // --- turrets ------------------------------------------------------------
    ok(S.TURRETS.length === 6, "six rebuildable turrets");
    for (const t of S.TURRETS) {
      ok(!!S.station(t.station), `${t.id} maps to a real station`);
      ok(t.gun.shortMax < t.gun.longMax, `${t.id}'s gun has a sane range band`);
      ok(!!S.gun(t.gun.id), `S.gun resolves ${t.id}'s gun`);
      const acts = S.stationActions(t.station);
      ok(acts.main.length === 1 && acts.main[0].type === "turret", `${t.station} has one real turret action`);
      ok(acts.bonus.length === 1 && acts.bonus[0].type === "adjust", `${t.station} has Adjust Aim`);
    }
    const fresh = S.normalize({});
    ok(Object.keys(fresh.turrets).length === 6, "a fresh ship tracks all six turrets");
    ok(Object.values(fresh.turrets).every((t) => !t.built && t.hp.cur === 0), "…and none is built yet — they were sheared off in the crash");
    ok(S.turretOnline(fresh, "turret_flak") === false, "an unbuilt turret cannot fire");
    const built = S.normalize({ turrets: { turret_flak: { built: true, hp: { cur: 18, max: 18 } } } });
    ok(S.turretOnline(built, "turret_flak") === true, "a built, undamaged turret can fire");
    ok(S.availableGuns(built).length === 3, "…and joins the gunner's list alongside the two wing guns");
    ok(S.availableGuns(fresh).length === 2, "with none built, only the two wing guns are offered");
    const wrecked = S.normalize({ turrets: { turret_flak: { built: true, hp: { cur: 0, max: 18 } } } });
    ok(S.turretOnline(wrecked, "turret_flak") === false, "a turret at 0 HP cannot fire");
    const weaponsGone = S.normalize({ turrets: { turret_flak: { built: true, hp: { cur: 18, max: 18 } } },
      systemHp: { weapons: { cur: 0, max: 5 } } });
    ok(S.turretOnline(weaponsGone, "turret_flak") === false, "no turret fires while Weapons are down");

    // --- cloaking -----------------------------------------------------------
    const cloakActs = S.stationActions("cloaking");
    ok(cloakActs.main.length === 4 && cloakActs.main.every((a) => a.type === "cloak"), "four real cloak actions");
    ok(cloakActs.bonus.length === 1 && cloakActs.bonus[0].type === "cloak", "…and a real bonus");
    ok(cloakActs.main.map((a) => a.cloak).join(",") === "engage,burst,phase,decoy", "each names its own effect");

    // --- crew buffs and the spool survive normalize ------------------------
    const buffed = S.normalizeCombat({ spool: 2, gunBuff: "1d6",
      crew: { k: { name: "K", station: "captain", buff: { flat: 1, adv: true, die: "1d4" } } } });
    ok(buffed.spool === 2 && buffed.gunBuff === "1d6", "the spool track and the gun rail survive normalize");
    ok(buffed.crew.k.buff.flat === 1 && buffed.crew.k.buff.adv === true && buffed.crew.k.buff.die === "1d4",
       "a crew member's Rally, Command and Reroute buffs survive normalize");
    ok(S.normalizeCombat({ spool: 99 }).spool === 3, "the spool cannot exceed three folds");
    ok(!!S.STATUSES.rerouted && S.STATUSES.rerouted.ac === 2, "Reroute Power has a status to hang +2 AC on");
    // Every status id the appendix names must exist under exactly that key —
    // applyStatus silently refuses an unknown one, and a typo is invisible.
    for (const id of ["evasive", "aggressive", "hidden", "ramming_committed", "shields_down",
                      "engines_disabled", "weapon_offline", "frozen", "grappled", "on_fire",
                      "painted", "boarded", "cloaked", "station_shock", "adrift", "rerouted",
                      "jammed", "shrouded"]) {
      ok(!!S.STATUSES[id], `status "${id}" must exist under that exact key`);
    }
    ok(S.applyStatus({ statuses: [] }, "ramming_committed", { round: 1 }) !== null,
       "applyStatus accepts ramming_committed — the id the Ram handler uses");

    // --- scanning ----------------------------------------------------------
    ok(S.scanResult(-6).tier === "silhouette", "a failed scan still returns the silhouette tier");
    ok(S.scanResult(-6).painted === true, "…and paints the target, so the next scan has advantage");
    ok(S.scanResult(-6).reveal.ac === false, "…but reveals no vitals");
    ok(S.scanResult(0).reveal.ac && S.scanResult(0).reveal.shields, "meeting the DC gives vitals and the shield facing");
    ok(S.scanResult(0).reveal.systems === false, "…but not the systems");
    ok(S.scanResult(3).reveal.systems === true, "beating it by 3 gives the systems");
    ok(S.scanResult(3).gunnerAdvantage === 1, "…and one gunner advantage");
    ok(S.scanResult(10).reveal.crew === true && S.scanResult(10).gunnerAdvantage === 2,
       "beating it by 10 gives the manifest and both gunners");
    ok(S.scanResult(10).reveal.deckmap === 1, "…and the first deck-map tier");
    for (const m of [-20, -1, 0, 2, 3, 9, 10, 25]) {
      const r = S.scanResult(m);
      ok(r.confidence > 0 && r.confidence < 100, `confidence stays honest at margin ${m} (${r.confidence})`);
      ok(!!S.SCAN_TIERS.find((t) => t.key === r.tier), `margin ${m} names a real tier`);
    }
    // applyScan never un-reveals what an earlier scan already got
    const scanned = S.normalizeShip({ id: "s2" });
    S.applyScan(scanned, S.scanResult(12));
    ok(scanned.revealed.crew === true, "a great scan reveals the crew");
    S.applyScan(scanned, S.scanResult(-5));
    ok(scanned.revealed.crew === true, "a later BAD scan does not take it away again");

    // --- the reveal boundary (the leak audit) -------------------------------
    const secret = S.normalizeShip({ id: "s1", name: "Ghost", hull: { cur: 40, max: 200 }, ac: { base: 17 },
      armour: 6, shield: { on: true, facing: "aft" }, crew: { c1: { name: "Captain", station: "captain" } } });
    const gmView = S.shipView(secret, { isGM: true });
    ok(gmView.hull.cur === 40 && gmView.ac.base === 17, "the GM sees everything");
    const blind = S.shipView(secret, { isGM: false });
    for (const k of Object.keys(blind)) {
      ok(S.SHIP_PUBLIC_KEYS.includes(k), `an unscanned player view leaked "${k}"`);
    }
    ok(blind.hull === undefined && blind.ac === undefined && blind.armour === undefined,
       "an unscanned player learns no hull, AC or armour");
    ok(blind.crew === undefined, "an unscanned player learns no crew");
    secret.revealed.ac = true;
    const tier1 = S.shipView(secret, { isGM: false });
    ok(tier1.ac.base === 17 && tier1.hull.cur === 40, "a scan reveals AC and hull");
    ok(tier1.shield === undefined, "…but not the shield facing until that tier");
    secret.revealed.shields = true; secret.revealed.crew = true;
    const tier2 = S.shipView(secret, { isGM: false });
    ok(tier2.shield.facing === "aft", "the shield tier reveals the facing");
    ok(tier2.crew.c1.name === "Captain", "the crew tier reveals the roster");
    ok(tier2.crew.c1.deck === undefined, "…but not their deck until the deck-map tier");
    // a rift hull withholds even its class until it is scanned
    const riftShip = S.normalizeShip({ id: "r1", name: "The Dark Crown", faction: "rift", cls: "corvette" });
    const riftBlind = S.shipView(riftShip, { isGM: false });
    ok(riftBlind.cls === "" && riftBlind.unresolved === true, "a rift hull does not resolve its class to a player");
    ok(S.shipView(riftShip, { isGM: true }).cls === "corvette", "the GM still sees a rift hull's class");
    riftShip.revealed.ac = true;
    ok(S.shipView(riftShip, { isGM: false }).cls === "corvette", "a successful scan resolves it");

    secret.revealed.deckmap = 3;
    ok(S.shipView(secret, { isGM: false }).crew.c1.deck === 1, "the top scan tier reveals crew positions");
    // A status a player can plainly see (a burning ship) is not a leak.
    S.applyStatus(secret, "on_fire", { round: 1 });
    ok(S.shipView(secret, { isGM: false }).statuses.some((x) => x.id === "on_fire"), "visible statuses stay visible");
    S.applyStatus(secret, "hidden", { round: 1 });
    ok(!S.shipView(secret, { isGM: false }).statuses.some((x) => x.id === "hidden"), "a ship in cover does not advertise it");

    // --- combat state carries the fleet ------------------------------------
    const fc = S.normalizeCombat({ active: true, round: 3, activeShip: "e1",
      ships: { e1: { name: "E", hull: { cur: 50, max: 60 } } }, initiative: [{ shipId: "e1", roll: 17 }] });
    ok(fc.round === 3 && fc.activeShip === "e1", "round and active ship survive");
    ok(fc.ships.e1.hull.cur === 50, "ships survive normalizeCombat");
    ok(fc.initiative[0].roll === 17, "initiative survives");
    ok(S.normalizeCombat({}).ships && Object.keys(S.normalizeCombat({}).ships).length === 0, "a fresh combat has no ships");

    // --- normalizeShip must not silently drop a field ----------------------
    // The failure mode this catches: someone adds a field to defaultShip (or
    // writes one from the wiring half) and forgets the normalizer, so the value
    // survives in memory and vanishes on the next save. It has happened three
    // times in this module — to `statuses`, to `actorId`, and to `aimBonus`.
    {
      const d = S.defaultShip({ id: "probe" });
      const mutated = { ...d, name: "Probe", faction: "rift", cls: "frigate", doctrine: "sniper",
        disposition: "neutral", hull: { cur: 7, max: 99 }, ac: { base: 17 }, armour: 3,
        resist: { energy: "half" }, shield: { on: true, facing: "aft", secondary: "port" },
        guns: [{ id: "g", label: "G", toHit: 4, damage: "2d6", shortMax: 1, longMax: 6, arc: "fore" }],
        abilities: ["unmeasurable"], boardingParty: 4, aimBonus: 6,
        morale: { cur: 2, max: 5 }, actorId: "A", tokenId: "T", sceneId: "S", combatantId: "C",
        skin: "Original", art: "a.png", sizeSq: [11, 22], outcome: "derelict",
        revealed: { ac: true, shields: true, systems: true, crew: true, deckmap: 2 },
        statuses: [{ id: "on_fire", src: "x", expiresRound: 9, data: {} }],
        systemHp: { reactor: { cur: 2, max: 5 } },
        crew: { c1: { id: "c1", name: "Gunner", roleId: "gunner", station: "gunner_port", block: "Guard", tier: 2, deck: 2 } } };
      const back = S.normalizeShip(mutated);
      // Order-insensitive, and the normalizer is allowed to ADD defaults —
      // what it may never do is drop a value or change one.
      const kept = (want, got, path) => {
        if (want === null || typeof want !== "object") {
          if (want !== got) { fails.push(`normalizeShip changed ${path}: ${JSON.stringify(want)} -> ${JSON.stringify(got)}`); return; }
          return;
        }
        if (got === null || typeof got !== "object") { fails.push(`normalizeShip dropped ${path}`); return; }
        for (const k of Object.keys(want)) kept(want[k], got[k], `${path}.${k}`);
      };
      for (const k of Object.keys(d)) {
        if (k === "systems") continue;                       // derived from systemHp
        kept(mutated[k], back[k], k);
      }
      ok(S.normalizeShip(back).aimBonus === 6, "aimBonus survives a second normalize");
      // and idempotence, so a reload cannot mutate a stored fleet
      ok(JSON.stringify(S.normalizeShip(back)) === JSON.stringify(back), "normalizeShip is idempotent");
    }

    // --- deck plans: every skin of every hull must be boardable -------------
    {
      const hull = { decks: 2, skins: {
        Original: { exterior: { sceneId: "e1", art: "e1.png" }, decks: { 1: { sceneId: "d1", art: "d1.png" }, 2: { sceneId: "d2", art: "d2.png" } } },
        Landed:   { exterior: { sceneId: "e2", art: "e2.png" } },                       // pose skin, no interior
        Half:     { exterior: { sceneId: "e3", art: "e3.png" }, decks: { 1: { sceneId: "d3", art: "d3.png" } } } } };
      ok(S.decksForSkin(hull, "Original").borrowed === 0, "a complete skin borrows nothing");
      const landed = S.decksForSkin(hull, "Landed");
      ok(landed.complete && landed.borrowed === 2 && landed.donor === "Original", "a pose skin borrows a whole deck plan");
      const half = S.decksForSkin(hull, "Half");
      ok(half.complete && half.borrowed === 1 && half.decks["1"].sceneId === "d3", "a half skin keeps its own deck 1 and borrows deck 2");
      ok(S.decksForSkin(hull, "nope").complete, "an unknown skin still resolves a deck plan");
      ok(S.decksForSkin(null, "x").count === 0, "decksForSkin survives a null hull");
    }

    // --- driving an enemy seat ---------------------------------------------
    {
      const ship = S.normalizeShip({ id: "e", name: "Probe", doctrine: "brawler",
        guns: [{ id: "auto", label: "Autocannon", toHit: 4, damage: "2d6", shortMax: 2, longMax: 8, arc: "fore" }],
        systemHp: { reactor: { cur: 5, max: 5 }, weapons: { cur: 5, max: 5 } },
        crew: {
          c1: { id: "c1", name: "Cap", roleId: "captain", station: "captain" },
          c2: { id: "c2", name: "Helm", roleId: "pilot", station: "pilot" },
          c3: { id: "c3", name: "Gun", roleId: "gunner", station: "gunner_port" },
          c4: { id: "c4", name: "Eng", roleId: "engineer", station: "engineer" },
          c5: { id: "c5", name: "Dead", roleId: "gunner", station: "gunner_starboard", dead: true },
          c6: { id: "c6", name: "Spare", roleId: "marine", station: "" } } });
      for (const c of Object.values(ship.crew)) {
        const acts = S.enemySeatActions(ship, c);
        if (c.dead) ok(acts.length === 0, "a dead crew member offers no actions");
        else ok(acts.length > 0, `seat "${c.station || "unassigned"}" offers at least one action`);
        for (const a of acts) ok(!!a.id && !!a.label, `every action on "${c.station}" has an id and a label`);
      }
      ok(S.enemySeatActions(ship, ship.crew.c3)[0].id === "e_fire:auto", "a gunner gets one button per online gun");
      ok(S.enemySeatActions(ship, null).length === 0, "enemySeatActions survives a null crew member");
      // A hint that names a number the handler does not apply is a lie the GM
      // reads on every hover. These three did.
      const hintOf = (id) => Object.values(S.ENEMY_SEAT_ACTIONS).flat().find((a) => a.id === id)?.hint || "";
      ok(hintOf("e_evade").includes(`+${S.STATUSES.evasive.ac} AC`),
         `Evade's hint must quote the evasive status's own +${S.STATUSES.evasive.ac} AC`);
      ok(hintOf("e_brace").includes(`+${S.STATUSES.rerouted.ac} AC`),
         `Brace's hint must quote the rerouted status's own +${S.STATUSES.rerouted.ac} AC`);
      for (const list of Object.values(S.ENEMY_SEAT_ACTIONS)) for (const a of list) {
        ok(!!a.hint && a.hint.length > 8, `enemy action "${a.id}" needs a hint the GM can read`);
      }

      const far = S.enemyStandingOrders(ship, { distance: 12 });
      ok(far.some((o) => o.action === "e_close"), "a brawler at 12 squares closes");
      ok(!far.some((o) => o.action === "e_fire:auto"), "and does not fire an 8-square gun at 12 squares");
      const near = S.enemyStandingOrders(ship, { distance: 2 });
      ok(near.some((o) => o.action === "e_fire:auto"), "a brawler in the pocket fires");
      ok(near.every((o) => ship.crew[o.crewId] && !ship.crew[o.crewId].dead), "standing orders never give an order to a corpse");
      ok(near.every((o) => o.action || o.skipped), "every order either names an action or says why it was skipped");
      ok(near.every((o) => !!o.why), "…and every order carries its reasoning for the GM");
      // Opening the range turns the stern to the target, so a fore mount cannot
      // bear — the plan must not order a shot that gmEnemyFire will refuse.
      const running = S.enemyStandingOrders({ ...ship, doctrine: "sniper" }, { distance: 1 });
      ok(running.some((o) => o.action === "e_open"), "a sniper at 1 square runs");
      ok(!running.some((o) => o.action === "e_fire:auto"),
         "…and does not order a fore mount to fire over its own stern");
      ok(running.filter((o) => o.skipped).length >= 1, "…it says the mount could not bear instead of going quiet");
      // A turret mount bears either way.
      const turreted = S.enemyStandingOrders({ ...ship, doctrine: "sniper",
        guns: [{ id: "ring", label: "Ring Turret", toHit: 4, damage: "2d6", shortMax: 2, longMax: 8, arc: "turret" }] },
        { distance: 1 });
      ok(turreted.some((o) => o.action === "e_fire:ring"), "a turret mount fires while running");
      ok(S.enemyStandingOrders(null).length === 0, "enemyStandingOrders survives a null ship");
      const sniper = S.enemyStandingOrders({ ...ship, doctrine: "sniper" }, { distance: 2 });
      ok(sniper.some((o) => o.action === "e_open"), "a sniper in the pocket backs off");
      // Every manned seat should get something to do, the captain included.
      ok(near.some((o) => o.crewId === "c1"), "the captain gets an order");
      const capOnly = S.enemyStandingOrders({ ...ship,
        crew: { c1: { id: "c1", name: "Cap", roleId: "captain", station: "captain" } } }, { distance: 3 });
      ok(capOnly.length > 0, "a captain-only hull still produces a turn");
      const hurt = S.normalizeShip({ ...ship, id: "h" });
      S.applyStatus(hurt, "on_fire", { round: 1, rounds: 2 });
      ok(S.enemyStandingOrders(hurt, { distance: 3 }).some((o) => o.action === "e_rally"),
         "a burning ship rallies instead of calling the target");
    }

    // --- combat normalize --------------------------------------------------
    const c = S.normalizeCombat({ active: true, turn: 4, crew: { x: { name: "Test", station: "pilot", mp: 3 } } });
    ok(c.turn === 4 && c.crew.x.station === "pilot" && c.crew.x.mp === 3, "combat normalize keeps crew fields");
    ok(S.normalizeCombat({ crew: { g: { name: "G", station: "gunner_port", target: "e1" } } }).crew.g.target === "e1",
       "a gunner's target survives normalize — a laid gun stays laid");
    ok(S.normalizeCombat({ crew: { y: { name: "Y", station: "not-a-station" } } }).crew.y.station === "", "invalid stations are dropped");

    return fails;
  };

  if (typeof process !== "undefined" && process.argv && process.argv.includes("--selftest")) {
    const fails = S.selftest();
    if (fails.length) {
      console.error("SELFTEST FAILED:");
      for (const f of fails) console.error("  \u2717 " + f);
      process.exit(1);
    }
    console.log(`ship-combat selftest: all assertions passed`);
  }
})();
