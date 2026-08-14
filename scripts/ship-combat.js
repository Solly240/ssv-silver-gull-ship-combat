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

  S.defaultCombat = function () {
    const rolesEnabled = {};
    for (const st of S.STATIONS) rolesEnabled[st.id] = !!st.defaultUnlocked;
    return { active: false, turn: 1, rolesEnabled, seats: {}, pendingSwap: null };
  };

  // Merge stored combat onto defaults so new fields/stations forward-migrate.
  S.normalizeCombat = function (stored) {
    const d = S.defaultCombat();
    if (!stored || typeof stored !== "object") return d;
    const out = {
      active: !!stored.active,
      turn: Number.isFinite(stored.turn) ? stored.turn : 1,
      rolesEnabled: { ...d.rolesEnabled },
      seats: {},
      pendingSwap: null
    };
    for (const st of S.STATIONS) {
      if (typeof stored.rolesEnabled?.[st.id] === "boolean") out.rolesEnabled[st.id] = stored.rolesEnabled[st.id];
    }
    for (const st of S.STATIONS) {
      const s = stored.seats?.[st.id];
      if (s && typeof s === "object" && s.ownerUserId) {
        out.seats[st.id] = {
          role: st.id,
          ownerUserId: String(s.ownerUserId),
          controllerUserId: String(s.controllerUserId || s.ownerUserId),
          action: !!s.action,
          bonus: !!s.bonus
        };
      }
    }
    const ps = stored.pendingSwap;
    if (ps && ps.role && ps.targetRole && ps.fromUserId && ps.targetUserId) {
      out.pendingSwap = {
        role: String(ps.role), targetRole: String(ps.targetRole),
        fromUserId: String(ps.fromUserId), targetUserId: String(ps.targetUserId)
      };
    }
    return out;
  };

  // Seats a given user currently operates (their own + any the GM handed them).
  S.seatsControlledBy = function (combat, userId) {
    return Object.values(combat.seats).filter((s) => s.controllerUserId === userId);
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
      // A single directional shield: on/off + which side it covers.
      shield: { on: true, facing: "fore" }
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
      shield: { ...d.shield }
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
    }
    out.hull.cur = Math.max(0, Math.min(out.hull.cur, out.hull.max));
    return out;
  };

  /* ---------------------------------------------------------------------- */
  /*  Helpers                                                               */
  /* ---------------------------------------------------------------------- */

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

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
    if (!state.shield.on || gen === "destroyed") return "";
    const file = ctx.assetUrl(`assets/shields/shield-${state.shield.facing}.png`);
    const cls = "sc-shieldimg" + (gen === "damaged" ? " dmg" : "");
    return `<img class="${cls}" src="${file}" alt="" onerror="this.style.display='none'">`;
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

  const legendHtml = () => `<div class="ct-legend">` +
    `<span>${token("action", false, false)} Action</span><span>${token("action", true, false)} used</span>` +
    `<span>${token("bonus", false, false)} Bonus</span><span>${token("bonus", true, false)} used</span></div>`;

  function wireTokens(el, role, cctx) {
    el.querySelectorAll(".ct-tok.click").forEach((t) => { t.onclick = () => cctx.spend(role, t.dataset.tok); });
  }

  S.renderTracker = function (root, cctx) {
    S.ensureStyles();
    const combat = S.normalizeCombat(cctx.getCombat());
    root.className = "sgct host";

    if (!combat.active) {
      if (cctx.isGM) {
        root.style.display = "flex";
        root.innerHTML = `<div class="ct-top"><span class="ct-turn">SHIP COMBAT</span>` +
          `<button class="ct-btn enter" data-act="enter">⚔ ENTER SHIP COMBAT</button></div>`;
        root.querySelector('[data-act="enter"]').onclick = () => cctx.enterCombat();
      } else {
        root.style.display = "none";
        root.innerHTML = "";
      }
      return;
    }
    root.style.display = "flex";

    if (cctx.isGM) {
      const seats = Object.values(combat.seats);
      const roster = seats.length ? seats.map((s) => {
        const st = S.station(s.role);
        const opts = (cctx.users || []).map((u) =>
          `<option value="${u.id}" ${u.id === s.controllerUserId ? "selected" : ""}>${esc(u.name)}${u.isGM ? " (GM)" : ""}</option>`).join("");
        return `<div class="ct-seat" data-role="${s.role}">` +
          `<div><div class="ct-name">${esc(st ? st.name : s.role)}</div><div class="ct-sub">owner: ${esc(nameOf(cctx, s.ownerUserId))}</div></div>` +
          `<div class="ct-toks">${token("action", s.action, true)}${token("bonus", s.bonus, true)}</div>` +
          `<div class="ct-ctrl"><select class="ct-sel" data-ctrl title="Who controls this seat">${opts}</select>` +
          `<span class="ct-x" data-remove title="Remove seat">✕</span></div></div>`;
      }).join("") : `<div class="ct-empty">No crew seated yet — players pick from the popup, or use “+ Add seat”.</div>`;
      const swap = combat.pendingSwap
        ? `<div class="ct-note">Swap pending: ${esc(S.station(combat.pendingSwap.role)?.name || combat.pendingSwap.role)} ↔ ${esc(S.station(combat.pendingSwap.targetRole)?.name || combat.pendingSwap.targetRole)} (awaiting confirm)</div>`
        : "";
      root.innerHTML =
        `<div class="ct-top"><span class="ct-turn">SHIP'S TURN ${combat.turn}</span>` +
        `<button class="ct-btn" data-act="next">⏭ Next Turn</button>` +
        `<button class="ct-btn" data-act="add">+ Add seat</button>` +
        `<button class="ct-btn" data-act="roles">Roles</button>` +
        `<button class="ct-btn" data-act="resend">Re-send picker</button>` +
        `<button class="ct-btn warn" data-act="end">✖ End Combat</button></div>` +
        `<div class="ct-seats">${roster}</div>${swap}${legendHtml()}`;
      root.querySelector('[data-act="next"]').onclick = () => cctx.nextTurn();
      root.querySelector('[data-act="add"]').onclick = () => cctx.addSeat();
      root.querySelector('[data-act="roles"]').onclick = () => cctx.openRoles();
      root.querySelector('[data-act="resend"]').onclick = () => cctx.broadcastPick();
      root.querySelector('[data-act="end"]').onclick = () => cctx.endCombat();
      root.querySelectorAll(".ct-seat").forEach((el) => {
        const role = el.dataset.role;
        wireTokens(el, role, cctx);
        const sel = el.querySelector("[data-ctrl]"); if (sel) sel.onchange = () => cctx.assignController(role, sel.value);
        const x = el.querySelector("[data-remove]"); if (x) x.onclick = () => cctx.removeSeat(role);
      });
      return;
    }

    // Player view — only the seats this user controls.
    const mine = S.seatsControlledBy(combat, cctx.userId);
    if (!mine.length) {
      root.innerHTML = `<div class="ct-top"><span class="ct-turn">SHIP'S TURN ${combat.turn}</span>` +
        `<button class="ct-btn" data-act="pick">Pick a role</button></div>`;
      root.querySelector('[data-act="pick"]').onclick = () => cctx.pickRole();
      return;
    }
    const blocks = mine.map((s) => {
      const st = S.station(s.role);
      const sub = s.ownerUserId === cctx.userId ? "" : `<div class="ct-sub">covering ${esc(nameOf(cctx, s.ownerUserId))}</div>`;
      return `<div class="ct-seat mine" data-role="${s.role}">` +
        `<div><div class="ct-name">${esc(st ? st.name : s.role)}</div>${sub}</div>` +
        `<div class="ct-toks">${token("action", s.action, true)}${token("bonus", s.bonus, true)}</div>` +
        `<button class="ct-btn" data-switch title="Switch station (costs a Bonus action)">Switch</button></div>`;
    }).join("");
    root.innerHTML = `<div class="ct-top"><span class="ct-turn">SHIP'S TURN ${combat.turn}</span></div>` +
      `<div class="ct-seats">${blocks}</div>${legendHtml()}`;
    root.querySelectorAll(".ct-seat").forEach((el) => {
      const role = el.dataset.role;
      wireTokens(el, role, cctx);
      const sw = el.querySelector("[data-switch]"); if (sw) sw.onclick = () => cctx.requestSwitch(role);
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

  /* -- Standalone window ------------------------------------------------- */

  let _win = null;
  function openShipHUD() {
    const Api = foundry.applications?.api;
    if (!Api?.ApplicationV2) return ui.notifications?.error("Ship Overview needs Foundry v12+ (ApplicationV2).");
    if (_win?.rendered) { _win.close(); return; }
    const { ApplicationV2 } = Api;
    if (!_win) {
      class ShipHUDWindow extends ApplicationV2 {
        static DEFAULT_OPTIONS = {
          id: "ssv-ship-hud", classes: ["ssv-ship-hud"],
          window: { title: "SSV Silver Gull — Ship Overview" },
          position: { width: 940, height: "auto" }
        };
        async _renderHTML() { return ""; }
        _replaceHTML(_r, content) { content.innerHTML = "<div></div>"; S.render(content.firstElementChild, ctx()); }
      }
      _win = new ShipHUDWindow();
    }
    _win.render(true);
  }

  function refreshOpen() {
    if (_win?.rendered) _win.render(false);
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
      case "pickRolePrompt": if (!game.user.isGM) promptRolePick(); break;
      case "pickRole":       gmSeatUser(msg.userId, msg.role); break;
      case "spend":          gmSpend(msg.role, msg.which, msg.userId); break;
      case "switchRequest":  gmSwitch(msg.userId, msg.role, msg.target); break;
      case "swapConfirm":    promptSwapConfirm(msg); break;
      case "swapResult":     gmResolveSwap(msg.accepted); break;
      case "notify":         ui.notifications?.warn(msg.text); break;
    }
  }

  /* GM-authoritative handlers */
  async function enterCombat() {
    if (!game.user.isGM) return;
    const cur = getCombat();
    const next = S.defaultCombat();
    next.active = true; next.turn = 1; next.rolesEnabled = cur.rolesEnabled;  // keep GM's role toggles
    await saveCombat(next);
    emit({ type: "pickRolePrompt" });
    ui.notifications?.info("Ship combat started — players are picking their stations.");
  }
  async function endCombat() {
    if (!game.user.isGM) return;
    const next = getCombat(); next.active = false; next.seats = {}; next.pendingSwap = null;
    await saveCombat(next);
  }
  async function nextTurn() {
    if (!game.user.isGM) return;
    const next = getCombat();
    for (const s of Object.values(next.seats)) { s.action = false; s.bonus = false; }
    next.turn = (next.turn || 1) + 1; next.pendingSwap = null;
    await saveCombat(next);
  }
  async function gmSeatUser(userId, role) {
    if (!game.user.isGM) return;
    const next = getCombat();
    if (!next.rolesEnabled[role]) return notifyUser(userId, "That station is disabled.");
    if (next.seats[role] && next.seats[role].ownerUserId !== userId) return notifyUser(userId, "That station is already taken.");
    for (const [rid, s] of Object.entries(next.seats)) if (s.ownerUserId === userId && rid !== role) delete next.seats[rid];
    next.seats[role] = { role, ownerUserId: userId, controllerUserId: userId, action: false, bonus: false };
    await saveCombat(next);
  }
  async function gmSpend(role, which, byUserId) {
    if (!game.user.isGM) return;
    const next = getCombat(); const seat = next.seats[role]; if (!seat) return;
    const gmActor = !byUserId || game.users.get(byUserId)?.isGM;
    if (!gmActor && seat.controllerUserId !== byUserId) return;   // players only touch seats they control
    if (which === "action") seat.action = !seat.action;
    else if (which === "bonus") seat.bonus = !seat.bonus;
    await saveCombat(next);
  }
  async function assignController(role, userId) {
    if (!game.user.isGM) return;
    const next = getCombat(); const seat = next.seats[role]; if (!seat) return;
    seat.controllerUserId = userId; await saveCombat(next);
  }
  async function removeSeat(role) {
    if (!game.user.isGM) return;
    const next = getCombat(); delete next.seats[role]; await saveCombat(next);
  }
  async function gmSwitch(byUserId, role, target) {
    if (!game.user.isGM) return;
    const next = getCombat(); const seat = next.seats[role]; if (!seat) return;
    const gmActor = game.users.get(byUserId)?.isGM;
    if (!gmActor && seat.controllerUserId !== byUserId) return;
    if (!next.rolesEnabled[target]) return notifyUser(byUserId, "That station is disabled.");
    if (seat.bonus) return notifyUser(byUserId, "You've already used your Bonus action.");
    const occupant = next.seats[target];
    if (!occupant) {                                   // move into an empty station
      seat.bonus = true;
      delete next.seats[role]; next.seats[target] = { ...seat, role: target };
      await saveCombat(next);
    } else {                                           // swap with another crew → needs confirm + their bonus
      if (occupant.bonus) return notifyUser(byUserId, "That station's crew has no Bonus action left.");
      next.pendingSwap = { role, targetRole: target, fromUserId: byUserId, targetUserId: occupant.controllerUserId };
      await saveCombat(next);
      const payload = { type: "swapConfirm", toUser: occupant.controllerUserId, fromName: nameById(byUserId), role, target };
      if (occupant.controllerUserId === game.user.id) promptSwapConfirm(payload);
      else emit(payload);
    }
  }
  async function gmResolveSwap(accepted) {
    if (!game.user.isGM) return;
    const next = getCombat(); const ps = next.pendingSwap; if (!ps) return;
    if (!accepted) { next.pendingSwap = null; await saveCombat(next); notifyUser(ps.fromUserId, "Your swap request was declined."); return; }
    const a = next.seats[ps.role], b = next.seats[ps.targetRole];
    if (a && b) {
      a.bonus = true; b.bonus = true;
      next.seats[ps.targetRole] = { ...a, role: ps.targetRole };
      next.seats[ps.role] = { ...b, role: ps.role };
    }
    next.pendingSwap = null;
    await saveCombat(next);
  }

  /* Player-side prompts */
  async function promptRolePick() {
    const combat = getCombat();
    if (!combat.active) return;
    const taken = new Set(Object.keys(combat.seats));
    const opts = S.STATIONS.filter((st) => combat.rolesEnabled[st.id] && !taken.has(st.id)).map((st) => ({ value: st.id, label: `${st.num}. ${st.name}` }));
    if (!opts.length) return ui.notifications?.warn("No stations are available to crew right now.");
    const role = await chooseDlg("Pick your station", "Choose the station you'll crew this combat:", opts);
    if (!role) return;
    if (game.user.isGM) gmSeatUser(game.user.id, role);
    else emit({ type: "pickRole", toGM: true, userId: game.user.id, role });
  }
  async function promptSwapConfirm(msg) {
    const theirs = S.station(msg.role)?.name || msg.role;
    const mine = S.station(msg.target)?.name || msg.target;
    const ok = await confirmDlg("Station swap request",
      `${esc(msg.fromName)} (${esc(theirs)}) wants to swap stations with you (${esc(mine)}). This spends your Bonus action. Accept?`);
    if (game.user.isGM) gmResolveSwap(ok);
    else emit({ type: "swapResult", toGM: true, accepted: !!ok });
  }
  async function addSeatDialog() {
    if (!game.user.isGM) return;
    const combat = getCombat();
    const taken = new Set(Object.keys(combat.seats));
    const roleOpts = S.STATIONS.filter((st) => combat.rolesEnabled[st.id] && !taken.has(st.id)).map((st) => ({ value: st.id, label: `${st.num}. ${st.name}` }));
    if (!roleOpts.length) return ui.notifications?.warn("No free enabled stations.");
    const role = await chooseDlg("Add seat — station", "Which station?", roleOpts);
    if (!role) return;
    const owner = await chooseDlg("Add seat — owner", "Whose station is this (e.g. an absent player)?", game.users.map((u) => ({ value: u.id, label: u.name + (u.isGM ? " (GM)" : "") })));
    if (!owner) return;
    gmSeatUser(owner, role);
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
    enterCombat, endCombat, nextTurn,
    spend: (role, which) => { if (game.user.isGM) gmSpend(role, which, null); else emit({ type: "spend", toGM: true, role, which, userId: game.user.id }); },
    requestSwitch: async (role) => {
      const combat = getCombat();
      const taken = new Set(Object.keys(combat.seats));
      const opts = S.STATIONS.filter((st) => combat.rolesEnabled[st.id] && st.id !== role)
        .map((st) => ({ value: st.id, label: `${st.num}. ${st.name}${taken.has(st.id) ? " — occupied" : ""}` }));
      if (!opts.length) return;
      const target = await chooseDlg("Switch station", "Move to which station? (costs a Bonus action)", opts);
      if (!target) return;
      if (game.user.isGM) gmSwitch(game.user.id, role, target);
      else emit({ type: "switchRequest", toGM: true, userId: game.user.id, role, target });
    },
    pickRole: promptRolePick,
    addSeat: addSeatDialog,
    openRoles: rolesDialog,
    broadcastPick: () => { emit({ type: "pickRolePrompt" }); ui.notifications?.info("Re-sent the station picker to players."); },
    assignController, removeSeat
  });

  /* The always-on tracker bar mounted into the Foundry UI */
  let _bar = null;
  function renderBar() {
    if (!_bar || !document.body.contains(_bar)) {
      _bar = document.createElement("div");
      _bar.id = "ssv-combat-bar";
      document.body.appendChild(_bar);
    }
    try { S.renderTracker(_bar, combatCtx()); } catch (e) { console.error(`${MODULE_ID} | tracker render failed`, e); }
  }

  /* -- Hooks ------------------------------------------------------------- */

  Hooks.once("init", () => {
    // onChange fires on every client when a world setting replicates → our cross-client refresh.
    game.settings.register(MODULE_ID, SETTING_DATA, { scope: "world", config: false, type: Object, default: {}, onChange: () => refreshOpen() });
    game.settings.register(MODULE_ID, SETTING_COMBAT, { scope: "world", config: false, type: Object, default: {}, onChange: () => renderBar() });
    game.keybindings.register(MODULE_ID, "open", {
      name: game.i18n?.localize(`${MODULE_ID}.keybind.open.name`) || "Open Ship Overview HUD",
      hint: game.i18n?.localize(`${MODULE_ID}.keybind.open.hint`) || "Opens the SSV Silver Gull ship-combat overview.",
      editable: [{ key: "KeyS" }],
      onDown: () => { openShipHUD(); return true; }
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
    const mod = game.modules.get(MODULE_ID);
    if (mod) mod.api = { open: openShipHUD, getState, setState, defaultState: S.defaultState,
      SYSTEMS: S.SYSTEMS, FACINGS: S.FACINGS, STATIONS: S.STATIONS,
      getCombat, enterCombat, endCombat, nextTurn };
    globalThis.SilverGullShip = mod?.api;
  });
})();
