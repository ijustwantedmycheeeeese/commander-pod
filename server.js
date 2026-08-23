const express = require("express");
const fs = require("fs");
const crypto = require("crypto");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

app.use(express.static("public"));
app.use(express.json({ limit: "1mb" }));

// ---------------- persistent storage (users + decks) ----------------

const DATA_DIR = "/app/data";
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data)); } catch (e) { console.error("Failed to save " + file, e); }
}
const USERS_FILE = DATA_DIR + "/users.json";
const DECKS_FILE = DATA_DIR + "/decks.json";
const CARD_ARCHIVE_FILE = DATA_DIR + "/card_archive.json";
let users = loadJSON(USERS_FILE, {});
let decks = loadJSON(DECKS_FILE, {});
let cardArchive = loadJSON(CARD_ARCHIVE_FILE, {}); // lowercase card name -> full extracted card data
function saveUsers() { saveJSON(USERS_FILE, users); }
function saveDecks() { saveJSON(DECKS_FILE, decks); }
function saveCardArchive() { saveJSON(CARD_ARCHIVE_FILE, cardArchive); }
function archiveKey(name) { return (name || "").toLowerCase().trim(); }
function archiveCard(fields) {
  if (!fields || !fields.name) return;
  cardArchive[archiveKey(fields.name)] = fields;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}
function verifyPassword(password, salt, hash) {
  const test = Buffer.from(hashPassword(password, salt), "hex");
  const stored = Buffer.from(hash, "hex");
  if (test.length !== stored.length) return false;
  return crypto.timingSafeEqual(test, stored);
}

let sessions = {}; // token -> username

// ---------------- game state ----------------

const COLORS = ["#ef4444", "#3b82f6", "#22c55e", "#eab308", "#a855f7", "#ec4899", "#14b8a6", "#f97316"];
let colorIndex = 0;
function nextColor() { return COLORS[colorIndex++ % COLORS.length]; }
function randInt(n) { return Math.floor(Math.random() * n); }
function newId() { return "c_" + Date.now() + "_" + randInt(100000); }

let cards = {};        // battlefield/hand cards, keyed by id
let players = {};      // socket.id -> player state
let targets = {};      // cardId -> [playerId, ...]
let gameState = { log: [] };
let chatLog = [];
let voiceParticipants = new Set();

const PHASES = ["Untap", "Upkeep", "Draw", "Main 1", "Combat", "Main 2", "End Step"];
let turn = { started: false, order: [], activeIndex: 0, phase: "Main 1", turnNumber: 1 };
let combat = { step: "none", attackers: {}, blocks: {}, defendersPending: [] };

