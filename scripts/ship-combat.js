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

  /* -- Hooks ------------------------------------------------------------- */

  Hooks.once("init", () => {
    game.settings.register(MODULE_ID, SETTING_DATA, { scope: "world", config: false, type: Object, default: {} });
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
    }
    const mod = game.modules.get(MODULE_ID);
    if (mod) mod.api = { open: openShipHUD, getState, setState, defaultState: S.defaultState, SYSTEMS: S.SYSTEMS, FACINGS: S.FACINGS };
    globalThis.SilverGullShip = mod?.api;
  });
})();
