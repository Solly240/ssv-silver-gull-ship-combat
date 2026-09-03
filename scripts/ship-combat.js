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
  let deckMode = false;        // console showing the DECKS panel (the hull you are standing in)
  let deckData = null;         // last-resolved deck context (deckCtx is async; the renderer is not)
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
  function closeConsole() { armed = null; invMode = false; gmActMode = false; deckMode = false; hideInvPop(); closeItemBrowser(); if (_console) _console.style.display = "none"; renderBar(); }
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
      deckMode, decks: deckData,
      // Flipping to DECKS resolves the panel's data first, then re-renders — the
      // renderer stays synchronous so it can also run in preview.html.
      setView: async (v) => {
        if (v === "decks") {
          deckData = await deckCtx(); deckMode = true; invMode = false; gmActMode = false;
          await viewMyDeck();
        } else {
          deckMode = false;
          await viewSpace();
        }
        swapAnim = true; refreshOpen();
      },
      goDeck: async (n) => { await goToDeck(n); deckData = await deckCtx(); refreshOpen(); },
      returnToShip: async () => { await returnToShip(); deckData = await deckCtx(); refreshOpen(); },
      buildDecks: async (rebuild) => {
        if (!game.user.isGM) return;
        const me = whereAmI(game.user.id);
        const isGull = me.shipId === "gull";
        const hull = isGull ? await gullHull() : hullFor(me.shipId).hull;
        if (!hull) return ui.notifications?.warn("No hull profile for that ship.");
        const skin = isGull ? "Original" : (getCombat().ships[me.shipId]?.skin || Object.keys(hull.skins)[0]);
        await buildDeckScene({ ...hull, name: isGull ? getState().name : hullFor(me.shipId).name }, skin, { rebuild: !!rebuild });
        deckData = await deckCtx(); refreshOpen();
      },
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
      gmActMode, toggleGM: () => { deckMode = false; gmActMode = !gmActMode; invMode = false; armed = null; swapAnim = true; renderConsole(); },
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
      invMode, toggleInv: () => { deckMode = false; invMode = !invMode; gmActMode = false; armed = null; swapAnim = true; renderConsole(); },
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
    // A BLANK field is a cancel, not a zero. `Number("")` is 0, and a quantity of
    // 0 deletes the item — so tabbing through the box and pressing OK silently
    // destroyed a stack.
    const read = (form) => {
      const raw = String(form.elements.v.value ?? "").trim();
      if (raw === "") return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };
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
    // A stack that is already empty has nothing to move; taking one anyway made
    // a unit out of nothing and left the source at -1.
    if (!(have > 0)) {
      return notifyUser(byUserId || game.user.id, `${item.name} is an empty stack — there is nothing to move.`);
    }
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
    const have = item.system?.quantity ?? 1;
    if (have - 1 > 0) await item.update({ "system.quantity": have - 1 }); else await item.delete();
    // Read the gauge AFTER the item write: that await yields, and a snapshot taken
    // before it silently discarded any fuel or power another station spent meanwhile.
    const st = getState();
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
    let spend = Math.max(1, Math.floor(Number(fuelAmt) || t.convertFuel));   // default to the big batch
    if (st.fuel.cur < spend) return notifyUser(byUserId || game.user.id, `Not enough fuel to convert (need ${spend}).`);
    // Only burn what the tank can actually take. It used to spend the whole batch
    // and then clamp the gain, so converting 10 into a nearly-full reactor threw
    // most of that fuel away — and reported the full figure in chat.
    const room = Math.max(0, st.power.max - st.power.cur);
    if (room <= 0) return notifyUser(byUserId || game.user.id, "The reactor is already full — nothing to convert into.");
    if (ratio > 0 && Math.round(spend * ratio) > room) spend = Math.max(1, Math.floor(room / ratio));
    const gain = Math.min(room, Math.round(spend * ratio));
    st.fuel.cur -= spend;
    st.power.cur = st.power.cur + gain;
    await setState(st);
    await ChatMessage.create({ content: `Converted <b>${spend}</b> fuel → <b>${gain}</b> power`, speaker: { alias: "SSV Silver Gull" } });
  }
  async function gmEditGauge(kind) {
    if (!game.user.isGM) return;
    const shown = getState();
    const cur = await promptNumber(`Set ${kind}`, `${kind.toUpperCase()} current (max ${shown[kind].max})`, shown[kind].cur, shown[kind].max);
    if (cur == null) return;
    // Re-read AFTER the dialog. A prompt can sit open for a minute, and writing
    // the object we read before it would revert anything that happened meanwhile.
    const st = getState();
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
    // Re-read: `st` was captured before the dialog opened, and a dialog can sit
    // there for minutes while the crew burn fuel. Writing the snapshot back
    // refunded every drop they spent.
    const now = getState();
    now.fuel.max = Math.max(1, r.fmax); now.power.max = Math.max(1, r.pmax);
    now.fuel.cur = Math.min(now.fuel.cur, now.fuel.max); now.power.cur = Math.min(now.power.cur, now.power.max);
    await setState(now);
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
    if (!game.user.isGM) return false;
    const next = getCombat(); const c = next.crew[crewId]; if (!c) return false;
    const gmActor = !byUserId || game.users.get(byUserId)?.isGM;
    if (!gmActor && c.controllerUserId !== byUserId) return false;
    const amt = Math.max(0, Math.round(Number(power) || 0));   // server-side power gate (mirrors gmAllocateShield)
    if (amt && playerSpends(byUserId) && getState().power.cur < amt) {
      notifyUser(byUserId, `Not enough power (need ${amt} — convert fuel to power first).`);
      return false;
    }
    if (!tryConsume(c, which)) {
      notifyUser(byUserId || game.user.id, `No ${which === "bonus" ? "Bonus" : "Main"} action left.`);
      return false;
    }
    await saveCombat(next);
    await gmSpendPower(byUserId, power);
    return true;
  }

  // Pilot: choose a maneuver (Main) → sets Movement Points; then spend them to move/rotate the ship.
  async function gmPilotManeuver(crewId, maneuverId, byUserId) {
    if (!game.user.isGM) return;
    const m = S.MANEUVERS[maneuverId]; if (!m) return;
    const next = getCombat(); const c = next.crew[crewId]; if (!c || c.station !== "pilot") return;
    const gmActor = !byUserId || game.users.get(byUserId)?.isGM;
    if (!gmActor && c.controllerUserId !== byUserId) return;
    // Spend the slot properly. Assigning `c.action = true` meant a pilot could
    // pick a maneuver, burn every Movement Point, pick another, and get a FULL
    // fresh pool — as often as they liked.
    if (!tryConsume(c, "action")) {
      return notifyUser(byUserId || game.user.id,
        c.maneuver ? `You are already flying ${S.MANEUVERS[c.maneuver]?.label || "a maneuver"} this turn.`
                   : "No Main action left to set a maneuver.");
    }
    const full = Math.round(m.mp * (c.navMult || 1));   // Science Nav Support may have pre-boosted this turn
    c.maneuver = maneuverId; c.mpMax = full; c.mp = full;
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
    // Re-read: moveShipToken awaits a document update that other clients' writes
    // can land behind. Spending from the snapshot taken before it discarded them —
    // and, when two moves overlapped, gave the pilot the movement for free.
    { const fresh = getCombat(); const fc = fresh.crew[crewId]; if (!fc) return;
      if (fc.mp > 0) fc.mp -= 1; else fc.bonus = true;    // Main pool first, then the +1 bonus
      await saveCombat(fresh); }
    if (fuelCost > 0) { const s2 = getState(); s2.fuel.cur = Math.max(0, s2.fuel.cur - fuelCost); await setState(s2); }
  }
  /** Keep a token on the board. Walking off the edge put ships at coordinates
   *  where range and facing stop meaning anything. */
  function clampToScene(scene, tdoc, upd) {
    if (upd.x == null && upd.y == null) return upd;
    const g = scene.grid?.size || 100;
    const w = (tdoc.width || 1) * g, h = (tdoc.height || 1) * g;
    if (upd.x != null) upd.x = Math.max(0, Math.min(upd.x, Math.max(0, scene.width - w)));
    if (upd.y != null) upd.y = Math.max(0, Math.min(upd.y, Math.max(0, scene.height - h)));
    return upd;
  }

  // Move/rotate the ship-icon actor's token on the active scene. Returns false if it can't.
  async function moveShipToken(kind, byUserId) {
    const a = shipIconActor();
    // The scene she is ON, not the one anybody happens to be looking at — the
    // pilot must still be able to fly while the boarding party is on a deck.
    const scene = spaceScene() || game.scenes?.active || canvas?.scene;
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
    await scene.updateEmbeddedDocuments("Token", [clampToScene(scene, tdoc, upd)]);
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
    // The socket rule proves the sender controls this crew member; it does not
    // prove they are sitting in the Captain's chair.
    if (!game.user.isGM) return;
    const next = getCombat(); const cap = next.crew[captainCrewId], tgt = next.crew[targetCrewId];
    if (!cap || !tgt) return;
    const gmActor = !byUserId || game.users.get(byUserId)?.isGM;
    if (!gmActor && cap.controllerUserId !== byUserId) return;
    if (!gmActor && cap.station !== "captain")
      return notifyUser(byUserId, "Only the Captain can grant an action.");
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
    // Gunnery from the S console. These were `note` actions, so clicking Attack,
    // Called Shot or Launch a Boarder posted the rules text, spent the Main
    // action and the power, and fired nothing — the working versions were only
    // reachable from the turn bar.
    if (a.id === "attack")   { await runGunFire(crew.id); return; }
    if (a.id === "called")   { await runCalledShot(crew.id); return; }
    if (a.id === "launch")   { await runBoardingFire(crew.id); return; }
    // Quick Aim is a checkbox inside the to-hit dialog, not a separate spend —
    // clicking it here used to eat the Bonus action and change nothing.
    if (a.id === "quickaim") {
      ui.notifications?.info(`Quick Aim is a tick-box on the to-hit roll — it spends your Bonus there. Press Fire.`);
      return;
    }
    if (a.type === "rally") { await runBuffCrew(crew, isBonus, "rally"); return; }
    if (a.type === "command") { await runBuffCrew(crew, isBonus, "command"); return; }
    if (a.type === "reroute") { await runReroute(crew, isBonus); return; }
    if (a.type === "patch") { await runPatch(crew, isBonus); return; }
    if (a.type === "ping") { await runPing(crew, isBonus); return; }
    if (a.type === "ram") { await runRam(crew, isBonus); return; }
    if (a.type === "flee") { await runFlee(crew, isBonus); return; }
    if (a.type === "cloak") { await runCloak(crew, isBonus, a.cloak); return; }
    if (a.type === "turret") { await runTurret(crew, isBonus, a.turret, a.id); return; }
    if (a.type === "adjust") { await runAdjustAim(crew, isBonus); return; }
    if (a.type === "breach") { await runBreach(crew, isBonus); return; }
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
  /**
   * Wait until the replicated combat state satisfies `pred`, or give up.
   *
   * A player cannot write world state — they ask the GM and the change comes
   * back over Foundry's own replication. Returning a resolved promise made every
   * `await consumeSlot(...)` a no-op on a player's client, so the effect fired
   * before the action was spent and a fast double-click spent it once.
   */
  function awaitCombat(pred, ms = 2500) {
    if (pred(getCombat())) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; clearInterval(iv); clearTimeout(to); resolve(v); };
      const iv = setInterval(() => { if (pred(getCombat())) finish(true); }, 60);
      const to = setTimeout(() => finish(false), ms);
    });
  }

  function consumeSlot(crew, which, power) {
    if (game.user.isGM) return gmConsume(crew.id, which, null, 0);
    // Snapshot BEFORE emitting. `tryConsume` either flips action/bonus or, when
    // that slot is already spent, decrements a granted extra — so "did it land?"
    // is "did any of those three change?", not "is action now true".
    const was = { action: !!crew.action, bonus: !!crew.bonus, granted: Number(crew.granted) || 0 };
    emit({ type: "consume", toGM: true, crewId: crew.id, which, userId: game.user.id, power });
    return awaitCombat((c) => {
      const me = c.crew?.[crew.id];
      if (!me) return true;                       // crew gone — nothing left to wait on
      return !!me.action !== was.action || !!me.bonus !== was.bonus
          || (Number(me.granted) || 0) !== was.granted;
    }).then((ok) => {
      // Silence here reads as "the button is broken". Say what actually happened.
      if (!ok) {
        ui.notifications?.warn(game.users.activeGM
          ? "The GM did not confirm that action — nothing was spent. Try again."
          : "No GM is connected, so nothing can be confirmed. Your action was not spent.");
      }
      return ok;
    });
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
    // An enemy shields officer's Jam is a real disadvantage on this roll.
    const jammed = !!S.statusMods(S.normalize(getState())).gunDis;
    const jamRow = jammed
      ? `<p style="margin:0;color:#e0454d"><b>Fire control jammed</b> — this roll is made at disadvantage.</p>` : "";
    const choice = await rollChoiceDialog(`To-Hit — ${gun.label}`, jamRow + content, "🎲 Roll 1d20", "Use manual d20");
    if (!choice) return null;
    const v = read(choice.form);
    let die, roll = null;
    if (choice.action === "roll") {
      roll = await (new Roll(jammed ? "2d20kl" : "1d20")).evaluate();
      die = roll.dice?.[0]?.results?.filter((r) => r.active)?.[0]?.result
         ?? roll.dice?.[0]?.results?.[0]?.result ?? roll.total;
    }
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
    if (!(await consumeSlot(crew, "action", atkPw))) return;   // refused: no action left, or not enough power
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
    if (!game.user.isGM) return;
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
    // With no token for one of them — spawned on another scene, or deleted by
    // hand — range and facing cannot be measured. Fall back to point-blank on the
    // bow, but SAY SO: silently treating an unplaced ship as adjacent and
    // unshielded is the kind of thing that reads as the dice being wrong.
    const measured = !!(from && me);
    const facing = measured ? S.facingFrom(me, from) : "fore";
    const dist = shipDistance("gull", sh.id);
    const range = S.rangePenalty(gun, dist ?? 0);
    const unmeasured = measured ? "" :
      `<br><span style="color:#f2b03d">No token on the map for one of these ships — range and facing could not be measured, so this resolved at point-blank on the bow.</span>`;
    if (dist != null && !range.ok) {
      await ChatMessage.create({ content: `<b>${esc(crew.name)}</b> — <b>${esc(sh.name)}</b> is <b>out of range</b> for the ${esc(gun.label)} (${dist} squares, max ${gun.longMax}).`, speaker: gunSpeaker });
      return;
    }
    // The Gull's wing guns are fixed forward — the rules say so and her own map
    // overlay draws the cone. Enforcing it only on the enemy made her an
    // all-round turret ship and made Come About worth nothing.
    const gunArc = String(gun.arc || "fore");
    const ourBearing = measured ? S.facingFrom(from, me) : "fore";
    if (measured && gunArc !== "all" && gunArc !== "turret" && gunArc !== ourBearing) {
      ui.notifications?.warn(
        `${gun.label} is a fixed ${gunArc} mount — ${sh.name} is off your ${S.FACING_LABEL[ourBearing]}. ` +
        `The Pilot has to Come About.`);
      return;
    }
    const ac = S.shipAC(sh, Object.values(sh.crew || {}));
    const total = res.total + range.toHit;
    const hit = total >= ac[facing];
    const crit = res.die === 20;
    // The facing is geometry the crew can see on the map; the AC number is not.
    // Publishing it meant a gunner learned by firing what the rules say the
    // Science officer must scan for.
    const acKnown = !!sh.revealed?.ac;
    const rangeBit = range.toHit ? ` · long range ${range.toHit}` : "";
    const bits = `AC ${ac[facing]} on the ${S.FACING_LABEL[facing]}${rangeBit}`;
    const bitsPublic = acKnown ? bits : `the ${S.FACING_LABEL[facing]}${rangeBit}`;

    if (!hit && !crit) {
      // Whiff protection: a miss still strips a shield pip off the arc it struck.
      const next = getCombat(); const t = next.ships[sh.id];
      let note = "";
      if (t && t.shield.on && t.shield.facing === facing) {
        // Facing-scoped, and `shield.on` is left alone: setting it false was a
        // PERMANENT kill that nothing ever undid, so one lucky miss disarmed an
        // enemy's shields for the rest of the fight.
        S.applyStatus(t, "shields_down", { round: next.round, rounds: 1, src: "grazing hit", data: { facing } });
        await saveCombat(next);
        note = `<br><span style="color:#f2b03d">The round still walks across their ${esc(S.FACING_LABEL[facing])} shield — that facing drops for a round.</span>`;
      }
      await sayRedacted(
        `<b>${esc(crew.name)}</b> — <b>${esc(gun.label)}</b> vs <b>${esc(sh.name)}</b>: <b>${total}</b> vs ${bitsPublic} — <b>miss</b>.${note}${unmeasured}`,
        acKnown ? "" : `<b>${esc(crew.name)}</b> — <b>${esc(gun.label)}</b> vs <b>${esc(sh.name)}</b>: <b>${total}</b> vs ${bits} — <b>miss</b>.`,
        gunSpeaker);
      refreshUI();
      return;
    }

    playFx({ kind: "tracer", fromId: "gull", toId: sh.id, color: 0xf2b03d });
    playFx({ kind: "seq", path: "jb2a.magic_missile", fromShip: "gull", toShip: sh.id });
    const rail = getCombat().gunBuff;
    const dmgRoll = await new Roll(`${gun.damage} + ${str}${rail ? ` + ${rail}` : ""}`).evaluate();
    let raw = Math.max(1, dmgRoll.total);
    if (rail) {   // one hit only — the Engineer routed it for this shot
      const nx = getCombat(); nx.gunBuff = ""; await saveCombat(nx);
    }
    if (range.halve) raw = Math.floor(raw / 2);
    await ChatMessage.create({
      content: `<b>${esc(crew.name)}</b> — <b>${esc(gun.label)}</b> vs <b>${esc(sh.name)}</b>: <b>${total}</b> vs ${bitsPublic} — ` +
               `<b style="color:#42d16a">${crit ? "CRITICAL" : "hit"}</b>${range.halve ? " <span style='opacity:.7'>(halved at long range)</span>" : ""}${unmeasured}`,
      speaker: gunSpeaker, rolls: [dmgRoll]
    });
    if (!acKnown) await ChatMessage.create({
      content: `<span style="opacity:.7">GM · </span><b>${esc(sh.name)}</b> — AC <b>${ac[facing]}</b> on the ${esc(S.FACING_LABEL[facing])}; the shot read <b>${total}</b>.`,
      speaker: gunSpeaker, whisper: gmIds() });
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
        const sysLabel = esc(S.SYSTEMS.find((x) => x.id === sysId)?.label || sysId);
        // Naming the system is itself a systems-tier scan result. Unscanned, the
        // crew see that something aboard broke — which is the fun part anyway.
        await sayRedacted(
          t.revealed?.systems
            ? `<b style="color:#f2b03d">Critical</b> — <b>${esc(sh.name)}</b>'s <b>${sysLabel}</b> is knocked out.`
            : `<b style="color:#f2b03d">Critical</b> — something aboard <b>${esc(sh.name)}</b> blows out. She sheds atmosphere and slews off her heading.`,
          t.revealed?.systems ? "" : `<b>${esc(sh.name)}</b>'s <b>${sysLabel}</b> is the system that went.`,
          gunSpeaker);
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
    // The list is the TARGET's systems, not our own — picking from the Gull's
    // eight was a stand-in from before enemy ships existed. Unscanned, you are
    // shooting at a compartment you cannot name.
    const tgt = getCombat().ships[crew.target];
    if (!tgt) return ui.notifications?.warn("Lay the gun on a contact first — Called Shot needs a target.");
    const tv = S.shipView(tgt, { isGM: game.user.isGM });
    const known = !!tv.known?.systems && tv.systems;
    const opts = known
      ? Object.keys(tv.systems).filter((id) => tv.systemHp?.[id]?.cur > 0)
          .map((id) => ({ value: id, label: `${S.SYSTEMS.find((x) => x.id === id)?.label || id} (${tv.systemHp[id].cur}/${tv.systemHp[id].max})` }))
      : [{ value: "__blind", label: "A compartment you cannot identify — she has not been scanned" }];
    if (!opts.length) return ui.notifications?.warn(`${tgt.name} has nothing left worth aiming at.`);
    const target = await chooseDlg("Called Shot",
      known ? `Which of <b>${esc(tv.name)}</b>'s systems?`
            : `<b>${esc(tv.name)}</b> is unscanned — the Science officer has to resolve her systems before you can pick one. You can still fire blind.`,
      opts);
    if (!target) return;
    const str = strMod();
    const res = await gunToHitDialog(crew, gun, str, { noAim: true });   // Called Shot: no Quick Aim
    if (!res) return;
    if (!(await consumeSlot(crew, "action", calledPw))) return;   // refused: no action left, or not enough power
    if (res.die === 1) {
      await ChatMessage.create({ content: `<b>${esc(stationName(crew.station))}</b> · ${esc(crew.name)} — <b>${esc(gun.label)}</b> Called Shot on <b>${esc(tv.name)}</b><br>` +
        `To-hit <b>${res.total}</b> (d20 1) — <b style="color:#e0454d">MISFIRE — 1 damage to your own Weapons / Turrets</b>`,
        speaker: gunSpeaker, rolls: res.roll ? [res.roll] : undefined });
      if (game.user.isGM) gmWeaponsMishap(null); else emit({ type: "weaponsMishap", toGM: true, userId: game.user.id });
      return;
    }
    // It lands on the TARGET now, instead of a chat line saying enemy ships are
    // coming soon. The GM's client does the write, as with every other shot.
    const amount = res.die === 20 ? 2 : 1;
    if (game.user.isGM) await gmCalledShot(crew.id, crew.target, target, amount, res);
    else emit({ type: "calledShot", toGM: true, crewId: crew.id, shipId: crew.target,
                systemId: target, amount, total: res.total, die: res.die, userId: game.user.id });
  }

  /**
   * Apply a Called Shot to an enemy system.
   *
   * A blind shot (she has not been scanned) hits a compartment at random — you
   * aimed at something, you just could not say what.
   */
  async function gmCalledShot(crewId, shipId, systemId, amount, res) {
    if (!game.user.isGM) return;
    const next = getCombat();
    const crew = next.crew[crewId], sh = next.ships[shipId];
    if (!crew || !sh) return;
    const live = Object.entries(sh.systemHp || {}).filter(([, hp]) => hp.cur > 0);
    if (!live.length) {
      return ChatMessage.create({ content: `<b>${esc(crew.name)}</b> — Called Shot on <b>${esc(sh.name)}</b>: nothing left aboard her to break.`, speaker: gunSpeaker });
    }
    const pickId = (systemId && systemId !== "__blind" && sh.systemHp?.[systemId]?.cur > 0)
      ? systemId : live[Math.floor(Math.random() * live.length)][0];
    const amt = Math.max(1, Math.min(S.SYSTEM_HP_MAX, Number(amount) || 1));
    const hp = sh.systemHp[pickId];
    hp.cur = Math.max(0, hp.cur - amt);
    sh.systems[pickId] = S.systemState(hp);
    if (pickId === "shields" && hp.cur <= 0) sh.shield.on = false;
    await saveCombat(next);

    const label = S.SYSTEMS.find((x) => x.id === pickId)?.label || pickId;
    const dead = hp.cur <= 0;
    const known = !!sh.revealed?.systems;
    playFx({ kind: "tracer", fromId: "gull", toId: shipId, color: 0xf2b03d, width: 4 });
    await sayRedacted(
      `<b>${esc(stationName(crew.station))}</b> · ${esc(crew.name)} — <b>Called Shot</b> on <b>${esc(sh.name)}</b>: ` +
      `<b>${res.total}</b> (d20 ${res.die})${res.die === 20 ? ` <b style="color:#42d16a">CRITICAL</b>` : ""} — ` +
      (known
        ? `<b>${esc(label)}</b> takes <b>${amt}</b>${dead ? ` and is <b style="color:#e0454d">destroyed</b>` : ` (${hp.cur}/${hp.max})`}.`
        : `something inside her ${dead ? `<b style="color:#e0454d">lets go</b>` : `takes it`}. <span style="opacity:.6">Scan her systems to aim properly.</span>`),
      known ? "" : `it was her <b>${esc(label)}</b> — now ${hp.cur}/${hp.max}${dead ? ", destroyed" : ""}.`,
      gunSpeaker);
    refreshUI(); refreshFleet();
  }
  /**
   * Boarding Fire: put a crewmate through the enemy's hull out of a gun tube.
   *
   * This used to spend the action and 8 power to post "boarding resolves later —
   * GM adjudicates for now", which stopped being true the day Launch & Breach
   * shipped. It is the same crossing, from a gun instead of a mag-line, so it
   * runs the same code — the gunner just fires someone else across.
   */
  async function runBoardingFire(crewId) {
    const crew = getCombat().crew[crewId]; if (!isGunner(crew)) return;
    if (!hasMain(crew)) return ui.notifications?.warn("No Main action left this turn.");
    const gun = S.gun(crew.gun);
    const combat = getCombat();
    // Who is going. Anyone aboard who is not the gunner themself.
    const others = Object.values(combat.crew).filter((c) => c.id !== crew.id);
    if (!others.length) return ui.notifications?.warn("There is nobody else aboard to fire across.");
    const whoId = others.length === 1 ? others[0].id
      : await chooseDlg("Boarding Fire", `Who goes through the tube?`,
          others.map((c) => ({ value: c.id, label: `${c.name} — ${S.station(c.station)?.name || "no station"}` })));
    if (!whoId) return;
    const rider = combat.crew[whoId];
    await ChatMessage.create({
      content: `<b>${esc(stationName(crew.station))}</b> · ${esc(crew.name)} loads <b>${esc(rider.name)}</b> into the <b>${esc(gun?.label || "gun")}</b>. 🚀`,
      speaker: gunSpeaker });
    // The RIDER makes the crossing, and the gunner's action pays for it.
    await runBreach(rider, false, { firedBy: crew, spendOn: crew });
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
  async function chooseDlg(title, intro, options, preselect) {  // options: [{value,label}] → value|null
    const body = `<div style="display:flex;flex-direction:column;gap:6px;">${intro ? `<p>${intro}</p>` : ""}` +
      `<select name="v" style="width:100%">${options.map((o) =>
        `<option value="${o.value}"${o.value === preselect ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select></div>`;
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
  /* ---------------------------------------------------------------------- */
  /*  Socket authorisation                                                    */
  /*                                                                          */
  /*  Foundry sockets are broadcast-to-all and every client runs the dispatch, */
  /*  so a message is a request, not a command. Each type declares:            */
  /*                                                                          */
  /*    gm        the handler writes world state -> only the ACTIVE GM runs it */
  /*    fromGM    only a GM may SEND it (UI broadcasts: pickers, notifications) */
  /*    crew      the field naming the crew member acted for; the sender must   */
  /*              control them                                                 */
  /*    seat      the station the sender must be sitting at                     */
  /*    self      the field that must equal the sender's own user id            */
  /*    anyCrew   the sender must control at least one crew member in the fight */
  /*                                                                          */
  /*  A type absent from this table is dropped. Adding a socket message and     */
  /*  forgetting its rule therefore fails loudly instead of shipping a hole.    */
  /* ---------------------------------------------------------------------- */
  const SOCKET_RULES = {
    pickPrompt:     { fromGM: true },
    vfx:            { fromGM: true },
    notify:         { fromGM: true },
    swapConfirm:    { fromGM: true },
    viewDeck:       { fromGM: true, needsToUser: true },
    gunDoDamage:    { fromGM: true, needsToUser: true },

    pickStation:    { gm: true, crew: "crewId" },
    spend:          { gm: true, crew: "crewId" },
    consume:        { gm: true, crew: "crewId" },
    allocateShield: { gm: true, crew: "crewId" },
    grantAction:    { gm: true, crew: "captainCrewId" },
    pilotManeuver:  { gm: true, crew: "crewId" },
    pilotMove:      { gm: true, crew: "crewId" },
    selectGun:      { gm: true, crew: "crewId" },
    selectTarget:   { gm: true, crew: "crewId" },
    breach:         { gm: true, crew: "crewId" },
    turretShot:     { gm: true, crew: "crewId" },
    adjustAim:      { gm: true, crew: "crewId" },
    // The handler acts on msg.crewId when it is present, so the seat rule alone
    // let one gunner fire the other's gun.
    gunHitCheck:    { gm: true, seat: ["gunner_port", "gunner_starboard"], check: (msg) => {
      if (!msg.crewId) return true;
      return getCombat().crew?.[msg.crewId]?.controllerUserId === msg.userId;
    } },
    weaponsMishap:  { gm: true, seat: ["gunner_port", "gunner_starboard"] },

    calledShot:     { gm: true, crew: "crewId" },
    applyScan:      { gm: true, seat: "science" },
    navSupport:     { gm: true, seat: "science" },
    buffCrew:       { gm: true, seat: "captain" },
    ram:            { gm: true, seat: "captain" },
    spool:          { gm: true, seat: "captain" },
    reroute:        { gm: true, seat: "engineer" },
    patch:          { gm: true, seat: "engineer" },
    repairSystem:   { gm: true, seat: "engineer" },
    cloak:          { gm: true, seat: "cloaking" },

    // `sender` = the handler acts ONLY on msg.userId, which onSocket has already
    // overwritten with the server's view of who sent this. (Writing it as
    // `self: "userId"` was a tautology — the field being compared IS the sender.)
    switchRequest:  { gm: true, sender: true },
    goDeck:         { gm: true, sender: true },
    // `player` = any real user. The inventory is used BETWEEN fights, when
    // combat.crew is empty and `anyCrew` therefore refuses everyone — which
    // silently broke every player-side inventory action out of combat. The
    // handlers each check what they are actually allowed to touch.
    // (kept for reference in socketAuthorised below)
    // Only the person actually being ASKED may answer a station-swap request —
    // `anyCrew` let any crewed player accept or decline on their behalf.
    // The occupant being ASKED answers — the field is `targetCrew`; an earlier
    // guess at `occId` matched nothing, so every swap answer was silently dropped.
    swapResult:     { gm: true, check: (msg) => {
      const c = getCombat(), p = c.pendingSwap;
      return !!p && c.crew?.[p.targetCrew]?.controllerUserId === msg.userId;
    } },
    moveItem:       { gm: true, player: true },
    useResource:    { gm: true, player: true },
    convert:        { gm: true, player: true }
  };

  /** May this sender ask for this? A GM may always act for anyone. */
  function socketAuthorised(msg, rule) {
    const sender = msg.userId;
    const senderIsGM = !sender || !!game.users.get(sender)?.isGM;
    if (rule.fromGM) {
      if (!senderIsGM) return false;
      if (rule.needsToUser && !msg.toUser) return false;   // an unaddressed broadcast every client would run
      return true;
    }
    if (senderIsGM) return true;
    const combat = getCombat();
    const mine = Object.values(combat.crew || {}).filter((c) => c.controllerUserId === sender);
    if (rule.crew) {
      const c = combat.crew?.[msg[rule.crew]];
      return !!c && c.controllerUserId === sender;
    }
    if (rule.seat) {
      const want = Array.isArray(rule.seat) ? rule.seat : [rule.seat];
      if (!mine.some((c) => want.includes(c.station))) return false;
      return rule.check ? !!rule.check(msg) : true;
    }
    if (rule.self) return msg[rule.self] === sender;
    if (rule.sender) return !!sender;
    if (rule.anyCrew) return mine.length > 0;
    if (rule.player) return !!game.users.get(sender);
    if (rule.check) return !!rule.check(msg);
    return true;
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

    // Every message is authorised against the table before it reaches a handler.
    // Before this existed, a player could emit `ram`, `cloak`, `patch`, `spool`
    // or `applyScan` with no station and no seat and the GM's client would run
    // them — the handlers only checked that THEY were the GM, not that the
    // sender was entitled. `gm: true` additionally pins execution to the ACTIVE
    // GM, so a second GM seat can no longer double-apply a write.
    const rule = SOCKET_RULES[msg.type];
    if (!rule) return console.warn(`${MODULE_ID} | dropped an unknown socket message "${msg.type}"`, msg);
    if (rule.gm && !isActiveGM()) return;
    if (!socketAuthorised(msg, rule)) {
      return console.warn(`${MODULE_ID} | dropped an unauthorised "${msg.type}" from ${msg.userId}`, msg);
    }

    switch (msg.type) {
      case "pickPrompt":     if (!game.user.isGM) promptPickAll(); break;
      case "vfx":            if (!game.user.isGM) runFx(msg.spec); break;
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
      // The result is RECOMPUTED from the roll, never taken from the payload: a
      // crafted `result` would otherwise reveal a hull the party never scanned.
      case "calledShot":     gmCalledShot(msg.crewId, msg.shipId, msg.systemId, msg.amount, { total: msg.total, die: msg.die }); break;
      case "applyScan":      gmApplyScan(msg.shipId, S.scanResult(Number(msg.total) - S.SCAN_DC), msg.gunnerName, { total: msg.total, die: msg.die }, msg.painted); break;
      case "buffCrew":       gmBuffCrew(msg.crewId, msg.kind, msg.byName); break;
      case "reroute":        gmReroute(msg.rail, msg.crewId, msg.byName); break;
      case "patch":          gmPatch(msg.pick, msg.byName); break;
      case "ram":            gmRam(msg.shipId, msg.byName); break;
      case "spool":          gmSpool({ total: msg.total, die: msg.die }, msg.byName); break;
      case "cloak":          gmCloak(msg.which, msg.byName); break;
      case "goDeck":         gmGoToDeck(msg.userId, msg.shipId, msg.deck); break;
      case "breach":         gmBreach(msg.crewId, msg.shipId, msg.toolId, msg.total, { die: msg.die }, msg.facing); break;
      case "viewDeck":       viewDeck(msg.sceneId, msg.levelId); break;
      case "turretShot":     gmTurretShot(msg.crewId, msg.turretId, msg.shipId, { total: msg.total, die: msg.die }, msg.str); break;
      case "adjustAim":      gmAdjustAim(msg.crewId, msg.byName); break;
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
    // Session 4 ended with a crew member still floating outside a ship that was
    // about to explode, because nothing tracked where anyone was. Now it does,
    // so say so before the fight closes and takes their scene with it.
    const stranded = Object.entries(getCombat().whereIs || {})
      .filter(([, w]) => w.shipId && w.shipId !== "gull")
      .map(([uid, w]) => `${game.users.get(uid)?.name || uid} (aboard ${getCombat().ships[w.shipId]?.name || "an enemy hull"})`);
    const adriftList = (S.normalize(getState()).adriftCrew || [])
      .map((uid) => `${game.users.get(uid)?.name || uid} (adrift)`);
    const out = [...stranded, ...adriftList];
    if (out.length) {
      const go = await confirmDlg("Still out there",
        `<b>${out.join("<br>")}</b><br><br>They have not been recovered. Ending the fight now strands them — ` +
        `boarders cannot teleport home, and anyone adrift is in open space.<br><br>End it anyway?`);
      if (!go) return;
      await ChatMessage.create({
        content: `<b style="color:#e0454d">Combat ended with crew unrecovered:</b><br>${esc(out.join(" · "))}`,
        speaker: { alias: "SSV Silver Gull" } });
    }
    // Take the enemy ships, their tokens and their actors with it — otherwise the
    // world quietly accumulates a folder of every hull ever spawned.
    await gmClearFleet({ silent: true });
    const next = getCombat();
    next.active = false; next.crew = {}; next.pendingSwap = null;
    next.ships = {}; next.initiative = []; next.activeShip = "gull";
    next.round = 1; next.turn = 1; next.whereIs = {}; next.spool = 0; next.gunBuff = "";
    await saveCombat(next);

    // Combat statuses are COMBAT statuses. Only `adrift` was being cleared, so a
    // fight could end with the Gull permanently on fire, permanently cloaked, or
    // with her shields permanently down — and nothing to tick them off, because
    // the clock only runs inside a fight.
    const ship = S.normalize(getState());
    const keep = new Set([]);                    // nothing survives the fight today
    const had = (ship.statuses || []).map((x) => x.id).filter((id) => !keep.has(id));
    ship.statuses = (ship.statuses || []).filter((x) => keep.has(x.id));
    ship.adriftCrew = [];
    ship.shield.secondary = null;
    ship.scanBlock = false;
    await setState(ship);
    if (had.length) await ChatMessage.create({
      content: `<span style="opacity:.75">Stand down — cleared: ${esc(had.map((id) => S.STATUSES[id]?.label || id).join(", "))}.</span>`,
      speaker: { alias: "SSV Silver Gull" } });
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
    // The ROUND is the clock every status duration is written against. This used
    // to bump only `turn`, so outside fleet initiative nothing ever expired: a
    // fire burned for the rest of the campaign and Shields Down never came back.
    next.round = (next.round || 1) + 1;
    const expiredEnemy = [];
    for (const sh of Object.values(next.ships || {})) {
      const gone = S.expireStatuses(sh, next.round);
      if (gone.length) expiredEnemy.push(`${sh.name}: ${gone.map((id) => S.STATUSES[id]?.label || id).join(", ")}`);
      sh.aimBonus = 0;
    }
    await saveCombat(next);

    // Micro-Adjust's secondary shield lasts only until the start of the next turn.
    const ship = S.normalize(getState());
    let dirty = false;
    if (ship.shield.secondary) { ship.shield.secondary = null; dirty = true; }
    const expired = S.expireStatuses(ship, next.round);
    if (expired.length) dirty = true;
    // Damage over time — the thing "On Fire" is for.
    const mods = S.statusMods(ship);
    let burn = 0;
    for (const dot of mods.dots) {
      const r = await new Roll(dot.formula).evaluate();
      burn += r.total;
    }
    if (burn > 0) { ship.hull.cur = Math.max(0, ship.hull.cur - burn); dirty = true; }
    if (dirty) await setState(ship);

    const lines = [];
    if (burn > 0) lines.push(`<b style="color:#e0454d">${burn}</b> hull from fires still burning — now <b>${ship.hull.cur}</b>/${ship.hull.max}.`);
    if (expired.length) lines.push(`Cleared: ${expired.map((id) => S.STATUSES[id]?.label || id).join(", ")}.`);
    for (const e of expiredEnemy) lines.push(esc(e) + " cleared.");
    if (lines.length) await ChatMessage.create({
      content: `<b>Round ${next.round}</b><br>${lines.join("<br>")}`, speaker: { alias: "SSV Silver Gull" } });
    refreshUI();
  }
  async function gmSpend(crewId, which, byUserId) {
    if (!game.user.isGM) return;
    const next = getCombat(); const c = next.crew[crewId]; if (!c) return;
    const gmActor = !byUserId || game.users.get(byUserId)?.isGM;
    if (!gmActor && c.controllerUserId !== byUserId) return;   // players only touch crew they control
    // The GM toggles (they fix mistakes); a player may only SPEND. Letting them
    // un-tick their own pip made the one-Main-one-Bonus limit advisory.
    if (!gmActor && ((which === "action" && c.action) || (which === "bonus" && c.bonus))) {
      return notifyUser(byUserId, "That action is already spent — the GM can give it back.");
    }
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
    // One list PER GUN, keyed by gun id, so each gunner's panel shows the range
    // band for THEIR mount. It used to collect every gun in use and then build a
    // single list from guns[0] — so a flak gunner read the autocannon's bands and
    // was told a 7-square contact was in range when their gun stops at 4.
    get targets() {
      const combat = getCombat();
      const guns = [...new Set(Object.values(combat.crew).filter((c) => c.gun).map((c) => c.gun))];
      const out = { any: targetList(null) };
      for (const id of guns) out[id] = targetList(S.gun(id) || null);
      return out;
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
      drawGunCone();
    });
  }

  Hooks.once("init", () => {
    game.settings.register(MODULE_ID, SETTING_DATA, { scope: "world", config: false, type: Object, default: {}, onChange: refreshUI });
    game.settings.register(MODULE_ID, SETTING_COMBAT, { scope: "world", config: false, type: Object, default: {}, onChange: refreshUI });
    game.keybindings.register(MODULE_ID, "open", {
      name: game.i18n?.localize(`${MODULE_ID}.keybind.open.name`) || "Open Ship Overview HUD",
      hint: game.i18n?.localize(`${MODULE_ID}.keybind.open.hint`) || "Opens the SSV Silver Gull ship-combat overview.",
      editable: [{ key: "KeyS" }],
      onDown: () => {
        // The fleet board sits above the console, so opening one under the other
        // just looked like the key had stopped working.
        if (fleetOpen()) closeFleet();
        openShipHUD();
        return true;
      }
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

  /* ====================================================================== */
  /*  Boarding: multi-deck scenes                                           */
  /*                                                                          */
  /*  Foundry v14 has native scene Levels, so a multi-deck ship is ONE scene  */
  /*  with N Levels rather than N scenes and a teleporter between them —      */
  /*  switching decks is scene.view({level}), with no scene change and no     */
  /*  multi-megabyte texture reload.                                         */
  /*                                                                          */
  /*  The one rule that matters: a wall, tile or light with an EMPTY `levels` */
  /*  set is on EVERY level (client/documents/wall.mjs:164). The map packs    */
  /*  ship exactly that, so every placeable copied out of a deck MUST be      */
  /*  written with an explicit levels:[thatLevelId] or deck 1's walls will    */
  /*  block deck 2.                                                          */
  /* ====================================================================== */

  const DECK_FOLDER = "SSV — Boarded Hulls";
  const deckSceneName = (hullName, skin) => `${hullName} — ${skin} (decks)`;

  /** Has this hull+skin already been built as a multi-level scene? */
  function findDeckScene(hullName, skin) {
    const want = deckSceneName(hullName, skin);
    return game.scenes.find((s) => s.getFlag(MODULE_ID, "deckScene") === want) || game.scenes.getName(want) || null;
  }

  /**
   * Build (or reuse) the multi-Level scene for one hull + skin.
   * Reads the pack's own interior scenes so the art, walls and lights are the
   * artist's, not something derived.
   */
  const _deckBuilds = new Map();   // name -> the in-flight build, so a double-click waits
  async function buildDeckScene(hull, skin, opts = {}) {
    // Two GMs, or one impatient double-click, used to run this twice and create
    // two scenes with the same name — after which findDeckScene picks whichever
    // it sees first and half the party ends up on the other one.
    const key = deckSceneName(hull?.name || "", skin || "");
    if (_deckBuilds.has(key)) return _deckBuilds.get(key);
    const p = _buildDeckScene(hull, skin, opts).finally(() => _deckBuilds.delete(key));
    _deckBuilds.set(key, p);
    return p;
  }
  async function _buildDeckScene(hull, skin, { rebuild = false } = {}) {
    if (!game.user.isGM) return null;
    const existing = findDeckScene(hull.name, skin);
    if (existing && !rebuild) {
      // Scenes built before ownership was set are invisible to players: they
      // cannot call scene.view() on a non-active scene below OBSERVER, so
      // walking aboard silently failed for everyone but the GM. Repair in place
      // rather than making the GM notice and rebuild.
      const want = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2;
      if ((existing.ownership?.default ?? 0) < want && game.user.isGM) {
        try { await existing.update({ ownership: { default: want } }); } catch (e) {}
      }
      return existing;
    }

    const sk = hull.skins?.[skin]; if (!sk) return null;
    // Pose skins ("Landed", "TuckedUp", "Breached Stage 2") ship no interior at
    // all, and a few colour skins are missing an upper deck. Borrow those from a
    // skin that has them rather than refusing to build — a ship's inside does not
    // change because its outside is painted differently.
    const plan = S.decksForSkin(hull, skin);
    const deckMap = plan.decks;
    const deckKeys = Object.keys(deckMap).sort((a, b) => Number(a) - Number(b));
    if (!deckKeys.length) { ui.notifications?.warn(`${hull.name} (${skin}) has no interior decks in the pack.`); return null; }
    if (plan.borrowed) ui.notifications?.info(`${hull.name} (${skin}) ships ${plan.count - plan.borrowed} of ${plan.count} decks — borrowing the rest from "${plan.donor}".`);

    const pack = game.packs.get(hull.pack);
    if (!pack) { ui.notifications?.error(`Map pack ${hull.pack} is not installed.`); return null; }

    ui.notifications?.info(`Building ${hull.name} — ${skin}: ${deckKeys.length} deck${deckKeys.length === 1 ? "" : "s"}…`);
    // Read the art off the SOURCE SCENE when the profile has no path of its own.
    // The Gull's profile is built from a compendium index and carries no art
    // string at all, so `artRoot + art` was "" — and rebuilding her deck plan
    // (a button in the DECKS panel) would have wiped the floor out of the one
    // hand-made asset in the world.
    // The deck art is a TILE — a transparent PNG of the ship laid over a nebula
    // BACKGROUND. Reading `background.src` gets you the star field, which is how
    // a rebuild turned the Gull's decks into deep space. Prefer the interior
    // tile, then the biggest tile, and only then the background.
    const artOf = (doc) => {
      const tiles = [...(doc?.tiles ?? [])].map((t) => ({
        src: t.texture?.src || t.img || "", area: (Number(t.width) || 0) * (Number(t.height) || 0) }))
        .filter((t) => t.src);
      const interior = tiles.filter((t) => /interior/i.test(t.src)).sort((a, b) => b.area - a.area)[0];
      if (interior) return interior.src;
      const biggest = tiles.sort((a, b) => b.area - a.area)[0];
      // A tile has to actually be the floor, not a thruster decal in the corner.
      if (biggest && biggest.area > (Number(doc.width) || 0) * (Number(doc.height) || 0) * 0.1) return biggest.src;
      return doc?.levels?.contents?.[0]?.background?.src || doc?.background?.src || "";
    };
    const sources = [];
    const missing = [];
    for (const k of deckKeys) {
      const doc = await pack.getDocument(deckMap[k].sceneId);
      if (!doc) { missing.push(k); continue; }
      const art = (hull.artRoot + deckMap[k].art) || artOf(doc);
      if (!art) missing.push(k);
      sources.push({ deck: Number(k), doc, art });
    }
    if (!sources.length) return null;
    // A deck that would not load must be SAID, not silently skipped: the levels
    // are built in order, so a hole quietly renumbered every deck above it.
    if (missing.length) ui.notifications?.warn(
      `${hull.name} (${skin}): deck ${missing.join(", ")} could not be read from the pack. ` +
      `The remaining decks keep their own numbers.`);

    const first = sources[0].doc;
    const width = first.width, height = first.height, gridSize = first.grid?.size || 100;

    // One Level per deck, stacked 20 elevation units apart so tokens on
    // different decks cannot see or shoot each other.
    const levels = sources.map((s, i) => ({
      // The NAME carries the deck number, and levelForDeck matches on it — an
      // index lookup renumbered everything above a deck that failed to import.
      name: `Deck ${s.deck}`,
      elevation: { bottom: i * 20, top: (i + 1) * 20 },
      // alphaThreshold matters: the deck art is a transparent PNG on a nebula,
      // and without it the empty surround counts as floor.
      background: { src: s.art, alphaThreshold: 0.6 }
    }));

    let scene = existing;
    const core = {
      name: deckSceneName(hull.name, skin),
      // Match the SOURCE scene's padding. Walls, lights and tiles are copied at
      // their source coordinates, and padding shifts the whole coordinate frame —
      // forcing 0 against a padded source slid every wall off the art by the
      // padding delta.
      width, height, padding: Number(first.padding) || 0,
      grid: { type: first.grid?.type ?? CONST.GRID_TYPES.SQUARE, size: gridSize,
              distance: first.grid?.distance ?? 5, units: first.grid?.units ?? "ft" },
      tokenVision: true,
      // Players must be at least OBSERVER to call scene.view() on a scene that is
      // not the active one — otherwise walking aboard silently fails for everyone
      // but the GM. (The same trap the settlements module documents.)
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2 },
      navigation: false,
      flags: { [MODULE_ID]: { deckScene: deckSceneName(hull.name, skin), hullId: hull.id, skin, decks: deckKeys.length } }
    };

    if (!scene) scene = await Scene.create({ ...core, levels });
    else {
      await scene.update(core);
      // Replace only what we own; anything the GM added by hand stays.
      const del = (type, ids) => ids.length ? scene.deleteEmbeddedDocuments(type, ids) : null;
      await del("Wall", scene.walls.map((d) => d.id));
      await del("AmbientLight", scene.lights.map((d) => d.id));
      await del("Tile", scene.tiles.filter((t) => t.getFlag(MODULE_ID, "deckArt")).map((t) => t.id));
      await del("Region", scene.regions?.filter?.((r) => r.getFlag(MODULE_ID, "deckLink"))?.map((r) => r.id) || []);
      // Remember which DECK each token was on before the levels change, or every
      // token is left pointing at a level id that no longer exists.
      const wasOn = scene.tokens.map((t) => ({ id: t.id, deck: deckForLevel(scene, t.level) }));
      // CREATE the replacements first, then delete the originals. Foundry v14
      // refuses to remove a scene's last Level ("must have at least one level"),
      // so delete-then-create threw halfway — after the walls and lights had
      // already gone. Rebuild has never worked on v14.
      const oldLevels = scene.levels.map((l) => l.id);
      await scene.createEmbeddedDocuments("Level", levels);
      if (oldLevels.length) await scene.deleteEmbeddedDocuments("Level", oldLevels);
      const moved = wasOn
        .map((t) => ({ _id: t.id, level: levelForDeck(scene, t.deck) }))
        .filter((t) => t.level);
      if (moved.length) await scene.updateEmbeddedDocuments("Token", moved);
    }
    const levelIds = scene.levels.contents.map((l) => l.id);

    // Walls, lights and decorative tiles, each TAGGED with its own deck's level.
    const walls = [], lights = [], tiles = [];
    sources.forEach((s, i) => {
      const lvl = levelIds[i];
      for (const w of s.doc.walls) { const o = w.toObject(); delete o._id; o.levels = [lvl]; walls.push(o); }
      for (const l of s.doc.lights) { const o = l.toObject(); delete o._id; o.levels = [lvl]; lights.push(o); }
      // The pack's own extras — burner glow, turret mounts — belong to that deck.
      for (const t of s.doc.tiles) {
        const src = decodeURIComponent(t.texture?.src || "");
        if (/Ship.?Images|\/Maps\//i.test(src) && !/turret|burner|glow/i.test(src)) continue;  // that IS the deck art
        if (/nebula|background/i.test(src)) continue;                                          // the backdrop is the level's job
        const o = t.toObject(); delete o._id; o.levels = [lvl];
        o.flags = { ...(o.flags || {}), [MODULE_ID]: { deckArt: true } };
        tiles.push(o);
      }
    });
    if (walls.length) await scene.createEmbeddedDocuments("Wall", walls);
    if (lights.length) await scene.createEmbeddedDocuments("AmbientLight", lights);
    if (tiles.length) await scene.createEmbeddedDocuments("Tile", tiles);

    // File it away so the scene sidebar does not fill up with hulls.
    const folder = await ensureFolder("Scene", DECK_FOLDER);
    if (folder && scene.folder?.id !== folder.id) await scene.update({ folder: folder.id });

    ui.notifications?.info(`${scene.name}: ${levelIds.length} decks, ${walls.length} walls, ${lights.length} lights.`);
    return scene;
  }

  /** Which level id is deck N on this scene? */
  /** Match on the level's NAME ("Deck 2"), falling back to position for scenes
   *  built before the names carried the number. An index-only lookup silently
   *  renumbered every deck above one that failed to import. */
  const levelForDeck = (scene, deck) => {
    const n = Math.max(1, Number(deck) || 1);
    const byName = scene?.levels?.contents?.find((l) => new RegExp(`\\b${n}\\b`).test(l.name || ""));
    return (byName || scene?.levels?.contents?.[n - 1])?.id || null;
  };
  const deckForLevel = (scene, levelId) => {
    const lv = scene?.levels?.contents?.find((l) => l.id === levelId);
    const m = lv && String(lv.name || "").match(/(\d+)/);
    if (m) return Number(m[1]);
    const i = scene?.levels?.contents?.findIndex((l) => l.id === levelId);
    return i >= 0 ? i + 1 : 1;
  };

  /* ---- where everyone is standing ---------------------------------------- */

  /** The Gull is where you are unless the combat state says otherwise. */
  function whereAmI(userId) {
    const w = getCombat().whereIs?.[userId || game.user.id];
    return w && w.shipId ? w : { shipId: "gull", deck: 1 };
  }

  /** The hull profile + skin for whichever ship a user is standing in. */
  function hullFor(shipId) {
    if (shipId === "gull") {
      const h = (FLEET?.hulls || []).find((x) => x.pack === GULL_PACK);
      return { hull: h || null, skin: "Original", name: getState().name };
    }
    const sh = getCombat().ships[shipId];
    if (!sh) return { hull: null, skin: "", name: "" };
    return { hull: hullById(sh.profileId), skin: sh.skin || "", name: sh.name };
  }
  // The Razorbill IS the Silver Gull; build_fleet.py skips it as the player ship,
  // so resolve it straight from the pack rather than from data/fleet.json.
  const GULL_PACK = "HyperdriveFleet-Razorbill-Interceptor.scenes";

  /** The Gull's own hull profile, synthesised from the pack (it is not in fleet.json). */
  async function gullHull() {
    await loadFleet();
    if (FLEET._gull) return FLEET._gull;
    const pack = game.packs.get(GULL_PACK);
    if (!pack) return null;
    const idx = await pack.getIndex();
    const skins = {};
    for (const e of idx) {
      const m = e.name.match(/\b\d\d[a-z]\s+(.+?)\s+Interior(?:\s+Level\s?0?(\d))?/i);
      if (!m) continue;
      let skin = m[1].trim(); const lvl = m[2] ? Number(m[2]) : 1;
      if (/alert$/i.test(skin)) continue;                 // the alert variants are a swap, not a deck
      skins[skin] ||= { exterior: { sceneId: "", art: "" }, decks: {} };
      if (!skins[skin].decks[lvl]) skins[skin].decks[lvl] = { sceneId: e._id, art: "" };
    }
    FLEET._gull = { id: "gull", name: getState().name, pack: GULL_PACK, artRoot: "", skins,
                    decks: Math.max(1, ...Object.values(skins).map((s) => Object.keys(s.decks).length)) };
    return FLEET._gull;
  }

  /** The deck panel's data, already filtered for who is looking. */
  async function deckCtx() {
    const me = whereAmI(game.user.id);
    const isGull = me.shipId === "gull";
    const hull = isGull ? await gullHull() : hullFor(me.shipId).hull;
    const name = isGull ? getState().name : hullFor(me.shipId).name;
    const skin = isGull ? "Original" : (getCombat().ships[me.shipId]?.skin || "");
    const skName = hull?.skins?.[skin] ? skin : Object.keys(hull?.skins || {})[0] || "";
    // Same fallback buildDeckScene uses, so the strip never offers a deck the
    // scene does not have — or hides one it does.
    const deckKeys = Object.keys(S.decksForSkin(hull, skName).decks).sort((a, b) => Number(a) - Number(b));

    // How many enemy crew are on each deck — only if the players have earned it.
    const sh = isGull ? null : getCombat().ships[me.shipId];
    const view = sh ? S.shipView(sh, { isGM: game.user.isGM }) : null;
    const canSeeCrew = !!(view?.known?.crew && view.crew && (game.user.isGM || (view.known.deckmap || 0) >= 3));
    const perDeck = {};
    if (canSeeCrew) for (const c of Object.values(view.crew)) if (!c.dead) perDeck[c.deck || 1] = (perDeck[c.deck || 1] || 0) + 1;

    return {
      hullName: name, isOwnShip: isGull, deck: me.deck, shipId: me.shipId,
      decks: deckKeys.map((k) => ({
        n: Number(k),
        name: Number(k) === 1 ? "Main deck" : Number(k) === 2 ? "Lower deck / engineering" : `Deck ${k}`,
        crew: canSeeCrew ? (perDeck[Number(k)] || 0) : null,
        here: Number(k) === me.deck
      })),
      canReturn: !isGull,
      breachInfo: isGull
        ? "Your own hull. Enemy boarders appear here, and this is where recovered crew come back to."
        : `You cut in on her <b>${esc(S.FACING_LABEL[(getCombat().whereIs || {})[game.user.id]?.facing] || "hull")}</b>. ` +
          `You cannot teleport home — someone has to physically recover you before the fight ends.`
    };
  }

  /** Move this user to a deck: switch the scene view and put their token there. */
  async function goToDeck(deck) {
    const me = whereAmI(game.user.id);
    if (game.user.isGM) await gmGoToDeck(game.user.id, me.shipId, deck);
    else emit({ type: "goDeck", toGM: true, shipId: me.shipId, deck, userId: game.user.id });
  }

  /**
   * The hull's box on one level, measured from the walls the pack shipped.
   *
   * Deck art is a transparent PNG on a canvas far larger than the ship, so the
   * centre of the SCENE is usually open space beside the hull. Everything that
   * places a token on a deck goes through this.
   */
  function deckInterior(scene, levelId) {
    const walls = scene.walls.filter((w) => {
      const lv = w._source?.levels;
      // An empty `levels` set means EVERY level (client/documents/wall.mjs).
      return !Array.isArray(lv) || !lv.length || lv.includes(levelId);
    }).map((w) => ({ c: w.c }));
    return S.deckBounds(walls, { x: 0, y: 0, w: scene.width, h: scene.height });
  }

  /**
   * Take an actor's token OFF every other deck scene this module owns.
   *
   * Boarding used to CREATE a token on the destination and leave the old one
   * behind, so a boarder stood on the Gull and on the enemy at the same time.
   */
  async function liftTokenFrom(actorId, keepSceneId) {
    if (!actorId) return 0;
    let n = 0;
    for (const sc of game.scenes) {
      if (sc.id === keepSceneId) continue;
      if (!sc.getFlag(MODULE_ID, "deckScene")) continue;
      const ids = sc.tokens.filter((t) => t.actorId === actorId).map((t) => t.id);
      if (!ids.length) continue;
      try { await sc.deleteEmbeddedDocuments("Token", ids); n += ids.length; } catch (e) {}
    }
    return n;
  }

  async function gmGoToDeck(userId, shipId, deck, { trusted = false, facing = "" } = {}) {
    if (!game.user.isGM) return;
    const isGull = shipId === "gull";
    // A player may walk the decks of their OWN ship, or of a hull they have
    // actually breached — not of any hull whose id they can type. Without this,
    // `goDeck` was a free teleport into an unscanned enemy's engine room.
    if (!trusted && !isGull && !game.users.get(userId)?.isGM) {
      const at = (getCombat().whereIs || {})[userId];
      if (!at || at.shipId !== shipId) {
        return notifyUser(userId, "You are not aboard that ship. Breach her first.");
      }
    }
    const hull = isGull ? await gullHull() : hullFor(shipId).hull;
    if (!hull) return notifyUser(userId, "No deck plan for that hull.");
    const skin = isGull ? "Original" : (getCombat().ships[shipId]?.skin || Object.keys(hull.skins)[0]);
    let scene = findDeckScene(isGull ? getState().name : hullFor(shipId).name, skin);
    if (!scene) scene = await buildDeckScene({ ...hull, name: isGull ? getState().name : hullFor(shipId).name }, skin);
    if (!scene) return notifyUser(userId, "Could not build that deck plan.");

    const levelId = levelForDeck(scene, deck);
    if (!levelId) return notifyUser(userId, `That hull has no deck ${deck}.`);

    // Put the player's own token on that deck — at the airlock they cut, if they
    // cut one, otherwise in the middle of the HULL (not the middle of the canvas).
    const user = game.users.get(userId);
    const actor = user?.character || game.actors.find((a) => a.type === "character" && a.testUserPermission(user, "OWNER"));
    if (actor) {
      const g = scene.grid?.size || 100;
      const box = deckInterior(scene, levelId);
      const at = facing
        ? S.breachPoint(box, facing, g)
        : { x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h / 2) };
      // Off every other hull first: standing on two ships at once is not boarding.
      await liftTokenFrom(actor.id, scene.id);
      const existing = scene.tokens.find((t) => t.actorId === actor.id);
      if (existing) await existing.update({ level: levelId, x: at.x, y: at.y });
      else {
        const td = (await actor.getTokenDocument({ x: at.x, y: at.y, actorLink: true })).toObject();
        delete td._id; td.level = levelId;
        await scene.createEmbeddedDocuments("Token", [td]);
      }
    }

    const next = getCombat();
    next.whereIs = { ...(next.whereIs || {}), [userId]: { shipId, deck, facing: facing || "" } };
    await saveCombat(next);
    emit({ type: "viewDeck", toUser: userId, sceneId: scene.id, levelId });
    if (userId === game.user.id) await viewDeck(scene.id, levelId);
  }

  /** Switch this client's view to a scene + level. */
  async function viewDeck(sceneId, levelId) {
    const scene = game.scenes.get(sceneId); if (!scene) return;
    try { await scene.view({ level: levelId }); }
    catch (e) { try { await scene.view(); } catch (e2) { console.warn(`${MODULE_ID} | could not view deck`, e2); } }
  }

  /**
   * The scene the ship battle is on: wherever the Gull's own token sits, and the
   * active scene otherwise. Remembered so a boarder can look back out at the
   * fight from inside an enemy hull.
   */
  function spaceScene() {
    const icon = shipIconActor();
    if (icon) {
      const sc = game.scenes.find((x) => !x.getFlag(MODULE_ID, "deckScene") && x.tokens.some((t) => t.actorId === icon.id));
      if (sc) return sc;
    }
    const act = game.scenes.active;
    if (act && !act.getFlag(MODULE_ID, "deckScene")) return act;
    return game.scenes.find((x) => !x.getFlag(MODULE_ID, "deckScene")) || null;
  }

  /**
   * Move the CAMERA between the battle and the deck you are standing on.
   *
   * The SPACE/DECKS control used to switch only the console PANEL, so a boarder
   * pressing SPACE got the space readout while their canvas still showed the
   * enemy's engine room. Your token does not move — you are still aboard; you
   * are just looking out of the window.
   */
  async function viewSpace() {
    const sc = spaceScene();
    if (!sc) return ui.notifications?.warn("No space scene to go back to.");
    if (game.scenes.current?.id === sc.id) return;
    try { await sc.view(); }
    catch (e) { ui.notifications?.warn("You do not have permission to view the battle map — ask the GM."); }
  }

  /** …and the other way: back to the deck this user is actually standing on. */
  async function viewMyDeck() {
    const me = whereAmI(game.user.id);
    const isGull = me.shipId === "gull";
    const hull = isGull ? await gullHull() : hullFor(me.shipId).hull;
    const name = isGull ? getState().name : hullFor(me.shipId).name;
    const skin = isGull ? "Original" : (getCombat().ships[me.shipId]?.skin || Object.keys(hull?.skins || {})[0]);
    const scene = findDeckScene(name, skin);
    if (!scene) return;                       // no plan built yet — the panel says so
    if (game.scenes.current?.id === scene.id) return;
    await viewDeck(scene.id, levelForDeck(scene, me.deck || 1));
  }

  /** Back to the Gull — only if someone has physically recovered you. */
  async function returnToShip() {
    if (game.user.isGM) await gmGoToDeck(game.user.id, "gull", 1);
    else emit({ type: "goDeck", toGM: true, shipId: "gull", deck: 1, userId: game.user.id });
  }

  /* ---- Boarding ---------------------------------------------------------- */

  const CREW_FOLDER = "SSV — Boarding Crew";
  /** Which SRD stat block a crew record resolves to, and where to find it. */
  const BLOCK_PACKS = ["dnd5e.actors24", "world.ssv--bestiary-srd", "dnd5e.monsters"];

  /**
   * Import a stat block once, renamed for the campaign, and cache it.
   * Same pattern as the settlements module's actorFor(): the world ends up with
   * one "Apostle Gunner" actor, not one per fight.
   */
  const blockCache = new Map();
  async function actorForBlock(blockName, displayName) {
    if (!blockName) return null;
    const key = `${blockName}|${displayName}`;
    // A cached actor the GM has since deleted is a dead document: creating a token
    // from it fails, and the boarding party silently comes up short.
    if (blockCache.has(key)) {
      const hit = blockCache.get(key);
      if (hit === null || game.actors.get(hit.id)) return hit;
      blockCache.delete(key);
    }
    let actor = game.actors.getName(displayName);
    if (!actor) {
      let src = null;
      for (const pid of BLOCK_PACKS) {
        const pack = game.packs.get(pid); if (!pack) continue;
        const idx = await pack.getIndex();
        const hit = idx.find((e) => e.name.toLowerCase() === blockName.toLowerCase());
        if (hit) { src = await pack.getDocument(hit._id); break; }
      }
      if (!src) { console.warn(`${MODULE_ID} | no stat block "${blockName}" in any bestiary`); blockCache.set(key, null); return null; }
      const data = src.toObject();
      data.name = displayName; delete data._id;
      data.folder = (await ensureFolder("Actor", CREW_FOLDER))?.id ?? null;
      data.flags = { ...(data.flags || {}), [MODULE_ID]: { boardingCrew: true, block: blockName } };
      actor = await Actor.create(data);
    }
    blockCache.set(key, actor);
    return actor;
  }

  /** Spread N tokens around a point without stacking them. */

  /**
   * Put an enemy ship's crew on its own decks, as hidden tokens.
   * Lazy — nothing is created until somebody actually boards.
   */
  async function materialiseCrew(shipId, scene) {
    if (!game.user.isGM) return 0;
    const combat = getCombat(); const sh = combat.ships[shipId]; if (!sh || !scene) return 0;
    const g = scene.grid?.size || 100;
    const byDeck = {};
    for (const c of Object.values(sh.crew)) {
      if (c.dead || c.tokenId) continue;
      (byDeck[c.deck || 1] ||= []).push(c);
    }
    const made = [];
    for (const [deck, list] of Object.entries(byDeck)) {
      const levelId = levelForDeck(scene, Number(deck));
      // Inside the hull, spread across it — the old hex spiral around the middle
      // of the CANVAS put half a crew in the void beside their own ship.
      const spots = S.deckSpots(deckInterior(scene, levelId), g, list.length);
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        const actor = await actorForBlock(c.block, c.name);
        if (!actor) continue;
        const proto = actor.prototypeToken.toObject();
        made.push({ ...proto, name: c.name, actorId: actor.id, actorLink: false,
          x: spots[i].x, y: spots[i].y, level: levelId,
          hidden: true,                       // the GM reveals a compartment as the boarders reach it
          disposition: -1,
          flags: { [MODULE_ID]: { boardingCrew: true, shipId, crewId: c.id } } });
      }
    }
    if (!made.length) return 0;
    const docs = await scene.createEmbeddedDocuments("Token", made);
    // Remember which token is which crew member, so killing one takes that
    // station offline — the rule ship-combat.md has always specified.
    const next = getCombat();
    docs.forEach((d) => {
      const cid = d.getFlag(MODULE_ID, "crewId");
      if (next.ships[shipId]?.crew[cid]) next.ships[shipId].crew[cid].tokenId = d.id;
    });
    await saveCombat(next);
    return docs.length;
  }

  /**
   * An enemy boarding party crosses onto the GULL.
   *
   * `boardingParty` has been carried on every hull since the fleet was authored
   * and shown in the spawn browser as a corner flag, but nothing ever spawned
   * them — the Leiothrix and the Apostle pod ships were advertising marines that
   * did not exist. They land on the Gull's deck 1, at the arc they came from.
   */
  async function gmEnemyBoard(shipId) {
    if (!game.user.isGM) return false;
    const combat = getCombat();
    const sh = combat.ships[shipId]; if (!sh) return false;
    const n = Math.max(0, Number(sh.boardingParty) || 0);
    if (!n) { ui.notifications?.warn(`${sh.name} carries no boarding party.`); return false; }
    if (sh.boardersSent) { ui.notifications?.warn(`${sh.name} has already sent her marines.`); return false; }
    const d = shipDistance(shipId, "gull");
    if (d != null && d > 1) {
      ui.notifications?.warn(`${sh.name} is ${d} squares off — she has to close to 1 to launch pods.`);
      return false;
    }

    // The Gull's own two-deck scene, built on demand exactly like an enemy's.
    const hull = await gullHull();
    const name = getState().name;
    let scene = findDeckScene(name, "Original");
    if (!scene && hull) scene = await buildDeckScene({ ...hull, name }, "Original");
    if (!scene) { ui.notifications?.error("The Gull has no deck plan to board — build it from the DECKS panel."); return false; }

    const levelId = levelForDeck(scene, 1);
    const g = scene.grid?.size || 100;
    const box = deckInterior(scene, levelId);
    // They cut in on the arc they are actually on, same rule the players get.
    const gullP = shipPoint("gull"), meP = shipPoint(shipId);
    const face = (gullP && meP) ? S.facingFrom(gullP, meP) : "fore";
    const entry = S.breachPoint(box, face, g);
    const spots = S.deckSpots({ x: entry.x - g * 1.5, y: entry.y - g * 1.5, w: g * 3, h: g * 3 }, g, n);

    const fac = S.faction(sh.faction);
    const label = { "apostles-threshold": "Apostle Zealot", "iron-directorate": "Directorate Trooper",
                    "sovereign-horizon": "Horizon Corsair", "frostwatch": "Frostwatch Constable" }[sh.faction] || "Boarder";
    const tier = Math.max(1, Math.min(4, Number(Object.values(sh.crew)[0]?.tier) || 1));
    const block = (sh.faction === "apostles-threshold" ? CREW_BLOCKS.zealot : CREW_BLOCKS.marine)[tier - 1];

    const made = [];
    for (let i = 0; i < n; i++) {
      const actor = await actorForBlock(block, `${label} ${i + 1}`);
      if (!actor) continue;
      const proto = actor.prototypeToken.toObject();
      made.push({ ...proto, name: `${label} ${i + 1}`, actorId: actor.id, actorLink: false,
        x: spots[i].x, y: spots[i].y, level: levelId, hidden: false, disposition: -1,
        flags: { [MODULE_ID]: { boardingCrew: true, shipId, boarder: true } } });
    }
    if (!made.length) { ui.notifications?.error(`No stat block "${block}" in any bestiary — cannot spawn her marines.`); return false; }
    await scene.createEmbeddedDocuments("Token", made);

    const next = getCombat();
    if (next.ships[shipId]) next.ships[shipId].boardersSent = true;
    await saveCombat(next);
    const gull = S.normalize(getState());
    S.applyStatus(gull, "boarded", { round: next.round, src: sh.name });
    await setState(gull);

    await ChatMessage.create({
      content: `<b style="color:#e0454d">BOARDERS</b> — <b>${esc(sh.name)}</b> puts <b>${made.length}</b> ` +
               `${esc(label.toLowerCase())}${made.length === 1 ? "" : "s"} through your <b>${esc(S.FACING_LABEL[face])}</b> ` +
               `onto <b>deck 1</b>.` +
               (fac ? `<br><span style="opacity:.75">${esc(fac.wants)}</span>` : "") +
               `<br><i>Switch to DECKS in the ship console — they are aboard now.</i>`,
      speaker: { alias: esc(sh.name) } });
    playFx({ kind: "alert", fraction: 0.13 });
    refreshUI(); refreshFleet();
    return true;
  }

  /** Launch & Breach: cross into an enemy hull. */
  async function runBreach(crew, isBonus, opts = {}) {
    const combat = getCombat();
    const near = Object.values(combat.ships).filter((s) => s.id !== "gull" && s.disposition !== "ally"
      && s.outcome !== "destroyed" && (shipDistance("gull", s.id) ?? 99) <= 2);
    if (!near.length) return ui.notifications?.warn("Nothing within 2 squares to board — the Pilot has to close first.");
    const pw = S.ACTION_POWER.launch_breach;
    if (!spendCheck(pw)) return;

    const targetId = near.length === 1 ? near[0].id
      : await chooseDlg("Launch & Breach", "Which hull?", near.map((s) => ({ value: s.id, label: `${s.name} — ${shipDistance("gull", s.id)} sq` })));
    if (!targetId) return;
    const target = combat.ships[targetId];

    // Which arc to cut into. The default is the one you are actually flying on —
    // and the shielded facing is called out, because cutting through a live
    // shield is the thing that stops most tools.
    const meP = shipPoint(targetId), gullP = shipPoint("gull");
    const onArc = (meP && gullP) ? S.facingFrom(meP, gullP) : "fore";
    const tv = S.shipView(target, { isGM: game.user.isGM });
    const shieldFace = tv.known?.shields ? tv.shield?.on && tv.shield.facing : null;
    showBreachMarkers(targetId, onArc);
    const facing = await chooseDlg("Launch & Breach",
      `Where do you cut in? You are on her <b>${esc(S.FACING_LABEL[onArc])}</b>.` +
      (tv.known?.shields ? "" : `<br><span style="opacity:.7">Her shield facing is unscanned — you are guessing.</span>`),
      S.BREACH_FACINGS.map((f) => ({ value: f,
        label: `${S.FACING_LABEL[f]}${f === onArc ? " — the arc you are on" : ""}` +
               (shieldFace === f ? " ⚠ SHIELDED" : "") })), onArc);
    hideBreachMarkers();
    if (!facing) return;

    const toolId = await chooseDlg("Launch & Breach", "What are you crossing with?",
      S.BOARDING_TOOLS.map((t) => ({ value: t.id, label: `${t.name} ${t.mod === 99 ? "(automatic)" : t.mod >= 0 ? `+${t.mod}` : t.mod} — ${t.note}` })));
    if (!toolId) return;
    const tool = S.boardingTool(toolId);
    if (tool.failsIf && tool.failsIf(target)) {
      await ChatMessage.create({ content: `<b>${esc(crew.name)}</b> — the <b>${esc(tool.name)}</b> will not bite on <b>${esc(target.name)}</b>: her shields are up. Nothing crossed.`, speaker: { alias: "SSV Silver Gull" } });
      return;
    }

    const res = await stationRollValue(crew, "str", false);
    if (!res) return;
    // Boarding Fire spends the GUNNER's action, not the passenger's.
    const payer = opts.spendOn || crew;
    if (!(await consumeSlot(payer, isBonus ? "bonus" : "action", pw))) return;   // refused: no action left, or not enough power
    const total = res.total + (tool.mod === 99 ? 99 : tool.mod);
    if (game.user.isGM) await gmBreach(crew.id, targetId, toolId, total, res, facing);
    else emit({ type: "breach", toGM: true, crewId: crew.id, shipId: targetId, toolId, total, die: res.die, facing, userId: game.user.id });
  }

  async function gmBreach(crewId, shipId, toolId, total, res, facing = "") {
    if (!game.user.isGM) return;
    const combat = getCombat();
    const crew = combat.crew[crewId], sh = combat.ships[shipId];
    if (!crew || !sh) return;
    const tool = S.boardingTool(toolId);
    const made = total >= S.BOARDING_DC;

    if (!made) {
      // Whiff protection: you are latched to the OUTSIDE of their hull, not
      // adrift. Session 4 lost a crew member to a hole exactly this size.
      await ChatMessage.create({
        content: `<b>Boarding</b> · ${esc(crew.name)} — <b>${total}</b> vs DC ${S.BOARDING_DC} with the ${esc(tool.name)} — <b style="color:#f2b03d">short</b>.<br>` +
                 `<i>Latched to the outside of <b>${esc(sh.name)}</b>'s hull, not adrift. Try again next round.</i>`,
        speaker: { alias: "SSV Silver Gull" }, rolls: res.roll ? [res.roll] : undefined });
      return;
    }

    // Build their decks (once) and put their crew on them.
    const hull = hullById(sh.profileId);
    const skin = sh.skin || Object.keys(hull?.skins || {})[0];
    let scene = findDeckScene(sh.name, skin);
    if (!scene && hull) scene = await buildDeckScene({ ...hull, name: sh.name }, skin);
    if (scene) await materialiseCrew(shipId, scene);

    const next = getCombat();
    S.applyStatus(next.ships[shipId], "boarded", { round: next.round, src: crew.name });
    await saveCombat(next);

    await ChatMessage.create({
      content: `<b>Boarding</b> · ${esc(crew.name)} — <b>${total}</b> vs DC ${S.BOARDING_DC} with the ${esc(tool.name)} — <b style="color:#42d16a">aboard ${esc(sh.name)}</b>.` +
               (tool.loud ? `<br><span style="color:#f2b03d">The mine was heard across the whole hull. No surprise.</span>` : "") +
               (S.BREACH_FACINGS.includes(facing) ? `<br>Cut in on her <b>${esc(S.FACING_LABEL[facing])}</b>.` : "") +
               `<br><i>No teleport home — somebody has to physically recover them before this fight ends.</i>`,
      speaker: { alias: "SSV Silver Gull" }, rolls: res.roll ? [res.roll] : undefined });

    // Move whoever controls that crew member onto deck 1 of the boarded hull.
    // `trusted` because THIS is the moment access is granted: the goDeck guard
    // asks whether you are already aboard, and `whereIs` is only written by
    // gmGoToDeck itself — so without it a successful breach refused itself and
    // the boarder never moved.
    const uid = crew.controllerUserId || crew.ownerUserId;
    if (uid) await gmGoToDeck(uid, shipId, 1, { trusted: true, facing: S.BREACH_FACINGS.includes(facing) ? facing : "" });
  }

  /**
   * A dead enemy crew member takes their station with them.
   * ship-combat.md has always said so; nothing enforced it until now.
   */
  async function onBoardingCrewDeath(tokenDoc) {
    if (!isActiveGM()) return;
    const shipId = tokenDoc.getFlag(MODULE_ID, "shipId");
    const crewId = tokenDoc.getFlag(MODULE_ID, "crewId");
    if (!shipId || !crewId) return;
    const next = getCombat(); const sh = next.ships[shipId]; const c = sh?.crew?.[crewId];
    if (!c || c.dead) return;
    c.dead = true;
    await saveCombat(next);
    const stn = c.station ? (S.station(c.station)?.name || c.station) : null;
    await ChatMessage.create({
      content: `<b>${esc(c.name)}</b> is down aboard <b>${esc(sh.name)}</b>.` +
               (stn ? `<br><b style="color:#42d16a">${esc(stn)} is offline</b> — nobody is working it.` : ""),
      speaker: { alias: "SSV Silver Gull" } });
    refreshUI();
  }

  /** Crew adrift in vacuum. Combat cannot end while anyone is out there. */
  async function gmSetAdrift(userId, adrift) {
    if (!game.user.isGM) return;
    const ship = S.normalize(getState());
    const list = new Set(ship.adriftCrew || []);
    if (adrift) list.add(userId); else list.delete(userId);
    ship.adriftCrew = [...list];
    if (list.size) S.applyStatus(ship, "adrift", { round: getCombat().round });
    else S.clearStatus(ship, "adrift");
    await setState(ship);
    refreshUI();
  }

  /* ---- Cloaking station -------------------------------------------------- */

  const CLOAK_STATUS = { engage: "cloaked", burst: "cloaked", phase: null, decoy: null, stealth: null };

  async function runCloak(crew, isBonus, which) {
    if (!S.systemWorks(getState(), "cloak"))
      return ui.notifications?.warn("The cloaking generator is offline — repair it first.");
    const pw = S.ACTION_POWER[which] || 0;
    if (!spendCheck(pw)) return;
    if (!(await consumeSlot(crew, isBonus ? "bonus" : "action", pw))) return;   // refused: no action left, or not enough power
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
  async function runTurret(crew, isBonus, turretId, turretAction) {
    const t = S.turret(turretId); if (!t) return;
    const ship = S.normalize(getState());
    if (!S.turretBuilt(ship, t.id)) return ui.notifications?.warn(`The ${t.name} has not been rebuilt yet.`);
    if (!S.turretOnline(ship, t.id)) return ui.notifications?.warn(`The ${t.name} is offline.`);
    const pw = S.actionPower({ id: turretAction }) || S.ACTION_POWER.attack;
    if (!spendCheck(pw)) return;

    const hostiles = Object.values(getCombat().ships).filter((s) => s.id !== "gull" && s.disposition !== "ally" && !s.outcome);
    if (!hostiles.length) return ui.notifications?.warn("Nothing to shoot at.");
    const target = hostiles.length === 1 ? hostiles[0].id
      : await chooseDlg(t.name, "Which contact?", hostiles.map((s) => ({ value: s.id, label: `${s.name} — ${shipDistance("gull", s.id) ?? "?"} sq` })));
    if (!target) return;

    const str = strMod();
    const res = await gunToHitDialog(crew, t.gun, str, { noAim: true });
    if (!res) return;
    if (!(await consumeSlot(crew, isBonus ? "bonus" : "action", pw))) return;   // refused: no action left, or not enough power
    if (game.user.isGM) await gmTurretShot(crew.id, t.id, target, res, str);
    else emit({ type: "turretShot", toGM: true, crewId: crew.id, turretId: t.id, shipId: target, total: res.total, die: res.die, str, byName: crew.name, userId: game.user.id });
  }

  async function gmTurretShot(crewId, turretId, shipId, res, str) {
    if (!game.user.isGM) return;
    const t = S.turret(turretId); if (!t) return;
    const combat = getCombat(); const sh = combat.ships[shipId]; if (!sh) return;
    const crew = combat.crew[crewId] || { name: "Gunner" };
    const from = shipPoint("gull"), me = shipPoint(shipId);
    const measured = !!(from && me);
    const facing = measured ? S.facingFrom(me, from) : "fore";
    const dist = shipDistance("gull", shipId);
    const range = S.rangePenalty(t.gun, dist ?? 0);
    const unmeasured = measured ? "" :
      `<br><span style="color:#f2b03d">No token on the map for one of these ships — resolved at point-blank on the bow.</span>`;
    if (dist != null && !range.ok) {
      await ChatMessage.create({ content: `<b>${esc(t.name)}</b> — <b>${esc(sh.name)}</b> is out of range (${dist} sq, max ${t.gun.longMax}).`, speaker: gunSpeaker });
      return;
    }
    const adjust = crew.buff?.turretAim ? 2 : 0;
    const ac = S.shipAC(sh, Object.values(sh.crew || {}));
    const total = res.total + range.toHit + adjust;
    const crit = res.die === 20;
    const hit = total >= ac[facing] || crit;
    const acKnown = !!sh.revealed?.ac;
    const tail = `${range.toHit ? ` · long ${range.toHit}` : ""}${adjust ? ` · Adjust Aim +${adjust}` : ""}`;
    const bits = `AC ${ac[facing]} on the ${S.FACING_LABEL[facing]}${tail}`;
    const bitsPublic = acKnown ? bits : `the ${S.FACING_LABEL[facing]}${tail}`;
    if (!hit) {
      await sayRedacted(
        `<b>${esc(t.name)}</b> · ${esc(crew.name)} vs <b>${esc(sh.name)}</b>: <b>${total}</b> vs ${bitsPublic} — <b>miss</b>.${unmeasured}`,
        acKnown ? "" : `<b>${esc(sh.name)}</b> — AC <b>${ac[facing]}</b> on the ${esc(S.FACING_LABEL[facing])}; the shot read <b>${total}</b>.`,
        gunSpeaker);
      return;
    }
    playFx({ kind: "tracer", fromId: "gull", toId: sh.id, color: 0x38e1c4, width: 4 });
    // Shield-breaker hits harder into a hull that is already open.
    const alreadyDown = S.hasStatus(sh, "shields_down") || !sh.shield.on;
    const bonusDie = (t.signature === "shieldbreak" && alreadyDown) ? " + 1d6" : "";
    const dmgRoll = await new Roll(`${t.gun.damage} + ${str}${bonusDie}`).evaluate();
    let raw = Math.max(1, dmgRoll.total);
    if (range.halve) raw = Math.floor(raw / 2);
    await ChatMessage.create({
      content: `<b>${esc(t.name)}</b> · ${esc(crew.name)} vs <b>${esc(sh.name)}</b>: <b>${total}</b> vs ${bitsPublic} — <b style="color:#42d16a">${crit ? "CRITICAL" : "hit"}</b>${unmeasured}`,
      speaker: gunSpeaker, rolls: [dmgRoll] });
    if (!acKnown) await ChatMessage.create({
      content: `<span style="opacity:.7">GM · </span><b>${esc(sh.name)}</b> — AC <b>${ac[facing]}</b> on the ${esc(S.FACING_LABEL[facing])}; the shot read <b>${total}</b>.`,
      speaker: gunSpeaker, whisper: gmIds() });
    await gmApplyDamage(shipId, raw, facing, { crit, type: t.signature === "emp" ? "energy" : "kinetic",
      ignoreArmour: t.signature === "pierce" });
    await gmTurretSignature(t, shipId, crew.name);
    refreshUI();
  }

  /** What each mount does beyond damage. This is why you rebuilt it. */
  async function gmTurretSignature(t, shipId, byName) {
    if (!game.user.isGM) return;
    if (!getCombat().ships[shipId]) return;
    // Every dialog happens FIRST, then one read-modify-write with nothing awaited
    // in the middle. The EMP picker can sit open while a player fires at the same
    // hull; writing a record read before it would revert their damage.
    let applyStatus = null, dropShield = false, note = "";
    switch (t.signature) {
      case "shieldbreak":
        applyStatus = "shields_down"; dropShield = true;
        note = "Their shields blow out — <b>Shields Down</b>."; break;
      case "freeze":
        applyStatus = "frozen";
        note = "Hull frosted — <b>Frozen</b>. The next kinetic hit has advantage and doubles."; break;
      case "emp": {
        const pick = await chooseDlg(t.name, "Which system does the charge take out?",
          [{ value: "engines_disabled", label: "Engines — no movement or maneuver" },
           { value: "shields_down", label: "Shields — the facing drops" }]);
        if (!pick) return;
        applyStatus = pick;
        note = pick === "engines_disabled" ? "Their drive dies — <b>Engines Down</b>." : "Their shields drop — <b>Shields Down</b>.";
        break; }
      case "grapple":
        applyStatus = "grappled";
        note = "Caught in the well — <b>Grappled</b>. No movement, and attacks against them have advantage."; break;
      case "spread": note = "Flak spread — the GM may apply the same roll to two more contacts in the arc."; break;
      case "pierce": note = "Armour-piercing — their plating did nothing."; break;
    }
    if (applyStatus || dropShield) {
      const next = getCombat(); const sh = next.ships[shipId];
      if (!sh) return;
      if (dropShield) sh.shield.on = false;
      if (applyStatus) S.applyStatus(sh, applyStatus, { round: next.round || 1, rounds: 1, src: t.name });
      await saveCombat(next);
    }
    if (note) await ChatMessage.create({ content: `<b>${esc(t.name)}</b> — ${note}`, speaker: gunSpeaker });
  }

  /** Adjust Aim: +2 with this mount this round. */
  async function runAdjustAim(crew, isBonus) {
    const pw = S.ACTION_POWER.adjust;
    if (!spendCheck(pw)) return;
    if (!(await consumeSlot(crew, isBonus ? "bonus" : "action", pw))) return;   // refused: no action left, or not enough power
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
    if (!(await consumeSlot(crew, isBonus ? "bonus" : "action", pw))) return;   // refused: no action left, or not enough power
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
    if (!(await consumeSlot(crew, isBonus ? "bonus" : "action", pw))) return;   // refused: no action left, or not enough power
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
    if (!(await consumeSlot(crew, isBonus ? "bonus" : "action", pw))) return;   // refused: no action left, or not enough power
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
    if (!(await consumeSlot(crew, isBonus ? "bonus" : "action", pw))) return;   // refused: no action left, or not enough power
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
    if (!(await consumeSlot(crew, isBonus ? "bonus" : "action", pw))) return;   // refused: no action left, or not enough power
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
    if (!(await consumeSlot(crew, isBonus ? "bonus" : "action", pw))) return;   // refused: no action left, or not enough power
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

    // Painted makes a scan easier; the enemy's Countermeasures make it harder.
    // They cancel, exactly like advantage and disadvantage.
    const scanAdv = S.statusMods(ship).scanAdv;
    const painted = scanAdv > 0;
    const shrouded = scanAdv < 0;
    if (shrouded) ui.notifications?.info("Her countermeasures are up — this sweep is at disadvantage.");
    const mod = abilityMod("int");
    const res = await stationRollValue(crew, "int", painted, shrouded);
    if (!res) return;
    if (!(await consumeSlot(crew, isBonus ? "bonus" : "action", pw))) return;   // refused: no action left, or not enough power

    const result = S.scanResult(res.total - S.SCAN_DC);
    const facing = (() => { const a = shipPoint("gull"), b = shipPoint(ship.id); return a && b ? S.facingFrom(b, a) : null; })();

    if (game.user.isGM) await gmApplyScan(chosen, result, crew.name, res, painted);
    else {
      emit({ type: "applyScan", toGM: true, shipId: chosen, result, gunnerName: crew.name, total: res.total, die: res.die, painted, userId: game.user.id });
      // Wait for the reveal to actually come back rather than guessing at 250 ms.
      // On a slow round-trip the old fixed delay rendered the readout from the
      // PRE-scan record, so ASTRA announced "VITALS" over a hatched panel.
      await awaitCombat((c) => {
        const r = c.ships?.[chosen]?.revealed; if (!r) return true;   // ship gone — stop waiting
        return Object.entries(result.reveal).every(([k, want]) =>
          !want || (k === "deckmap" ? (r.deckmap || 0) >= want : !!r[k]));
      });
    }

    // Show the readout to whoever ran it.
    const after = getCombat().ships[chosen];
    if (after) S.openScan(S.shipView(after, { isGM: game.user.isGM }), result, { facing });
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
  async function stationRollValue(crew, abil, advantage, disadvantage) {
    const mod = abilityMod(abil);
    // Whatever the Captain and Engineer handed this seat this round.
    const buff = crew.buff || { flat: 0, adv: false, die: "" };
    if (buff.adv) advantage = true;
    // They cancel one for one, as they do everywhere else in 5e.
    if (advantage && disadvantage) { advantage = false; disadvantage = false; }
    const swing = advantage ? " <b>Advantage</b> — the target is Painted."
                : disadvantage ? " <b style=\"color:#e0454d\">Disadvantage</b> — her countermeasures are up." : "";
    const choice = await rollChoiceDialog(
      `Scan — ${crew.name}`,
      `<p>Intelligence <b>${signMod(mod)}</b> is added automatically.${swing}</p>` +
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
      roll = await new Roll(advantage ? "2d20kh" : disadvantage ? "2d20kl" : "1d20").evaluate();
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
      // Read the DOCUMENT, not the canvas. shipTokenObject() only sees the scene
      // the GM is currently LOOKING at, so the moment anyone boarded — which
      // switches the GM's view to a deck — the Gull lost her position entirely:
      // `measured` went false, the arc check was skipped, the range check was
      // skipped, and every enemy fired at point-blank against her bow.
      const a = shipIconActor();
      if (!a) return null;
      const sc = spaceScene();
      const t = sc?.tokens.find((x) => x.actorId === a.id);
      if (t) {
        const g = sc.grid?.size || 100;
        return { x: t.x + (t.width || 1) * g / 2, y: t.y + (t.height || 1) * g / 2, rotation: t.rotation || 0 };
      }
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
    // The grid comes from the scene the ships are ACTUALLY on. Looking it up via
    // `ships["gull"]` — a record that has never existed — always missed and fell
    // through to the active scene, which is the wrong one the moment anybody is
    // standing on a deck.
    const combat = getCombat();
    const sceneOf = (id) => (id === "gull" ? null : game.scenes.get(combat.ships[id]?.sceneId));
    const sc = sceneOf(aId) || sceneOf(bId) || canvas?.scene || game.scenes.active;
    return Math.round(Math.hypot(b.x - a.x, b.y - a.y) / (sc?.grid?.size || 100));
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
  const gmIds = () => ChatMessage.getWhisperRecipients("GM").map((u) => u.id);

  /**
   * Post a public line and, when it differs, whisper the real numbers to the GM.
   *
   * Chat was the module's largest leak: every shot published the enemy's exact
   * AC and every damage line published their hull total, so the crew learned by
   * shooting what the rules say they must scan for. Anything the party has
   * actually revealed still shows publicly — secrecy is a consequence of not
   * having scanned, not a permanent blindfold.
   */
  async function sayRedacted(publicHtml, gmHtml, speaker) {
    await ChatMessage.create({ content: publicHtml, speaker });
    if (gmHtml && gmHtml !== publicHtml) {
      await ChatMessage.create({ content: `<span style="opacity:.7">GM · </span>${gmHtml}`, speaker, whisper: gmIds() });
    }
  }

  /** `opts.unavoidable` bypasses decoys and phase charges — the rift weapons. */
  async function gmApplyDamage(shipId, raw, facing, opts = {}) {
    if (!game.user.isGM) return null;
    const next = getCombat();
    const isGull = shipId === "gull";
    const sh = isGull ? S.normalize(getState()) : next.ships[shipId];
    if (!sh) return null;

    // The Cloaking Officer's two banked defences, finally spent. Both used to be
    // incremented by gmCloak and read by nothing at all, so Decoy Drop and Phase
    // Shift cost an action and a chunk of power to change a number nobody used.
    if (isGull && !opts.unavoidable) {
      if ((sh.decoys || 0) > 0) {
        sh.decoys -= 1;
        await setState(sh);
        playFx({ kind: "impact", shipId: "gull", facing, absorbed: true });
        await ChatMessage.create({
          content: `<b>Decoy</b> — the shot goes into a ghost of the Gull and she is untouched. ` +
                   `<span style="opacity:.7">${sh.decoys} decoy${sh.decoys === 1 ? "" : "s"} still running.</span>`,
          speaker: { alias: "SSV Silver Gull" } });
        refreshUI();
        return { final: 0, facing, absorbed: raw, shielded: true, steps: [{ label: "decoy", value: 0 }], consumed: [], outcome: "" };
      }
      if ((sh.phaseCharges || 0) > 0) {
        sh.phaseCharges -= 1;
        await setState(sh);
        playFx({ kind: "seq", path: "jb2a.misty_step.01.blue", atShip: "gull", scale: 0.6 });
        await ChatMessage.create({
          content: `<b style="color:#b06bf0">Phase shift</b> — the hit lands on a Gull that is not quite there. It simply does not happen. ` +
                   `<span style="opacity:.7">${sh.phaseCharges} charge${sh.phaseCharges === 1 ? "" : "s"} left.</span>`,
          speaker: { alias: "SSV Silver Gull" } });
        refreshUI();
        return { final: 0, facing, absorbed: raw, shielded: true, steps: [{ label: "phase", value: 0 }], consumed: [], outcome: "" };
      }
    }

    const res = S.resolveDamage(sh, raw, facing, opts);
    sh.hull.cur = Math.max(0, sh.hull.cur - res.final);
    // "Next hit" statuses are spent by this hit, in the same write that applies it.
    for (const id of res.consumed || []) S.clearStatus(sh, id);
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

    // The beat: a contained cool ring if the shields ate it, a hot expanding
    // burst if it went through. Absorbed hits never shake the screen.
    // The teal ring means "the shields ate it", which is a shields-tier fact about
    // an enemy. Broadcast the plain ring for a hull the crew have not scanned;
    // the GM's own client still gets the true one.
    const shieldsKnown = isGull || !!sh.revealed?.shields;
    const absorbed = res.final === 0 || res.shielded;
    runFx({ kind: "impact", shipId, facing, absorbed });
    if (game.user.isGM) emit({ type: "vfx", userId: game.user.id,
      spec: { kind: "impact", shipId, facing, absorbed: shieldsKnown ? absorbed : false } });
    // Only the Gull's own crew get the red alert — being shot at is their beat.
    if (isGull && res.final > 0) playFx({ kind: "alert", fraction: res.final / Math.max(1, sh.hull.max) });
    playFx(res.final > 0
      ? { kind: "seq", path: "jb2a.explosion.02", atShip: shipId, scale: 0.6 }
      : { kind: "seq", path: "jb2a.shield.01.outro_fast.blue", atShip: shipId, scale: 0.5 });

    const name = isGull ? getState().name : sh.name;
    const work = res.steps.map((x) => `${x.label} → ${x.value}`).join(" · ");
    const face = esc(S.FACING_LABEL[facing] || facing);
    // Your own ship's numbers are always yours. An enemy's are only public once
    // the Science officer has actually resolved her vitals.
    const numbers = isGull || !!sh.revealed?.ac;
    const full = res.final === 0
      ? `<b>${esc(name)}</b> — <b style="color:#38e1c4">absorbed</b> the hit on the ${face}.`
      : `<b>${esc(name)}</b> takes <b style="color:#e0454d">${res.final}</b> to the <b>${face}</b>` +
        `${res.absorbed ? ` <span style="opacity:.7">(${res.absorbed} absorbed)</span>` : ""} — hull <b>${sh.hull.cur}</b>/${sh.hull.max}`;
    const vague = res.final === 0
      ? `<b>${esc(name)}</b> — the round <b style="color:#38e1c4">washes off</b> her ${face}. Something is up over there.`
      : `<b>${esc(name)}</b> — <b style="color:#e0454d">${esc(S.hitWord(res.final, sh.hull.max))}</b> to the <b>${face}</b>. ` +
        `<span style="opacity:.8">She is <b>${esc(S.hullWord(sh.hull.cur, sh.hull.max))}</b>.</span>` +
        `<br><span style="opacity:.55;font-size:11px">Exact hull unknown — run a sensor sweep.</span>`;
    const tail = outcome === "derelict"
      ? `<br><b style="color:#7fb4c8">DERELICT</b> — drifting and unpowered. Her crew are alive; she can be boarded and salvaged.`
      : outcome === "destroyed" ? `<br><b style="color:#e0454d">DESTROYED</b> — no wreck worth taking.` : "";
    const working = `<br><span style="opacity:.55;font-size:11px">${esc(work)}</span>`;
    await sayRedacted(`${numbers ? full : vague}${tail}${numbers ? working : ""}`,
                      numbers ? "" : `${full}${tail}${working}`, { alias: "SSV Silver Gull" });
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
    const node = which === "exterior" ? sk.exterior : S.decksForSkin(hull, skin).decks[String(deck)];
    return node ? hull.artRoot + node.art : "";
  };
  /**
   * The moving version, where the pack ships one.
   *
   * Foundry plays a video texture on a token happily; an <img> in the fleet card
   * or the spawn browser does not. So the card gets the still and the TOKEN gets
   * the .webm — three hulls in the fleet have an animated exterior sitting unused.
   */
  const hullArtAnim = (hull, skin, which = "exterior", deck = "1") => {
    if (!hull) return "";
    const sk = hull.skins?.[skin] || Object.values(hull.skins || {})[0];
    if (!sk) return "";
    const node = which === "exterior" ? sk.exterior : S.decksForSkin(hull, skin).decks[String(deck)];
    return node?.artAnim ? hull.artRoot + node.artAnim : "";
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
  let fleetCrewSelected = "";   // which enemy seat the GM has folded open
  const _lastHull = new Map();  // shipId -> {cur, ghost, until} for the damage ghost
  const GHOST_MS = 700;         // the beat the plan specifies for the lost segment
  let _ghostTimer = null;
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
    // The keybinding is `restricted`, but the module API sits on globalThis for
    // everyone — without this guard a player could open the GM's board from the
    // console. The data is redacted either way; the board itself is not theirs.
    if (!game.user.isGM) return ui.notifications?.warn("Fleet Command is the GM's board.");
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
    // The damage ghost: how much hull each card lost since it was last drawn, so
    // the bar shows what was TAKEN and not only the new total. Purely local and
    // transient — it is a 700 ms visual, not state, so it never goes near the
    // reveal boundary or the world setting.
    const live = new Set();
    const now = performance.now();
    for (const v of out) {
      if (!v || !v.hull) continue;
      live.add(v.id);
      const prev = _lastHull.get(v.id);
      if (prev && prev.cur > v.hull.cur) {
        // A fresh hit: start the ghost clock.
        _lastHull.set(v.id, { cur: v.hull.cur, ghost: prev.cur - v.hull.cur, until: now + GHOST_MS });
      } else if (!prev || prev.cur !== v.hull.cur) {
        _lastHull.set(v.id, { cur: v.hull.cur, ghost: 0, until: 0 });
      }
      // Keep showing it for the whole beat. refreshFleet fires on every world
      // write, so a ghost computed only from "changed since last render" was
      // erased about a frame after it appeared and nobody ever saw it.
      const rec = _lastHull.get(v.id);
      if (rec && rec.ghost > 0 && now < rec.until) v._ghost = rec.ghost;
    }
    for (const id of [..._lastHull.keys()]) if (!live.has(id)) _lastHull.delete(id);
    // …and come back once when the beat is over, so the bar settles.
    if (out.some((v) => v && v._ghost) && !_ghostTimer) {
      _ghostTimer = setTimeout(() => { _ghostTimer = null; refreshFleet(); }, GHOST_MS + 40);
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
      select: (id) => { if (fleetSelected !== id) fleetCrewSelected = ""; fleetSelected = id; renderFleet(); },
      crest: crestFor,
      artUrl: (p) => (/^(https?:|modules\/|worlds\/|data\/)/i.test(p) ? p : assetUrl(p)),
      spawn: () => spawnShipBrowser(),
      rollInitiative: () => gmRollInitiative(),
      endShipTurn: () => gmEndShipTurn(),
      runShip: (id) => gmRunShip(id),
      removeShip: (id) => gmRemoveShip(id),
      crewId: fleetCrewSelected,
      // Click a seat to open its actions; click it again to fold it away.
      driveCrew: (shipId, crewId) => {
        if (fleetSelected !== shipId) { fleetSelected = shipId; fleetCrewSelected = crewId; }
        else fleetCrewSelected = fleetCrewSelected === crewId ? "" : crewId;
        renderFleet();
      },
      crewAct: async (shipId, crewId, actionId) => { await gmCrewAct(shipId, crewId, actionId); refreshFleet(); },
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
    const tokenArt = hullArtAnim(hull, opts.skin) || sh.art;

    // A vehicle actor per ship, so it can hold a token, be targeted, and be
    // deleted cleanly when the fight ends.
    const folder = await ensureFolder("Actor", "SSV — Enemy Ships");
    const actor = await Actor.create({
      name: sh.name, type: "vehicle", folder: folder?.id ?? null,
      img: sh.art || undefined,
      prototypeToken: { name: sh.name, width: size.width, height: size.height,
        texture: { src: tokenArt || undefined, scaleX: size.scale, scaleY: size.scale, fit: "contain" },
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

  /** Crew are RECORDS here. Actors and tokens are made lazily, only on boarding. */
  function buildCrew(hull, opts) {
    const crew = {};
    const names = CREW_NAMES[hull.faction] || CREW_NAMES[""];
    // S.assignSeats holds the one-crew-per-station rule and the bridge-first
    // ordering; it is pure, so the selftest can hold it to that.
    const seats = S.assignSeats(hull.crew.roles, Math.min(opts.crew, hull.crew.max));
    const counts = {};
    seats.forEach((seat, n) => {
      const cid = `c${n + 1}`;
      const label = names[seat.roleId] || seat.roleId;
      counts[seat.roleId] = (counts[seat.roleId] || 0) + 1;
      const total = seats.filter((x) => x.roleId === seat.roleId).length;
      crew[cid] = {
        id: cid, name: total > 1 ? `${label} ${counts[seat.roleId]}` : label, roleId: seat.roleId,
        station: seat.station,
        block: CREW_BLOCKS[seat.roleId]?.[opts.tier - 1] || "", tier: opts.tier,
        // Spread them over the decks the hull actually has, so a boarding party
        // does not find the entire complement standing in one room.
        deck: 1 + (n % Math.max(1, hull.decks || 1)),
        action: false, bonus: false, dead: false
      };
    });
    return crew;
  }

  async function ensureFolder(type, name) {
    let f = game.folders.find((x) => x.type === type && x.name === name);
    if (!f) f = await Folder.create({ name, type, color: "#12455a" });
    return f;
  }

  async function gmRollInitiative() {
    if (!game.user.isGM) return;
    // Roll FIRST, then read: each `await new Roll(...)` yields, and a snapshot
    // taken before them wrote back over anything that landed in between —
    // including, with a big fleet, the last ship someone had just damaged.
    const ids = ["gull", ...Object.keys(getCombat().ships).filter((k) => k !== "gull")];
    const rolls = [];
    for (const id of ids) {
      const r = await new Roll("1d20").evaluate();
      rolls.push({ shipId: id, roll: r.total });
    }
    rolls.sort((a, b) => b.roll - a.roll);
    const next = getCombat();
    next.initiative = rolls.filter((e) => e.shipId === "gull" || next.ships[e.shipId]);
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
    } else if (next.ships[startingId]) {
      const sh = next.ships[startingId];
      for (const c of Object.values(sh.crew)) { c.action = false; c.bonus = false; c.maneuver = null; c.mp = 0; c.gun = null; }
      S.expireStatuses(sh, next.round);
      sh.shield.secondary = null;
      // An unspent Focus Fire / Sensor Lock does not keep across the round.
      sh.aimBonus = 0;
    }
    // The combat write goes FIRST, with nothing awaited since it was read. The
    // Gull's own ship state is a different setting, so it is handled after — a
    // setState in the middle used to yield and let another client's combat write
    // be discarded by the save below.
    await saveCombat(next);
    if (startingId === "gull") {
      const ship = getState();
      let dirty = false;
      if (ship.shield.secondary) { ship.shield.secondary = null; dirty = true; }
      if (S.expireStatuses(ship, next.round).length) dirty = true;
      if (dirty) await setState(ship);
    }
    refreshFleet();
  }

  /* ---- driving an enemy ship -------------------------------------------- */

  /**
   * What to CALL an enemy crew member in public.
   *
   * Their names and roles are manifest-tier scan results, and the enemy-turn
   * chat was handing them over for free: "Apostle Gunner 1 fires the Votive
   * Lance" told the crew the complement, the faction's rank names and which seat
   * was manned, all without a scan. Unscanned, the ship acts — not a person.
   */
  function crewLabel(sh, crew) {
    // NOTE: this decides what goes into a PUBLIC chat message, so it must not
    // consider who is currently looking. A GM-only branch here put the real name
    // into a message every player then read.
    if (sh?.revealed?.crew) return crew?.name || "someone";
    const st = crew?.station || "";
    return { captain: "Her bridge", pilot: "Her helm", gunner_port: "Her port mount",
             gunner_starboard: "Her starboard mount", engineer: "Someone below decks",
             shields_officer: "Her shield board", science: "Her sensor watch" }[st] || "Someone aboard";
  }

  /** Rotate or step an enemy's own token, the same way the pilot moves the Gull. */
  async function moveEnemyToken(shipId, kind) {
    const sh = getCombat().ships[shipId]; if (!sh?.tokenId) return false;
    const scene = game.scenes.get(sh.sceneId) || game.scenes.active;
    const tdoc = scene?.tokens.get(sh.tokenId); if (!tdoc) return false;
    const g = scene.grid?.size || 100;
    const upd = { _id: tdoc.id };
    if (kind === "toward" || kind === "away") {
      const me = shipPoint(shipId), them = shipPoint("gull");
      if (!me || !them) return false;
      const dx = them.x - me.x, dy = them.y - me.y;
      const len = Math.hypot(dx, dy);
      // Same square: there is no direction to move OR to face. Do nothing rather
      // than snapping her nose to due north.
      if (!len) return false;
      const sign = kind === "toward" ? 1 : -1;
      upd.x = Math.round(tdoc.x + (dx / len) * g * sign);
      upd.y = Math.round(tdoc.y + (dy / len) * g * sign);
      // Point the nose along the direction of travel — rotation 0 = nose up, and
      // forward is (sin r, -cos r), matching the pilot's own convention. A ship
      // running away therefore turns its stern to you, which is the point.
      const tx = dx * sign, ty = dy * sign;
      upd.rotation = (Math.round((Math.atan2(tx, -ty) * 180) / Math.PI) % 360 + 360) % 360;
    } else if (kind === "face") {
      // Come About: turn the bow onto the Gull. A blind 90° spin left the standing
      // orders unable to predict which arc would bear, so the gunners' orders were
      // planned and then refused.
      const me = shipPoint(shipId), them = shipPoint("gull");
      if (!me || !them) return false;
      const dx = them.x - me.x, dy = them.y - me.y;
      if (!dx && !dy) return false;
      upd.rotation = (Math.round((Math.atan2(dx, -dy) * 180) / Math.PI) % 360 + 360) % 360;
    } else {
      const delta = { rotL45: -45, rotR45: 45, rotL90: -90, rotR90: 90 }[kind];
      if (delta == null) return false;
      upd.rotation = (((tdoc.rotation || 0) + delta) % 360 + 360) % 360;
    }
    await scene.updateEmbeddedDocuments("Token", [clampToScene(scene, tdoc, upd)]);
    return true;
  }

  /**
   * An enemy gunner shoots at the Gull.
   *
   * The mirror of gmResolveAgainstShip, and deliberately the same shape: measure
   * the facing off the two tokens, roll against THAT facing's AC, and push the
   * damage through gmApplyDamage so shields, armour, resistances, statuses, the
   * impact beat and the red alert all happen exactly as they do for the players.
   */
  async function gmEnemyFire(shipId, crewId, gunId) {
    if (!game.user.isGM) return;
    const combat = getCombat();
    const sh = combat.ships[shipId]; if (!sh) return;
    const crew = sh.crew?.[crewId];
    if (!crew || crew.dead) { ui.notifications?.warn("That seat is empty."); return false; }
    const gun = (sh.guns || []).find((g) => g.id === gunId);
    if (!gun) { ui.notifications?.warn(`${sh.name} has no gun "${gunId}".`); return false; }
    if (!S.gunOnline(sh, gunId)) { ui.notifications?.warn(`${gun.label || gunId} is offline.`); return false; }

    const from = shipPoint(shipId), gull = shipPoint("gull");
    const measured = !!(from && gull);
    // Which of the GULL's facings this shot walks into.
    const facing = measured ? S.facingFrom(gull, from) : "fore";
    // …and which of the ENEMY's arcs the Gull is sitting in. A port broadside
    // cannot fire at something dead ahead; the button's own hint says so.
    const bearing = measured ? S.facingFrom(from, gull) : "fore";
    const arc = String(gun.arc || "fore");
    if (measured && arc !== "all" && arc !== "turret" && arc !== bearing) {
      ui.notifications?.warn(
        `${gun.label || gunId} is a ${arc} mount — the Gull is off her ${S.FACING_LABEL[bearing]}. Come about first.`);
      return false;
    }
    const dist = shipDistance(shipId, "gull");
    const range = S.rangePenalty(gun, dist ?? 0);
    const unmeasured = measured ? "" :
      `<br><span style="color:#f2b03d">One of these ships has no token on the map — this resolved at point-blank on the bow.</span>`;
    if (dist != null && !range.ok) {
      // A gun's maximum range is a systems-tier fact; "she fired and it fell
      // short" is not.
      await sayRedacted(
        sh.revealed?.systems
          ? `<b>${esc(sh.name)}</b> — the ${esc(gun.label || gunId)} cannot reach you (${dist} squares, max ${gun.longMax}).`
          : `<b>${esc(sh.name)}</b> — a shot falls well short of you. Whatever she is carrying, it does not reach this far.`,
        sh.revealed?.systems ? "" : `${esc(gun.label || gunId)} is a ${gun.longMax}-square mount; she is ${dist} squares off.`,
        { alias: esc(sh.name) });
      return false;
    }

    const gullState = S.normalize(getState());
    const ac = S.shipAC(gullState, Object.values(combat.crew || {}));
    // Focus Fire / Sensor Lock, both set by another seat on this ship this round.
    const bonus = Number(sh.aimBonus) || 0;
    const roll = await new Roll(`1d20 + ${Number(gun.toHit) || 0}${bonus ? ` + ${bonus}` : ""}${range.toHit ? ` - ${Math.abs(range.toHit)}` : ""}`).evaluate();
    const die = roll.dice?.[0]?.results?.[0]?.result ?? 0;
    const crit = die === 20;
    const hit = crit || roll.total >= ac[facing];
    const bits = `AC ${ac[facing]} on your ${S.FACING_LABEL[facing]}${range.toHit ? ` · long range ${range.toHit}` : ""}${bonus ? ` · +${bonus} laid on` : ""}`;

    const whoPub = crewLabel(sh, crew);
    await ChatMessage.create({
      content: `<b>${esc(sh.name)}</b> — ${esc(whoPub)} fires the <b>${esc(gun.label || gunId)}</b>: ` +
               `<b>${roll.total}</b> vs ${bits} — ` +
               (hit ? `<b style="color:#e0454d">${crit ? "CRITICAL" : "hit"}</b>` : `<b style="color:#42d16a">miss</b>`) + unmeasured,
      speaker: { alias: esc(sh.name) }, rolls: [roll]
    });
    if (whoPub !== crew.name) await ChatMessage.create({
      content: `<span style="opacity:.7">GM · </span>that was <b>${esc(crew.name)}</b> at ${esc(S.station(crew.station)?.name || crew.station || "no station")}.`,
      speaker: { alias: esc(sh.name) }, whisper: gmIds() });

    // Spend the seat and burn the aim bonus, in one write, before anything awaits.
    { const nx = getCombat(); const t = nx.ships[shipId];
      if (t) { if (t.crew?.[crewId]) t.crew[crewId].action = true; t.aimBonus = 0; }
      await saveCombat(nx); }

    if (!hit) {
      playFx({ kind: "tracer", fromId: shipId, toId: "gull", color: 0x6f97a6, width: 2 });
      refreshUI(); refreshFleet();
      return;
    }
    playFx({ kind: "tracer", fromId: shipId, toId: "gull", color: 0xe0454d });
    playFx({ kind: "seq", path: "jb2a.magic_missile", fromShip: shipId, toShip: "gull" });
    const dmgRoll = await new Roll(String(gun.damage || "1d6")).evaluate();
    let raw = Math.max(1, dmgRoll.total);
    if (range.halve) raw = Math.floor(raw / 2);
    if (crit) raw *= 2;
    await ChatMessage.create({ content: `<b>${esc(sh.name)}</b> — damage${range.halve ? " <span style='opacity:.7'>(halved at long range)</span>" : ""}${crit ? " <span style='opacity:.7'>(doubled)</span>" : ""}`,
      speaker: { alias: esc(sh.name) }, rolls: [dmgRoll] });

    // Frostwatch never shoot the hull — every round is a called shot on a system.
    // This used to apply the hull damage AND the system hit, one line after a
    // comment saying it would not, and one line before a chat message telling the
    // crew their hull had been spared.
    const precise = (sh.abilities || []).includes("precision_fire");
    if (precise) await gmCalledShotGull(sh, raw);
    else await gmApplyDamage("gull", raw, facing, { crit, type: "kinetic" });
    refreshUI(); refreshFleet();
  }

  /**
   * Frostwatch precision: knock a Gull system down INSTEAD of chewing hull.
   *
   * The bite scales with the shot that was rolled, so a heavy gun still hurts —
   * a flat 2 meant a Frostwatch escort needed seventeen hits to break anything,
   * which is not what "every round is a called shot" is supposed to feel like.
   */
  async function gmCalledShotGull(sh, raw = 0) {
    const st = S.normalize(getState());
    const live = Object.entries(st.systemHp || {}).filter(([id, hp]) => hp.cur > 0 && S.SYSTEMS.find((x) => x.id === id));
    if (!live.length) {
      // Nothing left to break — the round has to go somewhere.
      return gmApplyDamage("gull", raw, "fore", { type: "kinetic" });
    }
    // Take the healthiest WORKING system: they are disabling the ship, not
    // finishing off something already broken.
    const pick = live.sort((a, b) => b[1].cur - a[1].cur)[0];
    const bite = Math.max(1, Math.min(S.SYSTEM_HP_MAX, Math.round(raw / 5)));
    st.systemHp[pick[0]].cur = Math.max(0, st.systemHp[pick[0]].cur - bite);
    st.systems[pick[0]] = S.systemState(st.systemHp[pick[0]]);
    await setState(st);
    const label = S.SYSTEMS.find((x) => x.id === pick[0])?.label || pick[0];
    await ChatMessage.create({
      content: `<b>${esc(sh.name)}</b> — <b style="color:#7fd4e8">precision fire</b>: your <b>${esc(label)}</b> takes the round (<b>−${bite}</b>), not your hull.`,
      speaker: { alias: esc(sh.name) } });
  }

  /**
   * Drive one enemy seat. Every button in the fleet crew strip lands here, and
   * so does every step of `▶ Run`, so hand-play and standing orders can never
   * drift apart.
   */
  async function gmCrewAct(shipId, crewId, actionId, { quiet = false } = {}) {
    if (!game.user.isGM) return;
    const combat = getCombat();
    const sh = combat.ships[shipId]; if (!sh) return;
    const crew = sh.crew?.[crewId]; if (!crew || crew.dead) return;
    // Every public line names the SHIP's station, not the person, until the
    // manifest has actually been scanned.
    const who = crewLabel(sh, crew);
    const say = async (html) => { if (!quiet) await ChatMessage.create({ content: html, speaker: { alias: esc(sh.name) } }); };
    const spend = async (mut) => {
      // Read-modify-write with nothing awaited in between — the trap this repo
      // has already been bitten by three times.
      const nx = getCombat(); const t = nx.ships[shipId]; if (!t) return;
      if (t.crew?.[crewId]) t.crew[crewId].action = true;
      if (mut) mut(t, nx);
      await saveCombat(nx);
    };

    if (actionId.startsWith("e_fire:")) return gmEnemyFire(shipId, crewId, actionId.slice(7));

    switch (actionId) {
      case "e_close": case "e_open": {
        const ok = await moveEnemyToken(shipId, actionId === "e_close" ? "toward" : "away");
        if (!ok) { ui.notifications?.warn(`${sh.name} has no token on this scene to move.`); return false; }
        await spend();
        const d = shipDistance(shipId, "gull");
        return say(`<b>${esc(who)}</b> ${actionId === "e_close" ? "closes" : "opens the range"} — now <b>${d ?? "?"}</b> squares off.`);
      }
      case "e_about": {
        const ok = await moveEnemyToken(shipId, "face");
        if (!ok) { ui.notifications?.warn(`${sh.name} has no token on this scene to turn.`); return false; }
        await spend();
        return say(`<b>${esc(who)}</b> brings her about, presenting a fresh arc.`);
      }
      case "e_evade":
        await spend((t, nx) => S.applyStatus(t, "evasive", { round: nx.round, rounds: 1, src: who }));
        return say(`<b>${esc(who)}</b> throws her into an evasive weave — <b>+4 AC</b> until her next turn.`);
      case "e_rally": {
        const bad = (sh.statuses || []).find((x) => S.STATUSES[x.id]?.kind === "bad");
        if (!bad) { await spend(); return say(`<b>${esc(who)}</b> calls the deck steady — nothing to shake off.`); }
        await spend((t) => S.clearStatus(t, bad.id));
        return say(`<b>${esc(who)}</b> rallies the crew — <b>${esc(S.STATUSES[bad.id].label)}</b> is cleared.`);
      }
      case "e_focus":
        await spend((t) => { t.aimBonus = (Number(t.aimBonus) || 0) + 2; });
        return say(`<b>${esc(who)}</b> calls the target — every mount aboard gets <b>+2 to hit</b>.`);
      case "e_ram": {
        const d = shipDistance(shipId, "gull");
        if (d != null && d > 1) { ui.notifications?.warn(`${sh.name} is ${d} squares off — close to 1 before ramming.`); return false; }
        await spend((t, nx) => S.applyStatus(t, "ramming_committed", { round: nx.round, rounds: 1, src: who }));
        const dmg = await new Roll("4d6").evaluate();
        await ChatMessage.create({ content: `<b>${esc(sh.name)}</b> — <b style="color:#e0454d">RAMMING</b>. ${esc(who)} puts the nose through you.`,
          speaker: { alias: esc(sh.name) }, rolls: [dmg] });
        const gull = shipPoint("gull"), me = shipPoint(shipId);
        await gmApplyDamage("gull", dmg.total, (gull && me) ? S.facingFrom(gull, me) : "fore", { type: "kinetic" });
        // She takes it too — half, on her own bow. Re-read first: the ram may have
        // been the blow that finished her, and a wreck does not take a second hit.
        if (getCombat().ships[shipId]?.outcome) return true;
        return gmApplyDamage(shipId, Math.floor(dmg.total / 2), "fore", { type: "kinetic" });
      }
      case "e_repair": {
        const hurt = Object.entries(sh.systemHp || {}).filter(([, hp]) => hp.cur < hp.max).sort((a, b) => a[1].cur - b[1].cur)[0];
        if (!hurt) { await spend(); return say(`<b>${esc(who)}</b> finds nothing broken.`); }
        // Report the value the WRITE produced, not the one the snapshot predicted:
        // another station may have repaired or broken the same system meanwhile.
        let landed = null;
        await spend((t) => {
          const hp = t.systemHp[hurt[0]]; hp.cur = Math.min(hp.max, hp.cur + 2);
          t.systems[hurt[0]] = S.systemState(hp);
          if (hurt[0] === "shields" && hp.cur > 0) S.clearStatus(t, "shields_down");
          landed = hp.cur;
        });
        const lbl = S.SYSTEMS.find((x) => x.id === hurt[0])?.label || hurt[0];
        return sh.revealed?.systems
          ? say(`<b>${esc(who)}</b> patches the <b>${esc(lbl)}</b> — back to ${landed ?? "?"}/${S.SYSTEM_HP_MAX}.`)
          : sayRedacted(`<b>${esc(who)}</b> is working on something below decks. Whatever you broke, it is being put back.`,
                        `she repaired <b>${esc(lbl)}</b> to ${landed ?? "?"}/${S.SYSTEM_HP_MAX}.`,
                        { alias: esc(sh.name) });
      }
      case "e_reroute":
        await spend((t) => { t.aimBonus = (Number(t.aimBonus) || 0) + 2; });
        return say(`<b>${esc(who)}</b> dumps the reactor into the mounts — <b>+2</b> on this ship's next shot.`);
      case "e_shield": {
        const me = shipPoint(shipId), gull = shipPoint("gull");
        const face = (me && gull) ? S.facingFrom(me, gull) : "fore";
        await spend((t) => { t.shield.on = true; t.shield.facing = face; });
        // Which arc she covered is a shields-tier scan result. Unscanned, the crew
        // see the ship do something, not what it was.
        return sh.revealed?.shields
          ? say(`<b>${esc(who)}</b> walks the shield round to <b>${esc(S.FACING_LABEL[face])}</b> — the arc you are actually on.`)
          : sayRedacted(`<b>${esc(who)}</b> works the shield board — something shifts across her hull.`,
                        `she moved the shield to <b>${esc(S.FACING_LABEL[face])}</b>, the arc the Gull is on.`,
                        { alias: esc(sh.name) });
      }
      case "e_jam": {
        // Applied to the GULL, so it expires on her clock and shows as a chip on
        // her own card. It used to be announced and applied nowhere.
        await spend();
        const g = S.normalize(getState());
        S.applyStatus(g, "jammed", { round: getCombat().round || 1, rounds: 1, src: sh.name });
        await setState(g);
        return say(`<b>${esc(who)}</b> floods your fire-control band — <b>the Gull's gunnery rolls have disadvantage</b> until her next turn.`);
      }
      case "e_lock": {
        // Ghost Their Sensors, spent: the Cloaking Officer's block eats exactly
        // one enemy lock, then clears.
        const gullNow = S.normalize(getState());
        if (gullNow.scanBlock) {
          gullNow.scanBlock = false; await setState(gullNow);
          await spend();
          return say(`<b>${esc(who)}</b> reaches for a lock and finds <b>nothing there</b> — the Gull's sensor ghost holds.`);
        }
        await spend((t) => { t.aimBonus = (Number(t.aimBonus) || 0) + 2; });
        return say(`<b>${esc(who)}</b> lays a sensor lock — <b>+2</b> on this ship's next attack.`);
      }
      case "e_cm":
        await spend((t, nx) => S.applyStatus(t, "shrouded", { round: nx.round, rounds: 2, src: crew.name }));
        return say(`<b>${esc(who)}</b> spins up countermeasures — <b>scans of this hull have disadvantage</b> for a round.`);
      case "e_brace":
        await spend((t, nx) => S.applyStatus(t, "rerouted", { round: nx.round, rounds: 1, src: who }));
        return say(`<b>${esc(who)}</b> shores up a bulkhead — <b>+2 AC</b> this round.`);
      case "e_board":
        await spend();
        return gmEnemyBoard(shipId);
      case "e_nogun":
        ui.notifications?.warn(`${sh.name} has no gun online.`);
        return false;
      default:
        ui.notifications?.warn(`Unknown enemy action "${actionId}".`);
        return false;
    }
  }

  /**
   * Run a whole enemy turn from its doctrine. Same primitives as hand-driving,
   * executed in order, with one summary line so the table sees what happened.
   */
  async function gmRunShip(shipId) {
    if (!game.user.isGM) return;
    const combat = getCombat(); const sh = combat.ships[shipId];
    if (!sh) return;
    if (sh.outcome) return ui.notifications?.warn(`${sh.name} is ${sh.outcome} — she does not act.`);
    const doc = S.doctrine(sh.doctrine); const f = S.faction(sh.faction);
    const dist = shipDistance(shipId, "gull");
    const plan = S.enemyStandingOrders(sh, { distance: dist ?? 4 });

    await ChatMessage.create({
      content: `<b>${esc(sh.name)}</b> — standing orders<br><i>${esc(doc.name)}: ${esc(doc.hint)}</i>` +
               (f ? `<br><span style="opacity:.75">Wants: ${esc(f.wants)}</span>` : "") +
               `<br><span style="opacity:.55;font-size:11px">${plan.length} order${plan.length === 1 ? "" : "s"} at ${dist ?? "?"} squares</span>`,
      speaker: { alias: esc(sh.name) }, whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id)
    });
    if (!plan.length) { ui.notifications?.info(`${sh.name}: nobody left to give an order to.`); return; }
    const skipped = [];
    for (const step of plan) {
      // Re-read every step: an earlier order may have killed a seat or ended the ship.
      const now = getCombat().ships[shipId];
      if (!now || now.outcome) break;
      const who = now.crew?.[step.crewId]?.name || step.crewId;
      if (step.skipped || !step.action) { skipped.push(`${who} — ${step.why}`); continue; }
      const done = await gmCrewAct(shipId, step.crewId, step.action);
      // gmCrewAct returns falsy when it refused (out of arc, out of range, no
      // token). Say so: a silently skipped order reads as the button not working.
      if (done === false) skipped.push(`${who} — could not carry out ${step.action.replace(/^e_/, "").replace(/:/, " ")}`);
    }
    if (skipped.length) await ChatMessage.create({
      content: `<b>${esc(sh.name)}</b> — orders not carried out:<br>` + skipped.map((x) => `· ${esc(x)}`).join("<br>"),
      speaker: { alias: esc(sh.name) }, whisper: gmIds() });
    refreshUI(); refreshFleet();
  }

  async function gmRemoveShip(shipId) {
    if (!game.user.isGM) return;
    const sh = getCombat().ships[shipId];
    if (!sh) return;
    await destroyShipDocuments(sh);
    // Read AFTER the deletes: they await document updates, and a snapshot taken
    // before them would roll back anything that landed while tokens were going.
    const next = getCombat();
    if (!next.ships[shipId]) return;
    const order = (next.initiative || []).map((e) => e.shipId);
    const at = order.indexOf(shipId);
    delete next.ships[shipId];
    next.initiative = (next.initiative || []).filter((e) => e.shipId !== shipId);
    // Hand the turn on rather than leaving activeShip pointing at a ship that is
    // gone: gmEndShipTurn reads indexOf(-1) as "wrapped", which skipped the rest
    // of the round and bumped the round counter.
    if (next.activeShip === shipId) {
      const rest = next.initiative.map((e) => e.shipId);
      next.activeShip = (at >= 0 && rest[at]) || rest[0] || "gull";
    }
    await saveCombat(next);
    refreshFleet();
  }

  /** Delete the token and actor a ship record is bound to, wherever they are.
   *  Also its deck scene and the hidden crew standing on it — leaving those
   *  behind meant the next ship of the same name inherited last fight's corpses. */
  async function destroyShipDocuments(sh) {
    // The crew actors this hull instantiated on boarding.
    const crewActors = game.actors.filter((a) => a.getFlag(MODULE_ID, "shipId") === sh.id
      || (a.getFlag(MODULE_ID, "boardingCrew") && a.getFlag(MODULE_ID, "shipId") === sh.id));
    for (const a of crewActors) {
      for (const scene of game.scenes) {
        const ids = scene.tokens.filter((t) => t.actorId === a.id).map((t) => t.id);
        if (ids.length) { try { await scene.deleteEmbeddedDocuments("Token", ids); } catch (e) {} }
      }
      try { await a.delete(); } catch (e) {}
    }
    // …and any token flagged as hers, whoever the actor is.
    for (const scene of game.scenes) {
      const ids = scene.tokens.filter((t) => t.getFlag(MODULE_ID, "shipId") === sh.id).map((t) => t.id);
      if (ids.length) { try { await scene.deleteEmbeddedDocuments("Token", ids); } catch (e) {} }
    }
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
    let n = 0;
    for (const sh of Object.values(getCombat().ships)) { await destroyShipDocuments(sh); n++; }
    // …then read, for the same reason gmRemoveShip does.
    const next = getCombat();
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
    // …and the boarding crew and enemy deck scenes the fight built. They were
    // created per ship instance and never removed, so a season of fights left a
    // sidebar full of dead Apostle gunners and a scene list full of hulls nobody
    // will board again. The GULL's own deck scene is kept — it is a real asset.
    const crewActors = game.actors.filter((a) => a.getFlag(MODULE_ID, "boardingCrew"));
    for (const a of crewActors) {
      for (const scene of game.scenes) {
        const ids = scene.tokens.filter((t) => t.actorId === a.id).map((t) => t.id);
        if (ids.length) { try { await scene.deleteEmbeddedDocuments("Token", ids); } catch (e) {} }
      }
      try { await a.delete(); n++; } catch (e) {}
    }
    blockCache.clear();
    const gullName = getState().name;
    const decks = game.scenes.filter((sc) => sc.getFlag(MODULE_ID, "deckScene")
      && !String(sc.getFlag(MODULE_ID, "deckScene")).startsWith(gullName));
    // "Never delete what someone is standing on" used to check only the GM's own
    // current scene — a player left aboard an enemy would have had the floor
    // deleted from under them.
    const occupied = new Set();
    for (const [uid, w] of Object.entries(next.whereIs || {})) {
      if (!w?.shipId || w.shipId === "gull") continue;
      const sh2 = getCombat().ships[w.shipId];
      const nm = sh2 ? deckSceneName(sh2.name, sh2.skin || "") : "";
      for (const sc of game.scenes) if (nm && sc.getFlag(MODULE_ID, "deckScene") === nm) occupied.add(sc.id);
    }
    for (const u of game.users) if (u.active && u.viewedScene) occupied.add(u.viewedScene);
    for (const sc of decks) {
      if (sc.active || occupied.has(sc.id)) continue;
      try { await sc.delete(); n++; } catch (e) {}
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
  /**
   * RETIRED — the shields are a PIXI overlay now (refreshOverlays), which works
   * for every hull on the board instead of only the Gull.
   *
   * The old path composited ship + shield onto a canvas and uploaded a uniquely
   * named .webp on every shield change, never deleting the previous one, so
   * Data/ssv-ship-icon/ grew by a file per shield allocation ever made. It still
   * sets the token's BASE art once (so the actor has a picture) and then stops.
   */
  async function updateShipIcon(force) {
    if (!game.user.isGM) return;
    // Only the hull VARIANT changes the base art now; shields are drawn live.
    const sig = S.shipVariant(S.normalize(getState()));
    if (!force && sig === _iconSig) return;
    if (_iconBusy) { _iconAgain = true; return; }        // coalesce rapid shield changes
    _iconBusy = true;
    try {
      const a = await ensureShipIconActor(); if (!a) return;
      // Point at the packaged art directly instead of compositing and uploading.
      const src = `modules/${MODULE_ID}/assets/ship/ship-${S.shipVariant(S.normalize(getState()))}.webp`;
      await a.update({ img: src, "prototypeToken.texture.src": src, "prototypeToken.name": a.name });
      for (const scene of game.scenes) {
        const ups = scene.tokens.filter((t) => t.actorId === a.id).map((t) => ({ _id: t.id, "texture.src": src }));
        if (ups.length) await scene.updateEmbeddedDocuments("Token", ups);
      }
      _iconSig = sig;
      refreshOverlays();
      return;
      /* eslint-disable no-unreachable */
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

  /* ====================================================================== */
  /*  The canvas overlay: shield arcs, firing cones, status badges, and FX   */
  /*                                                                          */
  /*  One PIXI container per ship, glued to its token. This replaces the old  */
  /*  approach of compositing the shield onto a .webp and uploading it —      */
  /*  which was one upload per shield change, never deleted the old file, and */
  /*  could not have worked for a board full of enemy hulls.                  */
  /*                                                                          */
  /*  Everything here is native PIXI: no dependency, and it draws in the same */
  /*  palette as the HUD. Sequencer/JB2A, where present, is garnish on top.   */
  /* ====================================================================== */

  const OVL = { teal: 0x38e1c4, amber: 0xf2b03d, red: 0xe0454d, green: 0x42d16a, violet: 0xb06bf0, ink: 0xcfeef0 };
  const overlays = new Map();          // shipId -> PIXI.Container
  let _pulseTicker = null;

  const fxLayer = () => (typeof canvas === "undefined" ? null : (canvas.interface || canvas.controls || canvas.stage));
  const pixiOk = () => typeof PIXI !== "undefined" && typeof canvas !== "undefined" && canvas?.ready;

  /** Fill+stroke a polygon under PIXI v7 (beginFill/drawPolygon) and v8 (poly/fill/stroke). */
  function fillPoly(g, pts, color, alpha, lineAlpha, width) {
    if (typeof g.beginFill === "function") {
      g.beginFill(color, alpha); g.lineStyle(width ?? 2, color, lineAlpha ?? 0.5); g.drawPolygon(pts); g.endFill();
    } else {
      g.poly(pts).fill({ color, alpha }).stroke({ width: width ?? 2, color, alpha: lineAlpha ?? 0.5 });
    }
  }

  /** Every ship that currently has a token on this scene. */
  function shipsOnCanvas() {
    const out = [];
    if (typeof canvas === "undefined" || !canvas?.tokens) return out;
    const gullTok = shipTokenObject();
    if (gullTok) out.push({ id: "gull", tok: gullTok, state: S.normalize(getState()) });
    const combat = getCombat();
    for (const sh of Object.values(combat.ships || {})) {
      if (!sh.tokenId) continue;
      const tok = canvas.tokens.placeables.find((t) => t.id === sh.tokenId);
      if (tok) out.push({ id: sh.id, tok, state: sh });
    }
    return out;
  }

  /**
   * Shield arcs, drawn from the token's own footprint so a long corvette gets a
   * long shield and a fat capital a fat one — no art, and it fits all 56 hulls.
   *
   * The UNSHIELDED facings are drawn as hairlines on purpose: that is what makes
   * the shielded arc read as a choice, and what makes flanking legible on the map.
   */
  function drawShieldArcs(g, state, w, h, viewer) {
    const known = viewer.known ? viewer.known.shields : true;
    const sh = state.shield || {};
    const works = S.systemWorks(state, "shields") && !S.statusMods(state).noShield;
    const rx = w * 0.62, ry = h * 0.62;
    const STEPS = 26;
    // fore is up (-y); starboard right; aft down; port left — the pilot's convention.
    const arcs = { fore: [-Math.PI / 4, Math.PI / 4], starboard: [Math.PI / 4, 3 * Math.PI / 4],
                   aft: [3 * Math.PI / 4, 5 * Math.PI / 4], port: [5 * Math.PI / 4, 7 * Math.PI / 4] };
    for (const [face, [a0, a1]] of Object.entries(arcs)) {
      const lit = known && works && sh.on && sh.facing === face;
      const micro = known && works && sh.secondary === face;
      const pts = [];
      for (let i = 0; i <= STEPS; i++) {
        const t = a0 + (a1 - a0) * (i / STEPS);
        // rotate so 0 = up
        pts.push(rx * Math.sin(t), -ry * Math.cos(t));
      }
      if (lit || micro) {
        const inner = [];
        for (let i = STEPS; i >= 0; i--) {
          const t = a0 + (a1 - a0) * (i / STEPS);
          inner.push(rx * 0.84 * Math.sin(t), -ry * 0.84 * Math.cos(t));
        }
        fillPoly(g, [...pts, ...inner], lit ? OVL.teal : OVL.violet, lit ? 0.26 : 0.16, lit ? 0.85 : 0.55, lit ? 3 : 2);
      } else if (known) {
        // hairline: you can see the arc exists and is not covered
        if (typeof g.lineStyle === "function") { g.lineStyle(2, OVL.teal, 0.30); g.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]); }
        else { g.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]); g.stroke({ width: 2, color: OVL.teal, alpha: 0.30 }); }
      }
    }
  }

  /** The forward firing cone for whichever guns this ship has selected. */
  function drawCones(g, shipId, grid) {
    const combat = getCombat();
    if (!combat.active) return;
    const crew = shipId === "gull" ? Object.values(combat.crew) : Object.values(combat.ships[shipId]?.crew || {});
    const gunIds = [...new Set(crew.filter((c) => c.gun).map((c) => c.gun))];
    if (!gunIds.length) return;
    const half = Math.PI / 4, fwd = -Math.PI / 2, a0 = fwd - half, a1 = fwd + half, STEPS = 22;
    const arcPts = (r, from, to) => { const o = []; for (let i = 0; i <= STEPS; i++) { const t = from + (to - from) * (i / STEPS); o.push(r * Math.cos(t), r * Math.sin(t)); } return o; };
    for (const id of gunIds.sort((x, y) => (S.gun(y)?.longMax || 0) - (S.gun(x)?.longMax || 0))) {
      const gun = S.gun(id); if (!gun) continue;
      const rG = Math.max(1, gun.shortMax) * grid, rR = Math.max(gun.shortMax + 0.5, gun.longMax) * grid;
      fillPoly(g, [...arcPts(rR, a0, a1), ...arcPts(rG, a1, a0)], OVL.red, 0.10, 0.35);
      fillPoly(g, [0, 0, ...arcPts(rG, a0, a1)], OVL.green, 0.14, 0.5);
    }
  }

  /** Only the GM and this ship's own gunners should see its firing arcs. */
  function canSeeCones(shipId) {
    if (game.user.isGM) return true;
    if (shipId !== "gull") return false;
    return Object.values(getCombat().crew).some(
      (c) => (c.station === "gunner_port" || c.station === "gunner_starboard") && c.controllerUserId === game.user.id);
  }

  /** The Gull's own placed token on the current scene. */
  function shipTokenObject() {
    const a = shipIconActor();
    if (!a || typeof canvas === "undefined" || !canvas?.tokens) return null;
    return canvas.tokens.placeables.find((t) => t.document?.actorId === a.id) || null;
  }

  const shipIdForToken = (tokenId) => {
    if (shipTokenObject()?.id === tokenId) return "gull";
    const hit = Object.values(getCombat().ships || {}).find((sh) => sh.tokenId === tokenId);
    return hit ? hit.id : null;
  };

  function clearOverlays() {
    for (const c of overlays.values()) { try { c.parent?.removeChild(c); c.destroy({ children: true }); } catch (e) {} }
    overlays.clear();
  }

  function refreshOverlays() {
    if (!pixiOk()) return;
    clearOverlays();
    const layer = fxLayer(); if (!layer) return;
    const grid = canvas.scene?.grid?.size || 100;
    for (const { id, tok, state } of shipsOnCanvas()) {
      // Everything drawn here goes through the reveal boundary first, so an
      // enemy's shield facing is not quietly readable off the map.
      const viewer = id === "gull" ? { known: { shields: true } }
                                   : S.shipView(getCombat().ships[id], { isGM: game.user.isGM });
      const c = new PIXI.Container();
      const w = (tok.document.width || 1) * grid, h = (tok.document.height || 1) * grid;
      const arcs = new PIXI.Graphics();
      drawShieldArcs(arcs, state, w, h, viewer);
      c.addChild(arcs);
      if (canSeeCones(id)) { const cone = new PIXI.Graphics(); drawCones(cone, id, grid); c.addChild(cone); }
      c.__arcs = arcs;
      overlays.set(id, c);
      layer.addChild(c);
      positionOverlay(id, tok);
    }
    startPulse();
  }

  function positionOverlay(shipId, tok) {
    const c = overlays.get(shipId); if (!c) return;
    tok = tok || (shipId === "gull" ? shipTokenObject() : canvas.tokens?.placeables.find((t) => t.id === getCombat().ships[shipId]?.tokenId));
    if (!tok) return;
    const m = tok.mesh;
    if (m && m.position && Number.isFinite(m.position.x)) { c.position.set(m.position.x, m.position.y); c.rotation = Number.isFinite(m.rotation) ? m.rotation : 0; }
    else {
      const grid = canvas.scene?.grid?.size || 100;
      const w = (tok.document.width || 1) * grid, h = (tok.document.height || 1) * grid;
      c.position.set(tok.document.x + w / 2, tok.document.y + h / 2);
      c.rotation = (tok.document.rotation || 0) * Math.PI / 180;
    }
  }
  function positionAllOverlays() { for (const id of overlays.keys()) positionOverlay(id); }

  /** One shared ticker breathes every shield arc — not one per ship. */
  function startPulse() {
    if (_pulseTicker || !overlays.size || typeof canvas?.app?.ticker === "undefined") return;
    let t = 0;
    _pulseTicker = () => {
      t += 0.024;
      const a = 0.82 + Math.sin(t) * 0.18;
      for (const c of overlays.values()) if (c.__arcs) c.__arcs.alpha = a;
    };
    canvas.app.ticker.add(_pulseTicker);
  }
  function stopPulse() { if (_pulseTicker && canvas?.app?.ticker) { canvas.app.ticker.remove(_pulseTicker); _pulseTicker = null; } }

  /* ---- transient effects ------------------------------------------------- */

  const shipCenter = (shipId) => {
    const p = shipPoint(shipId);
    return p ? { x: p.x, y: p.y } : null;
  };

  /** A tracer from one hull to another. ~260ms, then it fades. */
  function fxTracer(fromId, toId, { color = OVL.amber, width = 3 } = {}) {
    if (!pixiOk()) return;
    const a = shipCenter(fromId), b = shipCenter(toId);
    if (!a || !b) return;
    const layer = fxLayer(); if (!layer) return;
    const g = new PIXI.Graphics();
    if (typeof g.lineStyle === "function") { g.lineStyle(width, color, 0.95); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); }
    else { g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width, color, alpha: 0.95 }); }
    layer.addChild(g);
    const t0 = performance.now();
    const tick = () => {
      const k = (performance.now() - t0) / 260;
      if (k >= 1) { try { g.parent?.removeChild(g); g.destroy(); } catch (e) {} canvas.app.ticker.remove(tick); return; }
      g.alpha = 1 - k;
    };
    canvas.app.ticker.add(tick);
  }

  /**
   * The hit itself. Absorbed and penetrating must be tellable apart WITHOUT
   * reading: absorbed is a cool, contained ring on the struck arc; penetrating is
   * a hot expanding burst. Absorbed never shakes the screen — that one rule is
   * what keeps a long firefight tolerable.
   */
  function fxImpact(shipId, facing, { absorbed = false } = {}) {
    if (!pixiOk()) return;
    const c = shipCenter(shipId); if (!c) return;
    const layer = fxLayer(); if (!layer) return;
    const tok = shipId === "gull" ? shipTokenObject() : canvas.tokens?.placeables.find((t) => t.id === getCombat().ships[shipId]?.tokenId);
    const grid = canvas.scene?.grid?.size || 100;
    const w = ((tok?.document.width) || 1) * grid, h = ((tok?.document.height) || 1) * grid;
    const rot = ((tok?.document.rotation) || 0) * Math.PI / 180;
    // put the burst on the struck edge, in the token's own frame
    const off = { fore: [0, -h * 0.5], aft: [0, h * 0.5], port: [-w * 0.5, 0], starboard: [w * 0.5, 0] }[facing] || [0, 0];
    const px = c.x + off[0] * Math.cos(rot) - off[1] * Math.sin(rot);
    const py = c.y + off[0] * Math.sin(rot) + off[1] * Math.cos(rot);
    const g = new PIXI.Graphics();
    layer.addChild(g);
    const t0 = performance.now(), dur = absorbed ? 420 : 620;
    const color = absorbed ? OVL.teal : OVL.red;
    const rMax = absorbed ? Math.max(w, h) * 0.42 : Math.max(w, h) * 0.30;
    const tick = () => {
      const k = (performance.now() - t0) / dur;
      if (k >= 1) { try { g.parent?.removeChild(g); g.destroy(); } catch (e) {} canvas.app.ticker.remove(tick); return; }
      g.clear();
      const r = absorbed ? rMax * (0.75 + k * 0.25) : rMax * (0.2 + k * 1.5);
      const alpha = (1 - k) * (absorbed ? 0.8 : 0.95);
      if (typeof g.lineStyle === "function") { g.lineStyle(absorbed ? 4 : 3, color, alpha); g.drawCircle(px, py, r); }
      else { g.circle(px, py, r).stroke({ width: absorbed ? 4 : 3, color, alpha }); }
    };
    canvas.app.ticker.add(tick);
  }

  /**
   * "We are being hit." Four tiers off the FRACTION of max hull, so it reads the
   * same on a 150-hull corvette and a 1200-hull capital. Rate-limited hard, and
   * the GM is capped at the gentlest tier — they are watching, not being shot at.
   */
  let _lastAlert = 0;
  function fxRedAlert(fraction) {
    if (typeof document === "undefined") return;
    const now = performance.now();
    if (now - _lastAlert < 1200) return;
    _lastAlert = now;
    let tier = fraction >= 0.25 ? 3 : fraction >= 0.12 ? 2 : fraction > 0 ? 1 : 0;
    if (!tier) return;
    if (game.user.isGM) tier = 1;
    let el = document.getElementById("ssv-alert");
    if (!el) { el = document.createElement("div"); el.id = "ssv-alert"; document.body.appendChild(el); }
    el.className = `ssv-alert t${tier}`;
    el.style.display = "block";
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.display = "none"; }, tier === 3 ? 900 : tier === 2 ? 700 : 500);
    if (tier >= 2 && canvas?.stage) shakeCanvas(tier === 3 ? 9 : 5);
  }

  /** Shake the stage pivot, corrected for zoom, and always restore the base. */
  let _shaking = false;
  function shakeCanvas(px) {
    if (_shaking || !canvas?.stage) return;
    _shaking = true;
    const base = { x: canvas.stage.pivot.x, y: canvas.stage.pivot.y };
    const scale = canvas.stage.scale?.x || 1;
    const amp = px / scale;
    const t0 = performance.now(), dur = 340;
    const tick = () => {
      const k = (performance.now() - t0) / dur;
      if (k >= 1) { canvas.stage.pivot.set(base.x, base.y); canvas.app.ticker.remove(tick); _shaking = false; return; }
      const decay = (1 - k) * amp;
      canvas.stage.pivot.set(base.x + (Math.random() - 0.5) * decay * 2, base.y + (Math.random() - 0.5) * decay * 2);
    };
    canvas.app.ticker.add(tick);
  }

  /* ---------------------------------------------------------------------- */
  /*  Playing a visual on EVERY screen                                        */
  /*                                                                          */
  /*  Every fx call in this module is made from inside a `gm*` handler, which  */
  /*  returns early on a player's client — so the tracers, the impact rings,   */
  /*  the red alert and the screen shake were only ever drawn for the GM. The  */
  /*  players, who are the ones being shot at, saw a silent map.               */
  /*                                                                          */
  /*  playFx runs the effect locally and, from the GM, broadcasts it so every  */
  /*  client draws its own copy against its own canvas.                        */
  /* ---------------------------------------------------------------------- */
  function runFx(spec) {
    if (!spec || typeof spec !== "object") return;
    // Every id in a spec is scene-scoped. A viewer standing on a different scene
    // (a boarding deck, say) must not draw an impact against their own canvas.
    const onThisScene = (id) => {
      if (!id) return true;
      if (id === "gull") return !!shipTokenObject();
      const sh = getCombat().ships[id];
      return !!(sh && sh.sceneId && canvas?.scene?.id === sh.sceneId);
    };
    for (const k of ["shipId", "fromId", "toId", "atShip", "fromShip", "toShip"]) {
      if (spec[k] && !onThisScene(spec[k])) return;
    }
    canvasSafe(`fx ${spec.kind}`, () => {
      switch (spec.kind) {
        case "impact": fxImpact(spec.shipId, spec.facing, { absorbed: !!spec.absorbed }); break;
        case "tracer": fxTracer(spec.fromId, spec.toId, { color: spec.color, width: spec.width }); break;
        case "alert":  fxRedAlert(Number(spec.fraction) || 0); break;
        case "seq":    fx(spec.path, { atShip: spec.atShip, fromShip: spec.fromShip, toShip: spec.toShip, scale: spec.scale }); break;
      }
    });
  }
  function playFx(spec) {
    runFx(spec);
    if (game.user.isGM) emit({ type: "vfx", spec, userId: game.user.id });
  }

  /* ---------------------------------------------------------------------- */
  /*  Breach markers                                                          */
  /*                                                                          */
  /*  Four rings around the target while the boarding picker is open — one per */
  /*  arc, the one you are flying on lit — so the choice is a place on the map */
  /*  and not four words in a dropdown.                                        */
  /* ---------------------------------------------------------------------- */
  let _breachMarks = null;
  function hideBreachMarkers() {
    canvasSafe("breach markers", () => {
      if (!_breachMarks) return;
      _breachMarks.parent?.removeChild(_breachMarks);
      _breachMarks.destroy({ children: true });
      _breachMarks = null;
    });
  }
  function showBreachMarkers(shipId, litFacing) {
    hideBreachMarkers();
    canvasSafe("breach markers", () => {
      if (!pixiOk()) return;
      const layer = fxLayer(); if (!layer) return;
      const tok = canvas.tokens?.placeables.find((t) => t.id === getCombat().ships[shipId]?.tokenId);
      if (!tok) return;
      const grid = canvas.scene?.grid?.size || 100;
      const w = (tok.document.width || 1) * grid, h = (tok.document.height || 1) * grid;
      const c = new PIXI.Container();
      c.position.set(tok.center?.x ?? tok.document.x, tok.center?.y ?? tok.document.y);
      c.rotation = ((tok.document.rotation || 0) * Math.PI) / 180;
      // Just OUTSIDE the hull, in the token's own frame, so they rotate with her.
      const at = { fore: [0, -h * 0.62], aft: [0, h * 0.62], port: [-w * 0.62, 0], starboard: [w * 0.62, 0] };
      for (const [face, [ox, oy]] of Object.entries(at)) {
        const g2 = new PIXI.Graphics();
        const lit = face === litFacing;
        const r = Math.max(12, Math.min(w, h) * 0.16);
        if (typeof g2.lineStyle === "function") {
          g2.lineStyle(lit ? 4 : 2, OVL.red, lit ? 0.95 : 0.5);
          g2.drawCircle(ox, oy, r);
          if (lit) { g2.lineStyle(2, OVL.red, 0.6); g2.drawCircle(ox, oy, r * 1.45); }
        } else {
          g2.circle(ox, oy, r).stroke({ width: lit ? 4 : 2, color: OVL.red, alpha: lit ? 0.95 : 0.5 });
          if (lit) g2.circle(ox, oy, r * 1.45).stroke({ width: 2, color: OVL.red, alpha: 0.6 });
        }
        c.addChild(g2);
      }
      layer.addChild(c);
      _breachMarks = c;
    });
  }

  /** Sequencer/JB2A garnish. A module update should break sparkles, not combat. */
  function fx(effectPath, { atShip, fromShip, toShip, scale = 1 } = {}) {
    try {
      if (!game.modules.get("sequencer")?.active || typeof Sequence === "undefined") return;
      const seq = new Sequence();
      const a = fromShip ? shipCenter(fromShip) : null, b = (toShip || atShip) ? shipCenter(toShip || atShip) : null;
      if (!b) return;
      const e = seq.effect().file(effectPath).scale(scale);
      if (a) e.atLocation(a).stretchTo(b); else e.atLocation(b);
      seq.play();
    } catch (e) { /* garnish only */ }
  }

  /* The old single-ship cone lived here. It is now one of several things the
     per-ship overlay above draws, so every hull on the board gets its arcs, its
     cone and its shield facings — not just the Gull. These three names are kept
     because the hooks and refreshUI call them. */
  /**
   * Canvas work is called from hooks that fire per frame, so it has always been
   * wrapped in try/catch. It used to swallow — which is how a call to a function
   * deleted in a refactor survived for a whole release looking like "the arcs
   * just don't draw". Report once per distinct message instead.
   */
  const _reported = new Set();
  function canvasSafe(label, fn) {
    try { return fn(); }
    catch (e) {
      const key = `${label}:${e.message}`;
      if (!_reported.has(key)) {
        _reported.add(key);
        console.error(`${MODULE_ID} | ${label} failed —`, e);
        if (game.user?.isGM) ui.notifications?.error(`Ship Combat: ${label} failed — ${e.message}. See the console.`);
      }
    }
  }
  const drawGunCone = () => canvasSafe("canvas overlay", refreshOverlays);
  const positionGunCone = () => canvasSafe("overlay position", positionAllOverlays);
  const clearGunCone = () => canvasSafe("overlay teardown", clearOverlays);

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
    // A boarding-crew token dropping to 0 HP takes its station offline. Watch the
    // actor's HP rather than the token so it works whether the damage came from
    // the sheet, a macro, or midi-qol.
    Hooks.on("updateActor", (actor, change) => {
      if (!isActiveGM()) return;
      if (!actor.getFlag(MODULE_ID, "boardingCrew")) return;
      if (change?.system?.attributes?.hp?.value === undefined) return;
      if ((actor.system?.attributes?.hp?.value ?? 1) > 0) return;
      for (const scene of game.scenes) {
        for (const t of scene.tokens) {
          if (t.actorId === actor.id && t.getFlag(MODULE_ID, "crewId")) onBoardingCrewDeath(t);
        }
      }
    });
    // Unlinked tokens carry their own HP in the delta.
    Hooks.on("updateToken", (doc, change) => {
      if (!isActiveGM()) return;
      if (!doc.getFlag(MODULE_ID, "crewId")) return;
      const hp = change?.delta?.system?.attributes?.hp?.value ?? doc.actor?.system?.attributes?.hp?.value;
      if (hp !== undefined && hp <= 0) onBoardingCrewDeath(doc);
    });

    // Firing-arc cone on the map: (re)build on canvas ready / token add-remove; follow the ship every frame.
    Hooks.on("canvasReady", () => { drawGunCone(); });
    // Is this token one of ours? Cached per render pass — refreshToken fires per
    // token per animation frame, so this must not walk the ship list each time.
    let _shipTokIds = new Set(), _shipTokStamp = 0;
    const shipTokenIds = () => {
      const now = performance.now();
      if (now - _shipTokStamp < 500) return _shipTokIds;
      const ids = new Set();
      const g = shipTokenObject(); if (g) ids.add(g.id);
      for (const sh of Object.values(getCombat().ships || {})) if (sh.tokenId) ids.add(sh.tokenId);
      _shipTokIds = ids; _shipTokStamp = now;
      return ids;
    };
    const isShipToken = (doc) => doc && (shipTokenIds().has(doc.id) || doc.actorId === shipIconActor()?.id);
    Hooks.on("createToken", (doc) => { if (isShipToken(doc)) { _shipTokStamp = 0; drawGunCone(); } });
    Hooks.on("deleteToken", (doc) => { _shipTokStamp = 0; drawGunCone(); });
    Hooks.on("updateToken", (doc, change) => {
      if (!isShipToken(doc)) return;
      if ("width" in change || "height" in change) drawGunCone(); else positionGunCone();
    });
    // refreshToken fires each animation frame — keep the overlays glued on while ships move and turn.
    Hooks.on("refreshToken", (tok) => { if (overlays.size && isShipToken(tok?.document)) { canvasSafe("overlay follow", () => positionOverlay(shipIdForToken(tok.document.id), tok)); } });
    Hooks.on("canvasTearDown", () => { stopPulse(); clearOverlays(); });
    drawGunCone();
    /* Esc closes whatever this module has on TOP, not whatever it happens to know
     * about. Before this the handler only knew the console and the fleet board,
     * so pressing Esc over the scan readout or a mini-game closed the console
     * underneath and left the modal stranded on an empty screen.
     *
     * Capture phase, so we can stop Foundry's own Esc handling for our layers —
     * but only when one of ours is actually open. */
    const ESC_STACK = [
      { id: "ssv-scan", close: () => S.closeScan() },
      // Abort, not close: these two are TIMED and the action is already spent, so
      // tearing them down without their fail path ate the whole repair.
      { id: "ssv-nav-game", close: () => S.abortNavGame() },
      { id: "ssv-repair-puzzle", close: () => S.abortRepairPuzzle() },
      { id: "ssv-item-browser", close: () => S.closeItemBrowser() },
      { id: "ssv-fleet", close: () => closeFleet(), open: () => fleetOpen() },
      { id: "ssv-ship-console", close: () => closeConsole(), open: () => consoleOpen() }
    ];
    window.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      // A Foundry window opened ON TOP of one of ours owns the key — closing our
      // layer out from under it strands the dialog on an empty screen.
      const app = document.querySelector(".application:not(.minimized), dialog[open]");
      if (app && !app.closest("#ssv-ship-console, #ssv-fleet, .sgib-overlay, .srp-overlay, .sng-overlay, .sgscan")) {
        return;
      }
      for (const layer of ESC_STACK) {
        const showing = layer.open ? layer.open() : !!document.getElementById(layer.id);
        if (!showing) continue;
        ev.preventDefault(); ev.stopImmediatePropagation();
        S.hideInvPop();
        return layer.close();
      }
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
      buildDecks: async (shipId, opts) => {
        if (!game.user.isGM) return null;
        if (!shipId || shipId === "gull") {
          const h = await gullHull();
          return h ? buildDeckScene({ ...h, name: getState().name }, "Original", opts || {}) : null;
        }
        const sh = getCombat().ships[shipId]; if (!sh) return null;
        const h = hullById(sh.profileId); if (!h) return null;
        return buildDeckScene({ ...h, name: sh.name }, sh.skin || Object.keys(h.skins)[0], opts || {});
      },
      goToDeck: (userId, shipId, deck) => gmGoToDeck(userId, shipId, deck, { trusted: true }),
      whereIs: () => getCombat().whereIs || {},
      // Exposed for tools/check_shipcombat.js, which runs every enemy seat action
      // against a stub. A ReferenceError in a branch nothing exercised is exactly
      // how `who` shipped into three functions that never declared it.
      _test: { gmCrewAct, gmEnemyFire, gmRunShip, crewLabel, moveEnemyToken,
               SOCKET_RULES, socketAuthorised },
      getState, setState, defaultState: S.defaultState,
      SYSTEMS: S.SYSTEMS, FACINGS: S.FACINGS, STATIONS: S.STATIONS,
      getCombat, enterCombat, endCombat, nextTurn };
    globalThis.SilverGullShip = mod?.api;
  });
})();
