const express = require("express");
const fs = require("fs");
const crypto = require("crypto");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

app.use(express.static("public"));
app.use(express.json({ limit: "1mb" }));

// A single unhandled error anywhere (a bad client payload, a missed null check, etc.) used to
// kill the whole process — and since every table's game state only lives in memory, a crash-and
// -restart (Docker's restart:unless-stopped) silently wiped every active game for everyone.
// Log and keep running instead.
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));

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

// ---------------- lobbies ----------------
// Each lobby holds its own fully-isolated copy of what used to be single global game state
// (cards/players/turn/combat/etc). Sockets join a Socket.IO room matching the lobby id, and every
// game handler below resolves its lobby fresh via currentLobby(socket) — nothing is global anymore.

const COLORS = ["#ef4444", "#3b82f6", "#22c55e", "#eab308", "#a855f7", "#ec4899", "#14b8a6", "#f97316"];
let colorIndex = 0;
function nextColor() { return COLORS[colorIndex++ % COLORS.length]; }
function randInt(n) { return Math.floor(Math.random() * n); }
function newId() { return "c_" + Date.now() + "_" + randInt(100000); }
function newLobbyId() { return crypto.randomBytes(4).toString("hex"); }

const PHASES = ["Untap", "Upkeep", "Draw", "Main 1", "Combat", "Main 2", "End Step"];
const EMPTY_MANA = () => ({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });

function createLobbyState(id, name, hostUsername, password) {
  let passwordSalt = null, passwordHash = null;
  if (password) {
    passwordSalt = crypto.randomBytes(16).toString("hex");
    passwordHash = hashPassword(password, passwordSalt);
  }
  return {
    id, name, hostUsername,
    passwordSalt, passwordHash,
    createdAt: Date.now(),
    cards: {},        // battlefield/hand cards, keyed by id
    players: {},      // socket.id -> player state
    targets: {},      // cardId -> [playerId, ...]
    gameState: { log: [] },
    chatLog: [],
    spectators: {}, // socket.id -> { username, name } -- watch-only, never touches lobby.players
    voiceParticipants: new Set(),
    turn: { started: false, order: [], activeIndex: 0, phase: "Main 1", turnNumber: 1, pendingDiscard: null },
    combat: { step: "none", attackers: {}, blocks: {}, defendersPending: [] }
  };
}
function lobbySummaries() {
  return Object.values(lobbies).map((l) => ({
    id: l.id, name: l.name, playerCount: Object.keys(l.players).length, spectatorCount: Object.keys(l.spectators || {}).length,
    started: l.turn.started, locked: !!l.passwordHash
  }));
}
function broadcastSpectators(lobby) { io.to(lobby.id).emit("spectatorRoster", Object.values(lobby.spectators).map((s) => s.name)); }
function broadcastLobbyList() { io.emit("lobbyList", lobbySummaries()); }
function lobbySocketIds(lobby) { return io.sockets.adapter.rooms.get(lobby.id) || new Set(); }

// ---------------- lobby persistence + reconnect continuity ----------------
// A network blip (or a full server restart) used to just drop a player's seat instantly — cards,
// life total, hand, everything gone, dumped back at the Main Menu. Disconnects now get a grace
// window before the seat is actually vacated, and a reconnecting client with the same account
// within that window gets silently reattached to the same seat instead.

const LOBBIES_FILE = DATA_DIR + "/lobbies.json";
const RECONNECT_GRACE_MS = 3 * 60 * 1000;

function serializeLobbies() {
  const out = {};
  for (const id in lobbies) {
    out[id] = { ...lobbies[id], voiceParticipants: Array.from(lobbies[id].voiceParticipants) };
  }
  return out;
}
function saveLobbies() { saveJSON(LOBBIES_FILE, serializeLobbies()); }

function restoreLobbies() {
  const raw = loadJSON(LOBBIES_FILE, {});
  const restored = {};
  for (const id in raw) {
    const l = raw[id];
    l.voiceParticipants = new Set(); // live WebRTC state can't survive a restart regardless
    // A lobby persisted by an older server version won't have fields added to the schema since
    // (e.g. spectators, added well after persistence itself). Loading it as-is left code that
    // assumes these fields exist -- leaveCurrentLobbyIfAny's `lobby.spectators[socket.id]` chief
    // among them -- crashing on `undefined[...]` for any table that predates the field, which
    // silently broke createLobby/joinLobby/chat/disconnect for anyone still seated in one.
    if (!l.spectators) l.spectators = {};
    if (!l.turn) l.turn = { started: false, order: [], activeIndex: 0, phase: "Main 1", turnNumber: 1, pendingDiscard: null };
    if (l.turn.pendingDiscard === undefined) l.turn.pendingDiscard = null;
    // Nobody is actually connected right after a restart — mark every seated player as
    // disconnected so the normal reconnect-grace mechanism below picks up the cleanup/resume.
    for (const sid in l.players) l.players[sid].disconnectedAt = Date.now();
    restored[id] = l;
  }
  return restored;
}

let lobbies = restoreLobbies(); // id -> lobby state

setInterval(saveLobbies, 20000);
process.on("SIGTERM", () => { saveLobbies(); process.exit(0); });

function removePlayerFromLobby(lobby, socketId, verb) {
  const p = lobby.players[socketId];
  const uname = p ? p.username : null;
  delete lobby.players[socketId];
  lobby.voiceParticipants.delete(socketId);
  const turn = lobby.turn;
  const idx = turn.order.indexOf(socketId);
  if (idx !== -1) {
    turn.order.splice(idx, 1);
    if (turn.order.length === 0) turn.started = false;
    else if (idx < turn.activeIndex) turn.activeIndex--;
    else if (turn.activeIndex >= turn.order.length) turn.activeIndex = 0;
  }
  if (Object.keys(lobby.players).length === 0 && Object.keys(lobby.spectators || {}).length === 0) {
    delete lobbies[lobby.id];
  } else {
    broadcastVoiceRoster(lobby);
    broadcastTurn(lobby);
    broadcastPlayers(lobby);
    if (uname) pushLog(lobby, `${uname} ${verb} the table`);
  }
  broadcastLobbyList();
}

function scheduleGraceRemoval(lobby, socketId) {
  setTimeout(() => {
    if (lobbies[lobby.id] !== lobby) return; // lobby already gone (e.g. everyone left)
    const p = lobby.players[socketId];
    if (p && p.disconnectedAt) removePlayerFromLobby(lobby, socketId, "timed out and left");
  }, RECONNECT_GRACE_MS);
}

