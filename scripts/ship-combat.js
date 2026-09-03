/**
 * SSV Silver Gull — Ship Combat: the FOUNDRY WIRING half.
 *
 * Settings, the ctx builders, dialogs, the socket, every GM-authoritative
 * handler, and all actor / token / scene / canvas work. The renderers, the CSS
 * and the combat maths live in scripts/ship-combat-render.js, which module.json
 * loads first (as a classic "scripts" entry) so SSVShipHUD always exists here.
 *
 * Built for Foundry VTT v12–v14. No dependency on any other module.
 */

(function () {
  if (typeof Hooks === "undefined") return;

  const MODULE_ID = "ssv-silver-gull-ship-combat";
  const S = (typeof globalThis !== "undefined" ? globalThis : window).SSVShipHUD;
  if (!S) { console.error(`${MODULE_ID} | ship-combat-render.js did not load — the module cannot start.`); return; }

  // Helpers that live in the pure half.
  const esc = S.esc, clamp = S.clamp, stripHtml = S.stripHtml;
  const token = S.token, grantedTokens = S.grantedTokens, stationName = S.stationName;
  const hideInvPop = S.hideInvPop, openItemBrowser = S.openItemBrowser, closeItemBrowser = S.closeItemBrowser;
  const DEFAULT_ITEM_IMG = S.DEFAULT_ITEM_IMG, ITEM_COLLATOR = S.ITEM_COLLATOR;

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

  const ctx = () => ({ isGM: game.user.isGM, getState, setState, assetUrl, promptHull, promptNumber, getCombat });

  /* -- Full-screen station console (frameless overlay) ------------------- */

  let _console = null;
  let armed = null;            // transient shield-allocation mode: 'main' | 'secondary' | null
  let gmDriveCrewId = null;    // which crew the GM is driving in the console
  let playerDriveCrewId = null;// which of THEIR OWN crew a player is viewing (when they control more than one)
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
    const mine = S.crewControlledBy(combat, game.user.id).filter((c) => c.station);
    return mine.find((x) => x.id === playerDriveCrewId) || mine[0] || null;
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
      stationOptions: (game.user.isGM
        ? Object.values(combat.crew).filter((c) => c.station)
        : S.crewControlledBy(combat, game.user.id).filter((c) => c.station)
      ).map((c) => ({ crewId: c.id, station: c.station, label: `${c.name} — ${S.station(c.station)?.name || c.station}` })),
      selectStation: (cid) => { if (game.user.isGM) gmDriveCrewId = cid; else playerDriveCrewId = cid; armed = null; renderConsole(); },
      get armed() { return armed; },
      setArmed: (m) => { armed = m; renderConsole(); },
      allocate: (facing, slot) => {
        const gmDirect = gmActMode && game.user.isGM;   // GM Actions arming → set the ship directly
        armed = null;
        if (gmDirect) {
          if (slot === "secondary") gmSetSecondaryDirect(facing); else gmSetMainShieldDirect(facing);
          renderConsole(); return;
        }
        if (!crew) { renderConsole(); return; }
        if (game.user.isGM) gmAllocateShield(crew.id, facing, slot, null);
        else emit({ type: "allocateShield", toGM: true, crewId: crew.id, facing, slot, userId: game.user.id });
        renderConsole();
      },
      runAction: (a, isBonus) => runStationAction(a, isBonus, crew, stName),
      // GM Actions panel (GM-only, direct control + chat, no action economy)
      gmActMode, toggleGM: () => { gmActMode = !gmActMode; invMode = false; armed = null; swapAnim = true; renderConsole(); },
      armShield: (slot) => { armed = (armed === slot ? null : slot); renderConsole(); },

      // Build or scrap a turret. Also flips its station on, so the seat appears
      // in the picker the moment the mount exists.
      toggleTurret: async (id) => {
        if (!game.user.isGM) return;
        const st = S.normalize(getState());
        const t = st.turrets[id]; if (!t) return;
        t.built = !t.built;
        t.hp = { cur: t.built ? S.TURRET_HP_MAX : 0, max: S.TURRET_HP_MAX };
        await setState(st);
        const c = getCombat();
        c.rolesEnabled[id] = t.built;
        await saveCombat(c);
        const meta = S.turret(id);
        await ChatMessage.create({
          content: t.built
            ? `<b>${esc(meta.name)}</b> is rebuilt and online. <i>${esc(meta.blurb)}</i>`
            : `<b>${esc(meta.name)}</b> has been scrapped.`,
          speaker: { alias: "SSV Silver Gull" } });
        refreshUI();
      },      openProficiency: () => gmProficiencyDialog(),
      // Inventory
      invMode, toggleInv: () => { invMode = !invMode; gmActMode = false; armed = null; swapAnim = true; renderConsole(); },
      invTab, setInvTab: (tb) => { invTab = (tb === "you" ? "you" : "ship"); renderConsole(); },
      animateSwap: (() => { const a = swapAnim; swapAnim = false; return a; })(),
      addItem: () => gmAddItemBrowser(),
      dropItemData: (raw) => gmAddDroppedItem(raw),
      deleteItem: (id) => gmDeleteItem(id),
      getState,
      // Getters, not values: physicalItems() walks every owned item and runs three regexes
      // over each description. Only renderInventoryPanel reads these, and it is skipped
      // entirely unless the inventory is showing — so as plain properties this ran on
      // every console render for nothing.
      get shipItems() { return physicalItems(getShipActor()); },
      get playerItems() { return physicalItems(game.user.character); },
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
    if (st.actorId) { const a = game.actors.get(st.actorId); if (a) return a; }
    // Name fallback must skip the auto-created token-icon actor (also named "SSV Silver Gull") so inventory
    // ops don't target the throwaway display actor on a world where the cargo actor isn't configured yet.
    return game.actors?.find((a) => a.name === st.name && !a.getFlag?.(MODULE_ID, "shipIcon")) || null;
  }
  function physicalItems(actor) {
    if (!actor?.items) return [];
    return actor.items.filter((i) => PHYSICAL_TYPES.has(i.type)).map((i) => {
      const w = i.system?.weight;
      const weight = (w && typeof w === "object") ? (w.value ?? 0) : (w ?? 0);
      const fl = i.flags?.[MODULE_ID] || {};
      const resKind = (fl.resKind === "fuel" || fl.resKind === "power") ? fl.resKind : null;
      return { id: i.id, name: i.name, qty: i.system?.quantity ?? 1, img: i.img || DEFAULT_ITEM_IMG,
        type: i.type, weight, desc: stripHtml(i.system?.description?.value), rarity: i.system?.rarity || "",
        resKind, resAmount: Number(fl.resAmount) || 0, overcharge: !!fl.overcharge };
    });
  }
  async function promptNumber(title, label, value, max) {
    const content = `<div style="display:flex;flex-direction:column;gap:6px;"><label>${esc(label)}<input type="number" name="v" value="${value}" min="0"${max != null ? ` max="${max}"` : ""}/></label></div>`;
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
      `<label style="display:flex;justify-content:space-between;align-items:center;gap:10px;">Overcharge (push past max) <input type="checkbox" name="over" ${fl.overcharge ? "checked" : ""}></label>` +
      `<p style="opacity:.7;font-size:12px;margin:0">Fuel/power items show a ⛽ / ⚡ button; using one spends 1 and adds “amount per use” to that gauge. Overcharge lets it exceed the max (running hot). Quantity 0 deletes the item.</p></div>`;
    const read = (form) => ({ qty: Number(form.elements.qty.value), kind: form.elements.kind.value, amt: Number(form.elements.amt.value), over: !!form.elements.over?.checked });
    const D = D2();
    let v = null;
    if (D) v = await D.prompt({ window: { title: `Edit — ${item.name}` }, content, ok: { label: "Save", callback: (e, b) => read(b.form) } }).catch(() => null);
    else v = await new Promise((res) => new Dialog({ title: `Edit — ${item.name}`, content, buttons: { ok: { label: "Save", callback: (h) => res(read(h[0].querySelector("form") || h[0])) }, cancel: { label: "Cancel", callback: () => res(null) } }, default: "ok" }).render(true));
    if (!v) return;
    if (Number.isFinite(v.qty) && v.qty <= 0) { await item.delete(); refreshOpen(); return; }
    if (Number.isFinite(v.qty)) await item.update({ "system.quantity": Math.max(1, Math.floor(v.qty)) });
    if (v.kind === "fuel" || v.kind === "power") await item.update({ [`flags.${MODULE_ID}.resKind`]: v.kind, [`flags.${MODULE_ID}.resAmount`]: Math.max(0, Math.floor(v.amt) || 0), [`flags.${MODULE_ID}.overcharge`]: !!v.over });
    else await item.update({ [`flags.${MODULE_ID}.-=resKind`]: null, [`flags.${MODULE_ID}.-=resAmount`]: null, [`flags.${MODULE_ID}.-=overcharge`]: null });
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
    // Overcharge items (exotic/ancient) push the gauge PAST its max — a "running hot" buffer; others cap at max.
    const over = !!fl.overcharge;
    st[kind].cur = over ? (st[kind].cur + add) : Math.min(st[kind].max, st[kind].cur + add);
    await setState(st);
    const hot = st[kind].cur > st[kind].max ? ` <b style="color:#f2b03d">(OVERCHARGED — ${st[kind].cur}/${st[kind].max})</b>` : "";
    await ChatMessage.create({ content: `Used <b>${esc(item.name)}</b> → +${add} ${kind}${hot}`, speaker: { alias: "SSV Silver Gull" } });
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
    // Collator built once rather than an ICU lookup per comparison — this sorts the whole
    // compendium index, which is tens of thousands of comparisons on a loaded world.
    items.sort((a, b) => ITEM_COLLATOR.compare(a.name, b.name));
    const addOne = async (it) => {
      try {
        const src = await fromUuid(it.uuid); if (!src) return;
        const data = src.toObject(); delete data._id;
        await ship.createEmbeddedDocuments("Item", [data]);
        refreshOpen();
      } catch (e) { console.error(`${MODULE_ID} | add item failed`, e); }
    };
    const addNew = async () => {
      const name = await promptTextWithDefault("New item", "Item name", "New Cargo");
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
  async function promptTextWithDefault(title, label, value) {
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
    const st = getState();
    // Per-item amounts live on each item now, and conversion is the two fixed buttons — so only the
    // gauge maximums are tunable here.
    const content = `<div style="display:flex;flex-direction:column;gap:6px;">
      <label>Fuel max <input type="number" name="fmax" value="${st.fuel.max}" min="1"/></label>
      <label>Power max <input type="number" name="pmax" value="${st.power.max}" min="1"/></label></div>`;
    const read = (f) => ({ fmax: +f.elements.fmax.value, pmax: +f.elements.pmax.value });
    const d = D2();
    const r = d
      ? await d.prompt({ window: { title: "Fuel & power maximums" }, content, ok: { label: "Save", callback: (e, b) => read(b.form) } }).catch(() => null)
      : await new Promise((res) => new Dialog({ title: "Fuel & power maximums", content, buttons: { ok: { label: "Save", callback: (h) => res(read(h[0].querySelector("form") || h[0])) }, cancel: { label: "Cancel", callback: () => res(null) } }, default: "ok" }).render(true));
    if (!r) return;
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
  // Only players draw on ship resources — anything the GM (or no user) initiates is free.
  const playerSpends = (byUserId) => !!byUserId && !game.users.get(byUserId)?.isGM;
  // Authority check for a station-scoped action: the GM always passes; a player must control a crew at that station.
  const controlsStation = (byUserId, station) =>
    (!byUserId || game.users.get(byUserId)?.isGM) ||
    Object.values(getCombat().crew).some((c) => c.station === station && c.controllerUserId === byUserId);
  // GM-authoritative: drain `amount` power for a player's action (clamped at 0). GM/zero = no-op.
  async function gmSpendPower(byUserId, amount) {
    if (!game.user.isGM) return;
    const amt = Math.max(0, Math.round(Number(amount) || 0));
    if (!amt || !playerSpends(byUserId)) return;
    const ship = getState(); ship.power.cur = Math.max(0, ship.power.cur - amt); await setState(ship);
  }
  async function gmConsume(crewId, which, byUserId, power) {
    if (!game.user.isGM) return;
    const next = getCombat(); const c = next.crew[crewId]; if (!c) return;
    const gmActor = !byUserId || game.users.get(byUserId)?.isGM;
    if (!gmActor && c.controllerUserId !== byUserId) return;
    const amt = Math.max(0, Math.round(Number(power) || 0));   // server-side power gate (mirrors gmAllocateShield)
    if (amt && playerSpends(byUserId) && getState().power.cur < amt)
      return notifyUser(byUserId, `Not enough power (need ${amt} — convert fuel to power first).`);
    if (!tryConsume(c, which)) return notifyUser(byUserId || game.user.id, `No ${which === "bonus" ? "Bonus" : "Main"} action left.`);
    await saveCombat(next);
    await gmSpendPower(byUserId, power);
  }

  // Pilot: choose a maneuver (Main) → sets Movement Points; then spend them to move/rotate the ship.
  async function gmPilotManeuver(crewId, maneuverId, byUserId) {
    if (!game.user.isGM) return;
    const m = S.MANEUVERS[maneuverId]; if (!m) return;
    const next = getCombat(); const c = next.crew[crewId]; if (!c || c.station !== "pilot") return;
    const gmActor = !byUserId || game.users.get(byUserId)?.isGM;
    if (!gmActor && c.controllerUserId !== byUserId) return;
    const full = Math.round(m.mp * (c.navMult || 1));   // Science Nav Support may have pre-boosted this turn
    c.maneuver = maneuverId; c.mpMax = full; c.mp = full; c.action = true;
    await saveCombat(next);
    const boost = (c.navMult || 1) > 1 ? ` (×${c.navMult} nav support)` : "";
    await ChatMessage.create({ content: `<b>${esc(c.name)}</b> · Pilot — <b>${esc(m.label)}</b> (${full} Movement Points)${boost}`, speaker: { alias: "SSV Silver Gull" } });
  }
  // Science → Nav Support: multiply the Pilot's Movement Points for this turn (retroactive if they've begun moving).
  async function gmNavSupport(mult, byUserId) {
    if (!game.user.isGM) return;
    if (!controlsStation(byUserId, "science")) return notifyUser(byUserId || game.user.id, "Only the Science officer can run Navigation Support.");
    const m = Math.max(1, Math.min(3, Number(mult) || 1));
    const next = getCombat();
    const pilot = Object.values(next.crew).find((c) => c.station === "pilot");
    if (!pilot) return notifyUser(byUserId || game.user.id, "No pilot aboard to support.");
    pilot.navMult = m;
    if (pilot.maneuver) {                                 // retroactively re-scale the base pool, keeping MP already spent
      const base = S.MANEUVERS[pilot.maneuver]?.mp || 0;
      const spent = Math.max(0, (pilot.mpMax || base) - pilot.mp);
      const newMax = Math.round(base * m);
      pilot.mpMax = newMax;
      pilot.mp = Math.max(0, newMax - spent);
    }
    await saveCombat(next);
    await ChatMessage.create({ content: `Navigation Support — <b>${esc(pilot.name)}</b>'s Movement Points ×<b>${m}</b>${pilot.maneuver ? ` (now <b>${pilot.mp}</b> left this turn)` : " this turn"}`, speaker: { alias: "SSV Silver Gull" } });
  }
  async function gmPilotMove(crewId, kind, byUserId) {
    if (!game.user.isGM) return;
    const next = getCombat(); const c = next.crew[crewId]; if (!c || c.station !== "pilot") return;
    const gmActor = !byUserId || game.users.get(byUserId)?.isGM;
    if (!gmActor && c.controllerUserId !== byUserId) return;
    if (!c.maneuver) return notifyUser(byUserId || game.user.id, "Pick a maneuver first.");
    const ship = getState();   // Engine/Thrusters must work to move.
    if (!S.systemWorks(ship, "engine") || !S.systemWorks(ship, "thrusters"))
      return notifyUser(byUserId || game.user.id, "Can't move — engines or thrusters are down.");
    if (c.mp <= 0 && c.bonus) return notifyUser(byUserId || game.user.id, "No movement left this turn.");
    // Fuel cost (players only; the GM moves for free). Block if the tanks are too low.
    const fuelCost = playerSpends(byUserId) ? (S.MOVE_FUEL[kind] || 0) : 0;
    if (fuelCost > 0 && ship.fuel.cur < fuelCost)
      return notifyUser(byUserId, `Not enough fuel — that move needs ${fuelCost} (convert or refuel first).`);
    const moved = await moveShipToken(kind, byUserId);   // abort (don't spend) if there's no ship token
    if (!moved) return;
    if (c.mp > 0) c.mp -= 1; else c.bonus = true;         // spend from the Main pool, then the +1 bonus
    await saveCombat(next);
    if (fuelCost > 0) { const s2 = getState(); s2.fuel.cur = Math.max(0, s2.fuel.cur - fuelCost); await setState(s2); }
  }
  // Move/rotate the ship-icon actor's token on the active scene. Returns false if it can't.
  async function moveShipToken(kind, byUserId) {
    const a = shipIconActor();
    const scene = game.scenes?.active || canvas?.scene;
    if (!a || !scene) { notifyUser(byUserId || game.user.id, "No active scene or ship actor to move."); return false; }
    const tdoc = scene.tokens.find((t) => t.actorId === a.id);
    if (!tdoc) { notifyUser(byUserId || game.user.id, "Place the SSV Silver Gull token on the scene first."); return false; }
    const g = scene.grid?.size || canvas?.grid?.size || 100;
    const upd = { _id: tdoc.id };
    if (kind === "forward") {
      const rad = (tdoc.rotation || 0) * Math.PI / 180;   // rotation 0 = nose up
      upd.x = Math.round(tdoc.x + Math.sin(rad) * g);
      upd.y = Math.round(tdoc.y - Math.cos(rad) * g);
    } else {
      const delta = { rotL45: -45, rotR45: 45, rotL90: -90, rotR90: 90 }[kind];
      if (delta == null) return false;
      upd.rotation = (((tdoc.rotation || 0) + delta) % 360 + 360) % 360;
    }
    await scene.updateEmbeddedDocuments("Token", [upd]);
    return true;
  }
  async function gmSetProficiency(map) {
    if (!game.user.isGM) return;
    const next = getCombat();
    for (const [crewId, profMap] of Object.entries(map || {})) {
      const c = next.crew[crewId]; if (!c) continue;
      c.prof = {};
      for (const [rid, on] of Object.entries(profMap || {})) if (on) c.prof[rid] = true;
      // Mirror onto the roster: crew objects are thrown away at endCombat, the roster is not.
      const m = next.roster.find((r) => r.id === crewId);
      if (m) m.prof = { ...c.prof };
    }
    await saveCombat(next);
  }
  // GM editor: per crew, tick the station rolls they're proficient in (all stations except Boarding).
  async function gmProficiencyDialog() {
    if (!game.user.isGM) return;
    const crew = Object.values(getCombat().crew);
    const roles = S.profRoles();
    if (!crew.length) return ui.notifications?.warn("No crew in this fight yet.");
    const rows = crew.map((c) => {
      const boxes = roles.map((r) => `<label style="display:inline-flex;align-items:center;gap:4px;margin:2px 10px 2px 0;white-space:nowrap;">` +
        `<input type="checkbox" name="p-${c.id}-${r.id}" ${c.prof?.[r.id] ? "checked" : ""}> ${esc(r.name)}</label>`).join("");
      return `<div style="padding:8px 2px;border-bottom:1px solid #12455a;"><div style="font-weight:700;margin-bottom:4px;">${esc(c.name)}</div><div>${boxes}</div></div>`;
    }).join("");
    const content = `<div style="max-height:60vh;overflow:auto;min-width:360px;"><p style="opacity:.75;margin:0 0 6px;">Tick each roll a crew member is proficient in — adds their character's proficiency bonus.</p>${rows}</div>`;
    const read = (form) => { const map = {}; for (const c of crew) { map[c.id] = {}; for (const r of roles) map[c.id][r.id] = !!form.elements[`p-${c.id}-${r.id}`]?.checked; } return map; };
    const d = D2();
    const result = d
      ? await d.prompt({ window: { title: "Crew proficiencies" }, content, ok: { label: "Save", callback: (e, b) => read(b.form) } }).catch(() => null)
      : await new Promise((res) => new Dialog({ title: "Crew proficiencies", content, buttons: { ok: { label: "Save", callback: (h) => res(read(h[0].querySelector("form") || h[0])) }, cancel: { label: "Cancel", callback: () => res(null) } }, default: "ok" }).render(true));
    if (result) await gmSetProficiency(result);
  }
  async function gmGrant(captainCrewId, targetCrewId, byUserId) {
    if (!game.user.isGM) return;
    const next = getCombat(); const cap = next.crew[captainCrewId], tgt = next.crew[targetCrewId];
    if (!cap || !tgt) return;
    const gmActor = !byUserId || game.users.get(byUserId)?.isGM;
    if (!gmActor && cap.controllerUserId !== byUserId) return;
    if (playerSpends(byUserId) && getState().power.cur < S.ACTION_POWER.grant)
      return notifyUser(byUserId, `Not enough power to Grant (need ${S.ACTION_POWER.grant} — convert fuel to power first).`);
    if (!tryConsume(cap, "action")) return notifyUser(byUserId || game.user.id, "You've no Main action left to Grant.");
    tgt.granted = (tgt.granted || 0) + 1;
    await saveCombat(next);
    await gmSpendPower(byUserId, S.ACTION_POWER.grant);
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
    if (!S.systemWorks(ship, "shields")) return notifyUser(who, "The Shield Generator is down — can't allocate shields.");
    const power = playerSpends(byUserId) ? (slot === "secondary" ? S.ACTION_POWER.micro : S.ACTION_POWER.allocate) : 0;
    if (power > 0 && ship.power.cur < power) return notifyUser(who, `Not enough power — shields need ${power} (convert fuel to power first).`);
    const which = slot === "secondary" ? "bonus" : "action";
    if (!tryConsume(c, which)) return notifyUser(who, `No ${which === "bonus" ? "Bonus" : "Main"} action left.`);
    if (slot === "secondary") ship.shield.secondary = facing;
    else { ship.shield.on = true; ship.shield.facing = facing; }
    if (power > 0) ship.power.cur = Math.max(0, ship.power.cur - power);
    await setState(ship); await saveCombat(combat);
    const stn = S.station("shields_officer")?.name || "Shields Officer";
    await ChatMessage.create({ content: `<b>${esc(stn)}</b> · ${esc(c.name)} — ${slot === "secondary" ? "secondary" : "main"} shield → <b>${esc(S.FACING_LABEL[facing].toUpperCase())}</b>`, speaker: { alias: "SSV Silver Gull" } });
  }

  // GM Actions — direct shield allocation (no crew action economy); always announces in chat.
  // Placing a side turns that shield on; clicking the already-lit side turns it off / clears it.
  async function gmSetMainShieldDirect(facing) {
    if (!game.user.isGM || !S.FACINGS.includes(facing)) return;
    const ship = getState();
    if (ship.shield.on && ship.shield.facing === facing) {
      ship.shield.on = false; await setState(ship);
      await ChatMessage.create({ content: `<b>GM</b> — main shields <b>OFFLINE</b>`, speaker: { alias: "SSV Silver Gull" } });
    } else {
      ship.shield.on = true; ship.shield.facing = facing; await setState(ship);
      await ChatMessage.create({ content: `<b>GM</b> — main shield → <b>${esc(S.FACING_LABEL[facing].toUpperCase())}</b>`, speaker: { alias: "SSV Silver Gull" } });
    }
  }
  async function gmSetSecondaryDirect(facing) {
    if (!game.user.isGM || !S.FACINGS.includes(facing)) return;
    const ship = getState();
    if (ship.shield.secondary === facing) {
      ship.shield.secondary = null; await setState(ship);
      await ChatMessage.create({ content: `<b>GM</b> — secondary shield <b>cleared</b>`, speaker: { alias: "SSV Silver Gull" } });
    } else {
      ship.shield.secondary = facing; await setState(ship);
      await ChatMessage.create({ content: `<b>GM</b> — secondary shield → <b>${esc(S.FACING_LABEL[facing].toUpperCase())}</b>`, speaker: { alias: "SSV Silver Gull" } });
    }
  }

  // Roll dialog: pull the ability mod from the acting player's dnd5e sheet, or manual total.
  async function stationRoll(a, crew, stName) {
    const abil = a.ability, abilLabel = abil ? abil.toUpperCase() : "";
    const dcTxt = a.dc != null ? `DC ${a.dc}` : "a GM-set DC (usually 12–18)";
    const actor = game.user.character;
    const mod = actor?.system?.abilities?.[abil]?.mod;
    const hasMod = Number.isFinite(mod);
    // Proficiency: if the GM marked this crew proficient in their station's rolls, add their prof bonus.
    const profOn = !!crew?.prof?.[crew?.station];
    const rawProf = actor?.system?.attributes?.prof;
    const prof = (profOn && Number.isFinite(rawProf)) ? rawProf : 0;
    const bonusExpr = `${mod}${prof ? ` + ${prof}` : ""}`;
    const content = `<div style="display:flex;flex-direction:column;gap:8px;min-width:300px;">` +
      `<p style="opacity:.85">${esc(a.text)}</p><p>${abilLabel} check vs ${dcTxt}.</p>` +
      (hasMod ? `<p>Sheet: <b>${esc(actor.name)}</b> · ${abilLabel} <b>${mod >= 0 ? "+" : ""}${mod}</b>${prof ? ` · proficient <b>+${prof}</b>` : ""}</p>` : `<p><i>No linked character — enter your total.</i></p>`) +
      `<label>Manual total: <input type="number" name="total" placeholder="d20 + mods" style="width:90px"/></label></div>`;
    const D = D2();
    let choice = "cancel", form = null;
    if (D) {
      const buttons = [];
      if (hasMod) buttons.push({ action: "roll", label: `Roll 1d20 + ${bonusExpr}`, default: true, callback: (e, b) => { form = b.form; return "roll"; } });
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
    if (choice === "roll") { rollObj = await (new Roll(`1d20 + ${bonusExpr}`)).evaluate(); total = rollObj.total; }
    else { total = Number(form?.elements?.total?.value); if (!Number.isFinite(total)) { ui.notifications?.warn("Enter a number for your total."); return false; } }
    const pass = a.dc != null ? (total >= a.dc ? ` — <b style="color:#42d16a">SUCCESS</b>` : ` — <b style="color:#e0454d">FAIL</b>`) : "";
    const breakdown = (choice === "roll") ? ` <span style="opacity:.6">(${abilLabel} ${mod >= 0 ? "+" : ""}${mod}${prof ? ` · prof +${prof}` : ""})</span>` : "";
    const body = `<div><b>${esc(stName)}</b> · ${esc(crew.name)}<br>${esc(a.name)} — <b>${total}</b>${pass}${breakdown}<br><span style="opacity:.7">${esc(a.text)}</span></div>`;
    await ChatMessage.create({ content: body, speaker: { alias: "SSV Silver Gull" }, rolls: rollObj ? [rollObj] : undefined });
    return true;
  }
  async function runStationAction(a, isBonus, crew, stName) {
    if (!crew) return;
    // Enforcement: broken Weapons → gunners can't fire.
    if ((crew.station === "gunner_port" || crew.station === "gunner_starboard") && ["attack", "called", "launch"].includes(a.id) && !S.systemWorks(getState(), "weapons")) {
      ui.notifications?.warn("Weapons are down — the gun can't fire until it's repaired.");
      return;
    }
    // Pilot maneuvers/reposition are driven from the turn-bar panel. If clicked in the full console, route the
    // maneuver to the real handler (so it grants Movement Points) instead of burning the Main action on a no-op note.
    if (crew.station === "pilot") {
      if (S.MANEUVERS[a.id]) {
        if (game.user.isGM) gmPilotManeuver(crew.id, a.id, null);
        else emit({ type: "pilotManeuver", toGM: true, crewId: crew.id, maneuver: a.id, userId: game.user.id });
        return;
      }
      if (a.id === "reposition") { ui.notifications?.info("Use the ⟲ / ↑ Fwd / ⟳ buttons in the turn bar to move — repositioning spends Movement Points, not an action."); return; }
    }
    // Power check (players only; the GM acts for free). Block up-front so a powered action can't run on empty.
    const power = S.actionPower(a);
    if (!game.user.isGM && power > 0 && S.normalize(getState()).power.cur < power) {
      ui.notifications?.warn(`Not enough power — ${a.name} needs ${power} (convert fuel to power first).`);
      return;
    }
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
    // Engineer Repair: pick a system → d20+INT → nat20/nat1/puzzle → +2 HP. Manages its own consume.
    if (a.type === "repair") { await runRepair(crew, isBonus); return; }
    // Science Nav Support: play the nav mini-game → set the Pilot's Movement-Point multiplier. Own consume.
    if (a.type === "navsupport") { await runNavSupport(crew, isBonus); return; }
    if (a.type === "scan") { await runScan(crew, isBonus); return; }
    if (a.type === "rally") { await runBuffCrew(crew, isBonus, "rally"); return; }
    if (a.type === "command") { await runBuffCrew(crew, isBonus, "command"); return; }
    if (a.type === "reroute") { await runReroute(crew, isBonus); return; }
    if (a.type === "patch") { await runPatch(crew, isBonus); return; }
    if (a.type === "ping") { await runPing(crew, isBonus); return; }
    if (a.type === "ram") { await runRam(crew, isBonus); return; }
    if (a.type === "flee") { await runFlee(crew, isBonus); return; }
    if (a.type === "cloak") { await runCloak(crew, isBonus, a.cloak); return; }
    if (a.type === "turret") { await runTurret(crew, isBonus, a.turret); return; }
    if (a.type === "adjust") { await runAdjustAim(crew, isBonus); return; }
    let ok = true;
    if (a.type === "roll") ok = await stationRoll(a, crew, stName);
    else await ChatMessage.create({ content: `<b>${esc(stName)}</b> · ${esc(crew.name)} — ${esc(a.name)}<br><span style="opacity:.7">${esc(a.text)}</span>`, speaker: { alias: "SSV Silver Gull" } });
    if (!ok) return;
    const which = isBonus ? "bonus" : "action";
    if (game.user.isGM) gmConsume(crew.id, which, null, 0);
    else emit({ type: "consume", toGM: true, crewId: crew.id, which, userId: game.user.id, power });
  }

  // Engineer Repair: pick a damaged system → d20+INT → nat 20/1 auto → else timed puzzle → +2 HP.
  async function runRepair(crew, isBonus) {
    const st = getState();
    const repairable = S.SYSTEMS.filter((s) => s.installed !== false)
      .map((s) => ({ id: s.id, label: s.label, hp: st.systemHp?.[s.id] }))
      .filter((s) => s.hp && s.hp.cur > 0 && s.hp.cur < s.hp.max);
    if (!repairable.length) return ui.notifications?.info("No damaged systems to repair (destroyed systems can't be repaired).");
    const systemId = await chooseDlg("Repair System", "Which system are you repairing?", repairable.map((s) => ({ value: s.id, label: `${s.label} (${s.hp.cur}/${s.hp.max})` })));
    if (!systemId) return;   // cancelled → no action spent
    const sysLabel = S.SYSTEMS.find((s) => s.id === systemId)?.label || systemId;
    const consume = () => { const which = isBonus ? "bonus" : "action"; if (game.user.isGM) gmConsume(crew.id, which, null); else emit({ type: "consume", toGM: true, crewId: crew.id, which, userId: game.user.id }); };
    const doRepair = () => { if (game.user.isGM) gmRepairSystem(systemId, null); else emit({ type: "repairSystem", toGM: true, systemId, userId: game.user.id }); };
    const actor = game.user.character;
    const intMod = Number(actor?.system?.abilities?.int?.mod) || 0;
    const roll = await (new Roll(`1d20 + ${intMod}`)).evaluate();
    const die = roll.dice?.[0]?.results?.[0]?.result ?? (roll.total - intMod);
    const total = roll.total;
    const announce = async (win) => {
      const color = win ? "#42d16a" : "#e0454d", label = win ? "REPAIRED +2 HP" : "REPAIR FAILED";
      await ChatMessage.create({ content: `<b>Engineer</b> · ${esc(crew.name)} — Repair <b>${esc(sysLabel)}</b>: d20+INT = <b>${total}</b> (die ${die}) — <b style="color:${color}">${label}</b>`, speaker: { alias: "SSV Silver Gull" }, rolls: [roll] });
    };
    consume();   // attempting the repair spends the Main action
    if (die === 20) { doRepair(); return announce(true); }
    if (die === 1) { return announce(false); }
    const timeMs = Math.round(Math.max(10, Math.min(35, 8 + total)) * 1000);   // roll total → puzzle time
    S.openRepairPuzzle(systemId, {
      timeMs,
      onSolve: () => { doRepair(); announce(true); },
      onFail: () => { announce(false); }
    });
  }

  // Science → Nav Support: play the nav mini-game, then set the Pilot's Movement-Point multiplier.
  async function runNavSupport(crew, isBonus) {
    const pilot = Object.values(getCombat().crew).find((c) => c.station === "pilot");
    if (!pilot) return ui.notifications?.info("No pilot aboard — Nav Support has no one to help.");
    const navPower = S.ACTION_POWER.navsupport || 0;
    const consume = () => { const which = isBonus ? "bonus" : "action"; if (game.user.isGM) gmConsume(crew.id, which, null, 0); else emit({ type: "consume", toGM: true, crewId: crew.id, which, userId: game.user.id, power: navPower }); };
    S.openNavGame({
      onDone: (perf) => {
        const mult = Math.round((1.5 + Math.max(0, Math.min(1, perf))) * 100) / 100;   // ×1.5 … ×2.5
        consume();   // spent only once the mini-game is actually played
        if (game.user.isGM) gmNavSupport(mult, null); else emit({ type: "navSupport", toGM: true, mult, userId: game.user.id });
      },
      onCancel: () => {}   // aborted → no action spent
    });
  }

  /* ---- Gunner: pick a gun in the turn bar, then Fire / Called Shot / Boarding Fire ---- */
  const signMod = (n) => (n >= 0 ? "+" + n : String(n));
  const strMod = () => Number(game.user.character?.system?.abilities?.str?.mod) || 0;
  const isGunner = (c) => c && (c.station === "gunner_port" || c.station === "gunner_starboard");
  // Consume one of the acting crew's action slots + the given power (GM acts free).
  // Returns a promise so callers that write combat state straight afterwards can
  // await it. Without that, the caller's own getCombat() read races the consume's
  // write and the second save silently puts the spent action back.
  function consumeSlot(crew, which, power) {
    if (game.user.isGM) return gmConsume(crew.id, which, null, 0);
    emit({ type: "consume", toGM: true, crewId: crew.id, which, userId: game.user.id, power });
    return Promise.resolve();
  }
  // The acting crew still has a Main action (or a granted extra) to spend.
  const hasMain = (crew) => !crew.action || (crew.granted > 0);

  // GM: the gunner selected which gun (or "back" → null). Persists in combat state so the panel syncs.
  async function gmSelectGun(crewId, gun, byUserId) {
    if (!game.user.isGM) return;
    const next = getCombat(); const c = next.crew[crewId]; if (!isGunner(c)) return;
    const gmActor = !byUserId || game.users.get(byUserId)?.isGM;
    if (!gmActor && c.controllerUserId !== byUserId) return;
    c.gun = S.gun(gun) ? gun : null;
    await saveCombat(next);
  }
  // GM: a Called-Shot natural 1 backfires — 1 damage to our own Weapons / Turrets.
  async function gmWeaponsMishap(byUserId) {
    if (!game.user.isGM) return;
    if (!controlsStation(byUserId, "gunner_port") && !controlsStation(byUserId, "gunner_starboard")) return;
    const st = getState(); const hp = st.systemHp?.weapons; if (!hp) return;
    hp.cur = Math.max(0, hp.cur - 1); st.systems.weapons = S.systemState(hp);
    await setState(st);
  }

  // Roll-or-manual to-hit: adds the gun's to-hit + STR + other bonuses (+ optional Quick Aim). Returns
  // {die,total,bonus,quickAim,roll} or null.
  async function gunToHitDialog(crew, gun, str, opts) {
    opts = opts || {};
    const aimPw = S.ACTION_POWER.quickaim, atkPw = S.ACTION_POWER.attack;
    const canAim = !opts.noAim && !crew.bonus && (game.user.isGM || S.normalize(getState()).power.cur >= atkPw + aimPw);
    const aimRow = opts.noAim ? "" :
      `<label style="display:flex;gap:6px;align-items:center;${canAim ? "" : "opacity:.5"}"><input type="checkbox" name="aim" ${canAim ? "" : "disabled"}/> Quick Aim: +${S.QUICK_AIM_BONUS} to hit — spends your Bonus action${aimPw ? ` · ${aimPw}⚡` : ""}${crew.bonus ? " (no Bonus left)" : ""}</label>`;
    const content = `<div style="display:flex;flex-direction:column;gap:8px;">` +
      `<p style="margin:0;opacity:.8">${esc(gun.label)} <b>+${gun.toHit}</b> and STR <b>${signMod(str)}</b> are added automatically.</p>${aimRow}` +
      `<label>Other bonuses (Rally, range −5, granted buffs…) <input type="number" name="bonus" value="0" style="width:70px"/></label>` +
      `<label>Manual d20 (if not rolling here) <input type="number" name="die" min="1" max="20" placeholder="1–20" style="width:70px"/></label></div>`;
    const read = (f) => ({ aim: !!f.elements.aim?.checked, bonus: Number(f.elements.bonus?.value) || 0, die: f.elements.die?.value !== "" ? Number(f.elements.die.value) : null });
    const choice = await rollChoiceDialog(`To-Hit — ${gun.label}`, content, "🎲 Roll 1d20", "Use manual d20");
    if (!choice) return null;
    const v = read(choice.form);
    let die, roll = null;
    if (choice.action === "roll") { roll = await (new Roll("1d20")).evaluate(); die = roll.dice?.[0]?.results?.[0]?.result ?? roll.total; }
    else { if (!Number.isFinite(v.die)) { ui.notifications?.warn("Enter your d20 result (1–20)."); return null; } die = Math.max(1, Math.min(20, v.die)); }
    const quickAim = v.aim && canAim;
    return { die, total: die + gun.toHit + str + v.bonus + (quickAim ? S.QUICK_AIM_BONUS : 0), bonus: v.bonus, quickAim, roll };
  }
  // Roll-or-manual damage: formula (default = the gun's die) + STR + other bonuses. Returns {total,formula,bonus,roll} or null.
  async function gunDamageDialog(defaultFormula, str) {
    const dflt = defaultFormula || "2d6";
    const content = `<div style="display:flex;flex-direction:column;gap:8px;">` +
      `<p style="margin:0;opacity:.8">STR mod <b>${signMod(str)}</b> is added automatically.</p>` +
      `<label>Damage dice <input type="text" name="f" value="${esc(dflt)}" style="width:90px"/></label>` +
      `<label>Other bonuses <input type="number" name="bonus" value="0" style="width:70px"/></label>` +
      `<label>Manual dice total (if not rolling) <input type="number" name="manual" placeholder="dice only" style="width:90px"/></label></div>`;
    const read = (f) => ({ f: (f.elements.f?.value || dflt).trim(), bonus: Number(f.elements.bonus?.value) || 0, manual: f.elements.manual?.value !== "" ? Number(f.elements.manual.value) : null });
    const choice = await rollChoiceDialog("Damage", content, "🎲 Roll damage", "Use manual total");
    if (!choice) return null;
    const v = read(choice.form);
    let base, roll = null, formula;
    if (choice.action === "roll") { try { roll = await (new Roll(v.f || dflt)).evaluate(); } catch (e) { ui.notifications?.warn("Bad dice formula."); return null; } base = roll.total; formula = v.f; }
    else { if (!Number.isFinite(v.manual)) { ui.notifications?.warn("Enter your dice total."); return null; } base = v.manual; formula = "manual"; }
    return { total: base + str + v.bonus, formula, bonus: v.bonus, roll };
  }
  const gunSpeaker = { alias: "SSV Silver Gull" };
  async function announceGunDamage(gunnerName, gun, dmg, str) {
    await ChatMessage.create({ content: `<b>${esc(gunnerName)}</b> — <b>${esc(gun.label)}</b> damage <b>${dmg.total}</b> <span style="opacity:.6">(${dmg.formula === "manual" ? "manual" : esc(dmg.formula)} · STR ${signMod(str)}${dmg.bonus ? ` · +${dmg.bonus}` : ""})</span><br><i>Apply to the target (enemy ships coming soon).</i>`, speaker: gunSpeaker, rolls: dmg.roll ? [dmg.roll] : undefined });
  }
  // Shared two-button (Roll / Manual) + Cancel dialog. Resolves { action:"roll"|"manual", form } or null.
  async function rollChoiceDialog(title, content, rollLabel, manualLabel) {
    const D = D2(); let form = null, action = null;
    if (D) {
      action = await D.wait({ window: { title }, content, buttons: [
        { action: "roll", label: rollLabel, default: true, callback: (e, b) => { form = b.form; return "roll"; } },
        { action: "manual", label: manualLabel, callback: (e, b) => { form = b.form; return "manual"; } },
        { action: "cancel", label: "Cancel", callback: () => "cancel" }
      ], rejectClose: false }).catch(() => "cancel");
    } else {
      action = await new Promise((res) => new Dialog({ title, content, buttons: {
        roll: { label: rollLabel, callback: (h) => { form = h[0].querySelector("form") || h[0]; res("roll"); } },
        manual: { label: manualLabel, callback: (h) => { form = h[0].querySelector("form") || h[0]; res("manual"); } },
        cancel: { label: "Cancel", callback: () => res("cancel") }
      }, default: "roll", close: () => res("cancel") }).render(true));
    }
    return (action === "roll" || action === "manual") ? { action, form } : null;
  }
  async function promptText(title, label) {
    const content = `<div style="display:flex;flex-direction:column;gap:6px;"><label>${esc(label)}<input type="text" name="t" style="width:100%"/></label></div>`;
    const read = (f) => { const t = (f.elements.t?.value || "").trim(); return t || null; };
    const d = D2();
    if (d) return d.prompt({ window: { title }, content, ok: { label: "OK", callback: (e, b) => read(b.form) } }).catch(() => null);
    return new Promise((res) => new Dialog({ title, content, buttons: { ok: { label: "OK", callback: (h) => res(read(h[0].querySelector("form") || h[0])) }, cancel: { label: "Cancel", callback: () => res(null) } }, default: "ok" }).render(true));
  }

  // Fire: optional Quick Aim (+2, spends Bonus) → to-hit (gun + STR + bonuses) → the GM confirms Hit/Miss → damage.
  async function runGunFire(crewId) {
    const crew = getCombat().crew[crewId]; if (!isGunner(crew)) return;
    if (!S.systemWorks(getState(), "weapons")) return ui.notifications?.warn("Weapons are down — repair them before firing.");
    if (!hasMain(crew)) return ui.notifications?.warn("No Main action left this turn.");
    const gun = S.gun(crew.gun); if (!gun) return ui.notifications?.warn("Pick a gun first.");
    const atkPw = S.ACTION_POWER.attack;
    if (!game.user.isGM && S.normalize(getState()).power.cur < atkPw) return ui.notifications?.warn(`Not enough power — Fire needs ${atkPw} (convert fuel first).`);
    const str = strMod();
    const res = await gunToHitDialog(crew, gun, str);
    if (!res) return;
    await consumeSlot(crew, "action", atkPw);
    if (res.quickAim) await consumeSlot(crew, "bonus", S.ACTION_POWER.quickaim);
    const bd = `${gun.label} +${gun.toHit} · STR ${signMod(str)}${res.quickAim ? ` · Quick Aim +${S.QUICK_AIM_BONUS}` : ""}${res.bonus ? ` · +${res.bonus}` : ""}`;
    await ChatMessage.create({ content: `<b>${esc(stationName(crew.station))}</b> · ${esc(crew.name)} — <b>${esc(gun.label)}</b> Fire<br>To-hit <b>${res.total}</b> (d20 ${res.die}) <span style="opacity:.6">(${bd})</span>`, speaker: gunSpeaker, rolls: res.roll ? [res.roll] : undefined });
    // With a target laid, the shot resolves itself: AC comes from the target's own
    // record and the facing from where the two tokens actually are, so swinging
    // round to an unshielded arc is a mechanic rather than a GM ruling. Without a
    // target — an un-tokened enemy, a narrative shot — the GM still adjudicates.
    const tgt = crew.target && getCombat().ships[crew.target];
    if (tgt && !tgt.outcome) {
      if (game.user.isGM) await gmResolveAgainstShip(crew.id, gun, res, str);
      else { emit({ type: "gunHitCheck", toGM: true, crewId: crew.id, gunnerName: crew.name, gunId: gun.id, total: res.total, die: res.die, str, userId: game.user.id });
        ui.notifications?.info("Shot away."); }
      return;
    }
    if (game.user.isGM) await gmResolveGunHit(crew.name, gun, res.total, str);
    else { emit({ type: "gunHitCheck", toGM: true, gunnerName: crew.name, gunId: gun.id, total: res.total, userId: game.user.id }); ui.notifications?.info("Shot away — waiting for the GM to confirm the hit…"); }
  }
  // GM: was it a hit? (asked on the GM's screen). On hit, damage is rolled — by the GM if the GM fired, else by the shooter.
  async function gmResolveGunHit(gunnerName, gun, total, str) {
    const hit = await chooseDlg("Did it hit?", `<b>${esc(gunnerName)}</b>'s <b>${esc(gun.label)}</b> — to-hit <b>${total}</b>. Did it hit the target?`, [{ value: "hit", label: "✓ Hit — roll damage" }, { value: "miss", label: "✗ Miss" }]);
    if (hit !== "hit") { if (hit === "miss") await ChatMessage.create({ content: `<b>${esc(gunnerName)}</b> — the <b>${esc(gun.label)}</b> shot <b>missed</b>.`, speaker: gunSpeaker }); return; }
    const dmg = await gunDamageDialog(gun.damage, str);
    if (dmg) await announceGunDamage(gunnerName, gun, dmg, str);
  }
  /**
   * Resolve a shot against a real ship: compare to-hit against THAT facing's AC,
   * roll damage, and apply it. No dialog — the numbers are all on the table.
   */
  async function gmResolveAgainstShip(crewId, gun, res, str) {
    if (!game.user.isGM) return;
    const combat = getCombat();
    const crew = combat.crew[crewId]; if (!crew) return;
    const sh = combat.ships[crew.target]; if (!sh) return;

    const from = shipPoint("gull"), me = shipPoint(sh.id);
    const facing = from && me ? S.facingFrom(me, from) : "fore";
    const dist = shipDistance("gull", sh.id);
    const range = S.rangePenalty(gun, dist ?? 0);
    if (dist != null && !range.ok) {
      await ChatMessage.create({ content: `<b>${esc(crew.name)}</b> — <b>${esc(sh.name)}</b> is <b>out of range</b> for the ${esc(gun.label)} (${dist} squares, max ${gun.longMax}).`, speaker: gunSpeaker });
      return;
    }
    const ac = S.shipAC(sh, Object.values(sh.crew || {}));
    const total = res.total + range.toHit;
    const hit = total >= ac[facing];
    const crit = res.die === 20;
    const bits = `AC ${ac[facing]} on the ${S.FACING_LABEL[facing]}${range.toHit ? ` · long range ${range.toHit}` : ""}`;

    if (!hit && !crit) {
      // Whiff protection: a miss still strips a shield pip off the arc it struck.
      const next = getCombat(); const t = next.ships[sh.id];
      let note = "";
      if (t && t.shield.on && t.shield.facing === facing) {
        t.shield.on = false;
        S.applyStatus(t, "shields_down", { round: next.round, rounds: 1, src: "grazing hit" });
        await saveCombat(next);
        note = `<br><span style="color:#f2b03d">The round still walks across their ${esc(S.FACING_LABEL[facing])} shield — that facing drops for a round.</span>`;
      }
      await ChatMessage.create({ content: `<b>${esc(crew.name)}</b> — <b>${esc(gun.label)}</b> vs <b>${esc(sh.name)}</b>: <b>${total}</b> vs ${bits} — <b>miss</b>.${note}`, speaker: gunSpeaker });
      refreshUI();
      return;
    }

    const rail = getCombat().gunBuff;
    const dmgRoll = await new Roll(`${gun.damage} + ${str}${rail ? ` + ${rail}` : ""}`).evaluate();
    let raw = Math.max(1, dmgRoll.total);
    if (rail) {   // one hit only — the Engineer routed it for this shot
      const nx = getCombat(); nx.gunBuff = ""; await saveCombat(nx);
    }
    if (range.halve) raw = Math.floor(raw / 2);
    await ChatMessage.create({
      content: `<b>${esc(crew.name)}</b> — <b>${esc(gun.label)}</b> vs <b>${esc(sh.name)}</b>: <b>${total}</b> vs ${bits} — ` +
               `<b style="color:#42d16a">${crit ? "CRITICAL" : "hit"}</b>${range.halve ? " <span style='opacity:.7'>(halved at long range)</span>" : ""}`,
      speaker: gunSpeaker, rolls: [dmgRoll]
    });
    await gmApplyDamage(sh.id, raw, facing, { crit, type: "kinetic" });
    // A crit lets the gunner knock a system out for free — the statuses and
    // per-system HP already in the model are the crit table.
    if (crit) {
      const next = getCombat(); const t = next.ships[sh.id];
      const live = Object.entries(t.systemHp || {}).filter(([, hp]) => hp.cur > 0);
      if (live.length) {
        const [sysId] = live[Math.floor(Math.random() * live.length)];
        t.systemHp[sysId] = { cur: 0, max: S.SYSTEM_HP_MAX };
        t.systems[sysId] = "destroyed";
        await saveCombat(next);
        await ChatMessage.create({ content: `<b style="color:#f2b03d">Critical</b> — <b>${esc(sh.name)}</b>'s <b>${esc(S.SYSTEMS.find((x) => x.id === sysId)?.label || sysId)}</b> is knocked out.`, speaker: gunSpeaker });
      }
    }
    refreshUI();
  }

  async function gmGunHitCheck(msg) {
    if (!game.user.isGM) return;
    // A player firing at a real target: resolve it for them, no dialog.
    if (msg.crewId && getCombat().crew[msg.crewId]?.target) {
      const gun = S.gun(msg.gunId); if (!gun) return;
      return gmResolveAgainstShip(msg.crewId, gun, { total: msg.total, die: msg.die ?? 0 }, msg.str ?? 0);
    }
    const gun = S.gun(msg.gunId) || { label: "Gun", damage: "2d6" };
    const hit = await chooseDlg("Did it hit?", `<b>${esc(msg.gunnerName)}</b>'s <b>${esc(gun.label)}</b> — to-hit <b>${msg.total}</b>. Did it hit the target?`, [{ value: "hit", label: "✓ Hit" }, { value: "miss", label: "✗ Miss" }]);
    if (hit === "hit") emit({ type: "gunDoDamage", toUser: msg.userId, gunnerName: msg.gunnerName, gunId: msg.gunId });
    else if (hit === "miss") await ChatMessage.create({ content: `<b>${esc(msg.gunnerName)}</b> — the <b>${esc(gun.label)}</b> shot <b>missed</b>.`, speaker: gunSpeaker });
  }
  // Player side: the GM confirmed a hit → roll damage here (uses this player's STR).
  async function runGunDamageRoll(gunnerName, gun) {
    const str = strMod();
    const dmg = await gunDamageDialog(gun.damage, str);
    if (dmg) await announceGunDamage(gunnerName, gun, dmg, str);
  }
  // Called Shot: pick an enemy system → to-hit; nat 20 = 2 dmg, nat 1 = 1 dmg to our Weapons, else 1 dmg.
  async function runCalledShot(crewId) {
    const crew = getCombat().crew[crewId]; if (!isGunner(crew)) return;
    if (!S.systemWorks(getState(), "weapons")) return ui.notifications?.warn("Weapons are down — repair them before firing.");
    if (!hasMain(crew)) return ui.notifications?.warn("No Main action left this turn.");
    const gun = S.gun(crew.gun); if (!gun) return ui.notifications?.warn("Pick a gun first.");
    const calledPw = S.ACTION_POWER.called;
    if (!game.user.isGM && S.normalize(getState()).power.cur < calledPw) return ui.notifications?.warn(`Not enough power — Called Shot needs ${calledPw} (convert fuel first).`);
    const opts = S.SYSTEMS.filter((s) => s.installed !== false).map((s) => ({ value: s.id, label: s.label }));
    opts.push({ value: "__other", label: "Other system (GM specifies)…" });
    const target = await chooseDlg("Called Shot", "Which enemy system are you targeting?", opts);
    if (!target) return;
    let targetLabel = S.SYSTEMS.find((s) => s.id === target)?.label || null;
    if (target === "__other") { targetLabel = await promptText("Called Shot — target", "Name the system you're targeting"); if (!targetLabel) return; }
    const str = strMod();
    const res = await gunToHitDialog(crew, gun, str, { noAim: true });   // Called Shot: no Quick Aim
    if (!res) return;
    await consumeSlot(crew, "action", calledPw);
    let outcome, apply = "";
    if (res.die === 20) { outcome = `<b style="color:#42d16a">CRITICAL — 2 damage</b> to <b>${esc(targetLabel)}</b>`; apply = `<br><i>Apply 2 to the enemy system (enemy ships coming soon).</i>`; }
    else if (res.die === 1) { outcome = `<b style="color:#e0454d">MISFIRE — 1 damage to your own Weapons / Turrets</b>`; }
    else { outcome = `<b>1 damage</b> to <b>${esc(targetLabel)}</b>`; apply = `<br><i>Apply 1 to the enemy system (enemy ships coming soon).</i>`; }
    await ChatMessage.create({ content: `<b>${esc(stationName(crew.station))}</b> · ${esc(crew.name)} — <b>${esc(gun.label)}</b> Called Shot on <b>${esc(targetLabel)}</b><br>To-hit <b>${res.total}</b> (d20 ${res.die}) — ${outcome}${apply}`, speaker: gunSpeaker, rolls: res.roll ? [res.roll] : undefined });
    if (res.die === 1) { if (game.user.isGM) gmWeaponsMishap(null); else emit({ type: "weaponsMishap", toGM: true, userId: game.user.id }); }
  }
  // Boarding Fire: placeholder — spends the Main action and announces a launch (full boarding flow comes later).
  async function runBoardingFire(crewId) {
    const crew = getCombat().crew[crewId]; if (!isGunner(crew)) return;
    if (!hasMain(crew)) return ui.notifications?.warn("No Main action left this turn.");
    const launchPw = S.ACTION_POWER.launch;
    if (!game.user.isGM && S.normalize(getState()).power.cur < launchPw) return ui.notifications?.warn(`Not enough power — Boarding Fire needs ${launchPw} (convert fuel first).`);
    await consumeSlot(crew, "action", launchPw);
    const gun = S.gun(crew.gun);
    await ChatMessage.create({ content: `<b>${esc(stationName(crew.station))}</b> · ${esc(crew.name)} launches a boarder from the <b>${esc(gun?.label || "gun")}</b> at the enemy hull! 🚀<br><i>Boarding resolves later — GM adjudicates for now.</i>`, speaker: gunSpeaker });
  }

  async function gmRepairSystem(systemId, byUserId) {
    if (!game.user.isGM) return;
    if (!controlsStation(byUserId, "engineer")) return notifyUser(byUserId || game.user.id, "Only the Engineer can repair systems.");
    const st = getState(); const hp = st.systemHp?.[systemId]; if (!hp) return;
    if (hp.cur <= 0) return notifyUser(byUserId || game.user.id, "That system is destroyed and can't be repaired.");
    hp.cur = Math.min(hp.max, hp.cur + 2);
    st.systems[systemId] = S.systemState(hp);
    await setState(st);
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
  function onSocket(msg, senderId) {
    if (!msg || typeof msg !== "object") return;
    // socket.io hands us the SERVER's view of who sent this, and it cannot be
    // spoofed. Every gm* handler below authorises against msg.userId, so trusting
    // the id in the payload let any player drive another crew's turn, spend their
    // action, or fire their gun. Take the server's word over the payload's.
    if (senderId && msg.userId && senderId !== msg.userId) {
      return console.warn(`${MODULE_ID} | dropped a message claiming to be from someone else`, msg);
    }
    if (senderId) msg.userId = senderId;
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
      case "consume":        gmConsume(msg.crewId, msg.which, msg.userId, msg.power); break;
      case "grantAction":    gmGrant(msg.captainCrewId, msg.targetCrewId, msg.userId); break;
      case "pilotManeuver":  gmPilotManeuver(msg.crewId, msg.maneuver, msg.userId); break;
      case "pilotMove":      gmPilotMove(msg.crewId, msg.kind, msg.userId); break;
      case "selectGun":      gmSelectGun(msg.crewId, msg.gun, msg.userId); break;
      case "selectTarget":   gmSelectTarget(msg.crewId, msg.shipId, msg.userId); break;
      case "applyScan":      gmApplyScan(msg.shipId, msg.result, msg.gunnerName, { total: msg.total, die: msg.die }, msg.painted); break;
      case "buffCrew":       gmBuffCrew(msg.crewId, msg.kind, msg.byName); break;
      case "reroute":        gmReroute(msg.rail, msg.crewId, msg.byName); break;
      case "patch":          gmPatch(msg.pick, msg.byName); break;
      case "ram":            gmRam(msg.shipId, msg.byName); break;
      case "spool":          gmSpool({ total: msg.total, die: msg.die }, msg.byName); break;
      case "cloak":          gmCloak(msg.which, msg.byName); break;
      case "turretShot":     gmTurretShot(msg.crewId, msg.turretId, msg.shipId, { total: msg.total, die: msg.die }, msg.str); break;
      case "adjustAim":      gmAdjustAim(msg.crewId, msg.byName); break;
      case "applyDamage":    gmApplyDamage(msg.shipId, msg.raw, msg.facing, msg.opts || {}); break;
      case "weaponsMishap":  gmWeaponsMishap(msg.userId); break;
      case "gunHitCheck":    gmGunHitCheck(msg); break;
      case "gunDoDamage":    runGunDamageRoll(msg.gunnerName, S.gun(msg.gunId) || { label: "Gun", damage: "2d6" }); break;
      case "repairSystem":   gmRepairSystem(msg.systemId, msg.userId); break;
      case "navSupport":     gmNavSupport(msg.mult, msg.userId); break;
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
      next.crew[m.id] = { id: m.id, name: m.name, ownerUserId: m.userId || "", controllerUserId: m.userId || game.user.id, station: "", action: false, bonus: false, granted: 0, maneuver: null, mp: 0, mpMax: 0, navMult: 1, gun: null, prof: { ...(m.prof || {}) } };   // carried over from the roster, so it survives end/start of combat
    }
    await saveCombat(next);
    emit({ type: "pickPrompt" });
    ui.notifications?.info("Ship combat started — players, pick your station.");
  }
  async function endCombat() {
    if (!game.user.isGM) return;
    // Take the enemy ships, their tokens and their actors with it — otherwise the
    // world quietly accumulates a folder of every hull ever spawned.
    await gmClearFleet({ silent: true });
    const next = getCombat();
    next.active = false; next.crew = {}; next.pendingSwap = null;
    next.ships = {}; next.initiative = []; next.activeShip = "gull"; next.round = 1;
    await saveCombat(next);
  }
  async function nextTurn() {
    if (!game.user.isGM) return;
    const next = getCombat();
    for (const c of Object.values(next.crew)) {
      c.action = false; c.bonus = false; c.granted = 0; c.maneuver = null; c.mp = 0; c.mpMax = 0; c.navMult = 1; c.gun = null;
      c.buff = { flat: 0, adv: false, die: "" };   // Rally, Command and Reroute last one round
    }
    next.gunBuff = "";
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
    next.crew[cid] = { id: cid, name: m.name, ownerUserId: m.userId || "", controllerUserId: m.userId || game.user.id, station: "", action: false, bonus: false, granted: 0, maneuver: null, mp: 0, mpMax: 0, navMult: 1, gun: null, prof: { ...(m.prof || {}) } };
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
        roster.push({ id: m.id, name: nm, userId: form.elements["user_" + i]?.value || "", prof: { ...(m.prof || {}) } });
      });
      const nn = (form.elements["name_new"]?.value || "").trim();
      if (nn) roster.push({ id: newId(), name: nn, userId: form.elements["user_new"]?.value || "", prof: {} });
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
    pilotManeuver: (crewId, id) => { if (game.user.isGM) gmPilotManeuver(crewId, id, null); else emit({ type: "pilotManeuver", toGM: true, crewId, maneuver: id, userId: game.user.id }); },
    pilotMove: (crewId, kind) => { if (game.user.isGM) gmPilotMove(crewId, kind, null); else emit({ type: "pilotMove", toGM: true, crewId, kind, userId: game.user.id }); },
    selectGun: (crewId, gun) => { if (game.user.isGM) gmSelectGun(crewId, gun, null); else emit({ type: "selectGun", toGM: true, crewId, gun, userId: game.user.id }); },
    gunFire: (crewId) => runGunFire(crewId),
    calledShot: (crewId) => runCalledShot(crewId),
    boardingFire: (crewId) => runBoardingFire(crewId),
    pickTarget: (crewId) => pickTargetDialog(crewId),
    // One list per distinct gun in use, so each gunner's panel shows the range
    // band for THEIR gun rather than a generic distance.
    get targets() {
      const combat = getCombat();
      const guns = [...new Set(Object.values(combat.crew).filter((c) => c.gun).map((c) => c.gun))];
      return targetList(S.gun(guns[0]) || null);
    },
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
    // Both full-screen views carry their own seat/action UI, and the bar sits at a
    // higher z-index than either, so it would otherwise draw straight over them.
    if (consoleOpen() || fleetOpen()) { _bar.style.display = "none"; return; }
    _bar.style.display = "";
    try { S.renderTracker(_bar, combatCtx()); } catch (e) { console.error(`${MODULE_ID} | tracker render failed`, e); }
  }

  /* -- Hooks ------------------------------------------------------------- */

  // onChange fires on every client when a world setting replicates → our cross-client refresh.
  // Both the bar AND the console read combat + ship state, so refresh both on either change.
  // A single action can write both settings and replicate to every client, so a burst of
  // onChange calls used to mean several full rebuilds of the bar + console + gun cone.
  // Coalesce them into one render on the next frame; the end state is identical.
  // Module scope, not inside init(): every GM handler needs to call it too.
  let _uiQueued = false;
  function refreshUI() {
    if (_uiQueued) return;
    _uiQueued = true;
    requestAnimationFrame(() => {
      _uiQueued = false;
      renderBar(); refreshOpen(); refreshFleet();
      try { drawGunCone(); } catch (e) {}
    });
  }

  Hooks.once("init", () => {
    game.settings.register(MODULE_ID, SETTING_DATA, { scope: "world", config: false, type: Object, default: {}, onChange: refreshUI });
    game.settings.register(MODULE_ID, SETTING_COMBAT, { scope: "world", config: false, type: Object, default: {}, onChange: refreshUI });
    game.keybindings.register(MODULE_ID, "open", {
      name: game.i18n?.localize(`${MODULE_ID}.keybind.open.name`) || "Open Ship Overview HUD",
      hint: game.i18n?.localize(`${MODULE_ID}.keybind.open.hint`) || "Opens the SSV Silver Gull ship-combat overview.",
      editable: [{ key: "KeyS" }],
      onDown: () => { openShipHUD(); return true; }
    });
    // F is core's `rulerWaypoint`. Registering at PRIORITY wins the key, and
    // `restricted` keeps it GM-only — so players keep ruler waypoints untouched
    // and only the GM trades F for the fleet board. Rebindable in Configure Controls.
    game.keybindings.register(MODULE_ID, "fleet", {
      name: "Open Fleet Command",
      hint: "Every ship in the engagement, and the panel to spawn more. GM only. F is also core's ruler-waypoint key, so this is registered at priority.",
      editable: [{ key: "KeyF" }],
      restricted: true,
      precedence: CONST.KEYBINDING_PRECEDENCE?.PRIORITY ?? 0,
      onDown: () => { openFleet(); return true; }
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

  /**
   * Say so when the browser is running a cached copy of an older release.
   *
   * Foundry serves scripts from a stable path, so a browser will happily keep
   * yesterday's file after an update — and old code against new data fails in
   * ways that read as bugs. This compares the version compiled into the loaded
   * script against the manifest the server is actually serving.
   */
  function staleScriptWarning() {
    const running = S.VERSION || "0";
    const declared = game.modules.get(MODULE_ID)?.version || "0";
    if (!S.VERSION || running === declared) return;
    const msg = `Ship Combat: your browser is running v${running} but the server has v${declared}. `
              + `Hard-refresh (Cmd/Ctrl + Shift + R) — until you do, the ship console may misbehave.`;
    console.warn(`${MODULE_ID} | ${msg}`);
    ui.notifications?.error(msg, { permanent: true });
  }

  /* ====================================================================== */
  /*  Fleet Command (key F)                                                 */
  /* ====================================================================== */

  /* ---- Cloaking station -------------------------------------------------- */

  const CLOAK_STATUS = { engage: "cloaked", burst: "cloaked", phase: null, decoy: null, stealth: null };

  async function runCloak(crew, isBonus, which) {
    if (!S.systemWorks(getState(), "cloak"))
      return ui.notifications?.warn("The cloaking generator is offline — repair it first.");
    const pw = S.ACTION_POWER[which] || 0;
    if (!spendCheck(pw)) return;
    await consumeSlot(crew, isBonus ? "bonus" : "action", pw);
    if (game.user.isGM) await gmCloak(which, crew.name);
    else emit({ type: "cloak", toGM: true, which, byName: crew.name, userId: game.user.id });
  }
  async function gmCloak(which, byName) {
    if (!game.user.isGM) return;
    const ship = S.normalize(getState());
    const round = getCombat().round || 1;
    let msg = "";
    if (which === "engage") { S.applyStatus(ship, "cloaked", { round, src: byName }); msg = "The Gull goes dark. Attacks against her have disadvantage until she fires."; }
    else if (which === "burst") { S.applyStatus(ship, "cloaked", { round, src: byName, data: { burst: true } }); msg = "<b>Cloak burst</b> — for one round nothing can target her at all."; }
    else if (which === "phase") { ship.phaseCharges = Math.min(3, (ship.phaseCharges || 0) + 1); msg = `Phase charge banked (<b>${ship.phaseCharges}</b>). The next attack that would hit simply does not.`; }
    else if (which === "decoy") { ship.decoys = Math.min(3, (ship.decoys || 0) + 1); msg = `Decoy away (<b>${ship.decoys}</b> running). The next shot at the Gull hits it instead.`; }
    else if (which === "stealth") { msg = "Their sensors are ghosted — the next scan of the Gull fails outright."; ship.scanBlock = true; }
    await setState(ship);
    await ChatMessage.create({ content: `<b>Cloaking Officer</b> · ${esc(byName)} — ${msg}`, speaker: { alias: "SSV Silver Gull" } });
    refreshUI();
  }

  /* ---- Turret stations --------------------------------------------------- */

  /**
   * A turret shot. Same resolution path as the wing guns — target, range,
   * facing, AC, damage — plus the mount's own signature on a hit.
   */
  async function runTurret(crew, isBonus, turretId) {
    const t = S.turret(turretId); if (!t) return;
    const ship = S.normalize(getState());
    if (!S.turretBuilt(ship, t.id)) return ui.notifications?.warn(`The ${t.name} has not been rebuilt yet.`);
    if (!S.turretOnline(ship, t.id)) return ui.notifications?.warn(`The ${t.name} is offline.`);
    const pw = S.ACTION_POWER.attack;
    if (!spendCheck(pw)) return;

    const hostiles = Object.values(getCombat().ships).filter((s) => s.id !== "gull" && s.disposition !== "ally" && !s.outcome);
    if (!hostiles.length) return ui.notifications?.warn("Nothing to shoot at.");
    const target = hostiles.length === 1 ? hostiles[0].id
      : await chooseDlg(t.name, "Which contact?", hostiles.map((s) => ({ value: s.id, label: `${s.name} — ${shipDistance("gull", s.id) ?? "?"} sq` })));
    if (!target) return;

    const str = strMod();
    const res = await gunToHitDialog(crew, t.gun, str, { noAim: true });
    if (!res) return;
    await consumeSlot(crew, isBonus ? "bonus" : "action", pw);
    if (game.user.isGM) await gmTurretShot(crew.id, t.id, target, res, str);
    else emit({ type: "turretShot", toGM: true, crewId: crew.id, turretId: t.id, shipId: target, total: res.total, die: res.die, str, byName: crew.name, userId: game.user.id });
  }

  async function gmTurretShot(crewId, turretId, shipId, res, str) {
    if (!game.user.isGM) return;
    const t = S.turret(turretId); if (!t) return;
    const combat = getCombat(); const sh = combat.ships[shipId]; if (!sh) return;
    const crew = combat.crew[crewId] || { name: "Gunner" };
    const from = shipPoint("gull"), me = shipPoint(shipId);
    const facing = from && me ? S.facingFrom(me, from) : "fore";
    const dist = shipDistance("gull", shipId);
    const range = S.rangePenalty(t.gun, dist ?? 0);
    if (dist != null && !range.ok) {
      await ChatMessage.create({ content: `<b>${esc(t.name)}</b> — <b>${esc(sh.name)}</b> is out of range (${dist} sq, max ${t.gun.longMax}).`, speaker: gunSpeaker });
      return;
    }
    const adjust = crew.buff?.turretAim ? 2 : 0;
    const ac = S.shipAC(sh, Object.values(sh.crew || {}));
    const total = res.total + range.toHit + adjust;
    const crit = res.die === 20;
    const hit = total >= ac[facing] || crit;
    const bits = `AC ${ac[facing]} on the ${S.FACING_LABEL[facing]}${range.toHit ? ` · long ${range.toHit}` : ""}${adjust ? ` · Adjust Aim +${adjust}` : ""}`;
    if (!hit) {
      await ChatMessage.create({ content: `<b>${esc(t.name)}</b> · ${esc(crew.name)} vs <b>${esc(sh.name)}</b>: <b>${total}</b> vs ${bits} — <b>miss</b>.`, speaker: gunSpeaker });
      return;
    }
    // Shield-breaker hits harder into a hull that is already open.
    const alreadyDown = S.hasStatus(sh, "shields_down") || !sh.shield.on;
    const bonusDie = (t.signature === "shieldbreak" && alreadyDown) ? " + 1d6" : "";
    const dmgRoll = await new Roll(`${t.gun.damage} + ${str}${bonusDie}`).evaluate();
    let raw = Math.max(1, dmgRoll.total);
    if (range.halve) raw = Math.floor(raw / 2);
    await ChatMessage.create({
      content: `<b>${esc(t.name)}</b> · ${esc(crew.name)} vs <b>${esc(sh.name)}</b>: <b>${total}</b> vs ${bits} — <b style="color:#42d16a">${crit ? "CRITICAL" : "hit"}</b>`,
      speaker: gunSpeaker, rolls: [dmgRoll] });
    await gmApplyDamage(shipId, raw, facing, { crit, type: t.signature === "emp" ? "energy" : "kinetic",
      ignoreArmour: t.signature === "pierce" });
    await gmTurretSignature(t, shipId, crew.name);
    refreshUI();
  }

  /** What each mount does beyond damage. This is why you rebuilt it. */
  async function gmTurretSignature(t, shipId, byName) {
    const next = getCombat(); const sh = next.ships[shipId]; if (!sh) return;
    const round = next.round || 1;
    let note = "";
    switch (t.signature) {
      case "shieldbreak":
        sh.shield.on = false;
        S.applyStatus(sh, "shields_down", { round, rounds: 1, src: t.name });
        note = "Their shields blow out — <b>Shields Down</b>."; break;
      case "freeze":
        S.applyStatus(sh, "frozen", { round, src: t.name });
        note = "Hull frosted — <b>Frozen</b>. The next kinetic hit has advantage and doubles."; break;
      case "emp": {
        const pick = await chooseDlg(t.name, "Which system does the charge take out?",
          [{ value: "engines_disabled", label: "Engines — no movement or maneuver" },
           { value: "shields_down", label: "Shields — the facing drops" }]);
        if (pick) { S.applyStatus(sh, pick, { round, rounds: 1, src: t.name });
          note = pick === "engines_disabled" ? "Their drive dies — <b>Engines Down</b>." : "Their shields drop — <b>Shields Down</b>."; }
        break; }
      case "grapple":
        S.applyStatus(sh, "grappled", { round, rounds: 1, src: t.name });
        note = "Caught in the well — <b>Grappled</b>. No movement, and attacks against them have advantage."; break;
      case "spread": note = "Flak spread — the GM may apply the same roll to two more contacts in the arc."; break;
      case "pierce": note = "Armour-piercing — their plating did nothing."; break;
    }
    await saveCombat(next);
    if (note) await ChatMessage.create({ content: `<b>${esc(t.name)}</b> — ${note}`, speaker: gunSpeaker });
  }

  /** Adjust Aim: +2 with this mount this round. */
  async function runAdjustAim(crew, isBonus) {
    const pw = S.ACTION_POWER.adjust;
    if (!spendCheck(pw)) return;
    await consumeSlot(crew, isBonus ? "bonus" : "action", pw);
    if (game.user.isGM) await gmAdjustAim(crew.id, crew.name);
    else emit({ type: "adjustAim", toGM: true, crewId: crew.id, byName: crew.name, userId: game.user.id });
  }
  async function gmAdjustAim(crewId, byName) {
    if (!game.user.isGM) return;
    const next = getCombat(); const c = next.crew[crewId]; if (!c) return;
    c.buff = c.buff || {}; c.buff.turretAim = true;
    await saveCombat(next);
    await ChatMessage.create({ content: `<b>${esc(byName)}</b> walks the mount onto the target — <b>+2</b> to hit this round.`, speaker: gunSpeaker });
    refreshUI();
  }

  /* ---- the station actions that used to be chat lines -------------------- */

  const crewChoices = (combat, filter) => Object.values(combat.crew)
    .filter((c) => c.station && (!filter || filter(c)))
    .map((c) => ({ value: c.id, label: `${c.name} — ${S.station(c.station)?.name || c.station}` }));

  /** Captain: Rally (+1) and Command (advantage). Both mark the target crew. */
  async function runBuffCrew(crew, isBonus, kind) {
    const combat = getCombat();
    const opts = crewChoices(combat, (c) => c.id !== crew.id);
    if (!opts.length) return ui.notifications?.warn("Nobody else is at a station.");
    const target = await chooseDlg(kind === "rally" ? "Rally" : "Command", "Who?", opts);
    if (!target) return;
    const pw = S.ACTION_POWER[kind === "rally" ? "rally" : "cmd_adv"];
    if (!spendCheck(pw)) return;
    await consumeSlot(crew, isBonus ? "bonus" : "action", pw);
    if (game.user.isGM) await gmBuffCrew(target, kind, crew.name);
    else emit({ type: "buffCrew", toGM: true, crewId: target, kind, byName: crew.name, userId: game.user.id });
  }
  async function gmBuffCrew(crewId, kind, byName) {
    if (!game.user.isGM) return;
    const next = getCombat(); const t = next.crew[crewId]; if (!t) return;
    t.buff = t.buff || {};
    if (kind === "rally") t.buff.flat = (t.buff.flat || 0) + 1;
    else t.buff.adv = true;
    await saveCombat(next);
    await ChatMessage.create({
      content: `<b>Captain</b> · ${esc(byName)} — ${kind === "rally" ? `<b>Rally</b>: ${esc(t.name)} gets <b>+1</b> on their Main Action.`
        : `<b>Command</b>: ${esc(t.name)} has <b>advantage</b> on their Main Action.`}`,
      speaker: { alias: "SSV Silver Gull" } });
    refreshUI();
  }

  /** Engineer: Reroute Power — three rails, no mishap. */
  async function runReroute(crew, isBonus) {
    const pw = S.ACTION_POWER.reroute;
    if (!spendCheck(pw)) return;
    const rail = await chooseDlg("Reroute Power", "Which rail?", [
      { value: "roll", label: "To a crew member — +1d4 on their next roll" },
      { value: "shields", label: "To the shields — +2 ship AC this round" },
      { value: "guns", label: "To the guns — +1d6 on the next gunner hit" }
    ]);
    if (!rail) return;
    let targetId = null;
    if (rail === "roll") {
      const opts = crewChoices(getCombat());
      targetId = await chooseDlg("Reroute Power", "To whom?", opts);
      if (!targetId) return;
    }
    await consumeSlot(crew, isBonus ? "bonus" : "action", pw);
    if (game.user.isGM) await gmReroute(rail, targetId, crew.name);
    else emit({ type: "reroute", toGM: true, rail, crewId: targetId, byName: crew.name, userId: game.user.id });
  }
  async function gmReroute(rail, crewId, byName) {
    if (!game.user.isGM) return;
    const next = getCombat();
    let msg = "";
    if (rail === "roll" && next.crew[crewId]) {
      const t = next.crew[crewId]; t.buff = t.buff || {}; t.buff.die = "1d4";
      msg = `<b>${esc(t.name)}</b> gets <b>+1d4</b> on their next roll.`;
    } else if (rail === "guns") {
      next.gunBuff = "1d6";
      msg = `The next gunner hit deals <b>+1d6</b>.`;
    }
    await saveCombat(next);
    if (rail === "shields") {
      const ship = getState();
      S.applyStatus(ship, "rerouted", { round: next.round });
      await setState(ship);
      msg = `Shields hardened — <b>+2 ship AC</b> this round.`;
    }
    await ChatMessage.create({ content: `<b>Engineer</b> · ${esc(byName)} — Reroute Power. ${msg}`, speaker: { alias: "SSV Silver Gull" } });
    refreshUI();
  }

  /** Engineer: Patch Job — 1d4 hull, or clear a status. No check. */
  async function runPatch(crew, isBonus) {
    const pw = S.ACTION_POWER.patch;
    if (!spendCheck(pw)) return;
    const ship = S.normalize(getState());
    const bad = (ship.statuses || []).filter((st) => S.STATUSES[st.id]?.kind === "bad");
    const opts = [{ value: "hull", label: "Patch the hull — 1d4 back" },
      ...bad.map((st) => ({ value: `st:${st.id}`, label: `Clear ${S.STATUSES[st.id].label}` }))];
    const pick = await chooseDlg("Patch Job", "What are you patching?", opts);
    if (!pick) return;
    await consumeSlot(crew, isBonus ? "bonus" : "action", pw);
    if (game.user.isGM) await gmPatch(pick, crew.name);
    else emit({ type: "patch", toGM: true, pick, byName: crew.name, userId: game.user.id });
  }
  async function gmPatch(pick, byName) {
    if (!game.user.isGM) return;
    const ship = S.normalize(getState());
    let msg = "";
    if (pick === "hull") {
      const r = await new Roll("1d4").evaluate();
      ship.hull.cur = Math.min(ship.hull.max, ship.hull.cur + r.total);
      msg = `patches <b>${r.total}</b> hull back — now <b>${ship.hull.cur}</b>/${ship.hull.max}.`;
      await setState(ship);
      await ChatMessage.create({ content: `<b>Engineer</b> · ${esc(byName)} — Patch Job: ${msg}`, speaker: { alias: "SSV Silver Gull" }, rolls: [r] });
    } else {
      const id = pick.slice(3);
      S.clearStatus(ship, id);
      await setState(ship);
      await ChatMessage.create({ content: `<b>Engineer</b> · ${esc(byName)} — Patch Job: clears <b>${esc(S.STATUSES[id]?.label || id)}</b>.`, speaker: { alias: "SSV Silver Gull" } });
    }
    refreshUI();
  }

  /** Science: Quick Ping — no roll, one true answer. */
  async function runPing(crew, isBonus) {
    const pw = S.ACTION_POWER.ping;
    if (!spendCheck(pw)) return;
    const q = await promptText("Quick Ping", "One factual question about a contact — the GM answers truthfully");
    if (!q) return;
    await consumeSlot(crew, isBonus ? "bonus" : "action", pw);
    await ChatMessage.create({
      content: `<b>Science / Sensors</b> · ${esc(crew.name)} — <b>Quick Ping</b><br>` +
               `<i>&ldquo;${esc(q)}&rdquo;</i><br><span style="opacity:.7">No roll. The GM answers truthfully.</span>`,
      speaker: { alias: "SSV Silver Gull" } });
    ui.notifications?.info("Quick Ping sent — the GM answers truthfully.");
  }

  /** Captain: Ram. Aggressive, within 3, ignores their shields, a quarter comes back. */
  async function runRam(crew, isBonus) {
    const combat = getCombat();
    const pilot = Object.values(combat.crew).find((c) => c.station === "pilot");
    if (!pilot?.maneuver || pilot.maneuver !== "aggressive")
      return ui.notifications?.warn("The Pilot must be on Aggressive Positioning to ram.");
    const near = Object.values(combat.ships).filter((s) => s.id !== "gull" && !s.outcome
      && (shipDistance("gull", s.id) ?? 99) <= 3);
    if (!near.length) return ui.notifications?.warn("Nothing within 3 squares to ram.");
    const pw = S.ACTION_POWER.bc_ram;
    if (!spendCheck(pw)) return;
    const target = near.length === 1 ? near[0].id
      : await chooseDlg("Ram", "Which hull?", near.map((s) => ({ value: s.id, label: `${s.name} — ${shipDistance("gull", s.id)} sq` })));
    if (!target) return;
    await consumeSlot(crew, isBonus ? "bonus" : "action", pw);
    if (game.user.isGM) await gmRam(target, crew.name);
    else emit({ type: "ram", toGM: true, shipId: target, byName: crew.name, userId: game.user.id });
  }
  async function gmRam(shipId, byName) {
    if (!game.user.isGM) return;
    const combat = getCombat(); const sh = combat.ships[shipId]; if (!sh) return;
    const roll = await new Roll("4d6").evaluate();
    const from = shipPoint("gull"), me = shipPoint(shipId);
    const facing = from && me ? S.facingFrom(me, from) : "fore";
    await ChatMessage.create({
      content: `<b>Captain</b> · ${esc(byName)} — <b>RAM</b> on <b>${esc(sh.name)}</b>. The Gull goes in nose-first.`,
      speaker: { alias: "SSV Silver Gull" }, rolls: [roll] });
    // Ignores their shield facing entirely — that is the whole point of a ram.
    await gmApplyDamage(shipId, roll.total, facing, { ignoreShields: true, type: "kinetic" });
    // The recoil and the commitment go in ONE write. Applying the status in a
    // separate pass raced gmApplyDamage's own read and was silently discarded.
    const back = Math.floor(roll.total / 4);
    await gmApplyDamage("gull", back, "fore", { ignoreShields: true, type: "kinetic",
      alsoStatus: { id: "ramming_committed", src: byName } });
    await ChatMessage.create({ content: `The Gull takes <b>${back}</b> back from the impact, and is <b>committed</b> — no changing course this round.`, speaker: { alias: "SSV Silver Gull" } });
  }

  /** Captain: spool the hyperfold drive. Three successes and the fight is over. */
  async function runFlee(crew, isBonus) {
    const pw = S.ACTION_POWER.bc_flee;
    if (!spendCheck(pw)) return;
    const res = await stationRollValue(crew, "cha", false);
    if (!res) return;
    await consumeSlot(crew, isBonus ? "bonus" : "action", pw);
    if (game.user.isGM) await gmSpool(res, crew.name);
    else emit({ type: "spool", toGM: true, total: res.total, die: res.die, byName: crew.name, userId: game.user.id });
  }
  async function gmSpool(res, byName) {
    if (!game.user.isGM) return;
    const next = getCombat();
    const hit = res.total >= 15;
    next.spool = Math.max(0, Math.min(3, (next.spool || 0) + (hit ? 1 : 0)));
    await saveCombat(next);
    const done = next.spool >= 3;
    await ChatMessage.create({
      content: `<b>Captain</b> · ${esc(byName)} — <b>spooling the hyperfold drive</b>: ${res.total} vs DC 15 — ` +
        `<b style="color:${hit ? "#42d16a" : "#f2b03d"}">${hit ? "one more fold locked in" : "the numbers will not settle"}</b>` +
        `<br>Spool <b>${next.spool}/3</b>.` +
        (done ? `<br><b style="color:#38e1c4">The drive catches. On your next turn the Gull is gone.</b>` : ""),
      speaker: { alias: "SSV Silver Gull" } });
    refreshUI();
  }

  /** Enough power for this action? Players pay, the GM never does. */
  function spendCheck(pw) {
    if (game.user.isGM || !pw) return true;
    if (S.normalize(getState()).power.cur >= pw) return true;
    ui.notifications?.warn(`Not enough power — that needs ${pw} (convert fuel first).`);
    return false;
  }

  /* ---- Science: Scan ---------------------------------------------------- */

  /**
   * A real scan. Whiff protection is the point: Session 5's roll of 5 returned
   * nothing at all, so the floor here is class + allegiance + hot arc + Painted.
   */
  async function runScan(crew, isBonus) {
    const combat = getCombat();
    const hostiles = Object.values(combat.ships).filter((s) => s.id !== "gull" && s.disposition !== "ally" && !s.outcome);
    if (!hostiles.length) return ui.notifications?.warn("Nothing out there to scan.");
    const pw = S.ACTION_POWER.scan;
    if (!game.user.isGM && S.normalize(getState()).power.cur < pw) return ui.notifications?.warn(`Not enough power — Scan needs ${pw}.`);

    const chosen = hostiles.length === 1 ? hostiles[0].id : await chooseDlg(
      "Scan", "Which contact?", hostiles.map((s) => ({ value: s.id, label: s.name })));
    if (!chosen) return;
    const ship = getCombat().ships[chosen]; if (!ship) return;

    // Painted: a previous failed scan makes this one easier.
    const painted = S.hasStatus(ship, "painted");
    const mod = abilityMod("int");
    const res = await stationRollValue(crew, "int", painted);
    if (!res) return;
    await consumeSlot(crew, isBonus ? "bonus" : "action", pw);

    const result = S.scanResult(res.total - S.SCAN_DC);
    const facing = (() => { const a = shipPoint("gull"), b = shipPoint(ship.id); return a && b ? S.facingFrom(b, a) : null; })();

    if (game.user.isGM) await gmApplyScan(chosen, result, crew.name, res, painted);
    else emit({ type: "applyScan", toGM: true, shipId: chosen, result, gunnerName: crew.name, total: res.total, die: res.die, painted, userId: game.user.id });

    // Show the readout to whoever ran it, straight away.
    setTimeout(() => {
      const after = getCombat().ships[chosen];
      if (after) S.openScan(S.shipView(after, { isGM: game.user.isGM }), result, { facing });
    }, 250);
  }

  async function gmApplyScan(shipId, result, byName, roll, painted) {
    if (!game.user.isGM) return;
    const next = getCombat(); const sh = next.ships[shipId]; if (!sh) return;
    S.applyScan(sh, result);
    if (result.painted) S.applyStatus(sh, "painted", { round: next.round, rounds: 3, src: byName });
    else S.clearStatus(sh, "painted");
    // The firing solution is shared as a status the gunners can see on the card.
    if (result.gunnerAdvantage) S.applyStatus(sh, "painted", { round: next.round, rounds: 1, src: "firing solution", data: { adv: result.gunnerAdvantage } });
    await saveCombat(next);
    await ChatMessage.create({
      content: `<b>Science / Sensors</b> · ${esc(byName)} — scan of <b>${esc(sh.name)}</b>: ` +
               `<b>${roll.total}</b> vs DC ${S.SCAN_DC}${painted ? ` <span style="opacity:.7">(Painted — advantage)</span>` : ""} → ` +
               `<b style="color:${result.margin >= 0 ? "#38e1c4" : "#f2b03d"}">${esc(result.label)}</b>, confidence ${result.confidence}%` +
               (result.painted ? `<br><span style="color:#f2b03d">Too weak to resolve — but she is <b>Painted</b>. The next scan of her has advantage.</span>` : "") +
               (result.gunnerAdvantage ? `<br><span style="color:#42d16a">Firing solution shared — ${result.gunnerAdvantage === 2 ? "both gunners" : "one gunner"} has advantage against her.</span>` : ""),
      speaker: { alias: "SSV Silver Gull" }, rolls: roll.roll ? [roll.roll] : undefined
    });
    refreshUI();
  }

  /** d20 + an ability mod, with optional advantage. Roll or manual, like every other station. */
  async function stationRollValue(crew, abil, advantage) {
    const mod = abilityMod(abil);
    // Whatever the Captain and Engineer handed this seat this round.
    const buff = crew.buff || { flat: 0, adv: false, die: "" };
    if (buff.adv) advantage = true;
    const choice = await rollChoiceDialog(
      `Scan — ${crew.name}`,
      `<p>Intelligence <b>${signMod(mod)}</b> is added automatically.${advantage ? " <b>Advantage</b> — the target is Painted." : ""}</p>` +
      `<div style="display:flex;flex-direction:column;gap:6px;">` +
      `<label>Other bonuses <input type="number" name="bonus" value="0" style="width:70px"/></label>` +
      `<label>Manual d20 (if not rolling here) <input type="number" name="die" min="1" max="20" placeholder="1–20" style="width:70px"/></label></div>`,
      "🎲 Roll 1d20", "Use manual d20");
    if (!choice) return null;
    // rollChoiceDialog hands back the FORM, not parsed values — same as gunToHitDialog.
    const el = choice.form?.elements;
    const manual = el?.die?.value !== "" ? Number(el.die.value) : null;
    const bonus = Number(el?.bonus?.value) || 0;
    let die, roll = null;
    if (choice.action === "roll") {
      roll = await new Roll(advantage ? "2d20kh" : "1d20").evaluate();
      die = roll.dice?.[0]?.results?.filter((r) => r.active)?.[0]?.result ?? roll.total;
    } else {
      if (!Number.isFinite(manual)) { ui.notifications?.warn("Enter your d20 result (1–20)."); return null; }
      die = Math.max(1, Math.min(20, manual));
    }
    let extra = 0, extraRoll = null;
    if (buff.die) { extraRoll = await new Roll(buff.die).evaluate(); extra = extraRoll.total; }
    const note = [buff.flat ? `Rally +${buff.flat}` : "", buff.adv ? "Command (advantage)" : "",
                  buff.die ? `Reroute +${buff.die} = ${extra}` : ""].filter(Boolean).join(" · ");
    if (note) ui.notifications?.info(note);
    return { die, total: die + mod + bonus + buff.flat + extra, roll, note };
  }

  const abilityMod = (a) => Number(game.user.character?.system?.abilities?.[a]?.mod) || 0;

  /* ---- targeting and damage ------------------------------------------- */

  /** Where a ship's token is, in pixels, so range and facing can be measured. */
  function shipPoint(shipId) {
    const combat = getCombat();
    if (shipId === "gull") {
      const tok = shipTokenObject();
      if (tok) return { x: tok.center?.x ?? tok.document.x, y: tok.center?.y ?? tok.document.y, rotation: tok.document.rotation || 0 };
      return null;
    }
    const sh = combat.ships[shipId]; if (!sh?.tokenId) return null;
    const scene = game.scenes.get(sh.sceneId) || game.scenes.active;
    const t = scene?.tokens.get(sh.tokenId); if (!t) return null;
    const g = scene.grid?.size || 100;
    return { x: t.x + (t.width || 1) * g / 2, y: t.y + (t.height || 1) * g / 2, rotation: t.rotation || 0 };
  }

  /** Distance between two ships in grid squares. */
  function shipDistance(aId, bId) {
    const a = shipPoint(aId), b = shipPoint(bId);
    if (!a || !b) return null;
    const g = (game.scenes.get(getCombat().ships[bId]?.sceneId) || game.scenes.active)?.grid?.size || 100;
    return Math.round(Math.hypot(b.x - a.x, b.y - a.y) / g);
  }

  /**
   * Everything a gunner needs to choose a target: who is out there, how far, and
   * which of their facings this shot would strike. Redacted like everything else.
   */
  function targetList(gun) {
    const combat = getCombat();
    const out = [];
    for (const sh of Object.values(combat.ships)) {
      if (sh.id === "gull" || sh.disposition === "ally") continue;
      const v = S.shipView(sh, { isGM: game.user.isGM });
      const dist = shipDistance("gull", sh.id);
      const from = shipPoint("gull"), me = shipPoint(sh.id);
      out.push({
        id: sh.id, name: v.name, outcome: sh.outcome,
        dist, band: gun && dist != null ? S.rangeBand(gun, dist) : null,
        facing: from && me ? S.facingFrom(me, from) : null
      });
    }
    return out.sort((a, b) => (a.dist ?? 99) - (b.dist ?? 99));
  }

  async function gmSelectTarget(crewId, shipId, byUserId) {
    if (!game.user.isGM) return;
    if (!controlsStation(byUserId, "gunner_port") && !controlsStation(byUserId, "gunner_starboard")) return;
    const next = getCombat(); const c = next.crew[crewId]; if (!c) return;
    c.target = shipId || "";
    await saveCombat(next);
  }

  async function pickTargetDialog(crewId) {
    const crew = getCombat().crew[crewId]; if (!crew) return;
    const gun = S.gun(crew.gun);
    const list = targetList(gun);
    if (!list.length) return ui.notifications?.warn("Nothing hostile on the board — the GM spawns ships from Fleet Command (F).");
    const opts = list.map((t) => ({
      value: t.id,
      label: `${t.name} — ${t.dist == null ? "range unknown" : `${t.dist} sq (${t.band})`}` +
             `${t.facing ? ` · you strike their ${S.FACING_LABEL[t.facing]}` : ""}`
    }));
    opts.push({ value: "", label: "— no target —" });
    const chosen = await chooseDlg("Lay the gun on", "Range and facing are measured from the two tokens on the map.", opts);
    if (chosen === null) return;
    if (game.user.isGM) await gmSelectTarget(crewId, chosen, null);
    else emit({ type: "selectTarget", toGM: true, crewId, shipId: chosen, userId: game.user.id });
  }

  /**
   * Apply a damage packet to a ship and resolve what it did.
   *
   * At 0 hull a ship becomes a DERELICT — drifting, boardable, salvageable, crew
   * alive — rather than exploding. Session 4's best twenty minutes came from
   * "this ship is small enough to capture", so that is the default and a kill is
   * the deliberate exception (reactor already gone, a crit, or a declared Kill Shot).
   */
  async function gmApplyDamage(shipId, raw, facing, opts = {}) {
    if (!game.user.isGM) return null;
    const next = getCombat();
    const isGull = shipId === "gull";
    const sh = isGull ? S.normalize(getState()) : next.ships[shipId];
    if (!sh) return null;

    const res = S.resolveDamage(sh, raw, facing, opts);
    sh.hull.cur = Math.max(0, sh.hull.cur - res.final);
    // Callers that need a status set at the same moment ride this write rather
    // than issuing their own, which would race this function's read.
    if (opts.alsoStatus) S.applyStatus(sh, opts.alsoStatus.id, { round: next.round, src: opts.alsoStatus.src || "" });

    let outcome = "";
    if (sh.hull.cur <= 0 && !isGull) {
      const reactorGone = (sh.systemHp?.reactor?.cur ?? 5) <= 0;
      outcome = (opts.killShot || opts.crit || reactorGone) ? "destroyed" : "derelict";
      sh.outcome = outcome;
      S.applyStatus(sh, "engines_disabled", { round: next.round, rounds: 99, src: outcome });
    }

    if (isGull) await setState(sh); else await saveCombat(next);

    const name = isGull ? getState().name : sh.name;
    const work = res.steps.map((x) => `${x.label} → ${x.value}`).join(" · ");
    const line = res.final === 0
      ? `<b>${esc(name)}</b> — <b style="color:#38e1c4">absorbed</b> the hit on the ${esc(S.FACING_LABEL[facing] || facing)}.`
      : `<b>${esc(name)}</b> takes <b style="color:#e0454d">${res.final}</b> to the <b>${esc(S.FACING_LABEL[facing] || facing)}</b>` +
        `${res.absorbed ? ` <span style="opacity:.7">(${res.absorbed} absorbed)</span>` : ""} — hull <b>${sh.hull.cur}</b>/${sh.hull.max}`;
    const tail = outcome === "derelict"
      ? `<br><b style="color:#7fb4c8">DERELICT</b> — drifting and unpowered. Her crew are alive; she can be boarded and salvaged.`
      : outcome === "destroyed" ? `<br><b style="color:#e0454d">DESTROYED</b> — no wreck worth taking.` : "";
    await ChatMessage.create({ content: `${line}${tail}<br><span style="opacity:.55;font-size:11px">${esc(work)}</span>`,
      speaker: { alias: "SSV Silver Gull" } });
    refreshUI();
    return { ...res, outcome };
  }

  /* ---- the hull catalogue -------------------------------------------- */
  // data/fleet.json is generated and shipped; a release overwrites it, so it
  // holds no instance state. Fetched once, then cached for the session.
  let FLEET = null, _fleetPromise = null;
  async function loadFleet() {
    if (FLEET) return FLEET;
    if (_fleetPromise) return _fleetPromise;
    _fleetPromise = (async () => {
      try {
        const res = await fetch(`modules/${MODULE_ID}/data/fleet.json`);
        FLEET = await res.json();
      } catch (e) {
        console.error(`${MODULE_ID} | could not load data/fleet.json`, e);
        FLEET = { version: "0", hulls: [] };
      }
      return FLEET;
    })();
    return _fleetPromise;
  }
  const hullById = (id) => (FLEET?.hulls || []).find((h) => h.id === id) || null;
  /** Full art path for a hull's skin: the shipped paths are relative to artRoot. */
  const hullArt = (hull, skin, which = "exterior", deck = "1") => {
    if (!hull) return "";
    const sk = hull.skins?.[skin] || Object.values(hull.skins || {})[0];
    if (!sk) return "";
    const node = which === "exterior" ? sk.exterior : sk.decks?.[String(deck)];
    return node ? hull.artRoot + node.art : "";
  };

  /**
   * Re-scan every installed ship map pack and upload the result as
   * `ssv-fleet-dump/fleet_scan.json`, which tools/build_fleet.py consumes.
   *
   *     await SilverGullShip.dumpFleet()
   *
   * Run this after installing or updating a map pack, then rebuild:
   *     python3 tools/build_fleet.py --verify
   *
   * It reads the real art path off each scene document rather than deriving one
   * from the scene's name, because the two disagree: the Razorbill's images are
   * spelled GL_Razorbill_Orginal_… while its scenes say Original. It is slow —
   * ~1,800 scene documents — so it yields to the browser between packs.
   */
  async function dumpFleet({ upload = true } = {}) {
    if (!game.user.isGM) return ui.notifications?.warn("GM only.");
    const clean = (u) => decodeURIComponent(String(u || ""));
    const packs = game.packs.filter((p) => p.documentName === "Scene" && /Czepeku|Hyperdrive|czepeku/i.test(p.collection));
    const out = [];
    ui.notifications?.info(`Scanning ${packs.length} ship packs — this takes a few minutes.`);
    for (const p of packs) {
      const idx = await p.getIndex();
      const rec = { pack: p.collection, label: p.metadata.label, scenes: idx.size, skins: {}, supp: {} };
      for (const e of idx) {
        const n = e.name;
        if (/blueprint|fire escape|console/i.test(n)) {
          const d = await p.getDocument(e._id);
          rec.supp[/blueprint/i.test(n) ? "blueprint" : /fire escape/i.test(n) ? "fireEscape" : "console"] =
            { scene: n, id: e._id, src: clean(d.background?.src || d.levels?.contents?.[0]?.background?.src || d.tiles.contents[0]?.texture?.src || "") };
          continue;
        }
        const m = n.match(/\b(\d\d)([a-z])\s+(.+?)\s+(Exterior|Interior)(?:\s+Level\s?0?(\d))?/i);
        if (!m) continue;
        let skin = m[3].trim(); const view = m[4].toLowerCase(); const lvl = m[5] ? Number(m[5]) : 1;
        // "Alert" / "No Turrets" / "Activated" are VARIANTS of a skin, not skins.
        let variant = "base";
        const vm = skin.match(/^(.*?)\s*(Alert|No Turrets|Activated|Animated)$/i);
        if (vm) { skin = vm[1].trim() || skin; variant = vm[2].toLowerCase().replace(/\s+/g, "-"); }
        if (/\balert\b/i.test(n) && variant === "base") variant = "alert";
        if (/no turrets/i.test(n) && variant === "base") variant = "no-turrets";
        rec.skins[skin] ||= { ext: {}, decks: {} };
        const bucket = view === "exterior" ? rec.skins[skin].ext : (rec.skins[skin].decks[lvl] ||= {});
        if (bucket[variant]) continue;
        const d = await p.getDocument(e._id);
        const g = d.grid?.size || 100;
        const tiles = d.tiles.contents.map((t) => ({ src: clean(t.texture?.src), w: t.width, h: t.height, x: Math.round(t.x), y: Math.round(t.y) }));
        const hull = tiles.filter((t) => !/nebula|burner|glow|turret|background|desert/i.test(t.src)).sort((a, b) => b.w * b.h - a.w * a.h)[0];
        const tur = tiles.filter((t) => /turret/i.test(t.src));
        bucket[variant] = { scene: n, id: e._id, w: d.width, h: d.height, grid: g,
          art: hull ? hull.src : clean(d.background?.src || ""),
          sq: hull ? [Math.round(hull.w / g), Math.round(hull.h / g)] : null,
          walls: d.walls.size, lights: d.lights.size,
          turretArt: [...new Set(tur.map((t) => t.src))],
          ...(view === "exterior" && tur.length ? { turretPos: tur.map((t) => ({ src: t.src, x: t.x, y: t.y, w: t.w, h: t.h })) } : {}) };
      }
      rec.decks = Math.max(1, ...Object.values(rec.skins).map((s) => Object.keys(s.decks).length || 1));
      out.push(rec);
      await new Promise((r) => setTimeout(r, 0));   // let the browser breathe
    }
    const json = JSON.stringify(out);
    if (!upload) return out;
    const FP = foundry.applications?.apps?.FilePicker?.implementation || FilePicker;
    try { await FP.createDirectory("data", "ssv-fleet-dump"); } catch (e) { /* exists */ }
    const res = await FP.upload("data", "ssv-fleet-dump",
      new File([new Blob([json], { type: "application/json" })], "fleet_scan.json", { type: "application/json" }), {}, { notify: false });
    ui.notifications?.info(`Scanned ${out.length} packs → ${res?.path}`);
    console.log(`${MODULE_ID} | fleet scan written to ${res?.path} (${json.length} bytes)`);
    return res?.path;
  }

  /* ---- faction crests -------------------------------------------------- */
  // Bundled rather than read out of the politics module: same crests, same
  // colours, but the fleet board still draws correctly with politics disabled.
  const CRESTS = {};
  async function loadCrests() {
    const ids = [...Object.keys(S.FACTIONS), "unaligned"];
    await Promise.all(ids.map(async (id) => {
      if (CRESTS[id] !== undefined) return;
      const url = `modules/${MODULE_ID}/assets/factions/${id}.svg`;
      try {
        const res = await fetch(url, { method: "HEAD" });
        CRESTS[id] = res.ok ? url : "";
      } catch (e) { CRESTS[id] = ""; }
    }));
    return CRESTS;
  }
  const crestFor = (id) => CRESTS[id || "unaligned"] || CRESTS.unaligned || "";

  /* ---- the overlay ----------------------------------------------------- */
  let _fleet = null, fleetSelected = null;
  const fleetOpen = () => _fleet && _fleet.style.display !== "none" && document.body.contains(_fleet);
  function closeFleet() { if (_fleet) _fleet.style.display = "none"; renderBar(); }
  function renderFleet() {
    if (!_fleet) { _fleet = document.createElement("div"); _fleet.id = "ssv-fleet"; document.body.appendChild(_fleet); }
    _fleet.style.display = "flex";
    try { S.renderFleet(_fleet, fleetCtx()); }
    catch (e) { console.error(`${MODULE_ID} | fleet render failed`, e); }
    renderBar();
  }
  function refreshFleet() { if (fleetOpen()) renderFleet(); }
  async function openFleet() {
    if (fleetOpen()) return closeFleet();
    await loadFleet(); await loadCrests();
    renderFleet();
  }

  /** Every ship in the engagement, already redacted for whoever is looking. */
  function fleetShips() {
    const combat = getCombat();
    const out = [];
    // The Gull is ship "gull" and reads from shipState, so it is never a copy
    // that can drift out of step with the S menu.
    const gullState = getState();
    const gull = S.normalizeShip({
      ...gullState, id: "gull", name: gullState.name, cls: "corvette",
      disposition: "ally", faction: "",
      crew: Object.fromEntries(Object.values(combat.crew).map((c) => [c.id, { ...c, roleId: "crew" }]))
    });
    gull.art = `modules/${MODULE_ID}/assets/ship/ship-${S.shipVariant(gullState)}.webp`;
    out.push(S.shipView(gull, { isGM: game.user.isGM, own: true }));
    for (const sh of Object.values(combat.ships || {})) {
      if (sh.id === "gull") continue;
      const hull = hullById(sh.profileId);
      const view = S.shipView(sh, { isGM: game.user.isGM });
      view.art = sh.art || hullArt(hull, sh.skin);
      out.push(view);
    }
    return out;
  }

  function fleetCtx() {
    const combat = getCombat();
    return {
      isGM: game.user.isGM, userId: game.user.id,
      ships: fleetShips(),
      round: combat.round || 1,
      activeShip: combat.activeShip || "gull",
      initiative: combat.initiative || [],
      selectedId: fleetSelected,
      select: (id) => { fleetSelected = id; renderFleet(); },
      crest: crestFor,
      artUrl: (p) => (/^(https?:|modules\/|worlds\/|data\/)/i.test(p) ? p : assetUrl(p)),
      spawn: () => spawnShipBrowser(),
      rollInitiative: () => gmRollInitiative(),
      endShipTurn: () => gmEndShipTurn(),
      runShip: (id) => gmRunShip(id),
      removeShip: (id) => gmRemoveShip(id),
      driveCrew: (shipId, crewId) => { fleetSelected = shipId; ui.notifications?.info("Per-seat driving lands with the station consoles."); },
      close: closeFleet
    };
  }

  /* ---- spawning -------------------------------------------------------- */

  /** The party's average level, so the crew tier defaults sensibly. */
  function partyLevel() {
    const pcs = game.actors.filter((a) => a.type === "character" && a.hasPlayerOwner);
    if (!pcs.length) return 3;
    const lv = pcs.map((a) => Number(a.system?.details?.level) || 0).filter((n) => n > 0);
    if (!lv.length) return 3;
    return Math.max(1, Math.round(lv.reduce((a, b) => a + b, 0) / lv.length));
  }
  const tierForLevel = (lv) => (lv <= 3 ? 1 : lv <= 6 ? 2 : lv <= 10 ? 3 : 4);

  /** A searchable grid of every hull, so the GM can decide in about five seconds. */
  async function spawnShipBrowser() {
    if (!game.user.isGM) return;
    await loadFleet(); await loadCrests();
    const hulls = (FLEET.hulls || []).slice();
    if (!hulls.length) return ui.notifications?.error("No hulls in data/fleet.json.");
    const lv = partyLevel();

    const tile = (h) => {
      const f = S.faction(h.faction), cls = S.shipClass(h.cls);
      const skin = Object.keys(h.skins)[0];
      const flags = [
        h.boardingParty ? `<span class="sgsb-f brd" title="Carries ${h.boardingParty} boarders for your decks">⚑ ${h.boardingParty}</span>` : "",
        (h.abilities || []).some((a) => /cloak|ghost/.test(a)) ? `<span class="sgsb-f clk" title="Can hide from you">☁</span>` : "",
        h.armour ? `<span class="sgsb-f arm" title="Armour ${h.armour} — small hits are wasted">⛨ ${h.armour}</span>` : "",
        h.faction === "rift" ? `<span class="sgsb-f rift" title="Apex threat — not a fair fight">⚠ RIFT</span>` : "",
        h.canonical ? `<span class="sgsb-f canon" title="A hull the crew have already met">★ ${esc(h.canonical)}</span>` : ""
      ].join("");
      return `<div class="sgsb-tile${h.faction === "rift" ? " rift" : ""}" data-hull="${esc(h.id)}"
                   data-search="${esc((h.name + " " + (f ? f.short : "unaligned") + " " + h.cls + " " + h.doctrine + " " + (h.blurb || "")).toLowerCase())}"
                   data-faction="${esc(h.faction || "unaligned")}" data-cls="${esc(h.cls)}">
        <div class="sgsb-art"><img src="${esc(hullArt(h, skin))}" alt="" loading="lazy" onerror="this.style.display='none'"></div>
        <div class="sgsb-body">
          <div class="sgsb-name">${crestFor(h.faction) ? `<img class="sgsb-crest" src="${esc(crestFor(h.faction))}" alt="">` : `<span class="sgsb-crest none"></span>`}${esc(h.name)}</div>
          <div class="sgsb-sub">${esc(cls ? cls.name : h.cls)} · ${esc(f ? f.short : "Unaligned")} · ${esc(S.doctrine(h.doctrine).name)}</div>
          <div class="sgsb-stats"><span>HULL <b>${h.hull}</b></span><span>AC <b>${h.acBase}</b></span>
            <span>GUNS <b>${(h.guns || []).length}</b></span><span>DECKS <b>${h.decks}</b></span>
            <span>CREW <b>${h.crew.max}</b></span></div>
          <div class="sgsb-blurb">${esc(h.blurb || "")}</div>
          <div class="sgsb-flags">${flags}</div>
        </div></div>`;
    };

    const factions = ["", ...Object.keys(S.FACTIONS)];
    const content = `<div class="sgsb">
      <div class="sgsb-head">
        <input class="sgsb-q" type="search" placeholder="Search 53 hulls — name, faction, doctrine…" autofocus>
        <select class="sgsb-ff"><option value="">All factions</option>${factions.filter(Boolean).map((id) => `<option value="${id}">${esc(S.FACTIONS[id].short)}</option>`).join("")}<option value="unaligned">Unaligned</option></select>
        <select class="sgsb-cf"><option value="">All classes</option>${S.SHIP_CLASSES.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
      </div>
      <div class="sgsb-grid">${hulls.map(tile).join("")}</div>
    </div>`;

    const chosen = await new Promise((resolve) => {
      const D = foundry.applications?.api?.DialogV2;
      const wire = (root) => {
        const q = root.querySelector(".sgsb-q"), ff = root.querySelector(".sgsb-ff"), cf = root.querySelector(".sgsb-cf");
        const apply = () => {
          const term = (q.value || "").toLowerCase().trim();
          root.querySelectorAll(".sgsb-tile").forEach((t) => {
            const ok = (!term || t.dataset.search.includes(term))
              && (!ff.value || t.dataset.faction === ff.value)
              && (!cf.value || t.dataset.cls === cf.value);
            t.style.display = ok ? "" : "none";
          });
        };
        q.oninput = apply; ff.onchange = apply; cf.onchange = apply;
        root.querySelectorAll(".sgsb-tile").forEach((t) => {
          t.onclick = () => { resolve(t.dataset.hull); root.closest(".application")?.querySelector("[data-action=close]")?.click(); };
        });
      };
      if (D) {
        D.prompt({ window: { title: "Spawn a ship", resizable: true }, position: { width: 980, height: 700 },
                   content, ok: { label: "Cancel", callback: () => null },
                   render: (ev, dlg) => wire(dlg.element) }).then(() => resolve(null)).catch(() => resolve(null));
      } else {
        new Dialog({ title: "Spawn a ship", content, buttons: { cancel: { label: "Cancel", callback: () => resolve(null) } },
                     render: (h) => wire(h[0]) }, { width: 980, height: 700 }).render(true);
      }
    });
    if (!chosen) return;
    const hull = hullById(chosen); if (!hull) return;
    await spawnConfigure(hull, lv);
  }

  /** Skin, crew tier, headcount, disposition — everything pre-filled from the profile. */
  async function spawnConfigure(hull, lv) {
    const skins = Object.keys(hull.skins);
    const tier = tierForLevel(lv);
    const content = `<div style="display:flex;flex-direction:column;gap:8px;font-family:'Courier New',monospace">
      <p style="margin:0 0 4px"><b>${esc(hull.name)}</b> — ${esc(S.shipClass(hull.cls)?.name || hull.cls)},
        ${esc(S.factionName(hull.faction))}. Hull ${hull.hull}, AC ${hull.acBase}, ${hull.crew.max} crew.</p>
      <label>Skin <select name="skin">${skins.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}</select></label>
      <label>Crew level <select name="tier">
        ${[1, 2, 3, 4].map((t) => `<option value="${t}" ${t === tier ? "selected" : ""}>Tier ${t} — party level ${["1–3", "4–6", "7–10", "11+"][t - 1]}</option>`).join("")}
      </select></label>
      <label>Crew aboard <input type="number" name="crew" value="${hull.crew.max}" min="0" max="${hull.crew.max}"> <span style="opacity:.6">of ${hull.crew.max}</span></label>
      <label>Disposition <select name="disp">
        <option value="hostile" selected>Hostile</option><option value="neutral">Neutral</option><option value="ally">Ally</option>
      </select></label>
      <label>How many <input type="number" name="count" value="1" min="1" max="8"></label>
    </div>`;
    const read = (form) => ({
      skin: form.elements.skin.value, tier: Number(form.elements.tier.value),
      crew: Math.max(0, Number(form.elements.crew.value) || 0),
      disp: form.elements.disp.value, count: Math.max(1, Number(form.elements.count.value) || 1)
    });
    const D = foundry.applications?.api?.DialogV2;
    const opts = D
      ? await D.prompt({ window: { title: `Spawn — ${hull.name}` }, content,
                         ok: { label: "Spawn", callback: (e, b) => read(b.form) } }).catch(() => null)
      : await new Promise((res) => new Dialog({ title: `Spawn — ${hull.name}`, content,
          buttons: { ok: { label: "Spawn", callback: (h) => res(read(h[0].querySelector("form") || h[0])) },
                     cancel: { label: "Cancel", callback: () => res(null) } }, default: "ok" }).render(true));
    if (!opts) return;
    for (let i = 0; i < opts.count; i++) await gmSpawnShip(hull, opts, i);
    refreshUI(); refreshFleet();
  }

  /* ---- GM-authoritative fleet handlers --------------------------------- */

  const newShipId = () => "s" + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);

  async function gmSpawnShip(hull, opts, index = 0) {
    if (!game.user.isGM) return null;
    const combat = getCombat();
    const id = newShipId();
    const existing = Object.values(combat.ships).filter((s) => s.profileId === hull.id).length;
    const suffix = existing || index ? ` ${String.fromCharCode(65 + existing + index)}` : "";
    const size = S.tokenSizeFor(hull.sizeSq);

    const sh = S.normalizeShip({
      id, profileId: hull.id, name: hull.name + suffix,
      faction: hull.faction, cls: hull.cls, doctrine: hull.doctrine,
      disposition: opts.disp,
      hull: { cur: hull.hull, max: hull.hull },
      ac: { base: hull.acBase }, armour: hull.armour, resist: hull.resist,
      guns: hull.guns, abilities: hull.abilities,
      boardingParty: hull.boardingParty,
      morale: S.faction(hull.faction)?.resolve === null
        ? { cur: null, max: null }
        : { cur: S.faction(hull.faction)?.resolve ?? 4, max: S.faction(hull.faction)?.resolve ?? 4 },
      sizeSq: hull.sizeSq,
      systemHp: Object.fromEntries(S.SYSTEMS.filter((s) => s.id !== "cloak" ||
        (hull.abilities || []).some((a) => /cloak|ghost/.test(a))).map((s) => [s.id, { cur: S.SYSTEM_HP_MAX, max: S.SYSTEM_HP_MAX }])),
      crew: buildCrew(hull, opts)
    });
    sh.skin = opts.skin;
    sh.art = hullArt(hull, opts.skin);

    // A vehicle actor per ship, so it can hold a token, be targeted, and be
    // deleted cleanly when the fight ends.
    const folder = await ensureFolder("Actor", "SSV — Enemy Ships");
    const actor = await Actor.create({
      name: sh.name, type: "vehicle", folder: folder?.id ?? null,
      img: sh.art || undefined,
      prototypeToken: { name: sh.name, width: size.width, height: size.height,
        texture: { src: sh.art || undefined, scaleX: size.scale, scaleY: size.scale, fit: "contain" },
        disposition: opts.disp === "ally" ? 1 : opts.disp === "neutral" ? 0 : -1,
        actorLink: false, lockRotation: false, sight: { enabled: false } },
      flags: { [MODULE_ID]: { fleet: true, shipId: id, profileId: hull.id } }
    });
    sh.actorId = actor?.id || "";

    // Drop it on the active scene, spread out from the middle.
    const scene = game.scenes.active || canvas.scene;
    if (scene && actor) {
      const g = scene.grid?.size || 100;
      const n = Object.keys(combat.ships).length + index;
      const x = Math.round(scene.width * 0.5 + ((n % 4) - 1.5) * g * 2);
      const y = Math.round(scene.height * 0.22 + Math.floor(n / 4) * g * 2);
      const td = (await actor.getTokenDocument({ x, y })).toObject();
      delete td._id;
      const made = await scene.createEmbeddedDocuments("Token", [td]);
      sh.tokenId = made?.[0]?.id || ""; sh.sceneId = scene.id;
    }

    const next = getCombat();
    next.ships[id] = sh;
    await saveCombat(next);
    await ChatMessage.create({
      content: `<b>${esc(sh.name)}</b> — ${esc(S.factionName(sh.faction))} ${esc(S.shipClass(sh.cls)?.name || "")} — enters the engagement.`,
      speaker: { alias: "SSV Silver Gull" }, whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id)
    });
    return sh;
  }

  // Role -> stat block by tier. Verified against the live compendiums: dnd5e's
  // 2024 actors have the cleaner ladder, and world.ssv--bestiary-srd carries the
  // two it lacks. "Champion" and "Warlord" exist in neither — don't reach for them.
  const CREW_BLOCKS = {
    captain:  ["Bandit Captain", "Guard Captain", "Pirate Captain", "Assassin"],
    pilot:    ["Scout", "Spy", "Warrior Veteran", "Guard Captain"],
    gunner:   ["Guard", "Thug", "Warrior Veteran", "Gladiator"],
    engineer: ["Priest Acolyte", "Priest", "Mage", "Archmage"],
    marine:   ["Warrior Infantry", "Berserker", "Warrior Veteran", "Gladiator"],
    zealot:   ["Cultist", "Cultist Fanatic", "Berserker", "Gladiator"]
  };
  // Faction flavour names, so an Apostle gunner is not called "Guard".
  const CREW_NAMES = {
    "iron-directorate":   { captain: "Directorate Commander", pilot: "Directorate Helm", gunner: "Directorate Gunner", engineer: "Directorate Tech", marine: "Directorate Trooper", zealot: "Directorate Trooper" },
    "apostles-threshold": { captain: "Apostle Confessor", pilot: "Apostle Helm", gunner: "Apostle Gunner", engineer: "Apostle Artificer", marine: "Apostle Zealot", zealot: "Apostle Zealot" },
    "sovereign-horizon":  { captain: "Horizon Captain", pilot: "Horizon Helm", gunner: "Horizon Gunner", engineer: "Horizon Wrench", marine: "Horizon Corsair", zealot: "Horizon Corsair" },
    "frostwatch":         { captain: "Frostwatch Marshal", pilot: "Frostwatch Helm", gunner: "Frostwatch Gunner", engineer: "Frostwatch Tech", marine: "Frostwatch Constable", zealot: "Frostwatch Constable" },
    "rift":               {},
    "":                   { captain: "Ship's Master", pilot: "Helmsman", gunner: "Gunner", engineer: "Engineer", marine: "Deckhand", zealot: "Deckhand" }
  };
  const ROLE_STATION = { captain: "captain", pilot: "pilot", gunner: "gunner_port", engineer: "engineer", marine: "", zealot: "" };

  /** Crew are RECORDS here. Actors and tokens are made lazily, only on boarding. */
  function buildCrew(hull, opts) {
    const crew = {}, want = Math.min(opts.crew, hull.crew.max);
    const names = CREW_NAMES[hull.faction] || CREW_NAMES[""];
    let made = 0, seq = 0;
    // Fill the bridge first: dropping the headcount should thin the marines, not
    // leave a warship with nobody flying it.
    const order = ["captain", "pilot", "gunner", "engineer", "marine", "zealot"];
    const roles = (hull.crew.roles || []).slice().sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
    for (const r of roles) {
      for (let i = 0; i < r.n && made < want; i++, made++) {
        const cid = `c${++seq}`;
        const label = names[r.role] || r.role;
        crew[cid] = {
          id: cid, name: r.n > 1 ? `${label} ${i + 1}` : label, roleId: r.role,
          station: r.role === "gunner" && i === 1 ? "gunner_starboard" : (ROLE_STATION[r.role] || ""),
          block: CREW_BLOCKS[r.role]?.[opts.tier - 1] || "", tier: opts.tier,
          action: false, bonus: false, deck: 1, dead: false
        };
      }
    }
    return crew;
  }

  async function ensureFolder(type, name) {
    let f = game.folders.find((x) => x.type === type && x.name === name);
    if (!f) f = await Folder.create({ name, type, color: "#12455a" });
    return f;
  }

  async function gmRollInitiative() {
    if (!game.user.isGM) return;
    const next = getCombat();
    const ids = ["gull", ...Object.keys(next.ships).filter((k) => k !== "gull")];
    const rolls = [];
    for (const id of ids) {
      const r = await new Roll("1d20").evaluate();
      rolls.push({ shipId: id, roll: r.total });
    }
    rolls.sort((a, b) => b.roll - a.roll);
    next.initiative = rolls;
    next.activeShip = rolls[0]?.shipId || "gull";
    next.round = 1;
    await saveCombat(next);
    const nameOfShip = (id) => (id === "gull" ? getState().name : next.ships[id]?.name || id);
    await ChatMessage.create({
      content: `<b>Ship initiative</b><br>` + rolls.map((r, i) => `${i + 1}. ${esc(nameOfShip(r.shipId))} — <b>${r.roll}</b>`).join("<br>"),
      speaker: { alias: "SSV Silver Gull" }
    });
    refreshFleet();
  }

  async function gmEndShipTurn() {
    if (!game.user.isGM) return;
    const next = getCombat();
    const order = (next.initiative || []).map((e) => e.shipId).filter((id) => id === "gull" || next.ships[id]);
    if (!order.length) return ui.notifications?.warn("Roll ship initiative first.");
    const at = order.indexOf(next.activeShip);
    const wrapped = at < 0 || at === order.length - 1;
    next.activeShip = order[wrapped ? 0 : at + 1];
    if (wrapped) next.round = (next.round || 1) + 1;

    // Reset only the ship whose turn is starting, and tick only its statuses.
    const startingId = next.activeShip;
    if (startingId === "gull") {
      for (const c of Object.values(next.crew)) {
        c.action = false; c.bonus = false; c.granted = 0; c.maneuver = null;
        c.mp = 0; c.mpMax = 0; c.navMult = 1; c.gun = null;
        c.buff = { flat: 0, adv: false, die: "" };
      }
      next.gunBuff = "";
      const ship = getState();
      let dirty = false;
      if (ship.shield.secondary) { ship.shield.secondary = null; dirty = true; }
      const expired = S.expireStatuses(ship, next.round);
      if (expired.length) dirty = true;
      if (dirty) await setState(ship);
    } else if (next.ships[startingId]) {
      const sh = next.ships[startingId];
      for (const c of Object.values(sh.crew)) { c.action = false; c.bonus = false; c.maneuver = null; c.mp = 0; c.gun = null; }
      S.expireStatuses(sh, next.round);
      sh.shield.secondary = null;
    }
    await saveCombat(next);
    refreshFleet();
  }

  async function gmRunShip(shipId) {
    if (!game.user.isGM) return;
    const combat = getCombat(); const sh = combat.ships[shipId];
    if (!sh) return;
    const doc = S.doctrine(sh.doctrine); const f = S.faction(sh.faction);
    // Standing Orders: what this hull does when the GM does not want to micro it.
    await ChatMessage.create({
      content: `<b>${esc(sh.name)}</b> — standing orders<br><i>${esc(doc.name)}: ${esc(doc.hint)}</i>` +
               (f ? `<br><span style="opacity:.75">Wants: ${esc(f.wants)}</span>` : ""),
      speaker: { alias: esc(sh.name) }, whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id)
    });
    ui.notifications?.info(`${sh.name}: ${doc.hint}`);
  }

  async function gmRemoveShip(shipId) {
    if (!game.user.isGM) return;
    const next = getCombat(); const sh = next.ships[shipId];
    if (!sh) return;
    await destroyShipDocuments(sh);
    delete next.ships[shipId];
    next.initiative = (next.initiative || []).filter((e) => e.shipId !== shipId);
    await saveCombat(next);
    refreshFleet();
  }

  /** Delete the token and actor a ship record is bound to, wherever they are. */
  async function destroyShipDocuments(sh) {
    // By id first, then by flag: a token dragged to another scene, or an actor
    // whose id was lost in an older build, still has to go somewhere.
    for (const scene of game.scenes) {
      const ids = scene.tokens.filter((t) => t.id === sh.tokenId
        || (sh.actorId && t.actorId === sh.actorId)).map((t) => t.id);
      if (ids.length) { try { await scene.deleteEmbeddedDocuments("Token", ids); } catch (e) {} }
    }
    const actor = (sh.actorId && game.actors.get(sh.actorId))
      || game.actors.find((a) => a.getFlag(MODULE_ID, "shipId") === sh.id);
    if (actor) { try { await actor.delete(); } catch (e) {} }
  }

  /**
   * Remove every enemy ship, and sweep any flagged actor no live ship claims.
   * Orphans are otherwise invisible: they sit in the folder, and the next fight
   * starts with a sidebar full of last week's dead.
   */
  async function gmClearFleet({ silent = false } = {}) {
    if (!game.user.isGM) return 0;
    const next = getCombat();
    let n = 0;
    for (const sh of Object.values(next.ships)) { await destroyShipDocuments(sh); n++; }
    next.ships = {};
    next.initiative = [];
    next.activeShip = "gull";
    await saveCombat(next);
    // Sweep anything left flagged as ours that no ship record claims.
    const orphans = game.actors.filter((a) => a.getFlag(MODULE_ID, "fleet"));
    for (const a of orphans) {
      for (const scene of game.scenes) {
        const ids = scene.tokens.filter((t) => t.actorId === a.id).map((t) => t.id);
        if (ids.length) { try { await scene.deleteEmbeddedDocuments("Token", ids); } catch (e) {} }
      }
      try { await a.delete(); n++; } catch (e) {}
    }
    refreshFleet();
    if (!silent && n) ui.notifications?.info(`Cleared ${n} enemy ship${n === 1 ? "" : "s"}.`);
    return n;
  }

  /* ---- Live ship "icon" actor: its token image mirrors the S-menu ship + shield view ---- */
  const SHIP_ICON_DIR = "ssv-ship-icon";
  // Cached: this is called from updateToken/refreshToken, which fire per drag-step and per
  // animation frame. The uncached find() ran a getFlag over every actor in the world each time.
  let _shipIconCache;   // undefined = not resolved yet, null = resolved to "none"
  function shipIconActor() {
    if (_shipIconCache !== undefined) {
      // Guard against the cached actor having been deleted out from under us.
      if (_shipIconCache === null || _shipIconCache.id === game.actors?.get(_shipIconCache.id)?.id) return _shipIconCache;
    }
    _shipIconCache = game.actors?.find((a) => a.getFlag?.(MODULE_ID, "shipIcon")) || null;
    return _shipIconCache;
  }
  const invalidateShipIcon = () => { _shipIconCache = undefined; };
  Hooks.on("createActor", invalidateShipIcon);
  Hooks.on("deleteActor", invalidateShipIcon);
  Hooks.on("updateActor", (a, ch) => { if (ch?.flags?.[MODULE_ID] !== undefined) invalidateShipIcon(); });
  async function ensureShipIconActor() {
    if (!game.user.isGM) return null;
    let a = shipIconActor();
    if (!a) a = await Actor.create({ name: "SSV Silver Gull", type: "vehicle", flags: { [MODULE_ID]: { shipIcon: true } } });
    return a;
  }
  // Composite the ship + shields onto a transparent canvas exactly like the Ship Overview draws them.
  async function shipIconBlob(state) {
    const load = (src) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
    const A = `modules/${MODULE_ID}/assets/`, W = 1218, H = 1620;
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const c = cv.getContext("2d");
    const ship = await load(A + `ship/ship-${S.shipVariant(state)}.webp`); if (ship) c.drawImage(ship, 0, 0, W, H);
    if (state.shield.on && state.systems.shields !== "destroyed") {
      const sh = await load(A + `shields/shield-${state.shield.facing}.webp`);
      if (sh) {
        if (state.systems.shields === "damaged") {
          // Damaged Shield Generator → the field on the token goes amber/orange (matches the HUD "FAILING" warning).
          c.save(); c.filter = "hue-rotate(-130deg) saturate(1.6) brightness(1.05)"; c.drawImage(sh, 0, 0, W, H); c.restore();
        } else {
          c.drawImage(sh, 0, 0, W, H);
        }
      }
    }
    if (state.shield.secondary) {
      const sc = await load(A + `shields/shield-${state.shield.secondary}.webp`);
      if (sc) { c.save(); c.globalAlpha = 0.42; c.filter = "hue-rotate(92deg) saturate(1.2) brightness(0.72)"; c.drawImage(sc, 0, 0, W, H); c.restore(); }
    }
    return await new Promise((r) => cv.toBlob(r, "image/webp", 0.9));
  }
  // Only the shield/hull/variant affect the composite — signature so we skip regen on fuel/power/inventory writes.
  function shipIconSig(state) {
    const s = state.shield || {};
    return [S.shipVariant(state), s.on ? 1 : 0, s.facing || "", s.secondary || "", state.systems?.shields || ""].join("|");
  }
  let _iconBusy = false, _iconAgain = false, _iconSig = null;
  async function updateShipIcon(force) {
    if (!game.user.isGM) return;
    const sig = shipIconSig(S.normalize(getState()));
    if (!force && sig === _iconSig) return;              // nothing that changes the token image → skip the upload
    if (_iconBusy) { _iconAgain = true; return; }        // coalesce rapid shield changes
    _iconBusy = true;
    try {
      const a = await ensureShipIconActor(); if (!a) return;
      const blob = await shipIconBlob(S.normalize(getState())); if (!blob) return;
      const FP = (foundry.applications?.apps?.FilePicker?.implementation) || FilePicker;
      try { await FP.createDirectory("data", SHIP_ICON_DIR); } catch (e) { /* exists */ }
      const file = new File([blob], `gull-${Date.now()}.webp`, { type: "image/webp" });   // unique name busts the texture cache
      const res = await FP.upload("data", SHIP_ICON_DIR, file, {}, { notify: false });
      if (!res?.path) return;
      await a.update({ img: res.path, "prototypeToken.texture.src": res.path, "prototypeToken.name": a.name });
      for (const scene of game.scenes) {
        const ups = scene.tokens.filter((t) => t.actorId === a.id).map((t) => ({ _id: t.id, "texture.src": res.path }));
        if (ups.length) await scene.updateEmbeddedDocuments("Token", ups);
      }
      _iconSig = sig;   // mark rendered only after the actor + tokens actually updated (a mid-update failure retries)
    } catch (e) { console.error(`${MODULE_ID} | ship icon update failed`, e); }
    finally { _iconBusy = false; if (_iconAgain) { _iconAgain = false; updateShipIcon(); } }
  }

  /* ---- Firing-arc cone drawn ON the ship token (only the gunners + the GM see it) ---- */
  let _coneGfx = null;
  function clearGunCone() { if (_coneGfx) { try { _coneGfx.parent?.removeChild(_coneGfx); _coneGfx.destroy(); } catch (e) {} _coneGfx = null; } }
  // Only the GM and any user controlling a gunner should see the firing arc.
  function canSeeGunCone(combat) {
    if (game.user.isGM) return true;
    return Object.values(combat.crew).some((c) => (c.station === "gunner_port" || c.station === "gunner_starboard") && c.controllerUserId === game.user.id);
  }
  function shipTokenObject() {
    const a = shipIconActor(); if (!a || typeof canvas === "undefined" || !canvas?.tokens) return null;
    return canvas.tokens.placeables.find((t) => t.document?.actorId === a.id) || null;
  }
  // Move/rotate the cone to sit on the ship token — uses the token's live mesh transform so it follows animation.
  function positionGunCone(tok) {
    if (!_coneGfx) return;
    tok = tok || shipTokenObject(); if (!tok) return;
    const m = tok.mesh;
    if (m && m.position && Number.isFinite(m.position.x)) { _coneGfx.position.set(m.position.x, m.position.y); _coneGfx.rotation = Number.isFinite(m.rotation) ? m.rotation : 0; }
    else {
      const grid = canvas.scene?.grid?.size || 100, w = (tok.document.width || 1) * grid, h = (tok.document.height || 1) * grid;
      _coneGfx.position.set(tok.document.x + w / 2, tok.document.y + h / 2);
      _coneGfx.rotation = (tok.document.rotation || 0) * Math.PI / 180;
    }
  }
  function drawGunCone() {
    clearGunCone();
    if (typeof canvas === "undefined" || !canvas?.ready || typeof PIXI === "undefined") return;
    const combat = getCombat(); if (!combat.active || !canSeeGunCone(combat)) return;
    // One cone per distinct gun any gunner has selected — two gunners on different guns → two nested cones.
    const gunIds = [...new Set(Object.values(combat.crew)
      .filter((c) => (c.station === "gunner_port" || c.station === "gunner_starboard") && c.gun)
      .map((c) => c.gun))];
    if (!gunIds.length) return;
    const tok = shipTokenObject(); if (!tok) return;
    const grid = canvas.scene?.grid?.size || 100;
    // Geometry is LOCAL (apex at origin, forward = up); positionGunCone() then places+rotates it onto the token.
    const half = Math.PI / 4, fwd = -Math.PI / 2, a0 = fwd - half, a1 = fwd + half, STEPS = 22;
    const arcPts = (r, from, to) => { const out = []; for (let i = 0; i <= STEPS; i++) { const t = from + (to - from) * (i / STEPS); out.push(r * Math.cos(t), r * Math.sin(t)); } return out; };
    const g = new PIXI.Graphics();
    // Fill+stroke a polygon under both PIXI v7 (beginFill/drawPolygon) and v8 (poly/fill/stroke).
    const fillPoly = (pts, color, alpha, la) => {
      if (typeof g.beginFill === "function") { g.beginFill(color, alpha); g.lineStyle(2, color, la); g.drawPolygon(pts); g.endFill(); }
      else { g.poly(pts).fill({ color, alpha }).stroke({ width: 2, color, alpha: la }); }
    };
    for (const id of gunIds.sort((x, y) => (S.gun(y)?.longMax || 0) - (S.gun(x)?.longMax || 0))) {   // longest first
      const gun = S.gun(id); if (!gun) continue;
      const rG = Math.max(1, gun.shortMax) * grid, rR = Math.max(gun.shortMax + 0.5, gun.longMax) * grid;
      fillPoly([...arcPts(rR, a0, a1), ...arcPts(rG, a1, a0)], 0xe0454d, 0.12, 0.45);   // red (long) band
      fillPoly([0, 0, ...arcPts(rG, a0, a1)], 0x42d16a, 0.16, 0.6);                      // green (close) band
    }
    _coneGfx = g;
    (canvas.interface || canvas.controls || canvas.stage)?.addChild(g);
    positionGunCone(tok);
  }

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
    // Keep the ship "icon" actor's token image in sync with the shields (GM renders + uploads).
    Hooks.on(`${MODULE_ID}.updated`, () => updateShipIcon());
    if (game.user.isGM) ensureShipIconActor().then(() => updateShipIcon());
    // Firing-arc cone on the map: (re)build on canvas ready / token add-remove; follow the ship every frame.
    Hooks.on("canvasReady", () => { try { drawGunCone(); } catch (e) {} });
    Hooks.on("createToken", (doc) => { if (doc.actorId === shipIconActor()?.id) { try { drawGunCone(); } catch (e) {} } });
    Hooks.on("deleteToken", () => { try { drawGunCone(); } catch (e) {} });
    Hooks.on("updateToken", (doc, change) => {
      if (doc.actorId !== shipIconActor()?.id) return;
      try { if ("width" in change || "height" in change) drawGunCone(); else positionGunCone(); } catch (e) {}
    });
    // refreshToken fires each animation frame — keep the cone glued to the ship while it moves/turns.
    Hooks.on("refreshToken", (tok) => { if (_coneGfx && tok?.document?.actorId === shipIconActor()?.id) { try { positionGunCone(tok); } catch (e) {} } });
    try { drawGunCone(); } catch (e) {}
    // Esc closes the full-screen console (capture phase so we can stop Foundry's own Esc handling).
    window.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (fleetOpen()) { ev.preventDefault(); ev.stopImmediatePropagation(); return closeFleet(); }
      if (consoleOpen()) { ev.preventDefault(); ev.stopImmediatePropagation(); closeConsole(); }
    }, true);
    staleScriptWarning();
    const mod = game.modules.get(MODULE_ID);
    if (mod) mod.api = { open: openShipHUD, openFleet, loadFleet, dumpFleet,
      // Awaits the catalogue: called straight from a macro or the console, FLEET
      // has usually not been fetched yet, and hullById would silently return null.
      spawnShip: async (hullId, opts = {}) => {
        await loadFleet();
        const h = hullById(hullId);
        if (!h) { ui.notifications?.warn(`No hull "${hullId}". Try SilverGullShip.hullIds().`); return null; }
        return gmSpawnShip(h, { skin: Object.keys(h.skins)[0], tier: 1, crew: h.crew.max, disp: "hostile", ...opts });
      },
      hullIds: async () => (await loadFleet()).hulls.map((h) => h.id),
      findHull: async (q) => (await loadFleet()).hulls.filter((h) => new RegExp(q, "i").test(h.name + " " + h.id)).map((h) => h.id),
      rollInitiative: gmRollInitiative, endShipTurn: gmEndShipTurn, removeShip: gmRemoveShip,
      clearFleet: gmClearFleet,
      getState, setState, defaultState: S.defaultState,
      SYSTEMS: S.SYSTEMS, FACINGS: S.FACINGS, STATIONS: S.STATIONS,
      getCombat, enterCombat, endCombat, nextTurn };
    globalThis.SilverGullShip = mod?.api;
  });
})();