const EMPTY_MANA = () => ({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function classifyType(type) {
  if (!type) return "artifact";
  const t = type.toLowerCase();
  if (t.includes("land")) return "mana";
  if (t.includes("creature")) return "creature";
  return "artifact"; // artifacts, enchantments, planeswalkers, instants/sorceries, etc.
}

function basicLandColor(type) {
  if (!type) return null;
  if (type.includes("Plains")) return "W";
  if (type.includes("Island")) return "U";
  if (type.includes("Swamp")) return "B";
  if (type.includes("Mountain")) return "R";
  if (type.includes("Forest")) return "G";
  return null;
}

function parsePT(v) {
  const n = parseInt(v, 10);
  return isNaN(n) ? 0 : n;
}

function parseManaCost(costStr) {
  const cost = { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, hybrid: [], x: false };
  if (!costStr) return cost;
  const tokens = costStr.match(/\{[^}]+\}/g) || [];
  tokens.forEach((tok) => {
    const inner = tok.slice(1, -1).toUpperCase();
    if (inner === "X") { cost.x = true; return; }
    if (/^\d+$/.test(inner)) { cost.generic += parseInt(inner); return; }
    if (["W", "U", "B", "R", "G", "C"].includes(inner)) { cost[inner]++; return; }
    if (inner.includes("/")) {
      const parts = inner.split("/").filter((p) => ["W", "U", "B", "R", "G", "C"].includes(p));
      if (parts.length) cost.hybrid.push(parts);
      return;
    }
    cost.generic += 1; // unknown symbol (e.g. phyrexian) — fall back to 1 generic
  });
  return cost;
}

function canAffordAndPay(pool, cost, xValue) {
  const p = { ...pool };
  for (const c of ["W", "U", "B", "R", "G", "C"]) {
    if (p[c] < cost[c]) return null;
    p[c] -= cost[c];
  }
  for (const pair of cost.hybrid) {
    const colorWithMana = pair.find((c) => p[c] > 0);
    if (!colorWithMana) return null;
    p[colorWithMana]--;
  }
  let genericNeeded = cost.generic + (xValue || 0);
  const spendOrder = ["C", "W", "U", "B", "R", "G"];
  for (const c of spendOrder) {
    while (genericNeeded > 0 && p[c] > 0) { p[c]--; genericNeeded--; }
  }
  if (genericNeeded > 0) return null;
  return p;
}

function extractCardFields(c) {
  const face = (c.card_faces && c.card_faces[0]) || {};
  return {
    name: c.name,
    img: c.image_uris ? c.image_uris.normal : (face.image_uris ? face.image_uris.normal : null),
    type: c.type_line || face.type_line || "",
    manaCost: c.mana_cost || face.mana_cost || "",
    cmc: typeof c.cmc === "number" ? c.cmc : 0,
    colors: c.colors || face.colors || [],
    colorIdentity: c.color_identity || [],
    power: c.power !== undefined ? c.power : face.power,
    toughness: c.toughness !== undefined ? c.toughness : face.toughness,
    loyalty: c.loyalty !== undefined ? c.loyalty : face.loyalty,
    text: c.oracle_text || face.oracle_text || "",
    keywords: c.keywords || [],
    producedMana: c.produced_mana || null
  };
}

// Shape used for cards resting in library/graveyard/exile/commander-zone —
// same attribute set as the archive, minus battlefield-only state (tapped, counters, etc).
function toEntry(c) {
  return {
    name: c.name, img: c.img, type: c.type || "", manaCost: c.manaCost || "",
    cmc: c.cmc || 0, colors: c.colors || [], colorIdentity: c.colorIdentity || [],
    power: c.power, toughness: c.toughness, loyalty: c.loyalty,
    text: c.text || "", keywords: c.keywords || [], producedMana: c.producedMana || null,
    // Preserve commander identity across zone changes — a commander dealing combat damage still
    // counts as commander damage even when it wasn't cast from the command zone this time.
    isCommander: !!c.isCommander
  };
}

function setCommanderFromData(p, slot, data) {
  if (!p || slot < 0 || slot > 1 || !data) return;
  p.commanders[slot] = { ...toEntry(data), tax: 0, battlefieldId: null };
}

// Used when loading a whole deck: unlike setCommanderFromData (a single explicit slot pick),
// this is authoritative for both slots — a slot with no data in the incoming deck is cleared,
// so a stale commander from a previously-loaded deck doesn't linger.
function applyCommandersToPlayer(p, commanders) {
  for (let slot = 0; slot < 2; slot++) {
    const cmd = (commanders || [])[slot];
    if (cmd) setCommanderFromData(p, slot, cmd); else p.commanders[slot] = null;
  }
}

function maskCard(card, viewerId) {
  if (card.faceDown && card.owner !== viewerId) {
    return {
      id: card.id, tapped: card.tapped, faceDown: true, zoneType: card.zoneType, owner: card.owner, ownerColor: card.ownerColor,
      name: null, img: null, type: null, manaCost: null, power: null, toughness: null, counters: 0, isCommander: card.isCommander,
      cmc: null, colors: null, colorIdentity: null, loyalty: null, text: null, keywords: null, producedMana: null
    };
  }
  return card;
}

function broadcastCard(card) {
  for (const [sid, sock] of io.sockets.sockets) {
    sock.emit("cardUpdate", maskCard(card, sid));
  }
}

function broadcastTargets() { io.emit("targets", targets); }
function broadcastTurn() { io.emit("turnState", turn); }
function broadcastCombat() { io.emit("combatState", combat); }
function broadcastVoiceRoster() { io.emit("voiceRoster", Array.from(voiceParticipants)); }

function playersView(viewerId) {
  const out = {};
  for (const id in players) {
    const p = players[id];
    out[id] = {
      name: p.name,
      color: p.color,
      life: p.life,
      cmdr: p.cmdr,
      poison: p.poison,
      mulligans: p.mulligans,
      handKept: p.handKept,
      mana: p.mana,
      landsPlayedThisTurn: p.landsPlayedThisTurn,
      landDropBonus: p.landDropBonus,
      commanders: p.commanders,
      graveyard: p.graveyard,
      exile: p.exile,
      libraryCount: p.library.length,
      library: id === viewerId ? p.library : undefined
    };
  }
  return out;
}

function broadcastPlayers() {
  for (const [sid, sock] of io.sockets.sockets) {
    sock.emit("players", playersView(sid));
  }
}

function pushLog(msg) {
  gameState.log.push(msg);
  if (gameState.log.length > 150) gameState.log.shift();
  io.emit("log", msg);
}

function spawnBattlefieldCard(data) {
  const { owner, faceDown, zoneType, isCommander } = data;
  const p = players[owner];
  const id = newId();
  const card = {
    id, name: data.name, img: data.img, type: data.type || "", manaCost: data.manaCost || "",
    cmc: data.cmc || 0, colors: data.colors || [], colorIdentity: data.colorIdentity || [],
    power: data.power, toughness: data.toughness, loyalty: data.loyalty,
    text: data.text || "", keywords: data.keywords || [], producedMana: data.producedMana || null,
    zoneType: zoneType || classifyType(data.type),
    tapped: false, faceDown: !!faceDown, counters: 0,
    owner, ownerColor: p ? p.color : "#999",
    isCommander: !!isCommander
  };
  cards[id] = card;
  broadcastCard(card);
  return card;
}

function drawN(ownerId, n) {
  const p = players[ownerId];
  if (!p) return 0;
  let drawn = 0;
  for (let i = 0; i < n && p.library.length > 0; i++) {
    const entry = p.library.shift();
    spawnBattlefieldCard({ ...entry, owner: ownerId, faceDown: true, zoneType: "hand" });
    drawn++;
  }
  return drawn;
}

function returnAllHandToLibrary(ownerId) {
  const p = players[ownerId];
  if (!p) return;
  const toRemove = [];
  for (const id in cards) {
    if (cards[id].owner === ownerId && cards[id].zoneType === "hand") {
      p.library.push(toEntry(cards[id]));
      toRemove.push(id);
    }
  }
  toRemove.forEach((id) => {
    delete cards[id];
    if (targets[id]) delete targets[id];
    io.emit("cardRemove", id);
  });
  if (toRemove.length) broadcastTargets();
}

function attemptPlay(p, card, targetZoneType, xValue) {
  if (targetZoneType === "mana") {
    const allowed = 1 + (p.landDropBonus || 0);
    if ((p.landsPlayedThisTurn || 0) >= allowed) {
      return { ok: false, error: `You've already played your land${allowed > 1 ? "s" : ""} this turn (${allowed} allowed).` };
    }
    p.landsPlayedThisTurn = (p.landsPlayedThisTurn || 0) + 1;
    return { ok: true };
  }
  const cost = parseManaCost(card.manaCost);
  const remaining = canAffordAndPay(p.mana, cost, xValue);
  if (!remaining) {
    return { ok: false, error: `Not enough mana to cast ${card.name || "this card"}.` };
  }
  p.mana = remaining;
  return { ok: true };
}

// A commander that leaves the battlefield (dies, gets bounced, etc.) becomes recastable
// again — clear the slot's battlefield reference so castCommander stops rejecting it.
function clearCommanderRef(card) {
  const owner = players[card.owner];
  if (!owner || !card.isCommander) return;
  owner.commanders.forEach((c) => { if (c && c.battlefieldId === card.id) c.battlefieldId = null; });
}

function sendToGraveyardInternal(card) {
  delete cards[card.id];
  if (targets[card.id]) delete targets[card.id];
  io.emit("cardRemove", card.id);
  clearCommanderRef(card);
  const owner = players[card.owner];
  if (owner) owner.graveyard.push(toEntry(card));
}

// ---------------- turn engine ----------------

function advancePhase() {
  if (!turn.started || turn.order.length === 0) return;
  const oldPhase = turn.phase;
  let idx = PHASES.indexOf(turn.phase);
  idx++;
  if (idx >= PHASES.length) {
    idx = 0;
    turn.activeIndex = (turn.activeIndex + 1) % turn.order.length;
    turn.turnNumber++;
  }
  turn.phase = PHASES[idx];
  const activeId = turn.order[turn.activeIndex];
  const activePlayer = players[activeId];

  for (const pid in players) players[pid].mana = EMPTY_MANA(); // mana empties every step/phase

  if (oldPhase === "Combat" && turn.phase !== "Combat") {
    combat = { step: "none", attackers: {}, blocks: {}, defendersPending: [] };
  }
  if (turn.phase === "Combat") {
    combat = { step: "declareAttackers", attackers: {}, blocks: {}, defendersPending: [] };
  }

  if (activePlayer && turn.phase === "Untap") {
    activePlayer.landsPlayedThisTurn = 0;
    for (const id in cards) {
      if (cards[id].owner === activeId && cards[id].tapped) {
        cards[id].tapped = false;
        broadcastCard(cards[id]);
      }
    }
  }
  if (activePlayer && turn.phase === "Draw") {
    const isVeryFirstTurn = turn.turnNumber === 1 && turn.activeIndex === 0;
    if (!isVeryFirstTurn) {
      const drew = drawN(activeId, 1);
      if (drew) pushLog(`${activePlayer.name} drew a card for the turn`);
    } else {
      pushLog(`${activePlayer.name} skips their draw (playing first)`);
    }
  }
  broadcastTurn();
  broadcastCombat();
  broadcastPlayers();
  if (activePlayer) pushLog(`${activePlayer.name} — ${turn.phase}${turn.phase === "Untap" ? ` (Turn ${turn.turnNumber})` : ""}`);
}

function resolveCombatDamage() {
  const deaths = [];
  for (const [attackerId, defenderId] of Object.entries(combat.attackers)) {
    const attacker = cards[attackerId];
    if (!attacker) continue;
    const atkPower = parsePT(attacker.power) + (attacker.counters || 0);
    const atkTough = parsePT(attacker.toughness) + (attacker.counters || 0);
    const blockerId = combat.blocks[attackerId];
    if (blockerId && cards[blockerId]) {
      const blocker = cards[blockerId];
      const defPower = parsePT(blocker.power) + (blocker.counters || 0);
      const defTough = parsePT(blocker.toughness) + (blocker.counters || 0);
      pushLog(`${attacker.name || "A face-down creature"} (${atkPower}/${atkTough}) fights ${blocker.name || "a face-down creature"} (${defPower}/${defTough})`);
      if (atkPower >= defTough) deaths.push(blocker);
      if (defPower >= atkTough) deaths.push(attacker);
    } else {
      const defender = players[defenderId];
      if (defender) {
        defender.life -= atkPower;
        if (attacker.isCommander) defender.cmdr = (defender.cmdr || 0) + atkPower;
        pushLog(`${attacker.name || "A face-down creature"} hits ${defender.name} for ${atkPower}`);
      }
    }
  }
  const seen = new Set();
  deaths.forEach((c) => { if (!seen.has(c.id) && cards[c.id]) { seen.add(c.id); sendToGraveyardInternal(c); } });
  combat = { step: "none", attackers: {}, blocks: {}, defendersPending: [] };
  broadcastCombat();
  broadcastPlayers();
}

// ---------------- decklist parsing + resolution ----------------

function parseDecklistLine(line) {
  line = line.replace(/#.*/, "").trim();
  if (!line) return null;
  let qty = 1;
  let rest = line;
  const qtyMatch = rest.match(/^(\d+)\s*x?\s+(.*)$/i);
  if (qtyMatch) { qty = Math.max(1, parseInt(qtyMatch[1])); rest = qtyMatch[2]; }
  rest = rest.replace(/\s*[\(\[][A-Za-z0-9]+[\)\]]\s*\d*\s*$/, "").trim();
  if (!rest) return null;
  return { qty, name: rest };
}

function parseDecklistNames(text, limit) {
  const lines = (text || "").split("\n");
  const wanted = [];
  for (const line of lines) {
    const parsed = parseDecklistLine(line);
    if (parsed) for (let i = 0; i < parsed.qty; i++) wanted.push(parsed.name);
  }
  if (wanted.length > limit) wanted.length = limit;
  return wanted;
}

// Resolves card names to full archived card data, using the local archive first and
// batching only what's missing through Scryfall's collection endpoint.
async function resolveCardNames(names) {
  const found = [];
  const toFetch = [];
  names.forEach((n) => {
    const cached = cardArchive[archiveKey(n)];
    if (cached) found.push(cached); else toFetch.push(n);
  });

  for (let i = 0; i < toFetch.length; i += 75) {
    const batch = toFetch.slice(i, i + 75);
    const identifiers = batch.map((n) => ({ name: n }));
    const r = await fetch("https://api.scryfall.com/cards/collection", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "CommanderVTT/8.0" },
      body: JSON.stringify({ identifiers })
    });
    const json = await r.json();
    (json.data || []).forEach((c) => {
      const fields = extractCardFields(c);
      if (fields.img) { found.push(fields); archiveCard(fields); }
    });
  }
  if (toFetch.length) saveCardArchive();
  return found;
}