// Matches by username regardless of disconnectedAt -- spam-refreshing can easily land a new
// connection before the server has even detected the old socket as disconnected (socket.io's
// disconnect detection isn't instant), so requiring disconnectedAt here missed that race: the
// reconnect would silently fail, dump the player on the Main Menu, and a manual re-Join would
// then create a second seat for the same account instead of reclaiming the first one.
function findExistingSeat(username) {
  for (const lobby of Object.values(lobbies)) {
    const sid = seatInLobby(lobby, username);
    if (sid) return { lobby, oldSocketId: sid };
  }
  return null;
}
function seatInLobby(lobby, username) {
  for (const sid in lobby.players) {
    if (lobby.players[sid].username === username) return sid;
  }
  return null;
}

// Rekeys a disconnected player's seat from their old socket id to a newly-reconnected one,
// updating every place that stored the old id as a reference (not just the players map).
function reattachPlayer(lobby, oldId, newId) {
  const p = lobby.players[oldId];
  delete lobby.players[oldId];
  p.disconnectedAt = null;
  lobby.players[newId] = p;

  for (const id in lobby.cards) {
    if (lobby.cards[id].owner === oldId) lobby.cards[id].owner = newId;
  }
  for (const cardId in lobby.targets) {
    lobby.targets[cardId] = lobby.targets[cardId].map((pid) => (pid === oldId ? newId : pid));
  }
  lobby.turn.order = lobby.turn.order.map((id) => (id === oldId ? newId : id));
  if (lobby.turn.pendingDiscard && lobby.turn.pendingDiscard.playerId === oldId) lobby.turn.pendingDiscard.playerId = newId;
  for (const cardId in lobby.combat.attackers) {
    if (lobby.combat.attackers[cardId] === oldId) lobby.combat.attackers[cardId] = newId;
  }
  lobby.combat.defendersPending = (lobby.combat.defendersPending || []).map((id) => (id === oldId ? newId : id));
}

function buildLobbyJoinedPayload(lobby, socketId) {
  const maskedCards = {};
  for (const id in lobby.cards) maskedCards[id] = maskCard(lobby.cards[id], socketId);
  return {
    lobbyId: lobby.id,
    lobbyName: lobby.name,
    cards: maskedCards,
    gameState: lobby.gameState,
    players: playersView(lobby, socketId),
    targets: lobby.targets,
    turn: lobby.turn,
    combat: lobby.combat,
    chat: lobby.chatLog,
    voiceRoster: Array.from(lobby.voiceParticipants),
    spectatorRoster: Object.values(lobby.spectators).map((s) => s.name),
    spectator: !!lobby.spectators[socketId],
    myId: socketId
  };
}

// Restored (post-restart) seats and anyone who was already mid-grace-window when persisted
// need their removal timers (re)scheduled now that the server is back up.
for (const lobbyId in lobbies) {
  for (const sid in lobbies[lobbyId].players) {
    if (lobbies[lobbyId].players[sid].disconnectedAt) scheduleGraceRemoval(lobbies[lobbyId], sid);
  }
}

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

// Cards that unconditionally enter tapped ("~ enters the battlefield tapped.") should actually
// enter tapped instead of always untapped. Cards with a real choice attached (shocklands' "you
// may pay life", checklands' "unless you control", etc.) are deliberately excluded — the player
// has a decision to make there that this app can't resolve automatically, so those stay untapped
// by default and can be tapped manually like today.
function entersTapped(card) {
  const text = (card.text || "").toLowerCase();
  if (!text.includes("enters the battlefield tapped") && !text.includes("enters tapped")) return false;
  if (text.includes("you may pay") || text.includes("unless you") || text.includes("if you don't") || text.includes("you may reveal")) return false;
  return true;
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

function broadcastCard(lobby, card) {
  for (const sid of lobbySocketIds(lobby)) {
    const sock = io.sockets.sockets.get(sid);
    if (sock) sock.emit("cardUpdate", maskCard(card, sid));
  }
}

function broadcastTargets(lobby) { io.to(lobby.id).emit("targets", lobby.targets); }
function broadcastTurn(lobby) { io.to(lobby.id).emit("turnState", lobby.turn); }
function broadcastCombat(lobby) { io.to(lobby.id).emit("combatState", lobby.combat); }
function broadcastVoiceRoster(lobby) { io.to(lobby.id).emit("voiceRoster", Array.from(lobby.voiceParticipants)); }

function playersView(lobby, viewerId) {
  const out = {};
  for (const id in lobby.players) {
    const p = lobby.players[id];
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
      library: id === viewerId ? p.library : undefined,
      disconnected: !!p.disconnectedAt
    };
  }
  return out;
}

function broadcastPlayers(lobby) {
  for (const sid of lobbySocketIds(lobby)) {
    const sock = io.sockets.sockets.get(sid);
    if (sock) sock.emit("players", playersView(lobby, sid));
  }
}

function pushLog(lobby, msg) {
  lobby.gameState.log.push(msg);
  if (lobby.gameState.log.length > 150) lobby.gameState.log.shift();
  io.to(lobby.id).emit("log", msg);
}

function spawnBattlefieldCard(lobby, data) {
  const { owner, faceDown, zoneType, isCommander } = data;
  const p = lobby.players[owner];
  const id = newId();
  const resolvedZoneType = zoneType || classifyType(data.type);
  const card = {
    id, name: data.name, img: data.img, type: data.type || "", manaCost: data.manaCost || "",
    cmc: data.cmc || 0, colors: data.colors || [], colorIdentity: data.colorIdentity || [],
    power: data.power, toughness: data.toughness, loyalty: data.loyalty,
    text: data.text || "", keywords: data.keywords || [], producedMana: data.producedMana || null,
    zoneType: resolvedZoneType,
    // Only applies when actually entering the battlefield — drawing into hand (zoneType "hand")
    // goes through this same function but obviously shouldn't come in "tapped".
    tapped: resolvedZoneType !== "hand" && entersTapped(data),
    faceDown: !!faceDown, counters: 0,
    owner, ownerColor: p ? p.color : "#999",
    isCommander: !!isCommander,
    // Summoning sickness: stamped with the turn number it entered the battlefield. A creature is
    // sick (can't attack, can still block) if this still matches the CURRENT turn number when its
    // controller tries to attack with it — irrelevant for non-creatures, but harmless to set.
    controllerSince: lobby.turn.started ? lobby.turn.turnNumber : 0
  };
  lobby.cards[id] = card;
  broadcastCard(lobby, card);
  return card;
}

function drawN(lobby, ownerId, n) {
  const p = lobby.players[ownerId];
  if (!p) return 0;
  let drawn = 0;
  for (let i = 0; i < n && p.library.length > 0; i++) {
    const entry = p.library.shift();
    spawnBattlefieldCard(lobby, { ...entry, owner: ownerId, faceDown: true, zoneType: "hand" });
    drawn++;
  }
  return drawn;
}

function returnAllHandToLibrary(lobby, ownerId) {
  const p = lobby.players[ownerId];
  if (!p) return;
  const toRemove = [];
  for (const id in lobby.cards) {
    if (lobby.cards[id].owner === ownerId && lobby.cards[id].zoneType === "hand") {
      p.library.push(toEntry(lobby.cards[id]));
      toRemove.push(id);
    }
  }
  toRemove.forEach((id) => {
    delete lobby.cards[id];
    if (lobby.targets[id]) delete lobby.targets[id];
    io.to(lobby.id).emit("cardRemove", id);
  });
  if (toRemove.length) broadcastTargets(lobby);
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

// Instants (and anything with Flash) can be played anytime; everything else is sorcery-speed —
// only on your own turn, during a main phase. Before the game is actually started there's no
// turn structure yet, so pregame setup stays unrestricted.
function checkTiming(lobby, socketId, card) {
  const text = (card.type || "").toLowerCase();
  const isInstantSpeed = text.includes("instant") || (Array.isArray(card.keywords) && card.keywords.some((k) => (k || "").toLowerCase() === "flash"));
  if (isInstantSpeed) return { ok: true };
  if (!lobby.turn.started) return { ok: true };
  if (lobby.turn.order[lobby.turn.activeIndex] !== socketId) {
    return { ok: false, error: `You can only play ${card.name || "that"} on your own turn.` };
  }
  if (lobby.turn.phase !== "Main 1" && lobby.turn.phase !== "Main 2") {
    return { ok: false, error: `You can only play ${card.name || "that"} during a main phase.` };
  }
  return { ok: true };
}

// "You have no maximum hand size" effects come from a permanent's oracle text — check every
// battlefield card (not hand/library/etc, which aren't kept in lobby.cards) the player controls.
function hasNoMaxHandSize(lobby, playerId) {
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.owner === playerId && c.zoneType !== "hand" && (c.text || "").toLowerCase().includes("no maximum hand size")) return true;
  }
  return false;
}

// A commander that leaves the battlefield (dies, gets bounced, etc.) becomes recastable
// again — clear the slot's battlefield reference so castCommander stops rejecting it.
function clearCommanderRef(lobby, card) {
  const owner = lobby.players[card.owner];
  if (!owner || !card.isCommander) return;
  owner.commanders.forEach((c) => { if (c && c.battlefieldId === card.id) c.battlefieldId = null; });
}

function sendToGraveyardInternal(lobby, card) {
  delete lobby.cards[card.id];
  if (lobby.targets[card.id]) delete lobby.targets[card.id];
  io.to(lobby.id).emit("cardRemove", card.id);
  clearCommanderRef(lobby, card);
  const owner = lobby.players[card.owner];
  if (owner) owner.graveyard.push(toEntry(card));
}

// ---------------- turn engine ----------------

function advancePhase(lobby) {
  const turn = lobby.turn;
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
  const activePlayer = lobby.players[activeId];

  for (const pid in lobby.players) lobby.players[pid].mana = EMPTY_MANA(); // mana empties every step/phase

  if (oldPhase === "Combat" && turn.phase !== "Combat") {
    lobby.combat = { step: "none", attackers: {}, blocks: {}, defendersPending: [] };
  }
  if (turn.phase === "Combat") {
    lobby.combat = { step: "declareAttackers", attackers: {}, blocks: {}, defendersPending: [] };
  }

  if (activePlayer && turn.phase === "Untap") {
    activePlayer.landsPlayedThisTurn = 0;
    for (const id in lobby.cards) {
      if (lobby.cards[id].owner === activeId && lobby.cards[id].tapped) {
        lobby.cards[id].tapped = false;
        broadcastCard(lobby, lobby.cards[id]);
      }
    }
  }
  if (activePlayer && turn.phase === "Draw") {
    const isVeryFirstTurn = turn.turnNumber === 1 && turn.activeIndex === 0;
    if (!isVeryFirstTurn) {
      const drew = drawN(lobby, activeId, 1);
      if (drew) pushLog(lobby, `${activePlayer.name} drew a card for the turn`);
    } else {
      pushLog(lobby, `${activePlayer.name} skips their draw (playing first)`);
    }
  }
  broadcastTurn(lobby);
  broadcastCombat(lobby);
  broadcastPlayers(lobby);
  if (activePlayer) pushLog(lobby, `${activePlayer.name} — ${turn.phase}${turn.phase === "Untap" ? ` (Turn ${turn.turnNumber})` : ""}`);
}