async function resolveAndSetLibrary(socket, p, text) {
  try {
    const wanted = parseDecklistNames(text, 250);
    if (wanted.length === 0) { socket.emit("importResult", { success: false, error: "Nothing parsed from that list." }); return; }

    const found = await resolveCardNames(wanted);
    shuffle(found);
    p.library = found;
    broadcastPlayers();
    socket.emit("importResult", { success: true, requested: wanted.length, found: found.length });
    pushLog(`${p.name} loaded a ${wanted.length}-card decklist (${found.length} found)`);
  } catch (e) {
    socket.emit("importResult", { success: false, error: "Import failed — check your connection and try again." });
  }
}

// ---------------- HTTP API ----------------

app.post("/api/register", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.json({ success: false, error: "Username and password required." });
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return res.json({ success: false, error: "Username must be 3-20 letters, numbers, or underscores." });
  if (password.length < 4) return res.json({ success: false, error: "Password must be at least 4 characters." });
  if (users[username]) return res.json({ success: false, error: "That username is already taken." });
  const salt = crypto.randomBytes(16).toString("hex");
  users[username] = { salt, hash: hashPassword(password, salt) };
  saveUsers();
  const token = crypto.randomBytes(24).toString("hex");
  sessions[token] = username;
  res.json({ success: true, token, username });
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const u = users[username];
  if (!u || !verifyPassword(password || "", u.salt, u.hash)) {
    return res.json({ success: false, error: "Incorrect username or password." });
  }
  const token = crypto.randomBytes(24).toString("hex");
  sessions[token] = username;
  res.json({ success: true, token, username });
});