function resolveCombatDamage(lobby) {
  const combat = lobby.combat;
  const deaths = [];
  for (const [attackerId, defenderId] of Object.entries(combat.attackers)) {
    const attacker = lobby.cards[attackerId];
    if (!attacker) continue;
    const atkPower = parsePT(attacker.power) + (attacker.counters || 0);
    const atkTough = parsePT(attacker.toughness) + (attacker.counters || 0);
    const blockerId = combat.blocks[attackerId];
    if (blockerId && lobby.cards[blockerId]) {
      const blocker = lobby.cards[blockerId];
      const defPower = parsePT(blocker.power) + (blocker.counters || 0);
      const defTough = parsePT(blocker.toughness) + (blocker.counters || 0);
      pushLog(lobby, `${attacker.name || "A face-down creature"} (${atkPower}/${atkTough}) fights ${blocker.name || "a face-down creature"} (${defPower}/${defTough})`);
      if (atkPower >= defTough) deaths.push(blocker);
      if (defPower >= atkTough) deaths.push(attacker);
    } else {
      const defender = lobby.players[defenderId];
      if (defender) {
        defender.life -= atkPower;
        if (attacker.isCommander) defender.cmdr = (defender.cmdr || 0) + atkPower;
        pushLog(lobby, `${attacker.name || "A face-down creature"} hits ${defender.name} for ${atkPower}`);
      }
    }
  }
  const seen = new Set();
  deaths.forEach((c) => { if (!seen.has(c.id) && lobby.cards[c.id]) { seen.add(c.id); sendToGraveyardInternal(lobby, c); } });
  lobby.combat = { step: "none", attackers: {}, blocks: {}, defendersPending: [] };
  broadcastCombat(lobby);
  broadcastPlayers(lobby);
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

async function resolveAndSetLibrary(lobby, socket, p, text) {
  try {
    const wanted = parseDecklistNames(text, 250);
    if (wanted.length === 0) { socket.emit("importResult", { success: false, error: "Nothing parsed from that list." }); return; }

    const found = await resolveCardNames(wanted);
    shuffle(found);
    p.library = found;
    broadcastPlayers(lobby);
    socket.emit("importResult", { success: true, requested: wanted.length, found: found.length });
    pushLog(lobby, `${p.name} loaded a ${wanted.length}-card decklist (${found.length} found)`);
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

// WebRTC ICE server config for voice chat. Public STUN alone only lets two players connect
// directly, which fails whenever a router's NAT gets in the way — a self-hosted TURN relay
// (see docker-compose.yml's coturn service) is what makes cross-network voice chat actually work.
// Falls back to STUN-only if TURN env vars aren't configured.
app.get("/api/iceServers", (req, res) => {
  // Gated behind a valid session — this hands out standing TURN credentials, and the app is
  // reachable from the open internet (that's the whole reason TURN is needed), so an unauthenticated
  // endpoint here would let anyone who finds the URL harvest a relay credential without ever
  // logging in, not just members of this pod.
  const token = req.query.token;
  if (!token || !sessions[token]) return res.status(401).json({ error: "Not authenticated" });
  const servers = [{ urls: "stun:stun.l.google.com:19302" }];
  if (process.env.TURN_URL) {
    servers.push({ urls: process.env.TURN_URL, username: process.env.TURN_USERNAME || undefined, credential: process.env.TURN_PASSWORD || undefined });
  }
  res.json({ iceServers: servers });
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

  function currentLobby() {
    return socket.data.lobbyId ? lobbies[socket.data.lobbyId] : null;
  }

  // authOk always goes out first (client uses it to populate the Main Menu — deck list, etc.).
  // The reattach's lobbyJoined, if any, MUST be emitted after — the client's authOk handler
  // unconditionally shows the Main Menu, so emitting it after lobbyJoined would silently clobber
  // the reattach: the server would correctly have the player back in their seat, but the client
  // would be stuck showing the Main Menu, and since the server thinks they're already in that
  // lobby, both rejoining and creating a new table would silently no-op — a total softlock.
  socket.emit("authOk", { username, decks: Object.keys(decks[username] || {}) });

  // A reconnecting browser (network blip, tab refresh, server restart) resumes its seat silently
  // instead of landing back on the Main Menu with its board wiped. Matches by username regardless
  // of whether the old socket has actually been detected as disconnected yet -- if it's still
  // technically "connected" (a race from reconnecting faster than socket.io notices the old
  // connection is gone), force-close it after reattaching so there's never two live sockets
  // holding the same seat.
  const seat = findExistingSeat(username);
  if (seat) {
    const oldSocket = io.sockets.sockets.get(seat.oldSocketId);
    reattachPlayer(seat.lobby, seat.oldSocketId, socket.id);
    socket.data.lobbyId = seat.lobby.id;
    socket.join(seat.lobby.id);
    socket.emit("lobbyJoined", buildLobbyJoinedPayload(seat.lobby, socket.id));
    broadcastPlayers(seat.lobby);
    broadcastLobbyList();
    pushLog(seat.lobby, `${username} reconnected`);
    if (oldSocket && oldSocket.connected) oldSocket.disconnect(true);
  } else {
    socket.emit("lobbyList", lobbySummaries());
  }

  // ---- lobby lifecycle ----

  function joinLobbyInternal(lobby) {
    socket.data.lobbyId = lobby.id;
    socket.join(lobby.id);

    // Defense in depth against the same reconnect-race that the connection-time handler already
    // covers: if this account already has a seat in this exact lobby (disconnected, or even still
    // technically live from a duplicate connection), reclaim it instead of handing out a second,
    // empty seat that leaves the real one with all the cards orphaned until its grace timer fires.
    const existingId = seatInLobby(lobby, username);
    if (existingId && existingId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(existingId);
      reattachPlayer(lobby, existingId, socket.id);
      socket.emit("lobbyJoined", buildLobbyJoinedPayload(lobby, socket.id));
      broadcastPlayers(lobby);
      broadcastLobbyList();
      pushLog(lobby, `${username} reconnected`);
      if (oldSocket && oldSocket.connected) oldSocket.disconnect(true);
      return;
    }

    lobby.players[socket.id] = {
      username,
      name: username,
      color: nextColor(),
      life: 40, cmdr: 0, poison: 0,
      library: [], graveyard: [], exile: [],
      commanders: [null, null],
      mulligans: 0, handKept: false,
      mana: EMPTY_MANA(), landsPlayedThisTurn: 0, landDropBonus: 0
    };

    if (lobby.turn.started) {
      lobby.turn.order.push(socket.id);
      broadcastTurn(lobby);
    }

    socket.emit("lobbyJoined", buildLobbyJoinedPayload(lobby, socket.id));
    broadcastPlayers(lobby);
    broadcastLobbyList();
    pushLog(lobby, `${username} joined the table`);
  }

  // Watch-only join: never touches lobby.players, so every action handler's existing
  // `if (!p) return` guard already blocks a spectator from acting for free.
  function joinSpectatorInternal(lobby) {
    socket.data.lobbyId = lobby.id;
    socket.join(lobby.id);
    lobby.spectators[socket.id] = { username, name: username };
    socket.emit("lobbyJoined", buildLobbyJoinedPayload(lobby, socket.id));
    broadcastSpectators(lobby);
    broadcastLobbyList();
    pushLog(lobby, `${username} started spectating`);
  }

  // Defense in depth: if this socket is somehow still marked as seated (or spectating) somewhere
  // (a desync bug, a stale reattach, anything) leave it first instead of silently refusing to
  // create/join a new table — a main-menu action should never be able to permanently strand a
  // player with no way out and no way to clean up the table they're stuck in.
  function leaveCurrentLobbyIfAny() {
    const lobby = currentLobby();
    if (!lobby) return;
    socket.leave(lobby.id);
    socket.data.lobbyId = null;
    if (lobby.spectators[socket.id]) {
      delete lobby.spectators[socket.id];
      if (Object.keys(lobby.players).length === 0 && Object.keys(lobby.spectators).length === 0) {
        delete lobbies[lobby.id];
      } else {
        broadcastSpectators(lobby);
        pushLog(lobby, `${username} stopped spectating`);
      }
      broadcastLobbyList();
      return;
    }
    removePlayerFromLobby(lobby, socket.id, "left");
  }

  socket.on("createLobby", (data) => {
    const name = typeof data === "string" ? data : (data && data.name);
    const password = (typeof data === "object" && data && data.password) || "";
    leaveCurrentLobbyIfAny();
    const id = newLobbyId();
    const lobbyName = (name || "").toString().trim().slice(0, 40) || `${username}'s table`;
    const lobby = createLobbyState(id, lobbyName, username, password.toString().slice(0, 100));
    lobbies[id] = lobby;
    joinLobbyInternal(lobby);
  });

  socket.on("joinLobby", (data) => {
    const id = typeof data === "string" ? data : (data && data.id);
    const password = (typeof data === "object" && data && data.password) || "";
    if (socket.data.lobbyId === id) return; // already there — no-op, not a stale desync
    const lobby = lobbies[id];
    if (!lobby) { socket.emit("actionError", "That table no longer exists."); socket.emit("lobbyList", lobbySummaries()); return; }
    if (lobby.passwordHash && !verifyPassword(password.toString(), lobby.passwordSalt, lobby.passwordHash)) {
      socket.emit("actionError", "Wrong password for that table.");
      return;
    }
    leaveCurrentLobbyIfAny();
    joinLobbyInternal(lobby);
  });

  socket.on("spectateLobby", (data) => {
    const id = typeof data === "string" ? data : (data && data.id);
    const password = (typeof data === "object" && data && data.password) || "";
    if (socket.data.lobbyId === id) return;
    const lobby = lobbies[id];
    if (!lobby) { socket.emit("actionError", "That table no longer exists."); socket.emit("lobbyList", lobbySummaries()); return; }
    if (lobby.passwordHash && !verifyPassword(password.toString(), lobby.passwordSalt, lobby.passwordHash)) {
      socket.emit("actionError", "Wrong password for that table.");
      return;
    }
    leaveCurrentLobbyIfAny();
    joinSpectatorInternal(lobby);
  });

  socket.on("leaveLobby", leaveCurrentLobbyIfAny);

  socket.on("listLobbies", () => socket.emit("lobbyList", lobbySummaries()));

  socket.on("setName", (name) => {
    const lobby = currentLobby(); if (!lobby || !lobby.players[socket.id]) return;
    lobby.players[socket.id].name = (name || "Player").toString().slice(0, 24);
    broadcastPlayers(lobby);
  });

  socket.on("statChange", ({ key, val }) => {
    const lobby = currentLobby(); if (!lobby || !lobby.players[socket.id] || !["life", "cmdr", "poison"].includes(key)) return;
    lobby.players[socket.id][key] += val;
    broadcastPlayers(lobby);
  });

  // ---- mana / land drops ----

  socket.on("addMana", (color) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p || !["W", "U", "B", "R", "G", "C"].includes(color)) return;
    p.mana[color] = (p.mana[color] || 0) + 1;
    broadcastPlayers(lobby);
  });

  socket.on("removeMana", (color) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p || !["W", "U", "B", "R", "G", "C"].includes(color)) return;
    p.mana[color] = Math.max(0, (p.mana[color] || 0) - 1);
    broadcastPlayers(lobby);
  });

  socket.on("landDropBonus", (delta) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p) return;
    p.landDropBonus = Math.max(0, (p.landDropBonus || 0) + delta);
    broadcastPlayers(lobby);
  });

  // ---- battlefield cards ----

  socket.on("spawnCard", (data) => {
    const lobby = currentLobby(); if (!lobby || !lobby.players[socket.id]) return;
    spawnBattlefieldCard(lobby, { ...data, owner: socket.id, zoneType: classifyType(data.type) });
    const who = lobby.players[socket.id].name;
    pushLog(lobby, data.faceDown ? `${who} spawned a card face down` : `${who} spawned ${data.name}`);
  });

  socket.on("changeZone", ({ id, zoneType, x }) => {
    const lobby = currentLobby(); if (!lobby) return;
    const card = lobby.cards[id];
    const p = lobby.players[socket.id];
    if (!card || !p || card.owner !== socket.id) return;
    // "hand" is intentionally not a valid drag target here — there's no general rule that lets you
    // pick a permanent back up, so returning something to hand is a deliberate action (see "toHand"
    // below), not a side effect of dragging it into the hand row.
    if (!["mana", "creature", "artifact"].includes(zoneType)) return;

    if (card.zoneType === "hand") {
      const timing = checkTiming(lobby, socket.id, card);
      if (!timing.ok) { socket.emit("actionError", timing.error); return; }
      const result = attemptPlay(p, card, zoneType, x);
      if (!result.ok) { socket.emit("actionError", result.error); return; }
      card.zoneType = zoneType;
      card.faceDown = false;
      broadcastCard(lobby, card);
      broadcastPlayers(lobby);
      pushLog(lobby, `${p.name} played ${card.name || "a card"}`);
      return;
    }
    // reclassifying an existing battlefield permanent between creature/artifact/mana rows — purely
    // organizational, no cost.
    card.zoneType = zoneType;
    broadcastCard(lobby, card);
  });

  socket.on("playCard", (data) => {
    const lobby = currentLobby(); if (!lobby) return;
    const id = typeof data === "string" ? data : data.id;
    const xValue = (typeof data === "object" && data.x) || 0;
    const card = lobby.cards[id];
    const p = lobby.players[socket.id];
    if (!card || !p || card.owner !== socket.id) return;
    const targetZoneType = classifyType(card.type);
    const timing = checkTiming(lobby, socket.id, card);
    if (!timing.ok) { socket.emit("actionError", timing.error); return; }
    const result = attemptPlay(p, card, targetZoneType, xValue);
    if (!result.ok) { socket.emit("actionError", result.error); return; }
    card.zoneType = targetZoneType;
    card.faceDown = false;
    broadcastCard(lobby, card);
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} played ${card.name || "a card"}`);
  });

  socket.on("tap", (id) => {
    const lobby = currentLobby(); if (!lobby) return;
    const card = lobby.cards[id];
    if (!card || card.owner !== socket.id) return;
    // One-way now: this only ever taps. Real Magic has no "double-click to untap at will" —
    // untapping only happens automatically each Untap step (or via Untap All for effects that
    // untap things). Letting a player freely toggle back and forth on the same land was a way to
    // mint unlimited mana just by clicking it repeatedly.
    if (card.tapped) return;
    card.tapped = true;
    broadcastCard(lobby, card);
    // Auto-add mana for any tapped source with an unambiguous color — lands, rocks, and dorks
    // alike — not just basics. Basic land types are unambiguous by their type line; anything else
    // (rocks, dorks, nonbasic lands) is unambiguous only when the archive says it produces exactly
    // one color. A source that can produce more than one color (Command Tower, most signets/
    // talismans, City of Brass, mana dorks with a choice) prompts the player to pick instead of
    // silently guessing or staying fully manual.
    let color = basicLandColor(card.type);
    if (!color && Array.isArray(card.producedMana) && card.producedMana.length === 1) {
      color = card.producedMana[0];
    }
    if (color && ["W", "U", "B", "R", "G", "C"].includes(color)) {
      const p = lobby.players[socket.id];
      p.mana[color] = (p.mana[color] || 0) + 1;
      broadcastPlayers(lobby);
      pushLog(lobby, `${p.name} tapped ${card.name} for {${color}}`);
    } else if (Array.isArray(card.producedMana) && card.producedMana.length > 1) {
      const options = card.producedMana.filter((c) => ["W", "U", "B", "R", "G", "C"].includes(c));
      if (options.length) socket.emit("chooseMana", { cardId: card.id, cardName: card.name, options });
    }
  });

  // Player's answer to the "chooseMana" prompt above, for a tapped source with more than one
  // possible color.
  socket.on("resolveManaChoice", ({ cardId, color }) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    const card = lobby && lobby.cards[cardId];
    if (!p || !card || card.owner !== socket.id || !card.tapped) return;
    if (!Array.isArray(card.producedMana) || !card.producedMana.includes(color) || !["W", "U", "B", "R", "G", "C"].includes(color)) return;
    p.mana[color] = (p.mana[color] || 0) + 1;
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} tapped ${card.name} for {${color}}`);
  });

  socket.on("flip", (id) => {
    const lobby = currentLobby(); if (!lobby) return;
    const card = lobby.cards[id];
    if (!card || card.owner !== socket.id) return;
    card.faceDown = !card.faceDown;
    broadcastCard(lobby, card);
    const who = lobby.players[socket.id] ? lobby.players[socket.id].name : "Someone";
    pushLog(lobby, `${who} flipped a card`);
  });

  socket.on("counter", ({ id, delta }) => {
    const lobby = currentLobby(); if (!lobby) return;
    const card = lobby.cards[id];
    if (!card || card.owner !== socket.id) return;
    card.counters = (card.counters || 0) + delta;
    broadcastCard(lobby, card);
  });

  socket.on("removeCard", (id) => {
    const lobby = currentLobby(); if (!lobby) return;
    const card = lobby.cards[id];
    if (!card || card.owner !== socket.id) return;
    delete lobby.cards[id];
    if (lobby.targets[id]) { delete lobby.targets[id]; broadcastTargets(lobby); }
    io.to(lobby.id).emit("cardRemove", id);
    clearCommanderRef(lobby, card);
  });

  // Deliberate "this permanent is being bounced/returned to hand" action — represents a bounce
  // effect or similar, since there's no general rule that lets a permanent just go back to hand.
  socket.on("toHand", (id) => {
    const lobby = currentLobby(); if (!lobby) return;
    const card = lobby.cards[id];
    const p = lobby.players[socket.id];
    if (!card || !p || card.owner !== socket.id || card.zoneType === "hand") return;
    delete lobby.cards[id];
    if (lobby.targets[id]) { delete lobby.targets[id]; broadcastTargets(lobby); }
    io.to(lobby.id).emit("cardRemove", id);
    clearCommanderRef(lobby, card);
    spawnBattlefieldCard(lobby, { ...toEntry(card), owner: socket.id, faceDown: true, zoneType: "hand" });
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} returned ${card.name || "a face-down card"} to their hand`);
  });

  socket.on("untapAll", () => {
    const lobby = currentLobby(); if (!lobby) return;
    for (const id in lobby.cards) {
      if (lobby.cards[id].owner === socket.id && lobby.cards[id].tapped) {
        lobby.cards[id].tapped = false;
        broadcastCard(lobby, lobby.cards[id]);
      }
    }
    const who = lobby.players[socket.id] ? lobby.players[socket.id].name : "Someone";
    pushLog(lobby, `${who} untapped all their permanents`);
  });

  // ---- targeting (open to everyone) ----

  socket.on("toggleTarget", (cardId) => {
    const lobby = currentLobby(); if (!lobby || !lobby.cards[cardId]) return;
    const existing = lobby.targets[cardId] || [];
    const already = existing.includes(socket.id);
    const updated = already ? existing.filter((id) => id !== socket.id) : [...existing, socket.id];
    if (updated.length === 0) delete lobby.targets[cardId]; else lobby.targets[cardId] = updated;
    broadcastTargets(lobby);
    const who = lobby.players[socket.id] ? lobby.players[socket.id].name : "Someone";
    pushLog(lobby, `${who} ${already ? "removed a target from" : "targeted"} a card`);
  });

  // ---- zone transitions: battlefield -> graveyard/exile/library (owner only) ----

  function moveOut(lobby, cardId, zone, pos) {
    const card = lobby.cards[cardId];
    if (!card || card.owner !== socket.id) return;
    const owner = card.owner;
    delete lobby.cards[cardId];
    if (lobby.targets[cardId]) { delete lobby.targets[cardId]; broadcastTargets(lobby); }
    io.to(lobby.id).emit("cardRemove", cardId);
    clearCommanderRef(lobby, card);
    if (!lobby.players[owner]) return;
    const entry = toEntry(card);
    if (zone === "graveyard") lobby.players[owner].graveyard.push(entry);
    else if (zone === "exile") lobby.players[owner].exile.push(entry);
    else if (zone === "library") {
      if (pos === "top") lobby.players[owner].library.unshift(entry);
      else lobby.players[owner].library.push(entry);
    }
    broadcastPlayers(lobby);
    const ownerName = lobby.players[owner].name;
    pushLog(lobby, `${ownerName}'s ${card.name || "face-down card"} went to ${zone}`);
  }

  socket.on("toGraveyard", (id) => { const lobby = currentLobby(); if (lobby) moveOut(lobby, id, "graveyard"); });
  socket.on("toExile", (id) => { const lobby = currentLobby(); if (lobby) moveOut(lobby, id, "exile"); });
  socket.on("toLibraryTop", (id) => { const lobby = currentLobby(); if (lobby) moveOut(lobby, id, "library", "top"); });
  socket.on("toLibraryBottom", (id) => { const lobby = currentLobby(); if (lobby) moveOut(lobby, id, "library", "bottom"); });

  // ---- zone transitions: graveyard/exile -> battlefield/hand (owner only) ----

  socket.on("zoneToBattlefield", ({ zone, index }) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p || !p[zone] || !p[zone][index]) return;
    const entry = p[zone].splice(index, 1)[0];
    spawnBattlefieldCard(lobby, { ...entry, owner: socket.id, faceDown: false, zoneType: classifyType(entry.type) });
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} returned ${entry.name} to the battlefield`);
  });

  socket.on("zoneToHand", ({ zone, index }) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p || !p[zone] || !p[zone][index]) return;
    const entry = p[zone].splice(index, 1)[0];
    spawnBattlefieldCard(lobby, { ...entry, owner: socket.id, faceDown: true, zoneType: "hand" });
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} returned a card to their hand`);
  });

  // ---- library management (owner only) ----

  socket.on("shuffleLibrary", () => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p) return;
    shuffle(p.library);
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} shuffled their library`);
  });

  socket.on("drawCard", (count) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p) return;
    const drawn = drawN(lobby, socket.id, Math.max(1, Math.min(10, count || 1)));
    broadcastPlayers(lobby);
    if (drawn) pushLog(lobby, `${p.name} drew ${drawn} card${drawn > 1 ? "s" : ""}`);
  });

  socket.on("drawSpecific", (index) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p || !p.library[index]) return;
    const entry = p.library.splice(index, 1)[0];
    spawnBattlefieldCard(lobby, { ...entry, owner: socket.id, faceDown: true, zoneType: "hand" });
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} searched their library for a card`);
  });

  socket.on("millCard", (count) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p) return;
    const n = Math.max(1, Math.min(20, count || 1));
    let milled = 0;
    for (let i = 0; i < n && p.library.length > 0; i++) {
      p.graveyard.push(p.library.shift());
      milled++;
    }
    broadcastPlayers(lobby);
    if (milled) pushLog(lobby, `${p.name} milled ${milled} card${milled > 1 ? "s" : ""}`);
  });

  socket.on("importDeck", (text) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p) return;
    resolveAndSetLibrary(lobby, socket, p, text);
  });

  // ---- opening hand / mulligan ----

  socket.on("drawOpeningHand", () => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p) return;
    returnAllHandToLibrary(lobby, socket.id);
    shuffle(p.library);
    drawN(lobby, socket.id, 7);
    p.mulligans = 0;
    p.handKept = false;
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} drew their opening hand`);
  });

  socket.on("mulligan", () => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p || p.mulligans >= 2) return;
    returnAllHandToLibrary(lobby, socket.id);
    shuffle(p.library);
    drawN(lobby, socket.id, 7);
    p.mulligans += 1;
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} took a mulligan (${p.mulligans}/2)`);
  });

  socket.on("keepHand", () => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p) return;
    p.handKept = true;
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} kept their hand and is ready`);
  });

  // ---- persistent decks (account-scoped, not lobby-scoped) ----

  socket.on("saveDeck", ({ name, commanders, library }) => {
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
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p) return;
    const deck = decks[username] && decks[username][name];
    if (!deck) { socket.emit("importResult", { success: false, error: "Deck not found." }); return; }
    if (typeof deck === "string") {
      resolveAndSetLibrary(lobby, socket, p, deck); // legacy raw-text save, no separate commander
      return;
    }
    p.library = (deck.library || []).map((c) => ({ ...c }));
    shuffle(p.library);
    applyCommandersToPlayer(p, deck.commanders);
    broadcastPlayers(lobby);
    const cmdCount = (deck.commanders || []).filter(Boolean).length;
    socket.emit("importResult", { success: true, requested: p.library.length, found: p.library.length });
    pushLog(lobby, `${p.name} loaded deck "${name}" (${p.library.length} cards${cmdCount ? ` + ${cmdCount} commander${cmdCount > 1 ? "s" : ""}` : ""})`);
  });

  // Resolves a pasted decklist to full card data for the deck editor, without touching the
  // live game — the editor decides what to do with the result (add to its working library).
  // Not lobby-scoped — the editor works whether or not you're at a table.
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
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p) return;
    p.library = (Array.isArray(library) ? library : []).slice(0, 99).map((c) => toEntry(c));
    shuffle(p.library);
    applyCommandersToPlayer(p, commanders);
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} loaded a deck draft into the game`);
  });

  // ---- commander zone ----

  socket.on("setCommander", (data) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p) return;
    setCommanderFromData(p, data.slot, data);
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} set their commander: ${data.name}`);
  });

  socket.on("clearCommander", (slot) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p || slot < 0 || slot > 1) return;
    p.commanders[slot] = null;
    broadcastPlayers(lobby);
  });

  socket.on("commanderTax", ({ slot, delta }) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p || !p.commanders[slot]) return;
    p.commanders[slot].tax = Math.max(0, p.commanders[slot].tax + delta);
    broadcastPlayers(lobby);
  });

  socket.on("castCommander", (slot) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p || !p.commanders[slot]) return;
    const cmd = p.commanders[slot];
    if (cmd.battlefieldId && lobby.cards[cmd.battlefieldId]) {
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
    const card = spawnBattlefieldCard(lobby, { ...cmd, owner: socket.id, faceDown: false, zoneType: classifyType(cmd.type), isCommander: true });
    cmd.battlefieldId = card.id;
    cmd.tax += 2;
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} cast their commander: ${cmd.name} (tax now ${cmd.tax})`);
  });

  // ---- turn structure ----

  socket.on("startGame", () => {
    const lobby = currentLobby(); if (!lobby || !lobby.players[socket.id]) return;
    // Pregame dice roll decides turn order — everyone rolls a d20, highest goes first, ties
    // broken randomly, and the log shows every roll so it's not just a silent shuffle.
    const rolls = Object.keys(lobby.players).map((sid) => ({ sid, roll: randInt(20) + 1, tiebreak: Math.random() }));
    rolls.sort((a, b) => b.roll - a.roll || b.tiebreak - a.tiebreak);
    rolls.forEach((r) => pushLog(lobby, `${lobby.players[r.sid].name} rolled a ${r.roll} for turn order`));
    lobby.turn.order = rolls.map((r) => r.sid);
    lobby.turn.activeIndex = 0;
    lobby.turn.phase = "Main 1";
    lobby.turn.turnNumber = 1;
    lobby.turn.started = true;
    lobby.combat = { step: "none", attackers: {}, blocks: {}, defendersPending: [] };
    for (const pid in lobby.players) {
      lobby.players[pid].mana = EMPTY_MANA();
      lobby.players[pid].landsPlayedThisTurn = 0;
    }
    broadcastTurn(lobby);
    broadcastCombat(lobby);
    broadcastPlayers(lobby);
    pushLog(lobby, `${lobby.players[lobby.turn.order[0]].name} goes first! Turn order: ${lobby.turn.order.map((id) => (lobby.players[id] ? lobby.players[id].name : "?")).join(" → ")}`);
  });

  socket.on("nextPhase", () => {
    const lobby = currentLobby(); if (!lobby) return;
    if (!lobby.turn.started) return;
    const activeId = lobby.turn.order[lobby.turn.activeIndex];
    if (activeId !== socket.id) return;
    if (lobby.turn.pendingDiscard) return; // can't advance past End Step until the discard is resolved
    if (lobby.turn.phase === "End Step") {
      const handCount = Object.values(lobby.cards).filter((c) => c.owner === activeId && c.zoneType === "hand").length;
      if (handCount > 7 && !hasNoMaxHandSize(lobby, activeId)) {
        lobby.turn.pendingDiscard = { playerId: activeId, count: handCount - 7 };
        broadcastTurn(lobby);
        pushLog(lobby, `${lobby.players[activeId].name} must discard down to 7 cards`);
        return;
      }
    }
    advancePhase(lobby);
  });

  socket.on("resolveDiscard", (cardIds) => {
    const lobby = currentLobby(); if (!lobby) return;
    const pd = lobby.turn.pendingDiscard;
    if (!pd || pd.playerId !== socket.id) return;
    const ids = Array.isArray(cardIds) ? [...new Set(cardIds)] : [];
    if (ids.length !== pd.count) { socket.emit("actionError", `You must discard exactly ${pd.count} card(s).`); return; }
    for (const id of ids) {
      const card = lobby.cards[id];
      if (!card || card.owner !== socket.id || card.zoneType !== "hand") { socket.emit("actionError", "Invalid discard selection."); return; }
    }
    const p = lobby.players[socket.id];
    ids.forEach((id) => sendToGraveyardInternal(lobby, lobby.cards[id]));
    pushLog(lobby, `${p.name} discarded ${ids.length} card(s) to hand size`);
    lobby.turn.pendingDiscard = null;
    advancePhase(lobby);
  });

  // ---- combat ----

  socket.on("declareAttackers", (assignments) => {
    const lobby = currentLobby(); if (!lobby) return;
    if (!lobby.turn.started || lobby.turn.order[lobby.turn.activeIndex] !== socket.id) return;
    if (lobby.combat.step !== "declareAttackers") return;
    const validAttackers = {};
    const defendersSet = new Set();
    for (const [cardId, defenderId] of Object.entries(assignments || {})) {
      const card = lobby.cards[cardId];
      if (!card || card.owner !== socket.id || card.zoneType !== "creature" || card.tapped) continue;
      const hasHaste = Array.isArray(card.keywords) && card.keywords.some((k) => (k || "").toLowerCase() === "haste");
      if (card.controllerSince === lobby.turn.turnNumber && !hasHaste) continue; // summoning sick
      if (!lobby.players[defenderId] || defenderId === socket.id) continue;
      validAttackers[cardId] = defenderId;
      defendersSet.add(defenderId);
      card.tapped = true;
      broadcastCard(lobby, card);
    }
    lobby.combat.attackers = validAttackers;
    lobby.combat.blocks = {};
    // Skip declareBlockers for a defender with no untapped creature to block with — otherwise
    // combat just sits waiting on a no-op "No Blocks" confirmation they may not realize to give.
    const pendingWithBlockers = Array.from(defendersSet).filter((defId) =>
      Object.values(lobby.cards).some((c) => c.owner === defId && c.zoneType === "creature" && !c.tapped)
    );
    lobby.combat.defendersPending = pendingWithBlockers;
    lobby.combat.step = pendingWithBlockers.length > 0 ? "declareBlockers" : "damage";
    broadcastCombat(lobby);
    const activeName = lobby.players[socket.id] ? lobby.players[socket.id].name : "?";
    pushLog(lobby, `${activeName} declared ${Object.keys(validAttackers).length} attacker(s)`);
    if (lobby.combat.step === "damage") resolveCombatDamage(lobby);
  });

  socket.on("declareBlockers", (assignments) => {
    const lobby = currentLobby(); if (!lobby) return;
    if (lobby.combat.step !== "declareBlockers") return;
    if (!lobby.combat.defendersPending.includes(socket.id)) return;
    const usedBlockers = new Set(Object.values(lobby.combat.blocks).filter(Boolean));
    for (const [attackerId, blockerId] of Object.entries(assignments || {})) {
      if (lobby.combat.attackers[attackerId] !== socket.id) continue;
      if (blockerId) {
        if (usedBlockers.has(blockerId)) continue;
        const blockerCard = lobby.cards[blockerId];
        if (!blockerCard || blockerCard.owner !== socket.id || blockerCard.zoneType !== "creature" || blockerCard.tapped) continue;
        lobby.combat.blocks[attackerId] = blockerId;
        usedBlockers.add(blockerId);
      } else {
        lobby.combat.blocks[attackerId] = null;
      }
    }
    lobby.combat.defendersPending = lobby.combat.defendersPending.filter((id) => id !== socket.id);
    broadcastCombat(lobby);
    const p = lobby.players[socket.id];
    pushLog(lobby, `${p ? p.name : "?"} declared blockers`);
    if (lobby.combat.defendersPending.length === 0) {
      lobby.combat.step = "damage";
      broadcastCombat(lobby);
      resolveCombatDamage(lobby);
    }
  });

  // ---- chat ----

  socket.on("chatMessage", (text) => {
    const lobby = currentLobby(); if (!lobby || !text) return;
    const p = lobby.players[socket.id];
    const spectating = lobby.spectators[socket.id];
    if (!p && !spectating) return;
    const msg = p
      ? { name: p.name, color: p.color, text: String(text).slice(0, 500), ts: Date.now() }
      : { name: `${username} (spectator)`, color: "#8a7a55", text: String(text).slice(0, 500), ts: Date.now() };
    lobby.chatLog.push(msg);
    if (lobby.chatLog.length > 200) lobby.chatLog.shift();
    io.to(lobby.id).emit("chatMessage", msg);
  });

  // ---- voice signaling (WebRTC mesh; server only relays, scoped to the lobby) ----

  socket.on("voiceJoin", () => {
    const lobby = currentLobby(); if (!lobby) return;
    lobby.voiceParticipants.forEach((existingId) => {
      socket.emit("voiceShouldOffer", { toId: existingId });
    });
    lobby.voiceParticipants.add(socket.id);
    broadcastVoiceRoster(lobby);
  });

  socket.on("voiceLeave", () => {
    const lobby = currentLobby(); if (!lobby) return;
    lobby.voiceParticipants.delete(socket.id);
    broadcastVoiceRoster(lobby);
  });

  socket.on("voiceSignal", ({ toId, data }) => {
    const lobby = currentLobby(); if (!lobby) return;
    const target = io.sockets.sockets.get(toId);
    if (target && target.data.lobbyId === lobby.id) target.emit("voiceSignal", { fromId: socket.id, data });
  });

  // ---- misc ----

  socket.on("log", (msg) => { const lobby = currentLobby(); if (lobby) pushLog(lobby, msg); });

  socket.on("clearBoard", () => {
    const lobby = currentLobby(); if (!lobby || !lobby.players[socket.id]) return;
    for (const id in lobby.cards) {
      const c = lobby.cards[id];
      if (lobby.players[c.owner]) lobby.players[c.owner].library.push(toEntry(c));
    }
    lobby.cards = {};
    lobby.targets = {};
    for (const pid in lobby.players) {
      const p = lobby.players[pid];
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
    lobby.gameState.log = [];
    lobby.turn = { started: false, order: [], activeIndex: 0, phase: "Main 1", turnNumber: 1, pendingDiscard: null };
    lobby.combat = { step: "none", attackers: {}, blocks: {}, defendersPending: [] };
    io.to(lobby.id).emit("cleared");
    broadcastPlayers(lobby);
    broadcastTargets(lobby);
    broadcastTurn(lobby);
    broadcastCombat(lobby);
  });

  socket.on("disconnect", () => {
    const lobby = currentLobby();
    if (!lobby) return;
    if (lobby.spectators[socket.id]) {
      // Spectators hold no game state worth preserving -- just drop the watch slot immediately
      // instead of running the reconnect-grace machinery built for seated players.
      delete lobby.spectators[socket.id];
      if (Object.keys(lobby.players).length === 0 && Object.keys(lobby.spectators).length === 0) {
        delete lobbies[lobby.id];
      } else {
        broadcastSpectators(lobby);
      }
      broadcastLobbyList();
      return;
    }
    const p = lobby.players[socket.id];
    if (!p) return;
    p.disconnectedAt = Date.now();
    broadcastPlayers(lobby); // lets others see a "disconnected" indicator while the seat is held open
    scheduleGraceRemoval(lobby, socket.id);
  });
});

http.listen(8087, () => { console.log("Commander Engine Listening on 8087"); });