app.post("/api/spawn", async (req, res) => {
  try {
    const name = req.body.name || "";
    const cached = cardArchive[archiveKey(name)];
    if (cached) return res.json({ success: true, ...cached });
    const url = "https://api.scryfall.com/cards/named?fuzzy=" + encodeURIComponent(name);
    const r = await fetch(url, { headers: { "User-Agent": "CommanderVTT/8.0", "Accept": "application/json" } });
    const json = await r.json();
    const fields = extractCardFields(json);
    if (!fields.img) return res.json({ success: false });
    archiveCard(fields);
    saveCardArchive();
    res.json({ success: true, ...fields });
  } catch (e) {
    res.json({ success: false });
  }
});

app.get("/api/autocomplete", async (req, res) => {
  try {
    const q = req.query.q || "";
    if (q.length < 2) return res.json({ data: [] });
    const r = await fetch("https://api.scryfall.com/cards/autocomplete?q=" + encodeURIComponent(q));
    const json = await r.json();
    res.json({ data: json.data || [] });
  } catch (e) {
    res.json({ data: [] });
  }
});

// ---------------- Socket.IO ----------------

io.on("connection", (socket) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const username = sessions[token];
  if (!username) {
    socket.emit("authError", "Session expired — please log in again.");
    socket.disconnect(true);
    return;
  }

  players[socket.id] = {
    username,
    name: username,
    color: nextColor(),
    life: 40, cmdr: 0, poison: 0,
    library: [], graveyard: [], exile: [],
    commanders: [null, null],
    mulligans: 0, handKept: false,
    mana: EMPTY_MANA(), landsPlayedThisTurn: 0, landDropBonus: 0
  };

  if (turn.started) {
    turn.order.push(socket.id);
    broadcastTurn();
  }

  const maskedCards = {};
  for (const id in cards) maskedCards[id] = maskCard(cards[id], socket.id);
  socket.emit("init", {
    cards: maskedCards,
    gameState,
    players: playersView(socket.id),
    targets,
    turn,
    combat,
    chat: chatLog,
    voiceRoster: Array.from(voiceParticipants),
    myId: socket.id,
    decks: Object.keys(decks[username] || {})
  });
  broadcastPlayers();

  socket.on("setName", (name) => {
    if (!players[socket.id]) return;
    players[socket.id].name = (name || "Player").toString().slice(0, 24);
    broadcastPlayers();
  });

  socket.on("statChange", ({ key, val }) => {
    if (!players[socket.id] || !["life", "cmdr", "poison"].includes(key)) return;
    players[socket.id][key] += val;
    broadcastPlayers();
  });

  // ---- mana / land drops ----

  socket.on("addMana", (color) => {
    const p = players[socket.id];
    if (!p || !["W", "U", "B", "R", "G", "C"].includes(color)) return;
    p.mana[color] = (p.mana[color] || 0) + 1;
    broadcastPlayers();
  });

  socket.on("removeMana", (color) => {
    const p = players[socket.id];
    if (!p || !["W", "U", "B", "R", "G", "C"].includes(color)) return;
    p.mana[color] = Math.max(0, (p.mana[color] || 0) - 1);
    broadcastPlayers();
  });

  socket.on("landDropBonus", (delta) => {
    const p = players[socket.id];
    if (!p) return;
    p.landDropBonus = Math.max(0, (p.landDropBonus || 0) + delta);
    broadcastPlayers();
  });

  // ---- battlefield cards ----

  socket.on("spawnCard", (data) => {
    spawnBattlefieldCard({ ...data, owner: socket.id, zoneType: classifyType(data.type) });
    const who = players[socket.id] ? players[socket.id].name : "Someone";
    pushLog(data.faceDown ? `${who} spawned a card face down` : `${who} spawned ${data.name}`);
  });

  socket.on("changeZone", ({ id, zoneType, x }) => {
    const card = cards[id];
    const p = players[socket.id];
    if (!card || !p || card.owner !== socket.id) return;
    // "hand" is intentionally not a valid drag target here — there's no general rule that lets you
    // pick a permanent back up, so returning something to hand is a deliberate action (see "toHand"
    // below), not a side effect of dragging it into the hand row.
    if (!["mana", "creature", "artifact"].includes(zoneType)) return;

    if (card.zoneType === "hand") {
      const result = attemptPlay(p, card, zoneType, x);
      if (!result.ok) { socket.emit("actionError", result.error); return; }
      card.zoneType = zoneType;
      card.faceDown = false;
      broadcastCard(card);
      broadcastPlayers();
      pushLog(`${p.name} played ${card.name || "a card"}`);
      return;
    }
    // reclassifying an existing battlefield permanent between creature/artifact/mana rows — purely
    // organizational, no cost.
    card.zoneType = zoneType;
    broadcastCard(card);
  });

  socket.on("playCard", (data) => {
    const id = typeof data === "string" ? data : data.id;
    const xValue = (typeof data === "object" && data.x) || 0;
    const card = cards[id];
    const p = players[socket.id];
    if (!card || !p || card.owner !== socket.id) return;
    const targetZoneType = classifyType(card.type);
    const result = attemptPlay(p, card, targetZoneType, xValue);
    if (!result.ok) { socket.emit("actionError", result.error); return; }
    card.zoneType = targetZoneType;
    card.faceDown = false;
    broadcastCard(card);
    broadcastPlayers();
    pushLog(`${p.name} played ${card.name || "a card"}`);
  });

  socket.on("tap", (id) => {
    const card = cards[id];
    if (!card || card.owner !== socket.id) return;
    const wasTapped = card.tapped;
    card.tapped = !card.tapped;
    broadcastCard(card);
    if (!wasTapped && card.tapped && card.zoneType === "mana") {
      // Basic land types auto-add their color; nonbasic lands that are archived with exactly
      // one fixed producible color (shocklands, painlands, snow duals, etc.) do too. Lands with
      // multiple/any-color options (Command Tower, gates, tri-lands) stay manual since the choice is ambiguous.
      let color = basicLandColor(card.type);
      if (!color && Array.isArray(card.producedMana) && card.producedMana.length === 1) {
        color = card.producedMana[0];
      }
      if (color && ["W", "U", "B", "R", "G", "C"].includes(color)) {
        const p = players[socket.id];
        p.mana[color] = (p.mana[color] || 0) + 1;
        broadcastPlayers();
        pushLog(`${p.name} tapped ${card.name} for {${color}}`);
      }
    }
  });

  socket.on("flip", (id) => {
    const card = cards[id];
    if (!card || card.owner !== socket.id) return;
    card.faceDown = !card.faceDown;
    broadcastCard(card);
    const who = players[socket.id] ? players[socket.id].name : "Someone";
    pushLog(`${who} flipped a card`);
  });

  socket.on("counter", ({ id, delta }) => {
    const card = cards[id];
    if (!card || card.owner !== socket.id) return;
    card.counters = (card.counters || 0) + delta;
    broadcastCard(card);
  });

  socket.on("removeCard", (id) => {
    const card = cards[id];
    if (!card || card.owner !== socket.id) return;
    delete cards[id];
    if (targets[id]) { delete targets[id]; broadcastTargets(); }
    io.emit("cardRemove", id);
    clearCommanderRef(card);
  });

  // Deliberate "this permanent is being bounced/returned to hand" action — represents a bounce
  // effect or similar, since there's no general rule that lets a permanent just go back to hand.
  socket.on("toHand", (id) => {
    const card = cards[id];
    const p = players[socket.id];
    if (!card || !p || card.owner !== socket.id || card.zoneType === "hand") return;
    delete cards[id];
    if (targets[id]) { delete targets[id]; broadcastTargets(); }
    io.emit("cardRemove", id);
    clearCommanderRef(card);
    spawnBattlefieldCard({ ...toEntry(card), owner: socket.id, faceDown: true, zoneType: "hand" });
    broadcastPlayers();
    pushLog(`${p.name} returned ${card.name || "a face-down card"} to their hand`);
  });

  socket.on("untapAll", () => {
    for (const id in cards) {
      if (cards[id].owner === socket.id && cards[id].tapped) {
        cards[id].tapped = false;
        broadcastCard(cards[id]);
      }
    }
    const who = players[socket.id] ? players[socket.id].name : "Someone";
    pushLog(`${who} untapped all their permanents`);
  });

  // ---- targeting (open to everyone) ----

  socket.on("toggleTarget", (cardId) => {
    if (!cards[cardId]) return;
    const existing = targets[cardId] || [];
    const already = existing.includes(socket.id);
    const updated = already ? existing.filter((id) => id !== socket.id) : [...existing, socket.id];
    if (updated.length === 0) delete targets[cardId]; else targets[cardId] = updated;
    broadcastTargets();
    const who = players[socket.id] ? players[socket.id].name : "Someone";
    pushLog(`${who} ${already ? "removed a target from" : "targeted"} a card`);
  });

  // ---- zone transitions: battlefield -> graveyard/exile/library (owner only) ----

  function moveOut(cardId, zone, pos) {
    const card = cards[cardId];
    if (!card || card.owner !== socket.id) return;
    const owner = card.owner;
    delete cards[cardId];
    if (targets[cardId]) { delete targets[cardId]; broadcastTargets(); }
    io.emit("cardRemove", cardId);
    clearCommanderRef(card);
    if (!players[owner]) return;
    const entry = toEntry(card);
    if (zone === "graveyard") players[owner].graveyard.push(entry);
    else if (zone === "exile") players[owner].exile.push(entry);
    else if (zone === "library") {
      if (pos === "top") players[owner].library.unshift(entry);
      else players[owner].library.push(entry);
    }
    broadcastPlayers();
    const ownerName = players[owner].name;
    pushLog(`${ownerName}'s ${card.name || "face-down card"} went to ${zone}`);
  }

  socket.on("toGraveyard", (id) => moveOut(id, "graveyard"));
  socket.on("toExile", (id) => moveOut(id, "exile"));
  socket.on("toLibraryTop", (id) => moveOut(id, "library", "top"));
  socket.on("toLibraryBottom", (id) => moveOut(id, "library", "bottom"));

  // ---- zone transitions: graveyard/exile -> battlefield/hand (owner only) ----

  socket.on("zoneToBattlefield", ({ zone, index }) => {
    const p = players[socket.id];
    if (!p || !p[zone] || !p[zone][index]) return;
    const entry = p[zone].splice(index, 1)[0];
    spawnBattlefieldCard({ ...entry, owner: socket.id, faceDown: false, zoneType: classifyType(entry.type) });
    broadcastPlayers();
    pushLog(`${p.name} returned ${entry.name} to the battlefield`);
  });

  socket.on("zoneToHand", ({ zone, index }) => {
    const p = players[socket.id];
    if (!p || !p[zone] || !p[zone][index]) return;
    const entry = p[zone].splice(index, 1)[0];
    spawnBattlefieldCard({ ...entry, owner: socket.id, faceDown: true, zoneType: "hand" });
    broadcastPlayers();
    pushLog(`${p.name} returned a card to their hand`);
  });

  // ---- library management (owner only) ----

  socket.on("shuffleLibrary", () => {
    const p = players[socket.id];
    if (!p) return;
    shuffle(p.library);
    broadcastPlayers();
    pushLog(`${p.name} shuffled their library`);
  });

  socket.on("drawCard", (count) => {
    const p = players[socket.id];
    if (!p) return;
    const drawn = drawN(socket.id, Math.max(1, Math.min(10, count || 1)));
    broadcastPlayers();
    if (drawn) pushLog(`${p.name} drew ${drawn} card${drawn > 1 ? "s" : ""}`);
  });

  socket.on("drawSpecific", (index) => {
    const p = players[socket.id];
    if (!p || !p.library[index]) return;
    const entry = p.library.splice(index, 1)[0];
    spawnBattlefieldCard({ ...entry, owner: socket.id, faceDown: true, zoneType: "hand" });
    broadcastPlayers();
    pushLog(`${p.name} searched their library for a card`);
  });

  socket.on("millCard", (count) => {
    const p = players[socket.id];
    if (!p) return;
    const n = Math.max(1, Math.min(20, count || 1));
    let milled = 0;
    for (let i = 0; i < n && p.library.length > 0; i++) {
      p.graveyard.push(p.library.shift());
      milled++;
    }
    broadcastPlayers();
    if (milled) pushLog(`${p.name} milled ${milled} card${milled > 1 ? "s" : ""}`);
  });

  socket.on("importDeck", (text) => {
    const p = players[socket.id];
    if (!p) return;
    resolveAndSetLibrary(socket, p, text);
  });

  // ---- opening hand / mulligan ----

  socket.on("drawOpeningHand", () => {
    const p = players[socket.id];
    if (!p) return;
    returnAllHandToLibrary(socket.id);
    shuffle(p.library);
    drawN(socket.id, 7);
    p.mulligans = 0;
    p.handKept = false;
    broadcastPlayers();
    pushLog(`${p.name} drew their opening hand`);
  });

  socket.on("mulligan", () => {
    const p = players[socket.id];
    if (!p || p.mulligans >= 2) return;
    returnAllHandToLibrary(socket.id);
    shuffle(p.library);
    drawN(socket.id, 7);
    p.mulligans += 1;
    broadcastPlayers();
    pushLog(`${p.name} took a mulligan (${p.mulligans}/2)`);
  });

  socket.on("keepHand", () => {
    const p = players[socket.id];
    if (!p) return;
    p.handKept = true;
    broadcastPlayers();
    pushLog(`${p.name} kept their hand and is ready`);
  });

  // ---- persistent decks ----

  socket.on("saveDeck", ({ name, commanders, library }) => {
    if (!players[socket.id]) return;
    name = (name || "").toString().trim().slice(0, 40);
    if (!name) return;
    const cmds = Array.isArray(commanders) ? commanders.slice(0, 2).map((c) => (c ? toEntry(c) : null)) : [];
    while (cmds.length < 2) cmds.push(null);
    const lib = Array.isArray(library) ? library.slice(0, 99).map((c) => toEntry(c)) : [];
    if (!lib.length && !cmds.some(Boolean)) return; // nothing to save
    if (!decks[username]) decks[username] = {};
    decks[username][name] = { commanders: cmds, library: lib };
    saveDecks();
    socket.emit("deckSaved", name);
    socket.emit("deckList", Object.keys(decks[username]));
  });

  socket.on("deleteDeck", (name) => {
    if (!decks[username]) return;
    delete decks[username][name];
    saveDecks();
    socket.emit("deckList", Object.keys(decks[username]));
  });

  socket.on("loadDeck", (name) => {
    const p = players[socket.id];
    if (!p) return;
    const deck = decks[username] && decks[username][name];
    if (!deck) { socket.emit("importResult", { success: false, error: "Deck not found." }); return; }
    if (typeof deck === "string") {
      resolveAndSetLibrary(socket, p, deck); // legacy raw-text save, no separate commander
      return;
    }
    p.library = (deck.library || []).map((c) => ({ ...c }));
    shuffle(p.library);
    applyCommandersToPlayer(p, deck.commanders);
    broadcastPlayers();
    const cmdCount = (deck.commanders || []).filter(Boolean).length;
    socket.emit("importResult", { success: true, requested: p.library.length, found: p.library.length });
    pushLog(`${p.name} loaded deck "${name}" (${p.library.length} cards${cmdCount ? ` + ${cmdCount} commander${cmdCount > 1 ? "s" : ""}` : ""})`);
  });

  // Resolves a pasted decklist to full card data for the deck editor, without touching the
  // live game — the editor decides what to do with the result (add to its working library).
  socket.on("resolveDeckPaste", async (text) => {
    try {
      const wanted = parseDecklistNames(text, 99);
      if (wanted.length === 0) { socket.emit("deckPasteResult", { success: false, error: "Nothing parsed from that list." }); return; }
      const found = await resolveCardNames(wanted);
      socket.emit("deckPasteResult", { success: true, requested: wanted.length, found });
    } catch (e) {
      socket.emit("deckPasteResult", { success: false, error: "Resolve failed — check your connection and try again." });
    }
  });

  // Loads a deck's raw saved data into the editor (for the "Edit" button on a saved deck).
  socket.on("getDeckData", (name) => {
    const deck = decks[username] && decks[username][name];
    socket.emit("deckData", { name, data: deck || null });
  });

  // Applies an in-progress editor draft directly to the live game, without requiring a save first.
  socket.on("loadDeckDraft", ({ commanders, library }) => {
    const p = players[socket.id];
    if (!p) return;
    p.library = (Array.isArray(library) ? library : []).slice(0, 99).map((c) => toEntry(c));
    shuffle(p.library);
    applyCommandersToPlayer(p, commanders);
    broadcastPlayers();
    pushLog(`${p.name} loaded a deck draft into the game`);
  });

  // ---- commander zone ----

  socket.on("setCommander", (data) => {
    const p = players[socket.id];
    if (!p) return;
    setCommanderFromData(p, data.slot, data);
    broadcastPlayers();
    pushLog(`${p.name} set their commander: ${data.name}`);
  });

  socket.on("clearCommander", (slot) => {
    const p = players[socket.id];
    if (!p || slot < 0 || slot > 1) return;
    p.commanders[slot] = null;
    broadcastPlayers();
  });

  socket.on("commanderTax", ({ slot, delta }) => {
    const p = players[socket.id];
    if (!p || !p.commanders[slot]) return;
    p.commanders[slot].tax = Math.max(0, p.commanders[slot].tax + delta);
    broadcastPlayers();
  });

  socket.on("castCommander", (slot) => {
    const p = players[socket.id];
    if (!p || !p.commanders[slot]) return;
    const cmd = p.commanders[slot];
    if (cmd.battlefieldId && cards[cmd.battlefieldId]) {
      socket.emit("actionError", `${cmd.name} is already on the battlefield.`);
      return;
    }
    const cost = parseManaCost(cmd.manaCost);
    cost.generic += cmd.tax || 0; // commander tax: +{2} generic per previous cast from the command zone
    const remaining = canAffordAndPay(p.mana, cost, 0);
    if (!remaining) {
      socket.emit("actionError", `Not enough mana to cast ${cmd.name}${cmd.tax ? ` (includes +${cmd.tax} commander tax)` : ""}.`);
      return;
    }
    p.mana = remaining;
    const card = spawnBattlefieldCard({ ...cmd, owner: socket.id, faceDown: false, zoneType: classifyType(cmd.type), isCommander: true });
    cmd.battlefieldId = card.id;
    cmd.tax += 2;
    broadcastPlayers();
    pushLog(`${p.name} cast their commander: ${cmd.name} (tax now ${cmd.tax})`);
  });

  // ---- turn structure ----

  socket.on("startGame", () => {
    turn.order = Object.keys(players);
    turn.activeIndex = 0;
    turn.phase = "Main 1";
    turn.turnNumber = 1;
    turn.started = true;
    combat = { step: "none", attackers: {}, blocks: {}, defendersPending: [] };
    for (const pid in players) {
      players[pid].mana = EMPTY_MANA();
      players[pid].landsPlayedThisTurn = 0;
    }
    broadcastTurn();
    broadcastCombat();
    broadcastPlayers();
    pushLog(`Game started! Turn order: ${turn.order.map((id) => (players[id] ? players[id].name : "?")).join(" → ")}`);
  });

  socket.on("nextPhase", () => {
    if (!turn.started) return;
    if (turn.order[turn.activeIndex] !== socket.id) return;
    advancePhase();
  });

  // ---- combat ----

  socket.on("declareAttackers", (assignments) => {
    if (!turn.started || turn.order[turn.activeIndex] !== socket.id) return;
    if (combat.step !== "declareAttackers") return;
    const validAttackers = {};
    const defendersSet = new Set();
    for (const [cardId, defenderId] of Object.entries(assignments || {})) {
      const card = cards[cardId];
      if (!card || card.owner !== socket.id || card.zoneType !== "creature" || card.tapped) continue;
      if (!players[defenderId] || defenderId === socket.id) continue;
      validAttackers[cardId] = defenderId;
      defendersSet.add(defenderId);
      card.tapped = true;
      broadcastCard(card);
    }
    combat.attackers = validAttackers;
    combat.blocks = {};
    combat.defendersPending = Array.from(defendersSet);
    combat.step = defendersSet.size > 0 ? "declareBlockers" : "damage";
    broadcastCombat();
    const activeName = players[socket.id] ? players[socket.id].name : "?";
    pushLog(`${activeName} declared ${Object.keys(validAttackers).length} attacker(s)`);
    if (combat.step === "damage") resolveCombatDamage();
  });

  socket.on("declareBlockers", (assignments) => {
    if (combat.step !== "declareBlockers") return;
    if (!combat.defendersPending.includes(socket.id)) return;
    const usedBlockers = new Set(Object.values(combat.blocks).filter(Boolean));
    for (const [attackerId, blockerId] of Object.entries(assignments || {})) {
      if (combat.attackers[attackerId] !== socket.id) continue;
      if (blockerId) {
        if (usedBlockers.has(blockerId)) continue;
        const blockerCard = cards[blockerId];
        if (!blockerCard || blockerCard.owner !== socket.id || blockerCard.zoneType !== "creature" || blockerCard.tapped) continue;
        combat.blocks[attackerId] = blockerId;
        usedBlockers.add(blockerId);
      } else {
        combat.blocks[attackerId] = null;
      }
    }
    combat.defendersPending = combat.defendersPending.filter((id) => id !== socket.id);
    broadcastCombat();
    const p = players[socket.id];
    pushLog(`${p ? p.name : "?"} declared blockers`);
    if (combat.defendersPending.length === 0) {
      combat.step = "damage";
      broadcastCombat();
      resolveCombatDamage();
    }
  });

  // ---- chat ----

  socket.on("chatMessage", (text) => {
    const p = players[socket.id];
    if (!p || !text) return;
    const msg = { name: p.name, color: p.color, text: String(text).slice(0, 500), ts: Date.now() };
    chatLog.push(msg);
    if (chatLog.length > 200) chatLog.shift();
    io.emit("chatMessage", msg);
  });

  // ---- voice signaling (WebRTC mesh; server only relays) ----

  socket.on("voiceJoin", () => {
    voiceParticipants.forEach((existingId) => {
      socket.emit("voiceShouldOffer", { toId: existingId });
    });
    voiceParticipants.add(socket.id);
    broadcastVoiceRoster();
  });

  socket.on("voiceLeave", () => {
    voiceParticipants.delete(socket.id);
    broadcastVoiceRoster();
  });

  socket.on("voiceSignal", ({ toId, data }) => {
    const target = io.sockets.sockets.get(toId);
    if (target) target.emit("voiceSignal", { fromId: socket.id, data });
  });

  // ---- misc ----

  socket.on("log", (msg) => pushLog(msg));

  socket.on("clearBoard", () => {
    for (const id in cards) {
      const c = cards[id];
      if (players[c.owner]) players[c.owner].library.push(toEntry(c));
    }
    cards = {};
    targets = {};
    for (const pid in players) {
      const p = players[pid];
      p.graveyard.forEach((e) => p.library.push(e));
      p.exile.forEach((e) => p.library.push(e));
      p.graveyard = [];
      p.exile = [];
      shuffle(p.library);
      p.life = 40; p.cmdr = 0; p.poison = 0;
      p.commanders.forEach((c) => { if (c) { c.tax = 0; c.battlefieldId = null; } });
      p.mulligans = 0;
      p.handKept = false;
      p.mana = EMPTY_MANA();
      p.landsPlayedThisTurn = 0;
      p.landDropBonus = 0;
    }
    gameState.log = [];
    turn = { started: false, order: [], activeIndex: 0, phase: "Main 1", turnNumber: 1 };
    combat = { step: "none", attackers: {}, blocks: {}, defendersPending: [] };
    io.emit("cleared");
    broadcastPlayers();
    broadcastTargets();
    broadcastTurn();
    broadcastCombat();
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
    voiceParticipants.delete(socket.id);
    broadcastVoiceRoster();
    const idx = turn.order.indexOf(socket.id);
    if (idx !== -1) {
      turn.order.splice(idx, 1);
      if (turn.order.length === 0) turn.started = false;
      else if (idx < turn.activeIndex) turn.activeIndex--;
      else if (turn.activeIndex >= turn.order.length) turn.activeIndex = 0;
      broadcastTurn();
    }
    broadcastPlayers();
  });
});

http.listen(8087, () => { console.log("Commander Engine Listening on 8087"); });
