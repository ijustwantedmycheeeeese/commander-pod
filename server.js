const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const { execFile } = require("child_process");
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

// User-uploaded board mat/avatar images. Falls inside the same DATA_DIR the Docker volume
// (mtg_data:/app/data) already mounts wholesale -- no separate volume declaration needed for
// uploads to actually persist across container restarts/redeploys the same way users.json does.
const UPLOAD_DIR = DATA_DIR + "/uploads";
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) {}
app.use("/uploads", express.static(UPLOAD_DIR));

// Deletes an old uploaded file when it's being replaced/cleared -- UNLESS it's still referenced
// by an entry in that user's saved-mats library, in which case it has to survive. Scoped to the
// common case (repeatedly changing your own avatar/active mat shouldn't pile up files forever),
// not a full reference-counting system across every lobby/account -- a known, accepted limitation
// for a small trusted pod, not a silent partial fix.
function deleteUploadIfOrphaned(oldUrl, forUsername) {
  if (!oldUrl || !oldUrl.startsWith("/uploads/")) return;
  const savedMats = mats[forUsername] || {};
  if (Object.values(savedMats).includes(oldUrl)) return; // still referenced, keep it
  const savedPileMats = pileMats[forUsername] || {};
  if (Object.values(savedPileMats).some((m) => m && m.url === oldUrl)) return; // still a saved pile-art preset
  if (users[forUsername] && users[forUsername].avatar === oldUrl) return; // still the account avatar
  // The same account could have this same URL set as the ACTIVE mat on a different table (e.g.
  // applied a saved mat on two tables, then changed it on one) -- don't delete out from under it.
  for (const id in lobbies) {
    for (const sid in lobbies[id].players) {
      const p = lobbies[id].players[sid];
      if (p.username !== forUsername) continue;
      if (p.boardMat === oldUrl) return;
      if (p.pileArt && Object.values(p.pileArt).some((a) => a && a.url === oldUrl)) return;
    }
  }
  const filename = oldUrl.slice("/uploads/".length);
  // Filenames this app generates are always a flat hex string -- refuse anything else rather
  // than trust a stored value that could (however unlikely) contain a path separator.
  if (!/^[0-9a-f]+(\.[a-z0-9]+)?$/i.test(filename)) return;
  fs.unlink(path.join(UPLOAD_DIR, filename), () => {}); // best-effort, fire-and-forget
}

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data)); } catch (e) { console.error("Failed to save " + file, e); }
}
const USERS_FILE = DATA_DIR + "/users.json";
const DECKS_FILE = DATA_DIR + "/decks.json";
const MATS_FILE = DATA_DIR + "/mats.json";
const PILE_MATS_FILE = DATA_DIR + "/pile_mats.json";
const CARD_ARCHIVE_FILE = DATA_DIR + "/card_archive.json";
const COLLECTION_FILE = DATA_DIR + "/collection.json";
// Bug-report tickets -- read/written directly by admin-server.js too (same shared DATA_DIR volume,
// same "separate process, same file" pattern users.json already uses for account approval). Since
// the admin can close a ticket from that completely separate process while this one keeps running,
// `tickets` is re-read fresh from disk right before every use (see submitTicket/getMyTickets) rather
// than trusted as a long-lived in-memory copy -- the exact same "an admin's edit must be honored on
// the very next relevant action, not whenever this process happens to restart" reasoning already
// applied to users.json in the login/register handlers.
const TICKETS_FILE = DATA_DIR + "/tickets.json";
let users = loadJSON(USERS_FILE, {});
let decks = loadJSON(DECKS_FILE, {});
let mats = loadJSON(MATS_FILE, {}); // username -> { matName: url } -- account-wide, unlike the per-table active boardMat
let pileMats = loadJSON(PILE_MATS_FILE, {}); // username -> { presetName: {url,scale,x,y} } -- same idea, for pile art
let cardArchive = loadJSON(CARD_ARCHIVE_FILE, {}); // lowercase card name -> full extracted card data
// username -> { archiveKey(name): {name,type,img} } -- a personal "I own this in real life" list,
// entirely independent of any saved deck (a card can be checked off here without being in any
// deck, and being in a deck doesn't check it off automatically). Only the display fields are kept,
// same "just enough to render a row" scope as mats/pileMats.
let collection = loadJSON(COLLECTION_FILE, {});
function saveUsers() { saveJSON(USERS_FILE, users); }
function saveDecks() { saveJSON(DECKS_FILE, decks); }
function saveMats() { saveJSON(MATS_FILE, mats); }
function savePileMats() { saveJSON(PILE_MATS_FILE, pileMats); }
function saveCollection() { saveJSON(COLLECTION_FILE, collection); }
function saveCardArchive() { saveJSON(CARD_ARCHIVE_FILE, cardArchive); }
function archiveKey(name) { return (name || "").toLowerCase().trim(); }
function archiveCard(fields) {
  if (!fields || !fields.name) return;
  cardArchive[archiveKey(fields.name)] = fields;
}

// Optional: set NTFY_TOPIC to get a push notification (via https://ntfy.sh, or a self-hosted
// ntfy server via NTFY_SERVER) whenever a new account registers and needs admin approval.
// Silently does nothing if NTFY_TOPIC isn't set -- this is a nice-to-have, not required config.
const NTFY_TOPIC = process.env.NTFY_TOPIC || "";
const NTFY_SERVER = process.env.NTFY_SERVER || "https://ntfy.sh";
function notifyNewAccountPending(username) {
  if (!NTFY_TOPIC) return;
  fetch(NTFY_SERVER.replace(/\/$/, "") + "/" + NTFY_TOPIC, {
    method: "POST",
    headers: { "Title": "Archon", "Tags": "bust_in_silhouette" },
    body: `New account waiting on approval: ${username}`,
  }).catch((e) => console.error("ntfy notification failed:", e.message));
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

// A user record predating this feature has neither field -- backfill both once at startup rather
// than treating "field missing" as a special case at every read site. approved:true for anyone
// already registered (the approval gate only ever applies to NEW registrations from here on);
// sessionVersion starts at 0 and increments on password change, invalidating every session issued
// before that point (see sessionUsername below) -- the one piece of "known limitation" this file
// used to call out explicitly.
for (const uname in users) {
  if (users[uname].approved === undefined) users[uname].approved = true;
  if (users[uname].sessionVersion === undefined) users[uname].sessionVersion = 0;
}
saveUsers();

let sessions = {}; // token -> { username, version, createdAt }
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days -- generous on purpose, this is a casual small-pod app, not logging people out mid-week
// Single choke point for "is this token still good" -- expiry AND version-invalidation (a password
// change bumps sessionVersion, which silently invalidates every token issued before that, including
// ones from other devices/browsers that never get an explicit sign-out). Every session-token lookup
// in this file goes through this instead of a raw `sessions[token]` read.
function sessionUsername(token) {
  const s = token && sessions[token];
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_MAX_AGE_MS) { delete sessions[token]; return null; }
  const u = users[s.username];
  if (!u || u.sessionVersion !== s.version) { delete sessions[token]; return null; }
  return s.username;
}
function issueSession(username) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions[token] = { username, version: users[username].sessionVersion, createdAt: Date.now() };
  return token;
}

// Basic brute-force throttling on login -- in-memory only (resets on restart), matching this app's
// existing "small trusted pod, not a public service" threat model rather than building out anything
// persistent/IP-based. Keyed by username since that's what an attacker would be guessing passwords
// against; a genuine user mistyping their own password a few times in a row is the expected/accepted
// cost of this.
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
let loginAttempts = {}; // username -> { count, firstAttemptAt }
function isLockedOut(username) {
  const a = loginAttempts[username];
  if (!a) return false;
  if (Date.now() - a.firstAttemptAt > LOGIN_LOCKOUT_MS) { delete loginAttempts[username]; return false; }
  return a.count >= LOGIN_MAX_ATTEMPTS;
}
function recordFailedLogin(username) {
  const a = loginAttempts[username];
  if (!a || Date.now() - a.firstAttemptAt > LOGIN_LOCKOUT_MS) {
    loginAttempts[username] = { count: 1, firstAttemptAt: Date.now() };
  } else {
    a.count++;
  }
}
function clearFailedLogins(username) { delete loginAttempts[username]; }

// ---------------- lobbies ----------------
// Each lobby holds its own fully-isolated copy of what used to be single global game state
// (cards/players/turn/combat/etc). Sockets join a Socket.IO room matching the lobby id, and every
// game handler below resolves its lobby fresh via currentLobby(socket) — nothing is global anymore.

const COLORS = ["#ef4444", "#3b82f6", "#22c55e", "#eab308", "#a855f7", "#ec4899", "#14b8a6", "#f97316"];
let colorIndex = 0;
function nextColor() { return COLORS[colorIndex++ % COLORS.length]; }
// A separate, fixed 10-color palette for the live cursor-tracking dot -- deliberately its OWN list
// rather than reusing COLORS above, since COLORS is assigned via a global round-robin counter with
// no real per-lobby uniqueness guarantee (fine for a name-tag color, not fine for "no two players
// share a cursor color," which setCursorColor below actually enforces per lobby).
const CURSOR_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#3b82f6", "#6366f1", "#a855f7", "#ec4899", "#78716c"];
function randInt(n) { return Math.floor(Math.random() * n); }
function newId() { return "c_" + Date.now() + "_" + randInt(100000); }
// "ab_" prefix keeps a triggered-ability stack instance's id visually distinct from a real card id
// and guarantees it can never collide with one.
function newAbilityId() { return "ab_" + Date.now() + "_" + randInt(100000); }
function newLobbyId() { return crypto.randomBytes(4).toString("hex"); }

const PHASES = ["Untap", "Upkeep", "Draw", "Main 1", "Combat", "Main 2", "End Step"];
// Manually grantable keywords (auras, equipment, anthems, etc. -- none of which are automated in
// this app) -- a curated list matching Scryfall's own keyword naming so a granted keyword looks
// identical to one a card was natively printed with. Haste already plugs straight into the
// existing summoning-sickness check in declareAttackers with zero extra code.
const KNOWN_KEYWORDS = ["Flying", "Haste", "Indestructible", "Deathtouch", "Lifelink", "Trample", "Vigilance", "Menace", "Reach", "First strike", "Double strike", "Hexproof", "Ward", "Defender", "Flash", "Protection", "Shroud", "Infect", "Unblockable"];
const EMPTY_MANA = () => ({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });

// ---------------- trigger/effect engine ----------------
//
// Hand-authored, structured automation for SELF-referential triggers only (a card's own ETB/
// death/attack -- never "whenever another creature you control dies" or anything requiring a
// player-chosen target). Oracle text is never parsed; each entry here is a deliberate, reviewed
// translation of a specific card's real text into a fixed effect vocabulary. Looked up server-side
// ONLY by card name, at the moment a trigger fires -- never trusted from client payloads, unlike
// `cardArchive` (which round-trips through client-supplied spawn data and can't be treated as
// server-authoritative). Grows on demand as specific cards are requested, not pre-populated.
const CARD_ABILITIES = {
  "elvish visionary": [{ trigger: "etb", label: "Elvish Visionary — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "mulldrifter": [{ trigger: "etb", label: "Mulldrifter — draw two cards", effects: [{ type: "drawCards", amount: 2 }] }],
  "kitchen finks": [{ trigger: "etb", label: "Kitchen Finks — gain 2 life", effects: [{ type: "gainLife", target: "controller", amount: 2 }] }],
  "hornet queen": [{
    trigger: "etb", label: "Hornet Queen — create four Insect tokens",
    effects: [{ type: "createToken", amount: 4, name: "Insect", tokenType: "Token Creature — Insect", power: "1", toughness: "1", colors: ["G"], keywords: ["Flying", "Deathtouch"], img: "https://cards.scryfall.io/normal/front/f/5/f5844636-3fdd-4818-9c35-c24f74b29baa.jpg" }]
  }],
  // Real text is "you may draw a card" -- optional triggers ("may") aren't modeled, always resolves.
  "solemn simulacrum": [{ trigger: "death", label: "Solemn Simulacrum — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  // Real text: "each opponent loses 5 life. You gain life equal to the life lost this way." The gain
  // is hardcoded to 5 rather than actually summing what opponents lost -- correct 1v1, undercounts
  // in a 3+ opponent pod (real Magic would gain 15 there). Accepted v1 simplification; no effect
  // in this vocabulary can reference another effect's outcome yet.
  "kokusho, the evening star": [{
    trigger: "death", label: "Kokusho, the Evening Star — drains for 5",
    effects: [{ type: "loseLife", target: "eachOpponent", amount: 5 }, { type: "gainLife", target: "controller", amount: 5 }]
  }],
  "library larcenist": [{ trigger: "attack", label: "Library Larcenist — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  // Real text also grants first strike + becomes an Assassin once it has 2+ counters -- that's a
  // conditional continuous effect, out of scope for this vocabulary; only the counter itself is
  // automated. Chosen specifically to prove combat-sequencing: the counter needs to land BEFORE
  // damage is computed for this to matter (a 1/1 that's genuinely a 2/2 by the time it deals damage).
  "ezio, brash novice": [{ trigger: "attack", label: "Ezio, Brash Novice — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  // requiresTarget entries queue for a player-chosen target (see queueTargetChoice) instead of
  // pushing straight to the stack -- everything else about them works the same once a target is
  // picked. Real conditions this vocabulary can't check (nonartifact/nonblack, "an opponent
  // controls") are simplified to "any creature" -- same "close approximation, adjudicate anything
  // narrower manually" precedent as everywhere else unautomated in this app.
  "nekrataal": [{ trigger: "etb", label: "Nekrataal — destroy target creature", requiresTarget: true, effects: [{ type: "destroyTarget" }] }],
  "ravenous chupacabra": [{ trigger: "etb", label: "Ravenous Chupacabra — destroy target creature", requiresTarget: true, effects: [{ type: "destroyTarget" }] }],
  "man-o'-war": [{ trigger: "etb", label: "Man-o'-War — bounce target creature", requiresTarget: true, effects: [{ type: "bounceTargetToHand" }] }],
  // First three seeded examples of the non-self-referential trigger types (see fireGlobalTrigger) --
  // "deathYouControl"/"selfGainsLife"/"youCastSpell" fire for a permanent's controller off an event
  // on any of their OTHER permanents/actions, not just this card's own name.
  "zulaport cutthroat": [{ trigger: "deathYouControl", label: "Zulaport Cutthroat — drains for 1", effects: [{ type: "loseLife", target: "eachOpponent", amount: 1 }, { type: "gainLife", target: "controller", amount: 1 }] }],
  "ajani's pridemate": [{ trigger: "selfGainsLife", label: "Ajani's Pridemate — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  // Real text has no further condition ("Whenever you cast a spell, you gain 1 life") -- no
  // simplification needed here, unlike most other narrowed entries in this table.
  "contemplation": [{ trigger: "youCastSpell", label: "Contemplation — gain 1 life", effects: [{ type: "gainLife", target: "controller", amount: 1 }] }],
  // Batch-generated from data/oracle-catalog.json via tools/scan-trigger-candidates.js -- each
  // entry matched one of the exact simple phrasings above (single-clause draw/gain-life/+1-1-counter/
  // destroy-exile-bounce-tap-target triggers) against real, verified Scryfall oracle text, so no
  // hand-verification of individual card text was needed the way the earlier hand-picked examples
  // required. Regenerate/extend this batch by re-running that script as the card pool grows.
  "proft's eidetic memory": [{ trigger: "etb", label: "Proft's Eidetic Memory — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "the lion-turtle": [{ trigger: "etb", label: "The Lion-Turtle — gain 3 life", effects: [{ type: "gainLife", target: "controller", amount: 3 }] }],
  "venerated stormsinger": [{ trigger: "deathYouControl", label: "Venerated Stormsinger — each opponent loses 1 life, gain 1 life", effects: [{ type: "loseLife", target: "eachOpponent", amount: 1 }, { type: "gainLife", target: "controller", amount: 1 }] }],
  "voice of the blessed": [{ trigger: "selfGainsLife", label: "Voice of the Blessed — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "essence channeler": [{ trigger: "selfGainsLife", label: "Essence Channeler — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "wall of limbs": [{ trigger: "selfGainsLife", label: "Wall of Limbs — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "exemplar of light": [{ trigger: "selfGainsLife", label: "Exemplar of Light — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "bloodbond vampire": [{ trigger: "selfGainsLife", label: "Bloodbond Vampire — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "blood researcher": [{ trigger: "selfGainsLife", label: "Blood Researcher — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "bloodthirsty aerialist": [{ trigger: "selfGainsLife", label: "Bloodthirsty Aerialist — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "fiendish panda": [{ trigger: "selfGainsLife", label: "Fiendish Panda — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "pest mascot": [{ trigger: "selfGainsLife", label: "Pest Mascot — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "celestial unicorn": [{ trigger: "selfGainsLife", label: "Celestial Unicorn — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "elenda's hierophant": [{ trigger: "selfGainsLife", label: "Elenda's Hierophant — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "scion of the swarm": [{ trigger: "selfGainsLife", label: "Scion of the Swarm — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "twinblade paladin": [{ trigger: "selfGainsLife", label: "Twinblade Paladin — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "aerith gainsborough": [{ trigger: "selfGainsLife", label: "Aerith Gainsborough — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  // Windcrag Siege ("As this enchantment enters, choose Mardu or Jeskai. • Mardu — ... • Jeskai —
  // At the beginning of your upkeep, create a 1/1 red Goblin creature token. It gains lifelink and
  // haste until end of turn.") -- the mode itself is chosen via ACTIVATED_ABILITIES (see its comment
  // for why), this is just the Jeskai mode's resulting upkeep trigger, gated on that choice.
  // Simplification: lifelink/haste are granted PERMANENTLY on the token rather than until end of
  // turn -- this app has no temporary/duration-based effect system (nothing ever expires at cleanup),
  // so a real "until end of turn" grant isn't representable; haste no longer matters past this turn
  // anyway, and permanent lifelink on a single 1/1 token is a minor, disclosed deviation rather than
  // a silent one. The Mardu mode ("double a triggered ability caused by attacking") is NOT automated
  // at all -- it would need to intercept every OTHER permanent's arbitrary triggered abilities, far
  // outside this vocabulary's scope; picking it is tracked (see chooseMode) but has no game effect.
  "windcrag siege": [{ trigger: "upkeep", label: "Windcrag Siege — create a Goblin token", condition: (c) => c.chosenMode === "Jeskai",
    effects: [{ type: "createToken", name: "Goblin", tokenType: "Token Creature — Goblin", power: "1", toughness: "1", colors: ["R"], keywords: ["Lifelink", "Haste"], img: "https://cards.scryfall.io/normal/front/7/0/70f8a1de-cd4c-4afa-bf03-0245d375d42e.jpg" }] }],
  "rune-scarred demon": [{ trigger: "etb", label: "Rune-Scarred Demon — search for a card", effects: [{ type: "tutorToHand" }] }],
  // Real text: "you MAY destroy target creature" -- optional, unlike most triggers in this table.
  // Modeled as a normal required-target trigger (same as everything else "may" in this app), with
  // Cancel on the target-choice banner as the way to decline -- that escape hatch didn't exist when
  // most of the earlier "may" simplifications in this file were written, so this one uses it instead
  // of quietly always resolving.
  "overseer of the damned": [{ trigger: "etb", label: "Overseer of the Damned — destroy target creature", requiresTarget: true, targetZoneType: "creature", effects: [{ type: "destroyTarget" }] }],
  // Kaalia of the Vast's signature ability -- see the "handCard" targetKind branches in fireTrigger/
  // resolveChosenTarget/EFFECTS.putFromHandAttacking for the actual mechanism. "You may" is handled
  // by the pre-existing Cancel-on-target-choice escape hatch, same as Overseer of the Damned above.
  "kaalia of the vast": [{ trigger: "attack", label: "Kaalia of the Vast — put an Angel, Demon, or Dragon from hand onto the battlefield attacking",
    requiresTarget: true, targetKind: "handCard", handTypeFilter: ["Angel", "Demon", "Dragon"], effects: [{ type: "putFromHandAttacking" }] }],
  // Hellkite Tyrant / Lord of the Void: "whenever this creature deals combat damage to a player,
  // gain control of..." / "...exile the top seven, put a creature from among them onto the
  // battlefield under your control" -- both are control-change effects keyed off COMBAT DAMAGE TO
  // A PLAYER specifically (not just "attacks"), which needed its own new trigger type + hook point
  // (see fireCombatDamageTriggers, called from resolveCombatDamage at the exact point unblocked/
  // trampled-over damage actually lands on a player, not at declare-attackers time).
  "hellkite tyrant": [{ trigger: "combatDamageToPlayer", label: "Hellkite Tyrant — gain control of all their artifacts", effects: [{ type: "gainControlOfArtifacts" }] }],
  "lord of the void": [{ trigger: "combatDamageToPlayer", label: "Lord of the Void — exile top 7, put a creature onto the battlefield", effects: [{ type: "exileTopNPutCreatureOntoBattlefield", amount: 7 }] }],
  "aurelia, the warleader": [{ trigger: "attack", label: "Aurelia, the Warleader — untap creatures, additional combat phase",
    condition: (c, lobby) => c.lastExtraCombatTurn !== lobby.turn.turnNumber,
    effects: [{ type: "grantExtraCombatPhase", stampCard: true }] }],
  "combat celebrant": [{ trigger: "attack", label: "Combat Celebrant — untap other creatures, additional combat phase",
    condition: (c, lobby) => c.lastExtraCombatTurn !== lobby.turn.turnNumber,
    effects: [{ type: "grantExtraCombatPhase", stampCard: true, excludeSelf: true }] }],
  "balefire dragon": [{ trigger: "combatDamageToPlayer", label: "Balefire Dragon — damage each creature they control", effects: [{ type: "damageAllCreaturesOfPlayer" }] }],
  "demon of loathing": [{ trigger: "combatDamageToPlayer", label: "Demon of Loathing — they sacrifice a creature", effects: [{ type: "sacrificeACreatureOfPlayer" }] }],
  "ancient copper dragon": [{ trigger: "combatDamageToPlayer", label: "Ancient Copper Dragon — roll a d20, create that many Treasures", effects: [{ type: "rollD20CreateTreasures" }] }],
  "warren instigator": [{ trigger: "combatDamageToPlayer", label: "Warren Instigator — put a Goblin creature card from your hand onto the battlefield", requiresTarget: true, targetKind: "handCard", handTypeFilter: ["goblin"], effects: [{ type: "putHandCardOntoBattlefield" }] }],
  // Wave 25 -- "a creature you control" (not "this creature") needs the new global variant
  // (fireGlobalCombatDamageToPlayerTrigger/"anyCreatureCombatDamageToPlayer"), not the self-only
  // "combatDamageToPlayer" trigger the entries just above use.
  "old gnawbone": [{ trigger: "anyCreatureCombatDamageToPlayer", label: "Old Gnawbone — create that many Treasure tokens", requiresTarget: false, effects: [{ type: "createTokensEqualToDealtDamage", name: "Treasure", tokenType: "Token Artifact — Treasure", img: "https://cards.scryfall.io/normal/front/6/8/68894c85-fb43-4c9a-9de3-2fa1c9c31543.jpg" }] }],
  "zeriam, golden wind": [{ trigger: "anyCreatureCombatDamageToPlayer", typeFilter: ["griffin"], label: "Zeriam, Golden Wind — create a 2/2 white Griffin token with flying", requiresTarget: false, effects: [{ type: "createToken", name: "Griffin", tokenType: "Token Creature — Griffin", power: "2", toughness: "2", colors: ["W"], keywords: ["Flying"] }] }],
  "kaalia, zenith seeker": [{ trigger: "etb", label: "Kaalia, Zenith Seeker — look at top 6, take Angels/Demons/Dragons", effects: [{ type: "lookTopNRevealTypesToHand", amount: 6, types: ["Angel", "Demon", "Dragon"] }] }],
  "utvara hellkite": [{ trigger: "otherAttacks", typeFilter: ["Dragon"], label: "Utvara Hellkite — create a 6/6 flying Dragon token, tapped and attacking",
    effects: [{ type: "createAttackingToken", name: "Dragon", tokenType: "Token Creature — Dragon", power: "6", toughness: "6", colors: ["R"], keywords: ["Flying"], img: "https://cards.scryfall.io/normal/front/1/1/11335886-a422-42ff-be14-226602202603.jpg" }] }],
  // amount is baked in dynamically by fireGlobalOtherCreatureEtbTriggers (the entering creature's
  // own power) -- the {type:"damageTarget"} entry here carries no amount of its own.
  "terror of the peaks": [{ trigger: "otherCreatureEtb", label: "Terror of the Peaks — deal damage equal to that creature's power to any target", requiresTarget: true, targetKind: "any", effects: [{ type: "damageTarget" }] }],
  // Two separate otherCreatureEtb entries on one card, gated by different filters -- keywordFilter
  // for the haste grant (any flier, no target needed), typeFilter + amountSource:"count" for the
  // damage trigger (Dragons only, X = current Dragon count).
  "dragon tempest": [
    { trigger: "otherCreatureEtb", keywordFilter: ["Flying"], label: "Dragon Tempest — that creature gains haste", requiresTarget: false, effects: [{ type: "grantHasteToEnteringCreature" }] },
    { trigger: "otherCreatureEtb", typeFilter: ["Dragon"], amountSource: "count", countTypeFilter: ["Dragon"], label: "Dragon Tempest — deal damage equal to Dragons you control to any target", requiresTarget: true, targetKind: "any", effects: [{ type: "damageTarget" }] }
  ],
  // Wave 21 -- excludeTokenSources: true is the real reason "another NONTOKEN Dragon" matters here
  // (not just flavor) -- without it, a token Dragon this ability itself just created would keep
  // re-triggering it forever. See createTokenCopyOfEnteringCreature's own comment.
  "miirym, sentinel wyrm": [{ trigger: "otherCreatureEtb", typeFilter: ["Dragon"], excludeTokenSources: true, requiresTarget: false, label: "Miirym, Sentinel Wyrm — create a nonlegendary token copy of that Dragon", effects: [{ type: "createTokenCopyOfEnteringCreature" }] }],
  "lathliss, dragon queen": [{ trigger: "otherCreatureEtb", label: "Lathliss, Dragon Queen — create a 5/5 red Dragon creature token with flying", requiresTarget: false, typeFilter: ["dragon"], excludeTokenSources: true, effects: [{ type: "createToken", amount: 1, name: "Dragon", tokenType: "Token Creature — Dragon", power: "5", toughness: "5", colors: ["R"], keywords: ["Flying"] }] }],
  // "opponentDraws"/"opponentFirstNoncreatureSpell" are handled by fireGlobalOpponentDrawTriggers/
  // fireGlobalOpponentFirstNoncreatureSpellTriggers (drawN/pushToStack hooks) rather than
  // fireTrigger, since the choice here belongs to the OPPONENT, not this card's controller -- see
  // queueOptionalPayment.
  "smothering tithe": [{ trigger: "opponentDraws", label: "Smothering Tithe — pay {2} or its controller creates a Treasure", costLabel: "{2}", cost: { mana: "{2}" }, declinedEffects: [{ type: "createTreasureToken" }] }],
  "esper sentinel": [{ trigger: "opponentFirstNoncreatureSpell", label: "Esper Sentinel — pay {X} or its controller draws a card", xFromPower: true, declinedEffects: [{ type: "drawCards", amount: 1 }] }],
  "rhystic study": [{ trigger: "opponentCastsSpell", label: "Rhystic Study — pay {1} or its controller draws a card", cost: { mana: "{1}" }, costLabel: "{1}", declinedEffects: [{ type: "drawCards", amount: 1 }] }],
  // "Other creatures you control have haste" needs no table entry (already generic). The graveyard-
  // name-match trigger reuses loseLife's existing chosenTargetId override to hit the CASTER, not
  // Kolaghan's own controller -- see fireGlobalOpponentCastsMatchingGraveyardCardTrigger's comment.
  "dragonlord kolaghan": [{ trigger: "opponentCastsMatchingGraveyardCard", label: "Dragonlord Kolaghan — that player loses 10 life", requiresTarget: false, effects: [{ type: "loseLife", amount: 10 }] }],
  "rakdos, patron of chaos": [{ trigger: "endStep", label: "Rakdos, Patron of Chaos — target opponent may sacrifice two nonland permanents or you draw two cards", requiresTarget: true, targetKind: "player", effects: [{ type: "offerSacrificeOrDraw", sacrificeCount: 2, declinedDraw: 2 }] }],
  "serra's emissary": [{ trigger: "etb", label: "Serra's Emissary — choose a card type for protection", requiresTarget: true, targetKind: "cardType", effects: [{ type: "grantPlayerProtectionFromCardType" }] }],
  // Two independent youCastSpell triggers, each gated by its own colorFilter (fireGlobalTrigger)
  // -- casting a spell that's BOTH red and white (a rare gold spell) correctly fires both. "any"
  // is the closest existing targetKind to the real "target player or planeswalker" wording (no
  // dedicated "player or planeswalker" kind exists) -- same approximate-the-common-case precedent
  // already used elsewhere in this table, so it also (slightly over-permissively) allows a creature.
  "balefire liege": [
    { trigger: "youCastSpell", colorFilter: "R", label: "Balefire Liege — deal 3 damage to target player or planeswalker", requiresTarget: true, targetKind: "any", effects: [{ type: "damageTarget", amount: 3 }] },
    { trigger: "youCastSpell", colorFilter: "W", label: "Balefire Liege — gain 3 life", requiresTarget: false, effects: [{ type: "gainLife", target: "controller", amount: 3 }] }
  ],
  "reya dawnbringer": [{ trigger: "upkeep", label: "Reya Dawnbringer — return target creature card from your graveyard to the battlefield", requiresTarget: true, targetKind: "ownGraveyardCreature", effects: [{ type: "reanimateFromGraveyard" }] }],
  // Wave 26 -- same shape as Reya Dawnbringer just above (including its free CR 603.3c empty-
  // graveyard auto-fizzle, fireTrigger's own targetKind:"ownGraveyardCreature" check), plus a real
  // land-count condition (same pattern as Temple of the False God's own condition/lobby.cards scan,
  // just counting Plains specifically instead of any land).
  "emeria, the sky ruin": [{ trigger: "upkeep", label: "Emeria, the Sky Ruin — return target creature card from your graveyard to the battlefield", requiresTarget: true, targetKind: "ownGraveyardCreature", condition: (card, lobby) => Object.values(lobby.cards).filter((c) => c.owner === card.owner && c.zoneType === "mana" && (c.type || "").toLowerCase().includes("plains")).length >= 7, effects: [{ type: "reanimateFromGraveyard" }] }],
  // Wave 27 -- the "Thriving" land cycle. "This land enters tapped" is already generic; this is
  // just the ETB half of the one-time color choice (chooseColorOtherThan) -- see the matching
  // ACTIVATED_ABILITIES entries below for the ongoing mana ability that reads it back.
  "thriving bluff": [{ trigger: "etb", label: "Thriving Bluff — choose a color other than red", requiresTarget: false, effects: [{ type: "chooseColorOtherThan", excludeColor: "R" }] }],
  "thriving grove": [{ trigger: "etb", label: "Thriving Grove — choose a color other than green", requiresTarget: false, effects: [{ type: "chooseColorOtherThan", excludeColor: "G" }] }],
  "thriving heath": [{ trigger: "etb", label: "Thriving Heath — choose a color other than white", requiresTarget: false, effects: [{ type: "chooseColorOtherThan", excludeColor: "W" }] }],
  "thriving isle": [{ trigger: "etb", label: "Thriving Isle — choose a color other than blue", requiresTarget: false, effects: [{ type: "chooseColorOtherThan", excludeColor: "U" }] }],
  "thriving moor": [{ trigger: "etb", label: "Thriving Moor — choose a color other than black", requiresTarget: false, effects: [{ type: "chooseColorOtherThan", excludeColor: "B" }] }],
  "necromancy": [{ trigger: "etb", label: "Necromancy — put target creature card from a graveyard onto the battlefield under your control", requiresTarget: true, targetKind: "anyGraveyardCreature", effects: [{ type: "reanimateFromGraveyard" }] }],
  "commercial district": [{ trigger: "etb", label: "Commercial District — surveil 1", requiresTarget: false, effects: [{ type: "surveilN", amount: 1 }] }],
  "izzet boilerworks": [{ trigger: "etb", label: "Izzet Boilerworks — return a land you control to its owner's hand", requiresTarget: true, targetKind: "ownLand", effects: [{ type: "bounceTargetToHand" }] }],
  // "When this land enters UNTAPPED" -- checked against the card's own real tapped state at ETB
  // time (whatever entersTapped already decided, including its own "unless you control..."
  // simplification for the conditional-tapped clause just above this in Idyllic Grange's real
  // text), rather than re-deriving the Plains count separately.
  "idyllic grange": [{ trigger: "etb", label: "Idyllic Grange — put a +1/+1 counter on target creature you control", requiresTarget: true, targetKind: "ownCreature", condition: (card) => !card.tapped, effects: [{ type: "addCountersToTarget" }] }],
  // A "death" trigger works on a LAND exactly like any other permanent -- fireDeathTriggers is
  // called unconditionally at every real sacrifice/destroy site regardless of card type (confirmed
  // via activateAbility's own cost.sacrifice handling), so this needs no new plumbing, just the
  // table entry. Reuses searchLandTypes verbatim, the same "may search, put onto the battlefield
  // tapped, then shuffle" fetchland effect already covering the whole fetchland cycle.
  "flagstones of trokair": [{ trigger: "death", label: "Flagstones of Trokair — search for a Plains", requiresTarget: false, effects: [{ type: "searchLandTypes", types: ["Plains"], entersTapped: true }] }],
  "hellkite courser": [{ trigger: "etb", label: "Hellkite Courser — put a commander from the Command Zone onto the battlefield with haste", requiresTarget: true, targetKind: "ownCommanderInZone", effects: [{ type: "putCommanderFromZoneWithHaste" }] }],
  // Kardur's "attack each combat if able and attack a player other than you if able" half is
  // enforced as a declareAttackers validation (see lobby.kardurForcedAttackControllers), not a
  // fireTrigger effect -- this ETB entry only starts that duration. The death half fires from
  // fireKardurDoomscourgeDeathTrigger, since it needs to scan for ANY attacking creature dying
  // table-wide, not just this card's own trigger/target machinery.
  "kardur, doomscourge": [{ trigger: "etb", label: "Kardur, Doomscourge — opponents' creatures attack each combat, if able, until your next turn", requiresTarget: false, effects: [{ type: "startKardurForcedAttack" }] }],
  // "As this artifact enters, you may have it become a copy of any creature on the battlefield
  // until end of turn, except it has haste." requiresTarget + the existing Cancel escape hatch on
  // any pending target choice already gives the "may" semantics for free -- no separate optional-
  // choice mechanism needed. See EFFECTS.becomeCopyUntilEOT for the actual copy.
  "cursed mirror": [{ trigger: "etb", label: "Cursed Mirror — you may have it become a copy of any creature on the battlefield until end of turn, except it has haste", requiresTarget: true, targetKind: "creature", effects: [{ type: "becomeCopyUntilEOT" }] }],
  // Batch added from the same live-decklist gap-analysis pass as SPELL_ABILITIES/ACTIVATED_ABILITIES
  // below. typeFilter is a plain type-line substring match, same shape tutorToHand already supports
  // for Weathered Wayfarer-style cards.
  "goblin matron": [{ trigger: "etb", label: "Goblin Matron — search your library for a Goblin card, put it into your hand", requiresTarget: false, effects: [{ type: "tutorToHand", typeFilter: "goblin" }] }],
  // "Whenever you cast an instant or sorcery spell, this creature deals 2 damage to each opponent."
  // See fireGlobalTrigger's spellTypeFilter comment for how the instant-or-sorcery restriction works.
  "guttersnipe": [{ trigger: "youCastSpell", spellTypeFilter: ["instant", "sorcery"], label: "Guttersnipe — deal 2 damage to each opponent", requiresTarget: false, effects: [{ type: "damageEachOpponent", amount: 2 }] }],
  "electrostatic field": [{ trigger: "youCastSpell", spellTypeFilter: ["instant", "sorcery"], label: "Electrostatic Field — deal 1 damage to each opponent", requiresTarget: false, effects: [{ type: "damageEachOpponent", amount: 1 }] }],
  // Chulane, Teller of Tales -- "Whenever you cast a creature spell, draw a card, THEN you may put
  // a land card from your hand onto the battlefield." Split into two SEPARATE entries under the
  // same trigger (same shape as Dragon Tempest/Sun Titan's own multi-entry cards) rather than one
  // combined ability, since the draw must always happen even with zero lands in hand -- bundling
  // both into one requiresTarget:"handCard" ability would let the existing CR 603.3c no-legal-
  // target auto-fizzle (built for Warren Instigator) silently skip the draw too whenever there's no
  // land to drop, which is wrong. The land-drop reuses Warren Instigator's own putHandCardOntoBattlefield
  // effect verbatim -- {W}'s "another player's choice" mechanic. Vigilance needs no table entry.
  "chulane, teller of tales": [
    { trigger: "youCastSpell", spellTypeFilter: ["creature"], requiresTarget: false, label: "Chulane, Teller of Tales — draw a card", effects: [{ type: "drawCards", amount: 1 }] },
    { trigger: "youCastSpell", spellTypeFilter: ["creature"], requiresTarget: true, targetKind: "handCard", handTypeFilter: ["land"], label: "Chulane, Teller of Tales — you may put a land card from your hand onto the battlefield", effects: [{ type: "putHandCardOntoBattlefield" }] }
  ],
  // "Whenever Krenko attacks, put a +1/+1 counter on it, then create a number of 1/1 red Goblin
  // creature tokens equal to Krenko's power." Effects resolve strictly in array order, so
  // createTokensEqualToSelfPower correctly sees the counter addCountersToSelf just added -- see its
  // own comment.
  "krenko, tin street kingpin": [{ trigger: "attack", label: "Krenko, Tin Street Kingpin — +1/+1 counter, then create Goblin tokens equal to its power", requiresTarget: false, effects: [{ type: "addCountersToSelf", amount: 1 }, { type: "createTokensEqualToSelfPower", name: "Goblin", tokenType: "Token Creature — Goblin", power: "1", toughness: "1", colors: ["R"] }] }],
  // Real text: "Whenever a land enters the battlefield under your control, investigate. Whenever
  // you sacrifice a Clue, put a +1/+1 counter on Tireless Tracker." Investigate = "create a Clue
  // token" -- a plain artifact token whose own sacrifice-to-draw ability lives in
  // ACTIVATED_ABILITIES["clue"] (so ANY Clue, from any source, already knows how to be sacrificed
  // for a card -- this entry doesn't need to duplicate that). The second half uses the new
  // sourceNameFilter on fireGlobalTrigger's deathYouControl dispatch (see its own comment) to fire
  // only when the dying permanent was specifically a Clue, not any death.
  "tireless tracker": [
    { trigger: "landfall", label: "Tireless Tracker — investigate (create a Clue token)", requiresTarget: false, effects: [{ type: "createToken", name: "Clue", tokenType: "Token Artifact — Clue", img: "https://cards.scryfall.io/normal/front/5/e/5e644586-888f-4e2e-8d66-8aa02bd79ec1.jpg" }] },
    { trigger: "deathYouControl", sourceNameFilter: "clue", label: "Tireless Tracker — +1/+1 counter (sacrificed a Clue)", requiresTarget: false, effects: [{ type: "addCountersToSelf", amount: 1 }] }
  ],
  // Wave 22 -- "this land or another land you control enters" is landfall's own already-generic
  // self-inclusive wording (landfall fires for the entering land itself too, no exclusion). The
  // "seven or more lands with DIFFERENT NAMES" condition is a distinct-name count, not a raw land
  // count -- checked here rather than as a fixed-amount gate like Endless Atlas/Temple of the False
  // God's condition functions, since it needs a Set, not just a >= comparison.
  "field of the dead": [{ trigger: "landfall", requiresTarget: false,
    condition: (c, lobby) => new Set(Object.values(lobby.cards).filter((x) => x.owner === c.owner && x.zoneType === "mana").map((x) => archiveKey(x.name))).size >= 7,
    label: "Field of the Dead — create a 2/2 black Zombie", effects: [{ type: "createToken", name: "Zombie", tokenType: "Token Creature — Zombie", power: "2", toughness: "2", colors: ["B"] }] }],
  // Valakut, the Molten Pinnacle -- narrowed to Mountains only via landfall's own typeFilter (a
  // plain string here, matched against the entering land's own type line, same convention as
  // Pashalik Mons' deathYouControl typeFilter). "At least five OTHER Mountains" -- the Mountain
  // that just triggered this is already sitting on the battlefield by the time the condition runs
  // (fireGlobalTrigger fires after the land has already entered), so "5 others" is really "6
  // Mountains total including this one," not a count that needs to exclude anything. "You may" has
  // no real downside here, so it auto-resolves to a real target choice like every other undisclosed
  // "may" in this file -- a player who wants to decline can still use the existing cancelTargetChoice
  // escape hatch. Enters-tapped and its own plain {T}: Add {R} both need no table entry (already
  // generic).
  "valakut, the molten pinnacle": [{ trigger: "landfall", typeFilter: "mountain", requiresTarget: true, targetKind: "any",
    condition: (card, lobby) => Object.values(lobby.cards).filter((c) => c.owner === card.owner && c.zoneType === "mana" && (c.type || "").toLowerCase().includes("mountain")).length >= 6,
    label: "Valakut, the Molten Pinnacle — deal 3 damage to any target", effects: [{ type: "damageTarget", amount: 3 }] }],
  // Wave 28 -- City of Traitors: "When you play ANOTHER land, sacrifice this land." The mirror
  // image of Field of the Dead just above -- this one WANTS the exclusion landfall doesn't apply by
  // default, via the new excludeSelf flag on fireGlobalTrigger.
  "city of traitors": [{ trigger: "landfall", excludeSelf: true, requiresTarget: false, label: "City of Traitors — sacrifice this land", effects: [{ type: "sacrificeSelf" }] }],
  // See EFFECTS.attachSelfToTarget for the attach itself; the indestructible grant is already
  // generic (equipEffectsFromText) once attached.
  "mithril coat": [{ trigger: "etb", label: "Mithril Coat — attach to target legendary creature you control", requiresTarget: true, targetKind: "ownCreature", effects: [{ type: "attachSelfToTarget" }] }],
  // Wave 10 gap-analysis batch. Indestructible (both cards) and Bojuka Bog/Temple of the False
  // God's mana halves need no table entry at all -- already generic (KNOWN_KEYWORDS, the free-tap
  // shortcut's own producedMana handling, and Temple's activation condition, see ACTIVATED_ABILITIES).
  // The One Ring -- "if you cast it" isn't checked (see grantProtectionFromEverything's own comment).
  "the one ring": [
    { trigger: "etb", label: "The One Ring — gain protection from everything until your next turn", requiresTarget: false, effects: [{ type: "grantProtectionFromEverything" }] },
    { trigger: "upkeep", label: "The One Ring — lose life equal to its burden counters", requiresTarget: false, effects: [{ type: "loseLifeEqualToSelfCounters" }] }
  ],
  // Wave 20 -- only the upkeep value engine (the reason this card gets played); its activated
  // ability ("exile a graveyard creature card, create a 4/4 black Zombie token copy of it") needs a
  // genuinely different "token copy at OVERRIDDEN stats" shape than any existing reanimation effect,
  // and the death trigger returning it to hand isn't modeled either -- both disclosed, not built
  // this wave.
  "the scarab god": [{ trigger: "upkeep", label: "The Scarab God — each opponent loses life equal to Zombies you control, you scry that many", requiresTarget: false, amountSource: "count", countTypeFilter: ["zombie"], effects: [{ type: "loseLife", target: "eachOpponent" }, { type: "scryN" }] }],
  // "search your library for any number of Goblin cards... put those cards on top" -- see
  // EFFECTS.searchAllMatchingToTop's own comment for what's simplified (order among the found cards).
  "goblin recruiter": [{ trigger: "etb", label: "Goblin Recruiter — search for all Goblin cards, put them on top", requiresTarget: false, effects: [{ type: "searchAllMatchingToTop", typeFilter: ["goblin"] }] }],
  // Haste needs no table entry (KNOWN_KEYWORDS). Reuses the exact mechanism built for Kaalia, Zenith
  // Seeker (lookTopNRevealTypesToHand) -- "reveal the top four, matching go to hand, rest shuffled
  // back in" is the identical shape, just a different N and type filter.
  "goblin ringleader": [{ trigger: "etb", label: "Goblin Ringleader — reveal top 4, Goblins to hand", requiresTarget: false, effects: [{ type: "lookTopNRevealTypesToHand", amount: 4, types: ["goblin"] }] }],
  // "As this land enters, exile target player's graveyard." Reuses EFFECTS.exilePlayerGraveyard,
  // already built for an earlier card -- needed only this table entry, no new effect at all.
  "bojuka bog": [{ trigger: "etb", label: "Bojuka Bog — exile target player's graveyard", requiresTarget: true, targetKind: "player", effects: [{ type: "exilePlayerGraveyard" }] }],
  // "Whenever Pashalik Mons or another Goblin you control dies, deals 1 damage to any target." A
  // deathYouControl entry narrowed by typeFilter (see fireGlobalTrigger's own comment) rather than
  // sourceNameFilter -- ANY Goblin qualifies, not one specific name. Reuses the existing generic
  // damageTarget effect (Lightning Bolt et al.) targetKind "any".
  "pashalik mons": [{ trigger: "deathYouControl", typeFilter: "goblin", label: "Pashalik Mons — a Goblin died, deal 1 damage to any target", requiresTarget: true, targetKind: "any", effects: [{ type: "damageTarget", amount: 1 }] }],
  // Wave 11 gap-analysis batch. Deathtouch/Flying need no table entry (KNOWN_KEYWORDS).
  "acidic slime": [{ trigger: "etb", label: "Acidic Slime — destroy target artifact, enchantment, or land", requiresTarget: true, targetKind: "typeList", typeFilter: ["artifact", "enchantment", "land"], effects: [{ type: "destroyTarget" }] }],
  // "Destroy target permanent" -- narrowed to creature/artifact, same disclosed simplification as
  // Despark/Beast Within/Generous Gift/Chaos Warp's existing targetKind:"permanent" entries (a
  // land/enchantment/planeswalker can't be targeted by any of these yet).
  "angel of despair": [{ trigger: "etb", label: "Angel of Despair — destroy target permanent", requiresTarget: true, targetKind: "permanent", effects: [{ type: "destroyTarget" }] }],
  // "Exile up to two target artifacts and/or enchantments" -- narrowed to exactly one target (this
  // app's target-choice queue takes one target per queued choice; "up to two" would need two
  // separate, chainable choices with no way to skip the second, not worth building for one clause).
  // Plainscycling needs no table entry -- see cyclingCostFromText's own comment.
  "angel of the ruins": [{ trigger: "etb", label: "Angel of the Ruins — exile target artifact or enchantment", requiresTarget: true, targetKind: "typeList", typeFilter: ["artifact", "enchantment"], effects: [{ type: "exileTarget" }] }],
  // Magecraft -- reuses the exact youCastSpell/spellTypeFilter mechanism built for Guttersnipe.
  "archmage emeritus": [{ trigger: "youCastSpell", spellTypeFilter: ["instant", "sorcery"], label: "Archmage Emeritus — draw a card", requiresTarget: false, effects: [{ type: "drawCards", amount: 1 }] }],
  // "Whenever ~ enters or attacks, target opponent sacrifices a creature or planeswalker of their
  // choice, discards a card, and loses 3 life. You draw a card and gain 3 life." Two identical
  // trigger points sharing the same effects array -- see EFFECTS.targetPlayerSacrifices for the
  // sacrifice half's own disclosed narrowing (creatures only, not planeswalkers).
  "archon of cruelty": [
    { trigger: "etb", label: "Archon of Cruelty — target opponent sacrifices, discards, and loses 3 life; you draw and gain 3", requiresTarget: true, targetKind: "player", effects: [{ type: "targetPlayerSacrifices" }, { type: "targetPlayerDiscards", amount: 1 }, { type: "loseLife", amount: 3 }, { type: "drawCards", amount: 1 }, { type: "gainLife", target: "controller", amount: 3 }] },
    { trigger: "attack", label: "Archon of Cruelty — target opponent sacrifices, discards, and loses 3 life; you draw and gain 3", requiresTarget: true, targetKind: "player", effects: [{ type: "targetPlayerSacrifices" }, { type: "targetPlayerDiscards", amount: 1 }, { type: "loseLife", amount: 3 }, { type: "drawCards", amount: 1 }, { type: "gainLife", target: "controller", amount: 3 }] }
  ],
  // Wave 12 gap-analysis batch.
  // "When this Aura enters... Return enchanted creature card to the battlefield under your control
  // and attach this Aura to it." See EFFECTS.reanimateAndAttachAsAura's own comment for what's
  // disclosed (no sac-when-Aura-leaves linkage). Modeled as a plain etb trigger since this app routes
  // ANY non-instant/sorcery spell (Auras included) onto the battlefield as a real permanent first,
  // then fires its ETB triggers from there -- same as Mithril Coat's own ETB-attaches-itself shape.
  "animate dead": [{ trigger: "etb", label: "Animate Dead — return target creature card from a graveyard to the battlefield under your control, attach as an Aura", requiresTarget: true, targetKind: "anyGraveyardCreature", effects: [{ type: "reanimateAndAttachAsAura" }] }],
  // "When this creature enters, create two 1/1 red Goblin creature tokens."
  "beetleback chief": [{ trigger: "etb", label: "Beetleback Chief — create two Goblin tokens", requiresTarget: false, effects: [{ type: "createToken", amount: 2, name: "Goblin", tokenType: "Token Creature — Goblin", power: "1", toughness: "1", colors: ["R"] }] }],
  // Magecraft's own creature-spell cousin -- same youCastSpell/spellTypeFilter mechanism, just
  // filtered to "creature" instead of "instant"/"sorcery".
  "beast whisperer": [{ trigger: "youCastSpell", spellTypeFilter: ["creature"], label: "Beast Whisperer — draw a card", requiresTarget: false, effects: [{ type: "drawCards", amount: 1 }] }],
  // "Creatures your opponents control enter tapped" needs no table entry here -- see
  // ENTERS_TAPPED_FOR_OPPONENTS. Only the life-gain half (the NEW fireOpponentCreatureEtbTriggers
  // dispatch, the mirror image of the existing "you control" version) needs one.
  "authority of the consuls": [{ trigger: "opponentCreatureEtb", label: "Authority of the Consuls — gain 1 life", requiresTarget: false, effects: [{ type: "gainLife", target: "controller", amount: 1 }] }],
  // "When this creature enters, destroy all artifacts and enchantments. Put a +1/+1 counter on this
  // creature for each permanent destroyed this way." See destroyAllMatching's own counterSelfAmount
  // comment for how the dynamic count reaches addCountersToSelf.
  "bane of progress": [{ trigger: "etb", label: "Bane of Progress — destroy all artifacts and enchantments, +1/+1 counter for each", requiresTarget: false, effects: [{ type: "destroyAllMatching", typeIncludes: ["artifact", "enchantment"], counterSelfAmount: true }] }],
  // "When this creature enters or becomes monstrous, destroy target permanent." Only the ETB half is
  // automated -- monstrosity itself (a whole activated-ability-driven counter/mode mechanic) doesn't
  // exist anywhere in this engine, a disclosed simplification narrower than just this one card.
  // Menace/trample need no table entry (KNOWN_KEYWORDS).
  "alpha deathclaw": [{ trigger: "etb", label: "Alpha Deathclaw — destroy target permanent", requiresTarget: true, targetKind: "permanent", effects: [{ type: "destroyTarget" }] }],
  // Wave 13 gap-analysis batch.
  // Raid -- "At the beginning of your end step, if you attacked this turn, create a 1/1 red Goblin
  // creature token." Reuses the existing "endStep" global trigger (built for Windcrag Siege's own
  // upkeep trigger, equally generic for any phase); condition reads the new attackedThisTurn flag
  // (see declareAttackers) rather than lobby.combat.attackers, which is already reset by End Step.
  "searslicer goblin": [{ trigger: "endStep", label: "Searslicer Goblin — Raid: create a Goblin token", condition: (c, lobby) => { const p = lobby.players[c.owner]; return !!(p && p.attackedThisTurn); }, requiresTarget: false, effects: [{ type: "createToken", name: "Goblin", tokenType: "Token Creature — Goblin", power: "1", toughness: "1", colors: ["R"] }] }],
  // "At the beginning of combat on your turn, create a 1/1 red Goblin creature token. That token
  // attacks this combat if able." New "beginningOfCombat" global trigger (see advanceOnePhase),
  // generic for any future card with this timing. "Other Goblins you control have haste" needs no
  // table entry -- already generic (anthemKeywordsFromText's type-filtered branch). NOT automated:
  // the created token being forced to attack (no "must attack" enforcement for a single specific
  // creature exists in this engine, only Kardur, Doomscourge's table-wide forced-attack shape) and
  // the entire Max Speed subsystem ("Start your engines!", the {T} ability) -- this app tracks no
  // concept of speed at all, a disclosed gap wider than just this one card.
  "howlsquad heavy": [{ trigger: "beginningOfCombat", label: "Howlsquad Heavy — create a Goblin token", requiresTarget: false, effects: [{ type: "createToken", name: "Goblin", tokenType: "Token Creature — Goblin", power: "1", toughness: "1", colors: ["R"] }] }],
  // Wave 15 gap-analysis batch.
  "coiling oracle": [{ trigger: "etb", label: "Coiling Oracle — reveal the top card, land to battlefield or else to hand", requiresTarget: false, effects: [{ type: "revealTopCardLandToBattlefieldElseHand" }] }],
  "diregraf colossus": [
    { trigger: "etb", label: "Diregraf Colossus — +1/+1 counter for each Zombie card in your graveyard", requiresTarget: false, effects: [{ type: "addCountersEqualToGraveyardTypeCount", typeFilter: "zombie" }] },
    // Magecraft-family reuse (youCastSpell/spellTypeFilter), just filtered by a creature-type
    // substring ("zombie") instead of a broad instant/sorcery/creature category.
    { trigger: "youCastSpell", spellTypeFilter: ["zombie"], label: "Diregraf Colossus — create a tapped Zombie token", requiresTarget: false, effects: [{ type: "createToken", name: "Zombie", tokenType: "Token Creature — Zombie", power: "2", toughness: "2", colors: ["B"], tapped: true }] }
  ],
  // "Each opponent loses 1 life" needs no new effect -- loseLife's existing target:"eachOpponent"
  // (built for Archfiend of Despair-style cards) already covers it.
  "corpse knight": [{ trigger: "otherCreatureEtb", label: "Corpse Knight — each opponent loses 1 life", requiresTarget: false, effects: [{ type: "loseLife", target: "eachOpponent", amount: 1 }] }],
  // Wave 18 -- Cathars' Crusade is an enchantment, not a creature, so "the entering card itself"
  // (fireGlobalOtherCreatureEtbTriggers' own selfInclusive exclusion) never applies to it -- this
  // fires for every creature ETB under its controller, no filters/selfInclusive needed at all.
  "cathars' crusade": [{ trigger: "otherCreatureEtb", label: "Cathars' Crusade — put a +1/+1 counter on each creature you control", requiresTarget: false, effects: [{ type: "addCountersToAllYourCreatures", amount: 1 }] }],
  "contagion clasp": [{ trigger: "etb", label: "Contagion Clasp — put a -1/-1 counter on target creature", requiresTarget: true, targetKind: "creature", effects: [{ type: "addNegativeCounterTarget" }] }],
  // Wave 16 -- new "choose a creature type" free-text mechanism (see chooseCreatureType's own
  // comment). Icon of Ancestry's static "+1/+1 to creatures of the chosen type" lives in
  // staticBonusFor; its dig ability is a new ACTIVATED_ABILITIES entry below. Cavern of Souls'
  // "{T}: Add one mana of any color" needs no table entry -- already generic (the free-tap-shortcut
  // already prompts a real color choice for any land whose real producedMana lists more than one
  // color); "that spell can't be countered" isn't modeled -- no per-mana-source "tag" tracking
  // exists to know later which mana a spell was actually paid with.
  "icon of ancestry": [{ trigger: "etb", label: "Icon of Ancestry — choose a creature type", requiresTarget: true, targetKind: "creatureType", effects: [{ type: "chooseCreatureType" }] }],
  "cavern of souls": [{ trigger: "etb", label: "Cavern of Souls — choose a creature type", requiresTarget: true, targetKind: "creatureType", effects: [{ type: "chooseCreatureType" }] }],
  // Shared Animosity needs no table entry -- see applySharedAnimosity, called directly from
  // declareAttackers since it needs every attacker known at once, not a per-creature trigger.
  // Pack tactics -- "Whenever this creature attacks, if you attacked with creatures with total power
  // 6 or greater this combat, create a 1/1 red Goblin creature token that's tapped and attacking."
  "battle cry goblin": [{ trigger: "attack", label: "Battle Cry Goblin — Pack tactics: create a tapped, attacking Goblin token", condition: (card, lobby) => {
    const total = Object.keys(lobby.combat.attackers || {}).reduce((sum, id) => {
      const c = lobby.cards[id];
      if (!c) return sum;
      return sum + parsePT(c.power) + (c.counters || 0) + attachedBonusFor(lobby, c).powerBonus + staticBonusFor(lobby, c).powerBonus;
    }, 0);
    return total >= 6;
  }, requiresTarget: false, effects: [{ type: "createAttackingToken", name: "Goblin", tokenType: "Token Creature — Goblin", power: "1", toughness: "1", colors: ["R"] }] }],
  // Goldspan Dragon -- "Flying, haste" needs no table entry (KNOWN_KEYWORDS). Its Treasure-upgrade
  // static ability lives in EFFECTS.chooseManaAnyColor (see the generic "treasure"
  // ACTIVATED_ABILITIES entry). "...or becomes the target of a spell" isn't modeled -- no
  // "becomes the target of a spell" trigger type exists in this engine, a disclosed narrowing
  // (only the attack half of this trigger fires).
  "goldspan dragon": [{ trigger: "attack", label: "Goldspan Dragon — create a Treasure token", requiresTarget: false, effects: [{ type: "createTreasureToken" }] }],
  // Wave 17 gap-analysis batch.
  // Goblin Chieftain/Goblin Trashmaster/Hobgoblin Bandit Lord's "Other Goblins you control get
  // +1/+1" need no table entry -- see anthemEffectsFromText's new type-scoped branch. Chieftain's
  // "...and have haste" was already generic (anthemKeywordsFromText's own type-scoped branch, built
  // for Goblin Warchief). Goblin Piledriver/Goblin Wardriver's attack-triggered pumps need no table
  // entry either -- see applySelfAttackTypeCountPump/applyBattleCry, called from declareAttackers.
  "goblin instigator": [{ trigger: "etb", label: "Goblin Instigator — create a Goblin token", requiresTarget: false, effects: [{ type: "createToken", name: "Goblin", tokenType: "Token Creature — Goblin", power: "1", toughness: "1", colors: ["R"] }] }],
  "impact tremors": [{ trigger: "otherCreatureEtb", label: "Impact Tremors — deal 1 damage to each opponent", requiresTarget: false, effects: [{ type: "loseLife", target: "eachOpponent", amount: 1 }] }],
  // The static "Creatures you control have haste" half is already covered generically by
  // anthemKeywordsFromText's own self-inclusive "creatures you control have [X]" branch -- no table
  // entry needed for it at all, only this ETB draw trigger.
  "temur ascendancy": [{ trigger: "otherCreatureEtb", label: "Temur Ascendancy — draw a card (entering creature has power 4 or greater)", requiresTarget: false, effects: [{ type: "drawCardIfEnteringPowerAtLeast", threshold: 4 }] }],
  // "One or more" needs no special handling -- each qualifying creature's own ETB independently
  // reaches this same check, and oncePerTurn's turn-number gate already collapses any of them past
  // the first into a no-op, which is exactly "only once each turn" regardless of how many
  // power-2-or-less creatures enter that turn. effects' own explicit amount:1 is required here --
  // without it the shared amount-merge in fireGlobalOtherCreatureEtbTriggers would silently scale
  // this to the entering creature's power instead of always drawing exactly 1 (the Wave 52 bug).
  "welcoming vampire": [{ trigger: "otherCreatureEtb", maxPower: 2, oncePerTurn: true, label: "Welcoming Vampire — draw a card", requiresTarget: false, effects: [{ type: "drawCards", amount: 1 }] }],
  // New global "youDiscard" event type -- wired into every real discard choke point (resolveDiscard,
  // the autoDiscardFilter activation cost, and cycleCard -- cycling IS discarding, CR 702.28e). "Or
  // discard another card" needs no excludeSelf-style check: by the time this fires, a discarded
  // Archfiend of Ifnir itself has already left the battlefield (moved out of lobby.cards), so it
  // can't scan its own battlefield copy to fire off its own discard anyway.
  "archfiend of ifnir": [{ trigger: "youDiscard", label: "Archfiend of Ifnir — put a -1/-1 counter on each creature your opponents control", requiresTarget: false, effects: [{ type: "addNegativeCounterToEachOpponentCreature", amount: 1 }] }],
  // New "secondSpellCastByAPlayer" event -- fires for EVERY Ledger Shredder on the table regardless
  // of who cast the spell or who controls the Shredder (see fireGlobalTriggerAllPlayers' own
  // comment). Connive resolves through the existing pendingDiscard pipeline; see EFFECTS.connive
  // and resolveDiscard's own connive follow-up for the "nonland discard -> +1/+1 counter" half.
  "ledger shredder": [{ trigger: "secondSpellCastByAPlayer", label: "Ledger Shredder — connives", requiresTarget: false, effects: [{ type: "connive" }] }],
  // "of their choice" isn't a real per-opponent picker -- reuses eachOpponentSacrifices' existing
  // auto-pick (built for Pick Your Poison), same disclosed simplification as everywhere else.
  "grave pact": [{ trigger: "deathYouControl", label: "Grave Pact — each other player sacrifices a creature", requiresTarget: false, effects: [{ type: "eachOpponentSacrifices", zoneTypeFilter: "creature" }] }],
  "grave titan": [
    { trigger: "etb", label: "Grave Titan — create two Zombie tokens", requiresTarget: false, effects: [{ type: "createToken", amount: 2, name: "Zombie", tokenType: "Token Creature — Zombie", power: "2", toughness: "2", colors: ["B"] }] },
    { trigger: "attack", label: "Grave Titan — create two Zombie tokens", requiresTarget: false, effects: [{ type: "createToken", amount: 2, name: "Zombie", tokenType: "Token Creature — Zombie", power: "2", toughness: "2", colors: ["B"] }] }
  ],
  "gray merchant of asphodel": [{ trigger: "etb", label: "Gray Merchant of Asphodel — drain each opponent for your devotion to black", requiresTarget: false, effects: [{ type: "drainForDevotion", color: "B" }] }],
  // Echo isn't modeled (no upkeep-cost-or-sacrifice mechanic exists in this engine) -- the ETB
  // reanimation reuses reanimateFromGraveyard exactly as Reya Dawnbringer/Necromancy already do.
  "karmic guide": [{ trigger: "etb", label: "Karmic Guide — return target creature card from your graveyard to the battlefield", requiresTarget: true, targetKind: "ownGraveyardCreature", effects: [{ type: "reanimateFromGraveyard" }] }],
  // Wave 22 -- reuses the pre-existing ownGraveyardTypeList targetKind (built for Argivian Find)
  // plus returnOwnGraveyardEntryToHand (also pre-existing) -- a straight composition, no new code.
  "griffin dreamfinder": [{ trigger: "etb", label: "Griffin Dreamfinder — return target enchantment card from your graveyard to your hand", requiresTarget: true, targetKind: "ownGraveyardTypeList", typeFilter: ["enchantment"], effects: [{ type: "returnOwnGraveyardEntryToHand" }] }],
  "mortuary mire": [{ trigger: "etb", label: "Mortuary Mire — put target creature card from your graveyard on top of your library", requiresTarget: true, targetKind: "ownGraveyardTypeList", typeFilter: ["creature"], effects: [{ type: "putOwnGraveyardEntryOnTopOfLibrary" }] }],
  "archivist of oghma": [{ trigger: "opponentSearchesLibrary", label: "Archivist of Oghma — gain 1 life and draw a card", requiresTarget: false, effects: [{ type: "gainLife", target: "controller", amount: 1 }, { type: "drawCards", amount: 1 }] }],
  "sun titan": [
    { trigger: "etb", label: "Sun Titan — return target permanent card with mana value 3 or less from your graveyard to the battlefield", requiresTarget: true, targetKind: "ownGraveyardMvFilter", maxCmc: 3, effects: [{ type: "reanimateFromGraveyard" }] },
    { trigger: "attack", label: "Sun Titan — return target permanent card with mana value 3 or less from your graveyard to the battlefield", requiresTarget: true, targetKind: "ownGraveyardMvFilter", maxCmc: 3, effects: [{ type: "reanimateFromGraveyard" }] }
  ],
  "sharuum the hegemon": [{ trigger: "etb", label: "Sharuum the Hegemon — return target artifact card from your graveyard to the battlefield", requiresTarget: true, targetKind: "ownGraveyardTypeList", typeFilter: ["artifact"], effects: [{ type: "reanimateFromGraveyard" }] }],
  // Wave 24 -- reuses the pre-existing untapUpToNOwnLands effect (built for Frantic Search) as-is.
  "peregrine drake": [{ trigger: "etb", label: "Peregrine Drake — untap up to five lands", requiresTarget: false, effects: [{ type: "untapUpToNOwnLands", amount: 5 }] }],
  "mistmoon griffin": [{ trigger: "death", label: "Mistmoon Griffin — exile it, then return the top creature card of your graveyard to the battlefield", requiresTarget: false, effects: [{ type: "exileSelfAndReanimateTopGraveyardCreature" }] }],
  "child of alara": [{ trigger: "death", label: "Child of Alara — destroy all nonland permanents, they can't be regenerated", requiresTarget: false, effects: [{ type: "destroyAllNonlandPermanents", noRegen: true }] }],
  // Kyodai, Soul of Kamigawa -- excludeSelf enforces the real "ANOTHER target permanent" wording
  // (see resolveChosenTarget's own comment). The activated {W}{U}{B}{R}{G} pump is a separate
  // ACTIVATED_ABILITIES entry below (grantTemporaryPTAndKeywordsToTarget targeting itself is the
  // creature-buff shape Kessig Wolf Run already established, just self-targeted here).
  "kyodai, soul of kamigawa": [{ trigger: "etb", label: "Kyodai, Soul of Kamigawa — another target permanent gains indestructible for as long as you control Kyodai", requiresTarget: true, targetKind: "permanent", excludeSelf: true, effects: [{ type: "grantIndestructibleWhileSourceControlled" }] }]
};
function getAutomatedAbilities(cardName, triggerType) {
  const all = CARD_ABILITIES[archiveKey(cardName)] || [];
  return all.filter((a) => a.trigger === triggerType);
}

// Player-initiated abilities, separate from CARD_ABILITIES since these are activated, not
// automatic triggers -- see the activateAbility handler. cost.sacrifice is scoped to "sacrifice
// THIS permanent" only for v1, the single most common activated-sacrifice pattern; "sacrifice
// another creature" would need its own target-choice-shaped flow, same precedent as everywhere
// else this vocabulary narrows to the common case.
const ACTIVATED_ABILITIES = {
  // Fetchlands -- "{T}, Pay 1 life, Sacrifice: search your library for a [type] or [type] card, put
  // it onto the battlefield, then shuffle." See EFFECTS.searchLandTypes and the fetchLand/cancelFetch
  // handlers for how the actual search (a real choice among however many matches are in a 99-card
  // library, not something automatable like a fixed-effect spell) gets resolved.
  "arid mesa": [{ cost: { tap: true, life: 1, sacrifice: true }, label: "Arid Mesa — search for a Mountain or Plains", effects: [{ type: "searchLandTypes", types: ["Mountain", "Plains"] }] }],
  "scalding tarn": [{ cost: { tap: true, life: 1, sacrifice: true }, label: "Scalding Tarn — search for an Island or Mountain", effects: [{ type: "searchLandTypes", types: ["Island", "Mountain"] }] }],
  "verdant catacombs": [{ cost: { tap: true, life: 1, sacrifice: true }, label: "Verdant Catacombs — search for a Swamp or Forest", effects: [{ type: "searchLandTypes", types: ["Swamp", "Forest"] }] }],
  "marsh flats": [{ cost: { tap: true, life: 1, sacrifice: true }, label: "Marsh Flats — search for a Plains or Swamp", effects: [{ type: "searchLandTypes", types: ["Plains", "Swamp"] }] }],
  "misty rainforest": [{ cost: { tap: true, life: 1, sacrifice: true }, label: "Misty Rainforest — search for an Island or Forest", effects: [{ type: "searchLandTypes", types: ["Island", "Forest"] }] }],
  "bloodstained mire": [{ cost: { tap: true, life: 1, sacrifice: true }, label: "Bloodstained Mire — search for a Swamp or Mountain", effects: [{ type: "searchLandTypes", types: ["Swamp", "Mountain"] }] }],
  "flooded strand": [{ cost: { tap: true, life: 1, sacrifice: true }, label: "Flooded Strand — search for an Island or Plains", effects: [{ type: "searchLandTypes", types: ["Island", "Plains"] }] }],
  "wooded foothills": [{ cost: { tap: true, life: 1, sacrifice: true }, label: "Wooded Foothills — search for a Mountain or Forest", effects: [{ type: "searchLandTypes", types: ["Mountain", "Forest"] }] }],
  "windswept heath": [{ cost: { tap: true, life: 1, sacrifice: true }, label: "Windswept Heath — search for a Forest or Plains", effects: [{ type: "searchLandTypes", types: ["Forest", "Plains"] }] }],
  "polluted delta": [{ cost: { tap: true, life: 1, sacrifice: true }, label: "Polluted Delta — search for an Island or Swamp", effects: [{ type: "searchLandTypes", types: ["Island", "Swamp"] }] }],
  // "Painless" fetches: no life cost, but restricted to a BASIC land (basicOnly) and forced tapped
  // regardless of what's fetched (entersTapped) -- unlike the life-paying fetches above, which can
  // find any land with a matching type (including a nonbasic dual) and inherit ITS OWN tapped state.
  "evolving wilds": [{ cost: { tap: true, sacrifice: true }, label: "Evolving Wilds — search for a basic land", effects: [{ type: "searchLandTypes", types: ["Plains", "Island", "Swamp", "Mountain", "Forest"], basicOnly: true, entersTapped: true }] }],
  "terramorphic expanse": [{ cost: { tap: true, sacrifice: true }, label: "Terramorphic Expanse — search for a basic land", effects: [{ type: "searchLandTypes", types: ["Plains", "Island", "Swamp", "Mountain", "Forest"], basicOnly: true, entersTapped: true }] }],
  // Panorama cycle -- same painless-fetch shape as Evolving Wilds/Terramorphic Expanse just above
  // (basicOnly + entersTapped), but each one is restricted to its own 3-color wedge's basics AND
  // costs {1} in addition to Tap+Sacrifice (see Wayfarer's Bauble below for the mana+tap+sacrifice
  // cost shape precedent).
  "bant panorama": [{ cost: { mana: "{1}", tap: true, sacrifice: true }, label: "Bant Panorama — search for a basic Forest, Plains, or Island", effects: [{ type: "searchLandTypes", types: ["Forest", "Plains", "Island"], basicOnly: true, entersTapped: true }] }],
  "esper panorama": [{ cost: { mana: "{1}", tap: true, sacrifice: true }, label: "Esper Panorama — search for a basic Plains, Island, or Swamp", effects: [{ type: "searchLandTypes", types: ["Plains", "Island", "Swamp"], basicOnly: true, entersTapped: true }] }],
  "grixis panorama": [{ cost: { mana: "{1}", tap: true, sacrifice: true }, label: "Grixis Panorama — search for a basic Island, Swamp, or Mountain", effects: [{ type: "searchLandTypes", types: ["Island", "Swamp", "Mountain"], basicOnly: true, entersTapped: true }] }],
  "jund panorama": [{ cost: { mana: "{1}", tap: true, sacrifice: true }, label: "Jund Panorama — search for a basic Swamp, Mountain, or Forest", effects: [{ type: "searchLandTypes", types: ["Swamp", "Mountain", "Forest"], basicOnly: true, entersTapped: true }] }],
  "naya panorama": [{ cost: { mana: "{1}", tap: true, sacrifice: true }, label: "Naya Panorama — search for a basic Mountain, Forest, or Plains", effects: [{ type: "searchLandTypes", types: ["Mountain", "Forest", "Plains"], basicOnly: true, entersTapped: true }] }],
  // Signets -- "{1}, {T}: Add {X}{Y}." Both colors at once for a fixed cost, not a choice the way a
  // dual land's "T: add X or Y" is -- manaAbility:true is what makes that distinction real (see
  // activateAbility and the tap handler's own comments for why this can't just be the same
  // tap-for-free-mana shortcut every land/dork already uses).
  "azorius signet": [{ cost: { mana: "{1}", tap: true }, manaAbility: true, label: "Azorius Signet — Add {W}{U}", effects: [{ type: "addFixedMana", colors: ["W", "U"] }] }],
  "dimir signet": [{ cost: { mana: "{1}", tap: true }, manaAbility: true, label: "Dimir Signet — Add {U}{B}", effects: [{ type: "addFixedMana", colors: ["U", "B"] }] }],
  "rakdos signet": [{ cost: { mana: "{1}", tap: true }, manaAbility: true, label: "Rakdos Signet — Add {B}{R}", effects: [{ type: "addFixedMana", colors: ["B", "R"] }] }],
  "gruul signet": [{ cost: { mana: "{1}", tap: true }, manaAbility: true, label: "Gruul Signet — Add {R}{G}", effects: [{ type: "addFixedMana", colors: ["R", "G"] }] }],
  "selesnya signet": [{ cost: { mana: "{1}", tap: true }, manaAbility: true, label: "Selesnya Signet — Add {G}{W}", effects: [{ type: "addFixedMana", colors: ["G", "W"] }] }],
  "orzhov signet": [{ cost: { mana: "{1}", tap: true }, manaAbility: true, label: "Orzhov Signet — Add {W}{B}", effects: [{ type: "addFixedMana", colors: ["W", "B"] }] }],
  "izzet signet": [{ cost: { mana: "{1}", tap: true }, manaAbility: true, label: "Izzet Signet — Add {U}{R}", effects: [{ type: "addFixedMana", colors: ["U", "R"] }] }],
  "golgari signet": [{ cost: { mana: "{1}", tap: true }, manaAbility: true, label: "Golgari Signet — Add {B}{G}", effects: [{ type: "addFixedMana", colors: ["B", "G"] }] }],
  "boros signet": [{ cost: { mana: "{1}", tap: true }, manaAbility: true, label: "Boros Signet — Add {R}{W}", effects: [{ type: "addFixedMana", colors: ["R", "W"] }] }],
  "simic signet": [{ cost: { mana: "{1}", tap: true }, manaAbility: true, label: "Simic Signet — Add {G}{U}", effects: [{ type: "addFixedMana", colors: ["G", "U"] }] }],
  "archivist": [{ cost: { tap: true }, label: "Archivist — {T}: Draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  // Wave 22 -- High Market's own "{T}: Add {C}" needs no table entry (already generic).
  "high market": [{ cost: { tap: true, autoSacrificeFilter: "creature" }, label: "High Market — {T}, Sacrifice a creature: You gain 1 life", effects: [{ type: "gainLife", target: "controller", amount: 1 }] }],
  "horizon canopy": [
    { cost: { tap: true, life: 1 }, manaAbility: true, label: "Horizon Canopy — {T}, Pay 1 life: Add G or W", effects: [{ type: "chooseManaFromColors", colors: ["G", "W"], sourceName: "Horizon Canopy" }] },
    { cost: { mana: "{1}", tap: true, sacrifice: true }, label: "Horizon Canopy — {1}, {T}, Sacrifice this land: Draw a card", effects: [{ type: "drawCards", amount: 1 }] }
  ],
  "silent clearing": [
    { cost: { tap: true, life: 1 }, manaAbility: true, label: "Silent Clearing — {T}, Pay 1 life: Add W or B", effects: [{ type: "chooseManaFromColors", colors: ["W", "B"], sourceName: "Silent Clearing" }] },
    { cost: { mana: "{1}", tap: true, sacrifice: true }, label: "Silent Clearing — {1}, {T}, Sacrifice this land: Draw a card", effects: [{ type: "drawCards", amount: 1 }] }
  ],
  // Wave 23 -- both halves need real table entries once EITHER does (adding a manaAbility entry
  // for the conditional half disqualifies the plain "{T}: Add {C}" half from the free-tap
  // shortcut too -- see the "tap" handler's own comment on why). "control a Swamp" mirrors Temple
  // of the False God's own condition/conditionError shape, just checking a type-line substring
  // instead of a land count.
  "tainted isle": [
    { cost: { tap: true }, manaAbility: true, label: "Tainted Isle — Add {C}", effects: [{ type: "addFixedMana", colors: ["C"] }] },
    { cost: { tap: true }, manaAbility: true, condition: (card, lobby) => Object.values(lobby.cards).some((c) => c.owner === card.owner && c.zoneType === "mana" && (c.type || "").toLowerCase().includes("swamp")), conditionError: "You need to control a Swamp to activate this.", label: "Tainted Isle — Add U or B", effects: [{ type: "chooseManaFromColors", colors: ["U", "B"], sourceName: "Tainted Isle" }] }
  ],
  "tainted wood": [
    { cost: { tap: true }, manaAbility: true, label: "Tainted Wood — Add {C}", effects: [{ type: "addFixedMana", colors: ["C"] }] },
    { cost: { tap: true }, manaAbility: true, condition: (card, lobby) => Object.values(lobby.cards).some((c) => c.owner === card.owner && c.zoneType === "mana" && (c.type || "").toLowerCase().includes("swamp")), conditionError: "You need to control a Swamp to activate this.", label: "Tainted Wood — Add B or G", effects: [{ type: "chooseManaFromColors", colors: ["B", "G"], sourceName: "Tainted Wood" }] }
  ],
  // Wave 27 -- the "Thriving" cycle's own ongoing mana ability, reading back whatever
  // chooseColorOtherThan (see the matching CARD_ABILITIES ETB entries) stored on THIS card
  // instance via chooseManaOwnOrChosenColor -- a single manaAbility entry each, no second
  // plain-{T}-for-C ability needed since these lands have no colorless-only half at all.
  "thriving bluff": [{ cost: { tap: true }, manaAbility: true, label: "Thriving Bluff — Add R or the chosen color", effects: [{ type: "chooseManaOwnOrChosenColor", ownColor: "R" }] }],
  "thriving grove": [{ cost: { tap: true }, manaAbility: true, label: "Thriving Grove — Add G or the chosen color", effects: [{ type: "chooseManaOwnOrChosenColor", ownColor: "G" }] }],
  "thriving heath": [{ cost: { tap: true }, manaAbility: true, label: "Thriving Heath — Add W or the chosen color", effects: [{ type: "chooseManaOwnOrChosenColor", ownColor: "W" }] }],
  "thriving isle": [{ cost: { tap: true }, manaAbility: true, label: "Thriving Isle — Add U or the chosen color", effects: [{ type: "chooseManaOwnOrChosenColor", ownColor: "U" }] }],
  "thriving moor": [{ cost: { tap: true }, manaAbility: true, label: "Thriving Moor — Add B or the chosen color", effects: [{ type: "chooseManaOwnOrChosenColor", ownColor: "B" }] }],
  // Both abilities need real table entries once either is a manaAbility (the free-tap shortcut is
  // all-or-nothing per card, see tainted isle/wood above) -- the surveil half isn't itself a mana
  // ability, it just also costs {T}.
  "tocasia's dig site": [
    { cost: { tap: true }, manaAbility: true, label: "Tocasia's Dig Site — Add {C}", effects: [{ type: "addFixedMana", colors: ["C"] }] },
    { cost: { tap: true, mana: "{3}" }, label: "Tocasia's Dig Site — Surveil 1", effects: [{ type: "surveilN", amount: 1 }] }
  ],
  // Exalted itself (see applyExalted in declareAttackers) needs no table entry at all -- it's
  // detected generically off any permanent's own text -- so these two only need their unrelated
  // mana-dork half wired up.
  "ignoble hierarch": [{ cost: { tap: true }, manaAbility: true, label: "Ignoble Hierarch — Add B, R, or G", effects: [{ type: "chooseManaFromColors", colors: ["B", "R", "G"], sourceName: "Ignoble Hierarch" }] }],
  "noble hierarch": [{ cost: { tap: true }, manaAbility: true, label: "Noble Hierarch — Add G, W, or U", effects: [{ type: "chooseManaFromColors", colors: ["G", "W", "U"], sourceName: "Noble Hierarch" }] }],
  "cascading cataracts": [
    { cost: { tap: true }, manaAbility: true, label: "Cascading Cataracts — Add {C}", effects: [{ type: "addFixedMana", colors: ["C"] }] },
    { cost: { tap: true, mana: "{5}" }, manaAbility: true, label: "Cascading Cataracts — Add five mana in any combination of colors", effects: [{ type: "chooseManaAnyColorRepeated", count: 5, sourceName: "Cascading Cataracts" }] }
  ],
  "emergence zone": [
    { cost: { tap: true }, manaAbility: true, label: "Emergence Zone — Add {C}", effects: [{ type: "addFixedMana", colors: ["C"] }] },
    { cost: { mana: "{1}", tap: true, sacrifice: true }, label: "Emergence Zone — you may cast spells this turn as though they had flash", effects: [{ type: "grantFlashUntilEndOfTurn" }] }
  ],
  "witch's clinic": [
    { cost: { tap: true }, manaAbility: true, label: "Witch's Clinic — Add {C}", effects: [{ type: "addFixedMana", colors: ["C"] }] },
    { cost: { mana: "{2}", tap: true }, label: "Witch's Clinic — target commander gains lifelink until end of turn", requiresTarget: true, targetKind: "commander", effects: [{ type: "grantTemporaryKeywordToTarget", keyword: "Lifelink" }] }
  ],
  "kor haven": [
    { cost: { tap: true }, manaAbility: true, label: "Kor Haven — Add {C}", effects: [{ type: "addFixedMana", colors: ["C"] }] },
    { cost: { mana: "{1}{W}", tap: true }, label: "Kor Haven — prevent all combat damage from target attacking creature this turn", requiresTarget: true, targetKind: "attackingCreature", effects: [{ type: "preventCombatDamageFromTarget" }] }
  ],
  "war room": [
    { cost: { tap: true }, manaAbility: true, label: "War Room — Add {C}", effects: [{ type: "addFixedMana", colors: ["C"] }] },
    { cost: { mana: "{3}", tap: true, life: (lobby, controllerId) => commanderColorIdentity(lobby, controllerId).length }, label: "War Room — pay life equal to your commanders' color identity, draw a card", effects: [{ type: "drawCards", amount: 1 }] }
  ],
  // Chromatic Lantern's OWN tap ability -- the "Lands you control have ..." grant to every OTHER
  // land is handled generically by getGrantedActivatedAbilities/grantedAbilityGrantMatches, no
  // table entry needed for that half at all.
  "chromatic lantern": [{ cost: { tap: true }, manaAbility: true, label: "Chromatic Lantern — Add one mana of any color", effects: [{ type: "chooseManaAnyColor" }] }],
  "torch courier": [{ cost: { sacrifice: true }, label: "Torch Courier — another target creature gains haste until end of turn", requiresTarget: true, targetKind: "otherCreature", effects: [{ type: "grantTemporaryKeywordToTarget", keyword: "Haste" }] }],
  "vault of the archangel": [
    { cost: { tap: true }, manaAbility: true, label: "Vault of the Archangel — Add {C}", effects: [{ type: "addFixedMana", colors: ["C"] }] },
    { cost: { mana: "{2}{W}{B}", tap: true }, label: "Vault of the Archangel — creatures you control gain deathtouch and lifelink until end of turn", effects: [{ type: "grantTemporaryKeywordsToAllYours", keywords: ["Deathtouch", "Lifelink"] }] }
  ],
  "griffin canyon": [
    { cost: { tap: true }, manaAbility: true, label: "Griffin Canyon — Add {C}", effects: [{ type: "addFixedMana", colors: ["C"] }] },
    { cost: { tap: true }, label: "Griffin Canyon — untap target Griffin; if it's a creature, it gets +1/+1 until end of turn", requiresTarget: true, targetKind: "typeList", typeFilter: ["griffin"], effects: [{ type: "untapTarget" }, { type: "grantTemporaryPTAndKeywordsToTarget", power: 1, toughness: 1 }] }
  ],
  "mistveil plains": [
    { cost: { tap: true }, manaAbility: true, label: "Mistveil Plains — Add {W}", effects: [{ type: "addFixedMana", colors: ["W"] }] },
    {
      cost: { mana: "{W}", tap: true }, label: "Mistveil Plains — put target card from your graveyard on the bottom of your library",
      requiresTarget: true, targetKind: "ownGraveyard",
      condition: (card, lobby) => Object.values(lobby.cards).filter((c) => c.owner === card.owner && c.zoneType !== "hand" && c.zoneType !== "stack" && (c.colors || []).includes("W")).length >= 2,
      conditionError: "You need to control two or more white permanents to activate this.",
      effects: [{ type: "putOwnGraveyardEntryOnBottomOfLibrary" }]
    }
  ],
  "kessig wolf run": [
    { cost: { tap: true }, manaAbility: true, label: "Kessig Wolf Run — Add {C}", effects: [{ type: "addFixedMana", colors: ["C"] }] },
    { cost: { mana: "{X}{R}{G}", tap: true }, label: "Kessig Wolf Run — target creature gets +X/+0 and gains trample until end of turn", requiresTarget: true, targetKind: "creature", effects: [{ type: "grantTemporaryPTAndKeywordsToTarget", keywords: ["Trample"] }] }
  ],
  "ominous cemetery": [
    { cost: { tap: true }, manaAbility: true, label: "Ominous Cemetery — Add {C}", effects: [{ type: "addFixedMana", colors: ["C"] }] },
    { cost: { mana: "{5}", tap: true, exile: true }, label: "Ominous Cemetery — target creature's owner shuffles it into their library", requiresTarget: true, targetKind: "creature", effects: [{ type: "shuffleTargetIntoLibrary" }] }
  ],
  // Same shape, any-color instead of a fixed pair (chooseManaAnyColor, the Treasure-token mana
  // effect) plus a real life cost and an artifact-control condition instead of a type check.
  "spire of industry": [
    { cost: { tap: true }, manaAbility: true, label: "Spire of Industry — Add {C}", effects: [{ type: "addFixedMana", colors: ["C"] }] },
    { cost: { tap: true, life: 1 }, manaAbility: true, condition: (card, lobby) => Object.values(lobby.cards).some((c) => c.owner === card.owner && (c.type || "").toLowerCase().includes("artifact")), conditionError: "You need to control an artifact to activate this.", label: "Spire of Industry — Pay 1 life: Add one mana of any color", effects: [{ type: "chooseManaAnyColor" }] }
  ],
  // Wave 24 -- not a mana ability, so the plain "{T}: Add {C}" half stays covered by the free-tap
  // shortcut as-is (only a manaAbility-flagged entry disqualifies it -- see the "tap" handler's own
  // comment). targetPlayerDiscards with self:true is the exact same real discard-choice prompt
  // Frantic Search's own draw-then-discard already uses, just for a single card instead of two.
  "desolate lighthouse": [{ cost: { mana: "{1}{U}{R}", tap: true }, label: "Desolate Lighthouse — Draw a card, then discard a card", effects: [{ type: "drawCards", amount: 1 }, { type: "targetPlayerDiscards", self: true, amount: 1 }] }],
  "boompile": [{ cost: { tap: true }, label: "Boompile — {T}: Flip a coin. If you win, destroy all nonland permanents", effects: [{ type: "flipCoinDestroyAllNonland" }] }],
  "alchemist's apprentice": [{ cost: { sacrifice: true }, label: "Alchemist's Apprentice — Sacrifice: Draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "carnivorous moss-beast": [{ cost: { mana: "{5}{G}{G}" }, label: "Carnivorous Moss-Beast — {5}{G}{G}: +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  // Wave 18 -- Protection from black (a bare keyword, already free via the standard keywords-list
  // model) and Changeling ("this card is every creature type," disclosed unmodeled -- see
  // chooseCreatureType's own trust-model comment) aren't touched here; only the real activated
  // ability needs a table entry.
  "chameleon colossus": [{ cost: { mana: "{2}{G}{G}" }, label: "Chameleon Colossus — {2}{G}{G}: gets +X/+X until end of turn, where X is its power", effects: [{ type: "grantTemporaryPTEqualToSelfPower" }] }],
  // Batch-generated from data/oracle-catalog.json via tools/scan-trigger-candidates.js -- see the
  // matching comment above CARD_ABILITIES's generated block for how these were produced/verified.
  "campfire": [{ cost: { mana: "{1}", tap: true }, label: "Campfire — gain 2 life", effects: [{ type: "gainLife", target: "controller", amount: 2 }] }],
  "marketback walker": [{ cost: { mana: "{4}" }, label: "Marketback Walker — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "zarichi tiger": [{ cost: { mana: "{1}{W}", tap: true }, label: "Zarichi Tiger — gain 2 life", effects: [{ type: "gainLife", target: "controller", amount: 2 }] }],
  "league guildmage": [{ cost: { mana: "{3}{U}", tap: true }, label: "League Guildmage — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "fire sages": [{ cost: { mana: "{1}{R}{R}" }, label: "Fire Sages — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "phantom nantuko": [{ cost: { tap: true }, label: "Phantom Nantuko — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "benalish heralds": [{ cost: { mana: "{3}{U}", tap: true }, label: "Benalish Heralds — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "brass secretary": [{ cost: { mana: "{2}", sacrifice: true }, label: "Brass Secretary — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "gingerbrute": [{ cost: { mana: "{2}", tap: true, sacrifice: true }, label: "Gingerbrute — gain 3 life", effects: [{ type: "gainLife", target: "controller", amount: 3 }] }],
  "swarm guildmage": [{ cost: { mana: "{1}{G}", tap: true }, label: "Swarm Guildmage — gain 2 life", effects: [{ type: "gainLife", target: "controller", amount: 2 }] }],
  "sledding otter-penguin": [{ cost: { mana: "{3}" }, label: "Sledding Otter-Penguin — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "brindle boar": [{ cost: { sacrifice: true }, label: "Brindle Boar — gain 4 life", effects: [{ type: "gainLife", target: "controller", amount: 4 }] }],
  "tangletrove kelp": [{ cost: { mana: "{2}", sacrifice: true }, label: "Tangletrove Kelp — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "qala, ajani's pridemate": [{ cost: { mana: "{3}{W}" }, label: "Qala, Ajani's Pridemate — gain 1 life", effects: [{ type: "gainLife", target: "controller", amount: 1 }] }],
  "zacama, primal calamity": [{ cost: { mana: "{2}{W}" }, label: "Zacama, Primal Calamity — gain 3 life", effects: [{ type: "gainLife", target: "controller", amount: 3 }] }],
  "marble chalice": [{ cost: { tap: true }, label: "Marble Chalice — gain 1 life", effects: [{ type: "gainLife", target: "controller", amount: 1 }] }],
  "cryptic trilobite": [{ cost: { mana: "{1}", tap: true }, label: "Cryptic Trilobite — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "jungle delver": [{ cost: { mana: "{3}{G}" }, label: "Jungle Delver — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "big bertha": [{ cost: { mana: "{1}{G}", tap: true }, label: "Big Bertha — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "clockwork dragon": [{ cost: { mana: "{3}" }, label: "Clockwork Dragon — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "jayemdae tome": [{ cost: { mana: "{4}", tap: true }, label: "Jayemdae Tome — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "treasure trove": [{ cost: { mana: "{2}{U}{U}" }, label: "Treasure Trove — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "ezzaroot channeler": [{ cost: { tap: true }, label: "Ezzaroot Channeler — gain 2 life", effects: [{ type: "gainLife", target: "controller", amount: 2 }] }],
  "soulmender": [{ cost: { tap: true }, label: "Soulmender — gain 1 life", effects: [{ type: "gainLife", target: "controller", amount: 1 }] }],
  "unholy officiant": [{ cost: { mana: "{4}{W}" }, label: "Unholy Officiant — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "mercurial chemister": [{ cost: { mana: "{U}", tap: true }, label: "Mercurial Chemister — draw 2 cards", effects: [{ type: "drawCards", amount: 2 }] }],
  "marker beetles": [{ cost: { mana: "{2}", sacrifice: true }, label: "Marker Beetles — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "walking ballista": [{ cost: { mana: "{4}" }, label: "Walking Ballista — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "starlight invoker": [{ cost: { mana: "{7}{W}" }, label: "Starlight Invoker — gain 5 life", effects: [{ type: "gainLife", target: "controller", amount: 5 }] }],
  "oscorp research team": [{ cost: { mana: "{6}{U}" }, label: "Oscorp Research Team — draw 2 cards", effects: [{ type: "drawCards", amount: 2 }] }],
  "silent attendant": [{ cost: { tap: true }, label: "Silent Attendant — gain 1 life", effects: [{ type: "gainLife", target: "controller", amount: 1 }] }],
  "bottle gnomes": [{ cost: { sacrifice: true }, label: "Bottle Gnomes — gain 3 life", effects: [{ type: "gainLife", target: "controller", amount: 3 }] }],
  "combat courier": [{ cost: { mana: "{2}", sacrifice: true }, label: "Combat Courier — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "crystalline crawler": [{ cost: { tap: true }, label: "Crystalline Crawler — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "third path savant": [{ cost: { mana: "{7}" }, label: "Third Path Savant — draw 2 cards", effects: [{ type: "drawCards", amount: 2 }] }],
  "chronomaton": [{ cost: { mana: "{1}", tap: true }, label: "Chronomaton — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "oath of lim-dûl": [{ cost: { mana: "{B}{B}" }, label: "Oath of Lim-Dûl — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "eidolon of philosophy": [{ cost: { mana: "{6}{U}", sacrifice: true }, label: "Eidolon of Philosophy — draw 3 cards", effects: [{ type: "drawCards", amount: 3 }] }],
  "silversmote ghoul": [{ cost: { mana: "{1}{B}", sacrifice: true }, label: "Silversmote Ghoul — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "the great mound": [{ cost: { mana: "{6}", tap: true }, label: "The Great Mound — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "clockwork hydra": [{ cost: { tap: true }, label: "Clockwork Hydra — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "energizer": [{ cost: { mana: "{2}", tap: true }, label: "Energizer — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "tender wildguide": [{ cost: { tap: true }, label: "Tender Wildguide — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "tower of eons": [{ cost: { mana: "{8}", tap: true }, label: "Tower of Eons — gain 10 life", effects: [{ type: "gainLife", target: "controller", amount: 10 }] }],
  "obelisk of alara": [{ cost: { mana: "{1}{W}", tap: true }, label: "Obelisk of Alara — gain 5 life", effects: [{ type: "gainLife", target: "controller", amount: 5 }] }],
  "senate guildmage": [{ cost: { mana: "{W}", tap: true }, label: "Senate Guildmage — gain 2 life", effects: [{ type: "gainLife", target: "controller", amount: 2 }] }],
  "toadstool admirer": [{ cost: { mana: "{3}{G}" }, label: "Toadstool Admirer — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "yavimaya elder": [{ cost: { mana: "{2}", sacrifice: true }, label: "Yavimaya Elder — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "overgrown arch": [{ cost: { tap: true }, label: "Overgrown Arch — gain 1 life", effects: [{ type: "gainLife", target: "controller", amount: 1 }] }],
  "slinking skirge": [{ cost: { mana: "{2}", sacrifice: true }, label: "Slinking Skirge — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "tanglebloom": [{ cost: { mana: "{1}", tap: true }, label: "Tanglebloom — gain 1 life", effects: [{ type: "gainLife", target: "controller", amount: 1 }] }],
  "tough cookie": [{ cost: { mana: "{2}", tap: true, sacrifice: true }, label: "Tough Cookie — gain 3 life", effects: [{ type: "gainLife", target: "controller", amount: 3 }] }],
  "arcanis the omnipotent": [{ cost: { tap: true }, label: "Arcanis the Omnipotent — draw 3 cards", effects: [{ type: "drawCards", amount: 3 }] }],
  "hungry megasloth": [{ cost: { mana: "{2}", tap: true }, label: "Hungry Megasloth — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "scorn-blade berserker": [{ cost: { mana: "{1}", sacrifice: true }, label: "Scorn-Blade Berserker — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "juju bubble": [{ cost: { mana: "{2}" }, label: "Juju Bubble — gain 1 life", effects: [{ type: "gainLife", target: "controller", amount: 1 }] }],
  "niv-mizzet, the firemind": [{ cost: { tap: true }, label: "Niv-Mizzet, the Firemind — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "shore keeper": [{ cost: { mana: "{7}{U}", tap: true, sacrifice: true }, label: "Shore Keeper — draw 3 cards", effects: [{ type: "drawCards", amount: 3 }] }],
  "five hundred year diary": [{ cost: { mana: "{2}", sacrifice: true }, label: "Five Hundred Year Diary — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "grave-shell scarab": [{ cost: { mana: "{1}", sacrifice: true }, label: "Grave-Shell Scarab — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "parcel myr": [{ cost: { mana: "{2}", sacrifice: true }, label: "Parcel Myr — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "plague dogs": [{ cost: { mana: "{2}", sacrifice: true }, label: "Plague Dogs — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "spectral sailor": [{ cost: { mana: "{3}{U}" }, label: "Spectral Sailor — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "urza's blueprints": [{ cost: { tap: true }, label: "Urza's Blueprints — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "eriette's tempting apple": [{ cost: { mana: "{2}", tap: true, sacrifice: true }, label: "Eriette's Tempting Apple — gain 3 life", effects: [{ type: "gainLife", target: "controller", amount: 3 }] }],
  "skullmead cauldron": [{ cost: { tap: true }, label: "Skullmead Cauldron — gain 1 life", effects: [{ type: "gainLife", target: "controller", amount: 1 }] }],
  "ghost-lit redeemer": [{ cost: { mana: "{W}", tap: true }, label: "Ghost-Lit Redeemer — gain 2 life", effects: [{ type: "gainLife", target: "controller", amount: 2 }] }],
  "mystic archaeologist": [{ cost: { mana: "{3}{U}{U}" }, label: "Mystic Archaeologist — draw 2 cards", effects: [{ type: "drawCards", amount: 2 }] }],
  "fountain of youth": [{ cost: { mana: "{2}", tap: true }, label: "Fountain of Youth — gain 1 life", effects: [{ type: "gainLife", target: "controller", amount: 1 }] }],
  "heart warden": [{ cost: { mana: "{2}", sacrifice: true }, label: "Heart Warden — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "azure mage": [{ cost: { mana: "{3}{U}" }, label: "Azure Mage — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "enclave cryptologist": [{ cost: { tap: true }, label: "Enclave Cryptologist — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "rejuvenation chamber": [{ cost: { tap: true }, label: "Rejuvenation Chamber — gain 2 life", effects: [{ type: "gainLife", target: "controller", amount: 2 }] }],
  "dedicated martyr": [{ cost: { mana: "{W}", sacrifice: true }, label: "Dedicated Martyr — gain 3 life", effects: [{ type: "gainLife", target: "controller", amount: 3 }] }],
  "molten hydra": [{ cost: { mana: "{1}{R}{R}" }, label: "Molten Hydra — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "verdant automaton": [{ cost: { mana: "{3}{G}" }, label: "Verdant Automaton — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "braidwood cup": [{ cost: { tap: true }, label: "Braidwood Cup — gain 1 life", effects: [{ type: "gainLife", target: "controller", amount: 1 }] }],
  "werefox bodyguard": [{ cost: { mana: "{1}{W}", sacrifice: true }, label: "Werefox Bodyguard — gain 2 life", effects: [{ type: "gainLife", target: "controller", amount: 2 }] }],
  "illvoi galeblade": [{ cost: { mana: "{2}", sacrifice: true }, label: "Illvoi Galeblade — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "staff of domination": [{ cost: { mana: "{2}", tap: true }, label: "Staff of Domination — gain 1 life", effects: [{ type: "gainLife", target: "controller", amount: 1 }] }],
  "aether syphon": [{ cost: { mana: "{2}", tap: true }, label: "Aether Syphon — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "arcane encyclopedia": [{ cost: { mana: "{3}", tap: true }, label: "Arcane Encyclopedia — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "ruins recluse": [{ cost: { mana: "{3}{G}" }, label: "Ruins Recluse — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "endbringer": [{ cost: { mana: "{C}{C}", tap: true }, label: "Endbringer — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "hangarback walker": [{ cost: { mana: "{1}", tap: true }, label: "Hangarback Walker — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "tower of fortunes": [{ cost: { mana: "{8}", tap: true }, label: "Tower of Fortunes — draw 4 cards", effects: [{ type: "drawCards", amount: 4 }] }],
  "clockwork vorrac": [{ cost: { tap: true }, label: "Clockwork Vorrac — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "scepter of insight": [{ cost: { mana: "{3}{U}", tap: true }, label: "Scepter of Insight — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "walking archive": [{ cost: { mana: "{2}{W}{U}" }, label: "Walking Archive — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "snapping voidcraw": [{ cost: { mana: "{3}{C}", tap: true }, label: "Snapping Voidcraw — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "stone haven medic": [{ cost: { mana: "{W}", tap: true }, label: "Stone Haven Medic — gain 1 life", effects: [{ type: "gainLife", target: "controller", amount: 1 }] }],
  "sarcomite myr": [{ cost: { mana: "{2}", sacrifice: true }, label: "Sarcomite Myr — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "triskaidekaphile": [{ cost: { mana: "{3}{U}" }, label: "Triskaidekaphile — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "red herring": [{ cost: { mana: "{2}", sacrifice: true }, label: "Red Herring — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "swarm shambler": [{ cost: { mana: "{1}", tap: true }, label: "Swarm Shambler — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
  "ice cream kitty": [{ cost: { mana: "{2}", tap: true, sacrifice: true }, label: "Ice Cream Kitty — gain 3 life", effects: [{ type: "gainLife", target: "controller", amount: 3 }] }],
  // Windcrag Siege's "as this enchantment enters, choose Mardu or Jeskai" -- modeled as two free,
  // no-cost activated abilities rather than a new generic "modal ETB choice" prompt system, since
  // this app already has a working per-card dynamic-button mechanism (maskCard's activatedAbilities
  // list) that fits perfectly: `condition` hides both once chosenMode is set, so the choice can only
  // be made once. See the matching CARD_ABILITIES entry for what the Jeskai mode actually does.
  "windcrag siege": [
    { label: "Windcrag Siege — choose Mardu", condition: (c) => !c.chosenMode, effects: [{ type: "chooseMode", mode: "Mardu" }] },
    { label: "Windcrag Siege — choose Jeskai", condition: (c) => !c.chosenMode, effects: [{ type: "chooseMode", mode: "Jeskai" }] }
  ],
  // {T}: Add {C}{C} -- ONE color but TWO units from a single tap, which the generic "auto-add its
  // one fixed color" free-tap shortcut can't express (it only ever adds one unit); needs the same
  // manaAbility fast path (skips the stack, resolves the instant it's activated -- CR 605) signets
  // already use, just with no mana cost of its own.
  "sol ring": [{ cost: { tap: true }, manaAbility: true, label: "Sol Ring — Add {C}{C}", effects: [{ type: "addFixedMana", colors: ["C", "C"] }] }],
  // A "painless" fetch like Evolving Wilds/Terramorphic Expanse (basicOnly, any basic) but WITH a
  // real life cost like the life-paying fetches -- and unlike Evolving Wilds, doesn't force the
  // fetched land tapped.
  "prismatic vista": [{ cost: { tap: true, life: 1, sacrifice: true }, label: "Prismatic Vista — search for a basic land", effects: [{ type: "searchLandTypes", types: ["Plains", "Island", "Swamp", "Mountain", "Forest"], basicOnly: true }] }],
  // Real text also requires "activate only if an opponent controls more lands than you" -- not
  // checked (this table's cost/condition vocabulary has no cross-player state comparison), so this
  // is always activatable. A real, disclosed simplification, not a silent one.
  "weathered wayfarer": [{ cost: { mana: "{W}", tap: true }, label: "Weathered Wayfarer — search for a land", effects: [{ type: "tutorToHand", typeFilter: "land" }] }],
  "deathless angel": [{ cost: { mana: "{W}{W}" }, label: "Deathless Angel — target creature gains indestructible", requiresTarget: true, targetKind: "creature", effects: [{ type: "grantKeywordToTarget", keyword: "Indestructible" }] }],
  "skithiryx, the blight dragon": [
    { cost: { mana: "{B}" }, label: "Skithiryx — gains haste", effects: [{ type: "grantHasteToSelf" }] },
    { cost: { mana: "{B}{B}" }, label: "Skithiryx — regenerate", effects: [{ type: "grantRegenerationShield" }] }
  ],
  // "Activate only as a sorcery" isn't checked (this table has no timing-restriction vocabulary
  // for activated abilities) -- a disclosed narrowing, same as everywhere else timing nuances
  // aren't modeled.
  "whip of erebos": [{ cost: { mana: "{2}{B}{B}", tap: true }, label: "Whip of Erebos — return target creature card from your graveyard to the battlefield with haste, exile it at the next end step", requiresTarget: true, targetKind: "ownGraveyardCreature", effects: [{ type: "reanimateWithHasteExileAtEndStep" }] }],
  // "{T}: Target creature you control gains protection from the color of your choice until end of
  // turn." The real card presents "of your choice" as ONE activation with a color picker; this
  // engine has no such two-step (pick a target, THEN pick a color) choice flow, so it's modeled as
  // five separate buttons -- one per color -- each its own complete activated ability, same "reuse
  // the existing multi-button UI instead of building a new modal" precedent Windcrag Siege's ETB
  // mode-choice already established. See grantProtectionUntilEOT for where the grant actually lands.
  "mother of runes": ["White", "Blue", "Black", "Red", "Green"].map((color) => ({
    cost: { tap: true },
    label: `Mother of Runes — target creature you control gains protection from ${color} until end of turn`,
    requiresTarget: true, targetKind: "ownCreature",
    effects: [{ type: "grantProtectionUntilEOT", quality: color.toLowerCase() }]
  })),
  // Same shape as Mother of Runes, but "ANOTHER target creature you control" (targetKind
  // otherOwnCreature excludes Giver itself) and a sixth "colorless" option this card alone has.
  "giver of runes": ["White", "Blue", "Black", "Red", "Green", "Colorless"].map((color) => ({
    cost: { tap: true },
    label: `Giver of Runes — another target creature you control gains protection from ${color} until end of turn`,
    requiresTarget: true, targetKind: "otherOwnCreature",
    effects: [{ type: "grantProtectionUntilEOT", quality: color.toLowerCase() }]
  })),
  // Batch added from the same live-decklist gap-analysis pass as SPELL_ABILITIES below.
  "goblin motivator": [{ cost: { tap: true }, label: "Goblin Motivator — target creature gains haste until end of turn", requiresTarget: true, targetKind: "creature", effects: [{ type: "grantKeywordToTarget", keyword: "Haste" }] }],
  "skirk prospector": [{ cost: { sacrifice: true }, manaAbility: true, label: "Skirk Prospector — Sacrifice: Add {R}", effects: [{ type: "addFixedMana", colors: ["R"] }] }],
  "wayfarer's bauble": [{ cost: { mana: "{2}", tap: true, sacrifice: true }, label: "Wayfarer's Bauble — search for a basic land, tapped", effects: [{ type: "searchLandTypes", basicOnly: true, types: ["Plains", "Island", "Swamp", "Mountain", "Forest"], entersTapped: true }] }],
  // "{T}: Create X 1/1 red Goblin creature tokens, where X is the number of Goblins you control."
  // See createTokensEqualToTypeCountControlled's own comment for why X is computed inside the
  // effect itself rather than threaded in as a param.
  "krenko, mob boss": [{ cost: { tap: true }, label: "Krenko, Mob Boss — create Goblin tokens equal to Goblins you control", effects: [{ type: "createTokensEqualToTypeCountControlled", typeFilter: ["goblin"], name: "Goblin", tokenType: "Token Creature — Goblin", power: "1", toughness: "1", colors: ["R"] }] }],
  // "target creature can't be blocked this turn" -- see declareBlockers' own comment for how
  // Unblockable actually gets enforced.
  "rogue's passage": [{ cost: { mana: "{4}", tap: true }, label: "Rogue's Passage — target creature can't be blocked this turn", requiresTarget: true, targetKind: "creature", effects: [{ type: "grantKeywordToTarget", keyword: "Unblockable" }] }],
  // Two SEPARATE {T}, Sacrifice abilities (either one, not both -- sacrificing the land is part of
  // the cost either way) -- same "one entry per real activated ability" shape ACTIVATED_ABILITIES
  // already uses everywhere else a card has more than one.
  "escape tunnel": [
    { cost: { tap: true, sacrifice: true }, label: "Escape Tunnel — search for a basic land, tapped", effects: [{ type: "searchLandTypes", basicOnly: true, types: ["Plains", "Island", "Swamp", "Mountain", "Forest"], entersTapped: true }] },
    { cost: { tap: true, sacrifice: true }, label: "Escape Tunnel — target creature with power 2 or less can't be blocked this turn", requiresTarget: true, targetKind: "creature", effects: [{ type: "grantKeywordToTarget", keyword: "Unblockable" }] }
  ],
  // Clue tokens' own real text -- "{2}, Sacrifice this artifact: Draw a card." Keyed by the plain
  // token name ("Clue"), so ANY Clue on the battlefield already has this ability regardless of
  // which card's investigate/effect created it (Tireless Tracker's landfall, or any future
  // investigate source) -- no per-source duplication needed.
  "clue": [{ cost: { mana: "{2}", sacrifice: true }, label: "Clue — Sacrifice: Draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  // See EFFECTS.createTokenCopyWithHaste/sacrificeChosenCardById for the actual copy + delayed
  // sacrifice. targetKind otherOwnCreature already excludes Kiki-Jiki itself, matching "another".
  "kiki-jiki, mirror breaker": [{ cost: { tap: true }, label: "Kiki-Jiki, Mirror Breaker — create a hasty token copy of another creature you control, sacrifice it at the next end step", requiresTarget: true, targetKind: "otherOwnCreature", effects: [{ type: "createTokenCopyWithHaste" }] }],
  // Its "{T}: Add one mana..." half needs no table entry at all -- no extra cost/multi-color-at-once
  // shape (unlike a signet), so it's already covered by the free single-tap-for-mana shortcut's own
  // dependsOnCommanderColorIdentity narrowing. Only the sacrifice-to-draw half needs one.
  "commander's sphere": [{ cost: { sacrifice: true }, label: "Commander's Sphere — Sacrifice: Draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  // Its ETB reveal-or-tapped choice needs no table entry -- see checkRevealFromHandChoice, a
  // generic text-pattern mechanism. Only this tap-for-haste half is name-based.
  "flamekin village": [{ cost: { mana: "{R}", tap: true }, label: "Flamekin Village — target creature gains haste until end of turn", requiresTarget: true, targetKind: "creature", effects: [{ type: "grantKeywordToTarget", keyword: "Haste" }] }],
  // "{T}, Sacrifice: search for a basic land, put it onto the battlefield tapped, then shuffle.
  // Then if you control four or more lands, untap that land." See searchLandTypes/fetchLand's own
  // comments for untapIfLandCountAtLeast.
  "fabled passage": [{ cost: { tap: true, sacrifice: true }, label: "Fabled Passage — search for a basic land, tapped (untaps at 4+ lands)", effects: [{ type: "searchLandTypes", types: ["Plains", "Island", "Swamp", "Mountain", "Forest"], basicOnly: true, entersTapped: true, untapIfLandCountAtLeast: 4 }] }],
  // "{2}, {T}, Sacrifice: search for up to two basic lands that share a land type, put them onto
  // the battlefield tapped, then shuffle." The "share a land type" cross-referential constraint
  // between the two picks isn't checked (this app's fetch validation only ever matches a SINGLE
  // pick against a type list, with no memory of a prior pick in the same search) -- same "close
  // approximation, trust the player" precedent as every other unchecked condition in this file;
  // reuses the same thenEffects-chained-second-fetch shape Cultivate already established.
  "myriad landscape": [{ cost: { mana: "{2}", tap: true, sacrifice: true }, label: "Myriad Landscape — search for up to two basic lands, tapped", effects: [{ type: "searchLandTypes", types: ["Plains", "Island", "Swamp", "Mountain", "Forest"], basicOnly: true, entersTapped: true, thenEffects: [{ type: "searchLandTypes", types: ["Plains", "Island", "Swamp", "Mountain", "Forest"], basicOnly: true, entersTapped: true }] }] }],
  // Wave 10 gap-analysis batch.
  // Mind Stone's "{T}: Add {C}" half needs no table entry (free single-color tap shortcut).
  "mind stone": [{ cost: { mana: "{1}", tap: true, sacrifice: true }, label: "Mind Stone — Sacrifice: Draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  // "{T}: Put a burden counter on The One Ring, then draw a card for each burden counter." Not
  // flagged manaAbility -- this isn't a mana source, it goes through the stack normally like any
  // other activated ability (real Magic restricts it to sorcery speed, unchecked here, a disclosed
  // simplification shared with every other unchecked timing restriction in this file).
  "the one ring": [{ cost: { tap: true }, label: "The One Ring — put a burden counter on it, draw a card for each", effects: [{ type: "addCountersToSelf", amount: 1 }, { type: "drawCardsEqualToSelfCounters" }] }],
  // "{T}: Add {C}{C}. Activate only if you control five or more lands." Real activation-condition
  // gating (see the activateAbility handler's own `ability.condition` check) rather than a plain
  // mana ability -- manaAbility:true is still needed since it's TWO units of mana from one tap,
  // exactly like Sol Ring's own reasoning.
  // condition follows the SAME (card, lobby) signature every other ability condition in this file
  // uses (CARD_ABILITIES' fireTrigger, fireGlobalOtherCreatureEtbTriggers, and maskCard's own
  // activatedAbilities visibility filter, which is what actually calls this on every card broadcast
  // -- NOT (lobby, playerId), which maskCard has no way to supply and crashed on before this was
  // caught by testing a real activation against a live table).
  "temple of the false god": [{ cost: { tap: true }, manaAbility: true, condition: (card, lobby) => Object.values(lobby.cards).filter((c) => c.owner === card.owner && c.zoneType === "mana").length >= 5, conditionError: "You need five or more lands to activate this.", label: "Temple of the False God — Add {C}{C}", effects: [{ type: "addFixedMana", colors: ["C", "C"] }] }],
  // Geier Reach Sanitarium's "{T}: Add {C}" half needs no table entry (free single-color tap
  // shortcut). See EFFECTS.eachPlayerDrawsThenAutoDiscards for what's simplified (the discard isn't
  // a real per-player choice).
  "geier reach sanitarium": [{ cost: { mana: "{2}", tap: true }, label: "Geier Reach Sanitarium — each player draws a card, then discards a card", effects: [{ type: "eachPlayerDrawsThenAutoDiscards" }] }],
  // "{3}{R}, Sacrifice a Goblin: Create two 1/1 red Goblin creature tokens." Real "a Goblin" (not
  // "another"), so sacrificing Pashalik Mons itself IS legal -- but autoSacrificeFilter prefers any
  // OTHER qualifying Goblin first (see the activateAbility handler's own comment) so this doesn't
  // surprise-destroy the payoff engine whenever a different Goblin is available to sacrifice instead.
  "pashalik mons": [{ cost: { mana: "{3}{R}", autoSacrificeFilter: "goblin" }, label: "Pashalik Mons — Sacrifice a Goblin: create two Goblin tokens", effects: [{ type: "createToken", amount: 2, name: "Goblin", tokenType: "Token Creature — Goblin", power: "1", toughness: "1", colors: ["R"] }] }],
  // "Sacrifice a creature: Add {C}{C}." Reuses autoSacrificeFilter (Pashalik Mons's own new cost
  // shape) for the "a creature" cost -- unlike Pashalik's "a Goblin," this excludes nothing of its
  // own, so the auto-pick just needs a broad "creature" filter -- plus manaAbility:true since it's
  // two units of mana from one activation, same reasoning as Sol Ring/signets/Temple of the False
  // God. Cost-paying (including autoSacrificeFilter) always runs before the manaAbility/stack branch
  // check, so the two features already compose correctly with no extra wiring.
  "ashnod's altar": [{ cost: { autoSacrificeFilter: "creature" }, manaAbility: true, label: "Ashnod's Altar — Sacrifice a creature: Add {C}{C}", effects: [{ type: "addFixedMana", colors: ["C", "C"] }] }],
  // Wave 13 gap-analysis batch.
  // "{1}, {T}: Untap target creature." The static "you may activate abilities of creatures you
  // control as though those creatures had haste" half needs no table entry -- see
  // canActivateAbilitiesAsThoughHaste, checked directly in the activateAbility handler's own
  // summoning-sickness gate.
  "thousand-year elixir": [{ cost: { mana: "{1}", tap: true }, label: "Thousand-Year Elixir — untap target creature", requiresTarget: true, targetKind: "creature", effects: [{ type: "untapTarget" }] }],
  // Wave 14 gap-analysis batch.
  // "{T}: Add {C}." needs no table entry (free single-color tap shortcut).
  "bloom tender": [{ cost: { tap: true }, manaAbility: true, label: "Bloom Tender — Add one mana of each color among permanents you control", effects: [{ type: "addManaForEachColorControlled" }] }],
  "faeburrow elder": [{ cost: { tap: true }, manaAbility: true, label: "Faeburrow Elder — Add one mana of each color among permanents you control", effects: [{ type: "addManaForEachColorControlled" }] }],
  "aggravated assault": [{ cost: { mana: "{3}{R}{R}" }, label: "Aggravated Assault — untap all creatures you control, take an extra combat phase", effects: [{ type: "untapAllCreaturesAndExtraCombat" }] }],
  // "Activate only if you control a creature with power 4 or greater" -- a real activation-condition
  // gate (same (card, lobby) convention as Temple of the False God's own condition), checked against
  // each candidate's REAL effective power (base + counters + equipment/aura + anthem bonuses), not
  // just its printed power.
  "bonders' enclave": [{ cost: { mana: "{3}", tap: true }, condition: (card, lobby) => Object.values(lobby.cards).some((c) => c.owner === card.owner && c.zoneType === "creature" && (parsePT(c.power) + (c.counters || 0) + attachedBonusFor(lobby, c).powerBonus + staticBonusFor(lobby, c).powerBonus) >= 4), conditionError: "You need a creature with power 4 or greater to activate this.", label: "Bonders' Enclave — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  // Wave 15 gap-analysis batch.
  "contagion clasp": [{ cost: { mana: "{4}", tap: true }, label: "Contagion Clasp — Proliferate", effects: [{ type: "proliferateAll" }] }],
  // "Activate only if you control three or more lands with the same name" -- a real activation
  // condition (same (card, lobby) convention as Bonders' Enclave/Temple of the False God above).
  "endless atlas": [{ cost: { mana: "{2}", tap: true }, condition: (card, lobby) => {
    const nameCounts = {};
    Object.values(lobby.cards).forEach((c) => {
      if (c.owner === card.owner && c.zoneType === "mana") nameCounts[archiveKey(c.name)] = (nameCounts[archiveKey(c.name)] || 0) + 1;
    });
    return Object.values(nameCounts).some((n) => n >= 3);
  }, conditionError: "You need three or more lands with the same name to activate this.", label: "Endless Atlas — draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "battle cry goblin": [{ cost: { mana: "{1}{R}" }, label: "Battle Cry Goblin — Goblins you control get +1/+0 and gain haste until end of turn", effects: [{ type: "grantTemporaryPTAndKeywordsToType", typeFilter: "goblin", power: 1, toughness: 0, keywords: ["Haste"] }] }],
  "lathliss, dragon queen": [{ cost: { mana: "{1}{R}" }, label: "Lathliss, Dragon Queen — Dragons you control get +1/+0 until end of turn", effects: [{ type: "grantTemporaryPTAndKeywordsToType", typeFilter: "dragon", power: 1, toughness: 0 }] }],
  // "Pay 2 life, Sacrifice ANOTHER creature: Search your library for a card, put it into your hand,
  // then shuffle." cost.excludeSelf -- see the activateAbility handler's own comment -- since
  // "another" (unlike Pashalik Mons's "a Goblin") means this can't fall back to sacrificing itself.
  "razaketh, the foulblooded": [{ cost: { life: 2, autoSacrificeFilter: "creature", excludeSelf: true }, label: "Razaketh, the Foulblooded — Pay 2 life, Sacrifice another creature: search for a card", effects: [{ type: "tutorToHand" }] }],
  "tortured existence": [{ cost: { mana: "{B}", autoDiscardFilter: "creature" }, requiresTarget: true, targetKind: "ownGraveyardCreature", label: "Tortured Existence — {B}, Discard a creature card: return target creature card from your graveyard to your hand", effects: [{ type: "returnGraveyardCardToHand" }] }],
  // Wave 26 -- its plain "{T}: Add {C}" half is untouched by the free-tap-mana shortcut, same
  // reasoning as Desolate Lighthouse (this second ability isn't a manaAbility).
  "hall of heliod's generosity": [{ cost: { mana: "{1}{W}", tap: true }, requiresTarget: true, targetKind: "ownGraveyardTypeList", typeFilter: ["enchantment"], label: "Hall of Heliod's Generosity — {1}{W}, {T}: Put target enchantment card from your graveyard on top of your library", effects: [{ type: "putOwnGraveyardEntryOnTopOfLibrary" }] }],
  // The real Treasure token ability -- matches ANY token literally named "Treasure", regardless of
  // which effect created it (createTreasureToken/rollD20CreateTreasures/counterTargetSpellCreateTokenForController
  // all use this exact name). See chooseManaAnyColor's own comment for the sacrificed-source-by-the-
  // time-effects-run mechanics and the Goldspan Dragon upgrade it also handles.
  "treasure": [{ cost: { sacrifice: true, tap: true }, manaAbility: true, label: "Treasure — Sacrifice this artifact: Add one mana of any color", effects: [{ type: "chooseManaAnyColor", sourceName: "Treasure" }] }],
  // Icon of Ancestry's dig -- typeFromChosenCreatureType reads the ETB choice at activation time
  // instead of a fixed table-defined type list (see lookTopNRevealTypesToHand's own comment).
  "icon of ancestry": [{ cost: { mana: "{3}", tap: true }, label: "Icon of Ancestry — look at the top three, take creature(s) of the chosen type to hand", effects: [{ type: "lookTopNRevealTypesToHand", amount: 3, typeFromChosenCreatureType: true }] }],
  // Wave 17 gap-analysis batch.
  "goblin bombardment": [{ cost: { autoSacrificeFilter: "creature" }, requiresTarget: true, targetKind: "any", label: "Goblin Bombardment — Sacrifice a creature: deal 1 damage to any target", effects: [{ type: "damageTarget", amount: 1 }] }],
  // "Other Goblins you control get +1/+1" needs no table entry -- already generic (anthemEffectsFromText's
  // self-inclusive-typed-anthem branch). The dynamic damage amount is computed fresh at activation
  // time (see damageEqualToGoblinsEnteredThisTurn's own comment).
  "hobgoblin bandit lord": [{ cost: { mana: "{R}", tap: true }, requiresTarget: true, targetKind: "any", label: "Hobgoblin Bandit Lord — deal damage equal to Goblins that entered this turn to any target", effects: [{ type: "damageEqualToGoblinsEnteredThisTurn" }] }],
  "goblin trashmaster": [{ cost: { autoSacrificeFilter: "goblin" }, requiresTarget: true, targetKind: "artifact", label: "Goblin Trashmaster — Sacrifice a Goblin: destroy target artifact", effects: [{ type: "destroyTarget" }] }],
  // Shadowspear's equipped-creature bonus (+1/+1, trample, lifelink) is already covered generically
  // by the equipment text-scan machinery -- only this second, unattached activated ability needed a
  // real table entry. No target: it hits every opponent permanent at once (see
  // removeHexproofIndestructibleFromOpponents).
  "shadowspear": [{ cost: { mana: "{1}" }, label: "Shadowspear — Permanents your opponents control lose hexproof and indestructible until end of turn", effects: [{ type: "removeHexproofIndestructibleFromOpponents" }] }],
  // Cephalid Coliseum -- its plain "{T}: Add {U}. This land deals 1 damage to you." half needs no
  // table entry (the free single-color tap shortcut plus the new applyPainlandDamageIfNeeded check
  // in the "tap"/"resolveManaChoice" handlers already covers it). Threshold's "seven or more cards
  // in your graveyard" is a real activation-condition gate, same (card, lobby) convention as
  // Bonders' Enclave/Endless Atlas.
  "cephalid coliseum": [{
    cost: { mana: "{U}", tap: true, sacrifice: true }, requiresTarget: true, targetKind: "player",
    condition: (card, lobby) => (lobby.players[card.owner] && (lobby.players[card.owner].graveyard || []).length >= 7),
    conditionError: "You need seven or more cards in your graveyard to activate this.",
    label: "Cephalid Coliseum — target player draws three cards, then discards three cards",
    effects: [{ type: "targetPlayerDraws", amount: 3 }, { type: "targetPlayerDiscards", amount: 3 }]
  }],
  // Mtenda Griffin -- "Activate only during your upkeep" is a real activation-condition gate
  // reusing the exact same (card, lobby) mechanism as every other conditioned ability above; this
  // one is the first to check turn.phase/activeIndex instead of board state. bounceSelfToHand
  // (already built for Hibernation Sliver's granted ability) + the existing ownGraveyardTypeList
  // targetKind (Hall of Heliod's Generosity) cover both halves with zero new effects.
  "mtenda griffin": [{
    cost: { mana: "{W}", tap: true }, requiresTarget: true, targetKind: "ownGraveyardTypeList", typeFilter: ["griffin"],
    condition: (card, lobby) => lobby.turn.phase === "Upkeep" && lobby.turn.order[lobby.turn.activeIndex] === card.owner,
    conditionError: "You can only activate this during your own upkeep.",
    label: "Mtenda Griffin — return this creature to hand and return target Griffin card from your graveyard to your hand",
    effects: [{ type: "bounceSelfToHand" }, { type: "returnGraveyardCardToHand" }]
  }],
  "kyodai, soul of kamigawa": [{ cost: { mana: "{W}{U}{B}{R}{G}" }, label: "Kyodai, Soul of Kamigawa — gets +5/+5 until end of turn", effects: [{ type: "grantTemporaryPTToSelf", power: 5, toughness: 5 }] }],
  "chulane, teller of tales": [{ cost: { mana: "{3}", tap: true }, requiresTarget: true, targetKind: "ownCreature", label: "Chulane, Teller of Tales — return target creature you control to its owner's hand", effects: [{ type: "bounceTargetToHand" }] }],
  // Field of Ruin -- its plain "{T}: Add {C}" half needs no table entry (free-tap shortcut).
  "field of ruin": [{ cost: { mana: "{2}", tap: true, sacrifice: true }, requiresTarget: true, targetKind: "opponentNonbasicLand", label: "Field of Ruin — destroy target nonbasic land an opponent controls; each player searches for a basic land", effects: [{ type: "destroyTarget" }, { type: "eachPlayerSearchesForBasicLand" }] }]
};
// Generic "[X creatures you control / All Xs / Other creatures you control] have '[ability]'"
// grant detector -- the Sliver cycle's own defining template (Gemhide Sliver, Clot Sliver, Crypt
// Sliver, etc.), also used by cards like Hexing Squelcher. A real, name-independent text scan
// (same precedent as anthemKeywordsFromText/checkRiot), not a per-card table entry -- one grantor
// on the battlefield retroactively covers every future card using this exact templating, the same
// leverage the type-scoped anthem branch and the "treasure" ACTIVATED_ABILITIES entry already prove
// out. Only maps a small, growing library of KNOWN quoted-ability shapes (grantedAbilityFromText) --
// an unrecognized granted ability text is silently skipped, a disclosed narrowing matching every
// other text-pattern mechanism in this file.
function grantedAbilityGrantMatches(text) {
  const matches = [];
  const re = /(?:all (\w+)s|(\w+) creatures you control) have "([^"]+)"/gi;
  let m;
  while ((m = re.exec(text || ""))) {
    const typeWord = (m[1] || m[2] || "").toLowerCase();
    matches.push({ typeWord, abilityText: m[3] });
  }
  // Chromatic Lantern-style "Lands you control have '[ability]'" -- the LAND-scoped sibling of the
  // creature-type-word grants above (own alternative since "lands" isn't a creature type and this
  // wording has no "creatures" word for the existing branches to match against). typeWord "land" is
  // a sentinel getGrantedActivatedAbilities/getGrantedTriggeredAbilities check for explicitly.
  const landRe = /lands you control have "([^"]+)"/gi;
  while ((m = landRe.exec(text || ""))) {
    matches.push({ typeWord: "land", abilityText: m[1] });
  }
  return matches;
}
// Maps ONE granted ability's quoted text to a real ACTIVATED_ABILITIES-shaped entry, reusing
// existing EFFECTS wherever the shape matches an already-automated single-card ability (Skithiryx's
// own {B}{B}: Regenerate -> grantRegenerationShield, Treasure's own any-color tap -> chooseManaAnyColor).
function grantedAbilityFromText(abilityText) {
  const t = abilityText.trim().replace(/\.$/, "").toLowerCase();
  let m;
  if (/^\{t\}: add one mana of any color$/.test(t)) {
    return { cost: { tap: true }, manaAbility: true, effects: [{ type: "chooseManaAnyColor" }] };
  }
  if ((m = t.match(/^\{([^}]+)\}: regenerate this permanent$/))) {
    return { cost: { mana: `{${m[1].toUpperCase()}}` }, effects: [{ type: "grantRegenerationShield" }] };
  }
  if (/^\{t\}: regenerate target \w+$/.test(t)) {
    return { cost: { tap: true }, requiresTarget: true, targetKind: "creature", effects: [{ type: "grantRegenerationShieldToTarget" }] };
  }
  if ((m = t.match(/^pay (\d+) life: return this permanent to its owner'?s hand$/))) {
    return { cost: { life: parseInt(m[1], 10) || 0 }, effects: [{ type: "bounceSelfToHand" }] };
  }
  if ((m = t.match(/^\{([^}]+)\}, sacrifice this permanent: destroy target permanent$/))) {
    return { cost: { mana: `{${m[1].toUpperCase()}}`, sacrifice: true }, requiresTarget: true, targetKind: "permanent", effects: [{ type: "destroyTarget" }] };
  }
  // Hollowhead Sliver's own grant -- reuses the same autoDiscardFilter cost primitive Tortured
  // Existence's real ACTIVATED_ABILITIES entry needs.
  if (/^\{t\}, discard a card: draw a card$/.test(t)) {
    return { cost: { tap: true, autoDiscardFilter: "card" }, effects: [{ type: "drawCards", amount: 1 }] };
  }
  if (/^ward—pay 2 life$/.test(t) || /^ward - pay 2 life$/.test(t)) {
    // A granted KEYWORD line, not a real activated ability -- Ward isn't modeled as an
    // enforceable game restriction in this engine at all (same disclosed gap as everywhere else
    // Ward is printed), so this is intentionally a no-op match (skip, not a table entry).
    return null;
  }
  return null;
}
// Self-inclusive for "all Xs"/"[type] creatures you control" (matches how every real card in this
// shape actually reads); "other creatures you control" is the one variant that excludes the
// granting card's own copy of the ability.
function getGrantedActivatedAbilities(card, lobby) {
  const isCreature = card.zoneType === "creature";
  // Chromatic Lantern -- "Lands you control have [ability]" needs the exact same grant-detection
  // machinery, just scoped to lands (zoneType "mana") instead of creatures.
  const isLand = card.zoneType === "mana";
  if (!lobby || (!isCreature && !isLand)) return [];
  const cardType = (card.type || "").toLowerCase();
  const grants = [];
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.owner !== card.owner || c.zoneType === "hand" || c.zoneType === "stack") continue;
    grantedAbilityGrantMatches(c.text).forEach(({ typeWord, abilityText }) => {
      if (typeWord === "land") {
        if (!isLand) return;
      } else {
        if (!isCreature) return;
        const excludeSelf = typeWord === "other";
        if (!excludeSelf && typeWord && !cardType.includes(typeWord)) return;
        if (excludeSelf && c.id === card.id) return;
      }
      const shape = grantedAbilityFromText(abilityText);
      if (!shape) return;
      grants.push({ ...shape, label: `${card.name || (isLand ? "Land" : "Creature")} — ${abilityText.trim().replace(/\.$/, "")}` });
    });
  }
  return grants;
}
function getActivatedAbilities(card, lobby) {
  const named = ACTIVATED_ABILITIES[archiveKey(card.name)] || [];
  return [...named, ...getGrantedActivatedAbilities(card, lobby)];
}

// The TRIGGERED-ability counterpart to grantedAbilityFromText/getGrantedActivatedAbilities above --
// same grant-clause detection (grantedAbilityGrantMatches), a different small shape library for
// quoted ETB-triggered text instead of activated-ability text. Harmonic Sliver/Lavabelly Sliver's
// own ETB grants map onto CARD_ABILITIES' real "etb" trigger shape (requiresTarget/targetKind/
// effects/label), letting fireEtbTriggers fire them through the exact same fireTrigger call path a
// name-keyed CARD_ABILITIES entry already uses -- no separate resolution machinery needed.
function grantedTriggeredAbilityFromText(abilityText) {
  const t = abilityText.trim().replace(/\.$/, "");
  let m;
  if ((m = t.match(/^when this (?:creature|permanent) enters, it deals (\d+) damage to target player or planeswalker and you gain (\d+) life$/i))) {
    return { trigger: "etb", requiresTarget: true, targetKind: "playerOrPlaneswalker", effects: [{ type: "damageTarget", amount: parseInt(m[1], 10) || 0 }, { type: "gainLife", target: "controller", amount: parseInt(m[2], 10) || 0 }] };
  }
  if (/^when this permanent enters, destroy target artifact or enchantment$/i.test(t)) {
    return { trigger: "etb", requiresTarget: true, targetKind: "typeList", typeFilter: ["artifact", "enchantment"], effects: [{ type: "destroyTarget" }] };
  }
  return null;
}
function getGrantedTriggeredAbilities(card, lobby, triggerType) {
  if (!lobby || card.zoneType !== "creature") return [];
  const cardType = (card.type || "").toLowerCase();
  const grants = [];
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.owner !== card.owner || c.zoneType === "hand" || c.zoneType === "stack") continue;
    grantedAbilityGrantMatches(c.text).forEach(({ typeWord, abilityText }) => {
      const excludeSelf = typeWord === "other";
      if (!excludeSelf && typeWord && !cardType.includes(typeWord)) return;
      if (excludeSelf && c.id === card.id) return;
      const shape = grantedTriggeredAbilityFromText(abilityText);
      if (!shape || shape.trigger !== triggerType) return;
      grants.push({ ...shape, label: `${card.name || "Creature"} — ${abilityText.trim().replace(/\.$/, "")}` });
    });
  }
  return grants;
}

// "Creatures can't attack you unless their controller pays {2} for each creature they control
// that's attacking you." A real static restriction on DECLARING an attacker (checked/paid for right
// in declareAttackers below), not a triggered ability -- there's nothing to trigger, it's a cost
// gating the action itself, same as summoning sickness or a tapped creature already are in that same
// handler. Scoped to the flat "{N} per attacker, no other condition" shape shared by every card
// here; a variable-amount one (Sphere of Safety's per-enchantment scaling, Collective Restraint's
// per-Wall scaling) would need real per-card logic this table can't express, so those aren't
// included -- same "narrow to the common, unconditional case" precedent as everywhere else in this
// file that draws a line around what's automatable.
const ATTACK_TAX_EFFECTS = { "propaganda": 2, "ghostly prison": 2, "windborn muse": 2 };
// "This creature can only attack alone" -- checked in declareAttackers before anything gets tapped.
const ATTACK_ALONE_CARDS = ["master of cruelties"];

// What a cast instant/sorcery spell actually DOES, for the narrow set of real cards authored here --
// one entry per card (unlike CARD_ABILITIES/ACTIVATED_ABILITIES, a spell only ever resolves once,
// so there's no array of multiple abilities to pick from). Targets, when present, are chosen at
// CAST time (see castSpell), matching real Magic -- a target that becomes illegal before the spell
// resolves (e.g. its creature target died in response) simply fizzles: executeSpellEffectsNow's
// underlying EFFECTS functions all already no-op gracefully on a missing chosenTargetId. targetKind
// is one of "creature" (existing zoneType-based matching), "player", "any" (creature, player, or
// planeswalker), or "spell" (anything currently on the stack, for counters).
const SPELL_ABILITIES = {
  "armageddon": { label: "Armageddon — destroy all lands", effects: [{ type: "destroyAllLands" }] },
  // Wave 28 -- "Exile up to two target artifacts and/or enchantments," same disclosed one-target
  // narrowing as Angel of the Ruins' identical "up to two" clause (this app's target-choice queue
  // takes one target per queued choice). Basic landcycling needs no entry -- cyclingCostFromText.
  "sylvan reclamation": { label: "Sylvan Reclamation — exile target artifact or enchantment", effects: [{ type: "exileTarget" }], requiresTarget: true, targetKind: "typeList", typeFilter: ["artifact", "enchantment"] },
  // Batch-generated from data/oracle-catalog.json via tools/scan-spell-candidates.js -- same
  // real-Scryfall-text verification as the CARD_ABILITIES/ACTIVATED_ABILITIES batches. Every entry's
  // whole oracle text (not just one line -- a spell resolves atomically) matched one of a small set
  // of simple, single-clause shapes; targetKind steers resolveChosenTarget's validation.
  "lich's caress": { label: "Lich's Caress — destroy target creature, gain 3 life", effects: [{ type: "destroyTarget" }, { type: "gainLife", target: "controller", amount: 3 }], requiresTarget: true, targetKind: "creature" },
  "drag under": { label: "Drag Under — bounce target creature, draw a card", effects: [{ type: "bounceTargetToHand" }, { type: "drawCards", amount: 1 }], requiresTarget: true, targetKind: "creature" },
  "hero's downfall": { label: "Hero's Downfall — destroy target creature", effects: [{ type: "destroyTarget" }], requiresTarget: true, targetKind: "creature" },
  "breath of fire": { label: "Breath of Fire — deal 2 damage", effects: [{ type: "damageTarget", amount: 2 }], requiresTarget: true, targetKind: "creature" },
  "repulsor rays": { label: "Repulsor Rays — deal 3 damage", effects: [{ type: "damageTarget", amount: 3 }], requiresTarget: true, targetKind: "creature" },
  "resupply": { label: "Resupply — gain 6 life, draw a card", effects: [{ type: "gainLife", target: "controller", amount: 6 }, { type: "drawCards", amount: 1 }] },
  "absorb": { label: "Absorb — counter target spell, gain 3 life", effects: [{ type: "counterTargetSpell" }, { type: "gainLife", target: "controller", amount: 3 }], requiresTarget: true, targetKind: "spell" },
  "chaplain's blessing": { label: "Chaplain's Blessing — gain 5 life", effects: [{ type: "gainLife", target: "controller", amount: 5 }] },
  "final death": { label: "Final Death — exile target creature", effects: [{ type: "exileTarget" }], requiresTarget: true, targetKind: "creature" },
  "command the storm": { label: "Command the Storm — deal 5 damage", effects: [{ type: "damageTarget", amount: 5 }], requiresTarget: true, targetKind: "creature" },
  "ember shot": { label: "Ember Shot — deal 3 damage, draw a card", effects: [{ type: "damageTarget", amount: 3 }, { type: "drawCards", amount: 1 }], requiresTarget: true, targetKind: "any" },
  "strangle": { label: "Strangle — deal 3 damage", effects: [{ type: "damageTarget", amount: 3 }], requiresTarget: true, targetKind: "any" },
  "playful shove": { label: "Playful Shove — deal 1 damage, draw a card", effects: [{ type: "damageTarget", amount: 1 }, { type: "drawCards", amount: 1 }], requiresTarget: true, targetKind: "any" },
  "sear": { label: "Sear — deal 4 damage", effects: [{ type: "damageTarget", amount: 4 }], requiresTarget: true, targetKind: "any" },
  "hornet sting": { label: "Hornet Sting — deal 1 damage", effects: [{ type: "damageTarget", amount: 1 }], requiresTarget: true, targetKind: "any" },
  "divination": { label: "Divination — draw 2 cards", effects: [{ type: "drawCards", amount: 2 }] },
  "engulfing eruption": { label: "Engulfing Eruption — deal 5 damage", effects: [{ type: "damageTarget", amount: 5 }], requiresTarget: true, targetKind: "creature" },
  "lava spike": { label: "Lava Spike — deal 3 damage", effects: [{ type: "damageTarget", amount: 3 }], requiresTarget: true, targetKind: "player" },
  "concentrated fire": { label: "Concentrated Fire — deal 5 damage", effects: [{ type: "damageTarget", amount: 5 }], requiresTarget: true, targetKind: "creature" },
  "sacred nectar": { label: "Sacred Nectar — gain 4 life", effects: [{ type: "gainLife", target: "controller", amount: 4 }] },
  "lava axe": { label: "Lava Axe — deal 5 damage", effects: [{ type: "damageTarget", amount: 5 }], requiresTarget: true, targetKind: "player" },
  "vraska's contempt": { label: "Vraska's Contempt — exile target creature, gain 2 life", effects: [{ type: "exileTarget" }, { type: "gainLife", target: "controller", amount: 2 }], requiresTarget: true, targetKind: "creature" },
  "finishing blow": { label: "Finishing Blow — destroy target creature", effects: [{ type: "destroyTarget" }], requiresTarget: true, targetKind: "creature" },
  "lightning bolt": { label: "Lightning Bolt — deal 3 damage", effects: [{ type: "damageTarget", amount: 3 }], requiresTarget: true, targetKind: "any" },
  "cleansing screech": { label: "Cleansing Screech — deal 4 damage", effects: [{ type: "damageTarget", amount: 4 }], requiresTarget: true, targetKind: "any" },
  "bilbo's deadly slice": { label: "Bilbo's Deadly Slice — destroy target creature", effects: [{ type: "destroyTarget" }], requiresTarget: true, targetKind: "creature" },
  "fire ambush": { label: "Fire Ambush — deal 3 damage", effects: [{ type: "damageTarget", amount: 3 }], requiresTarget: true, targetKind: "any" },
  "zap": { label: "Zap — deal 1 damage, draw a card", effects: [{ type: "damageTarget", amount: 1 }, { type: "drawCards", amount: 1 }], requiresTarget: true, targetKind: "any" },
  "flame javelin": { label: "Flame Javelin — deal 4 damage", effects: [{ type: "damageTarget", amount: 4 }], requiresTarget: true, targetKind: "any" },
  "dosan's oldest chant": { label: "Dosan's Oldest Chant — gain 6 life, draw a card", effects: [{ type: "gainLife", target: "controller", amount: 6 }, { type: "drawCards", amount: 1 }] },
  "fall of the gavel": { label: "Fall of the Gavel — counter target spell, gain 5 life", effects: [{ type: "counterTargetSpell" }, { type: "gainLife", target: "controller", amount: 5 }], requiresTarget: true, targetKind: "spell" },
  "dismiss": { label: "Dismiss — counter target spell, draw a card", effects: [{ type: "counterTargetSpell" }, { type: "drawCards", amount: 1 }], requiresTarget: true, targetKind: "spell" },
  "explosive impact": { label: "Explosive Impact — deal 5 damage", effects: [{ type: "damageTarget", amount: 5 }], requiresTarget: true, targetKind: "any" },
  "precision bolt": { label: "Precision Bolt — deal 3 damage", effects: [{ type: "damageTarget", amount: 3 }], requiresTarget: true, targetKind: "any" },
  "counsel of the soratami": { label: "Counsel of the Soratami — draw 2 cards", effects: [{ type: "drawCards", amount: 2 }] },
  "touch of brilliance": { label: "Touch of Brilliance — draw 2 cards", effects: [{ type: "drawCards", amount: 2 }] },
  "angel's mercy": { label: "Angel's Mercy — gain 7 life", effects: [{ type: "gainLife", target: "controller", amount: 7 }] },
  "repulse": { label: "Repulse — bounce target creature, draw a card", effects: [{ type: "bounceTargetToHand" }, { type: "drawCards", amount: 1 }], requiresTarget: true, targetKind: "creature" },
  "spring of eternal peace": { label: "Spring of Eternal Peace — gain 8 life", effects: [{ type: "gainLife", target: "controller", amount: 8 }] },
  "fugue": { label: "Fugue — target player discards 3", effects: [{ type: "targetPlayerDiscards", amount: 3 }], requiresTarget: true, targetKind: "player" },
  "tidings": { label: "Tidings — draw 4 cards", effects: [{ type: "drawCards", amount: 4 }] },
  "bathe in dragonfire": { label: "Bathe in Dragonfire — deal 4 damage", effects: [{ type: "damageTarget", amount: 4 }], requiresTarget: true, targetKind: "creature" },
  "sarkhan's catharsis": { label: "Sarkhan's Catharsis — deal 5 damage", effects: [{ type: "damageTarget", amount: 5 }], requiresTarget: true, targetKind: "player" },
  "quick study": { label: "Quick Study — draw 2 cards", effects: [{ type: "drawCards", amount: 2 }] },
  "ritual of rejuvenation": { label: "Ritual of Rejuvenation — gain 4 life, draw a card", effects: [{ type: "gainLife", target: "controller", amount: 4 }, { type: "drawCards", amount: 1 }] },
  "cancel": { label: "Cancel — counter target spell", effects: [{ type: "counterTargetSpell" }], requiresTarget: true, targetKind: "spell" },
  "harmonize": { label: "Harmonize — draw 3 cards", effects: [{ type: "drawCards", amount: 3 }] },
  "unsummon": { label: "Unsummon — bounce target creature", effects: [{ type: "bounceTargetToHand" }], requiresTarget: true, targetKind: "creature" },
  "open fire": { label: "Open Fire — deal 3 damage", effects: [{ type: "damageTarget", amount: 3 }], requiresTarget: true, targetKind: "any" },
  "flame slash": { label: "Flame Slash — deal 4 damage", effects: [{ type: "damageTarget", amount: 4 }], requiresTarget: true, targetKind: "creature" },
  "fell": { label: "Fell — destroy target creature", effects: [{ type: "destroyTarget" }], requiresTarget: true, targetKind: "creature" },
  "zuko's offense": { label: "Zuko's Offense — deal 2 damage", effects: [{ type: "damageTarget", amount: 2 }], requiresTarget: true, targetKind: "any" },
  "winter's intervention": { label: "Winter's Intervention — deal 2 damage, gain 2 life", effects: [{ type: "damageTarget", amount: 2 }, { type: "gainLife", target: "controller", amount: 2 }], requiresTarget: true, targetKind: "creature" },
  "ragefire": { label: "Ragefire — deal 3 damage", effects: [{ type: "damageTarget", amount: 3 }], requiresTarget: true, targetKind: "creature" },
  "lightning blast": { label: "Lightning Blast — deal 4 damage", effects: [{ type: "damageTarget", amount: 4 }], requiresTarget: true, targetKind: "any" },
  "scorching spear": { label: "Scorching Spear — deal 1 damage", effects: [{ type: "damageTarget", amount: 1 }], requiresTarget: true, targetKind: "any" },
  "murder": { label: "Murder — destroy target creature", effects: [{ type: "destroyTarget" }], requiresTarget: true, targetKind: "creature" },
  // Real text: "Exile target creature. Its controller may search their library for a basic land
  // card, put that card onto the battlefield tapped, then shuffle." The optional land-search isn't
  // modeled -- same "may" abilities aren't automated precedent used everywhere else in this app.
  "path to exile": { label: "Path to Exile — exile target creature", effects: [{ type: "exileTarget" }], requiresTarget: true, targetKind: "creature" },
  "swords to plowshares": { label: "Swords to Plowshares — exile target creature", effects: [{ type: "exileTargetGainLifeEqualToPower" }], requiresTarget: true, targetKind: "creature" },
  // No target -- the library search prompt (EFFECTS.tutorToHand) fires the instant this resolves.
  "demonic tutor": { label: "Demonic Tutor — search for a card", effects: [{ type: "tutorToHand" }] },
  "grim tutor": { label: "Grim Tutor — search for a card, lose 3 life", effects: [{ type: "tutorToHand", lifeLoss: 3 }] },
  // Real text also lets Delirium (4+ card types in your graveyard) upgrade this to "search for ANY
  // card" -- not modeled (this app doesn't track graveyard card-type diversity anywhere), so this
  // always resolves as the base Demon-restricted search, a real but rare undercount.
  "demonic counsel": { label: "Demonic Counsel — search for a Demon card", effects: [{ type: "tutorToHand", typeFilter: "demon" }] },
  "dark ritual": { label: "Dark Ritual — Add {B}{B}{B}", effects: [{ type: "addFixedMana", colors: ["B", "B", "B"] }] },
  "sephiroth's intervention": { label: "Sephiroth's Intervention — destroy target creature, gain 2 life", effects: [{ type: "destroyTarget" }, { type: "gainLife", target: "controller", amount: 2 }], requiresTarget: true, targetKind: "creature" },
  "dark nourishment": { label: "Dark Nourishment — deal 3 damage, gain 3 life", effects: [{ type: "damageTarget", amount: 3 }, { type: "gainLife", target: "controller", amount: 3 }], requiresTarget: true, targetKind: "any" },
  "volcanic hammer": { label: "Volcanic Hammer — deal 3 damage", effects: [{ type: "damageTarget", amount: 3 }], requiresTarget: true, targetKind: "any" },
  "gut shot": { label: "Gut Shot — deal 1 damage", effects: [{ type: "damageTarget", amount: 1 }], requiresTarget: true, targetKind: "any" },
  "nourish": { label: "Nourish — gain 6 life", effects: [{ type: "gainLife", target: "controller", amount: 6 }] },
  "drown in shapelessness": { label: "Drown in Shapelessness — bounce target creature", effects: [{ type: "bounceTargetToHand" }], requiresTarget: true, targetKind: "creature" },
  "concentrate": { label: "Concentrate — draw 3 cards", effects: [{ type: "drawCards", amount: 3 }] },
  "contradict": { label: "Contradict — counter target spell, draw a card", effects: [{ type: "counterTargetSpell" }, { type: "drawCards", amount: 1 }], requiresTarget: true, targetKind: "spell" },
  "unyaro bee sting": { label: "Unyaro Bee Sting — deal 2 damage", effects: [{ type: "damageTarget", amount: 2 }], requiresTarget: true, targetKind: "any" },
  "dramatic rescue": { label: "Dramatic Rescue — bounce target creature, gain 2 life", effects: [{ type: "bounceTargetToHand" }, { type: "gainLife", target: "controller", amount: 2 }], requiresTarget: true, targetKind: "creature" },
  "explosive shot": { label: "Explosive Shot — deal 4 damage", effects: [{ type: "damageTarget", amount: 4 }], requiresTarget: true, targetKind: "creature" },
  "shock": { label: "Shock — deal 2 damage", effects: [{ type: "damageTarget", amount: 2 }], requiresTarget: true, targetKind: "any" },
  "searing spear": { label: "Searing Spear — deal 3 damage", effects: [{ type: "damageTarget", amount: 3 }], requiresTarget: true, targetKind: "any" },
  "feed the serpent": { label: "Feed the Serpent — exile target creature", effects: [{ type: "exileTarget" }], requiresTarget: true, targetKind: "creature" },
  "mind rot": { label: "Mind Rot — target player discards 2", effects: [{ type: "targetPlayerDiscards", amount: 2 }], requiresTarget: true, targetKind: "player" },
  "reviving dose": { label: "Reviving Dose — gain 3 life, draw a card", effects: [{ type: "gainLife", target: "controller", amount: 3 }, { type: "drawCards", amount: 1 }] },
  "fiery finish": { label: "Fiery Finish — deal 7 damage", effects: [{ type: "damageTarget", amount: 7 }], requiresTarget: true, targetKind: "creature" },
  "revitalize": { label: "Revitalize — gain 3 life, draw a card", effects: [{ type: "gainLife", target: "controller", amount: 3 }, { type: "drawCards", amount: 1 }] },
  "wander off": { label: "Wander Off — exile target creature", effects: [{ type: "exileTarget" }], requiresTarget: true, targetKind: "creature" },
  "searing wind": { label: "Searing Wind — deal 10 damage", effects: [{ type: "damageTarget", amount: 10 }], requiresTarget: true, targetKind: "any" },
  "three tragedies": { label: "Three Tragedies — target player discards 3", effects: [{ type: "targetPlayerDiscards", amount: 3 }], requiresTarget: true, targetKind: "player" },
  "thundering rebuke": { label: "Thundering Rebuke — deal 4 damage", effects: [{ type: "damageTarget", amount: 4 }], requiresTarget: true, targetKind: "any" },
  "bombard": { label: "Bombard — deal 4 damage", effects: [{ type: "damageTarget", amount: 4 }], requiresTarget: true, targetKind: "creature" },
  "eviscerate": { label: "Eviscerate — destroy target creature", effects: [{ type: "destroyTarget" }], requiresTarget: true, targetKind: "creature" },
  "symbol of unsummoning": { label: "Symbol of Unsummoning — bounce target creature, draw a card", effects: [{ type: "bounceTargetToHand" }, { type: "drawCards", amount: 1 }], requiresTarget: true, targetKind: "creature" },
  "unmake": { label: "Unmake — exile target creature", effects: [{ type: "exileTarget" }], requiresTarget: true, targetKind: "creature" },
  "flame lash": { label: "Flame Lash — deal 4 damage", effects: [{ type: "damageTarget", amount: 4 }], requiresTarget: true, targetKind: "any" },
  "cinder storm": { label: "Cinder Storm — deal 7 damage", effects: [{ type: "damageTarget", amount: 7 }], requiresTarget: true, targetKind: "any" },
  "reach through mists": { label: "Reach Through Mists — draw a card", effects: [{ type: "drawCards", amount: 1 }] },
  "unhinge": { label: "Unhinge — target player discards 1, draw a card", effects: [{ type: "targetPlayerDiscards", amount: 1 }, { type: "drawCards", amount: 1 }], requiresTarget: true, targetKind: "player" },
  "counterspell": { label: "Counterspell — counter target spell", effects: [{ type: "counterTargetSpell" }], requiresTarget: true, targetKind: "spell" },
  "jace's ingenuity": { label: "Jace's Ingenuity — draw 3 cards", effects: [{ type: "drawCards", amount: 3 }] },
  "pressure point": { label: "Pressure Point — tap target creature, draw a card", effects: [{ type: "tapTarget" }, { type: "drawCards", amount: 1 }], requiresTarget: true, targetKind: "creature" },
  "dreadbore": { label: "Dreadbore — destroy target creature", effects: [{ type: "destroyTarget" }], requiresTarget: true, targetKind: "creature" },
  "brilliant plan": { label: "Brilliant Plan — draw 3 cards", effects: [{ type: "drawCards", amount: 3 }] },
  "electrify": { label: "Electrify — deal 4 damage", effects: [{ type: "damageTarget", amount: 4 }], requiresTarget: true, targetKind: "creature" },
  "impale": { label: "Impale — destroy target creature", effects: [{ type: "destroyTarget" }], requiresTarget: true, targetKind: "creature" },
  "whitesun's passage": { label: "Whitesun's Passage — gain 5 life", effects: [{ type: "gainLife", target: "controller", amount: 5 }] },
  "scorching shot": { label: "Scorching Shot — deal 5 damage", effects: [{ type: "damageTarget", amount: 5 }], requiresTarget: true, targetKind: "creature" },
  "final reward": { label: "Final Reward — exile target creature", effects: [{ type: "exileTarget" }], requiresTarget: true, targetKind: "creature" },
  "unfriendly fire": { label: "Unfriendly Fire — deal 4 damage", effects: [{ type: "damageTarget", amount: 4 }], requiresTarget: true, targetKind: "any" },
  "tarfire": { label: "Tarfire — deal 2 damage", effects: [{ type: "damageTarget", amount: 2 }], requiresTarget: true, targetKind: "any" },
  "lightning strike": { label: "Lightning Strike — deal 3 damage", effects: [{ type: "damageTarget", amount: 3 }], requiresTarget: true, targetKind: "any" },
  "waking nightmare": { label: "Waking Nightmare — target player discards 2", effects: [{ type: "targetPlayerDiscards", amount: 2 }], requiresTarget: true, targetKind: "player" },
  "bee sting": { label: "Bee Sting — deal 2 damage", effects: [{ type: "damageTarget", amount: 2 }], requiresTarget: true, targetKind: "any" },
  "weave fate": { label: "Weave Fate — draw 2 cards", effects: [{ type: "drawCards", amount: 2 }] },
  // Modal spells ("Choose one —") -- see castSpell's `spellAbility.modes` branch for the actual
  // mechanism (mode picked first via the pendingTargetChoices queue, THEN a real target choice if
  // that mode needs one). Rip Apart's first mode is narrowed to "target creature" only (real text
  // also allows planeswalkers -- no "creature or planeswalker" targetKind exists, same "approximate
  // the common case" precedent as targetKind:"any" already does for player/creature/planeswalker).
  "rip apart": { label: "Rip Apart — choose one", modes: [
    { label: "Rip Apart — deal 3 damage to target creature", requiresTarget: true, targetKind: "creature", effects: [{ type: "damageTarget", amount: 3 }] },
    { label: "Rip Apart — destroy target artifact or enchantment", requiresTarget: true, targetKind: "artifact", effects: [{ type: "destroyTarget" }] }
  ] },
  "rakdos charm": { label: "Rakdos Charm — choose one", modes: [
    { label: "Rakdos Charm — exile target player's graveyard", requiresTarget: true, targetKind: "player", effects: [{ type: "exilePlayerGraveyard" }] },
    { label: "Rakdos Charm — destroy target artifact", requiresTarget: true, targetKind: "artifact", effects: [{ type: "destroyTarget" }] },
    { label: "Rakdos Charm — each creature deals 1 damage to its controller", requiresTarget: false, effects: [{ type: "eachCreatureDamagesController", amount: 1 }] }
  ] },
  // targetKind:"permanent" -- creature or artifact zoneType (which already covers artifacts,
  // enchantments, AND planeswalkers, since classifyType folds all three into "artifact" -- see its
  // own comment), plus minCmc for Despark's real "mana value 4 or greater" restriction. A generic
  // addition, not a one-off: any future "destroy/exile target permanent [with condition]" card can
  // reuse this same targetKind.
  "despark": { label: "Despark — destroy target permanent with mana value 4 or greater", effects: [{ type: "destroyTarget" }], requiresTarget: true, targetKind: "permanent", minCmc: 4 },
  "chaos warp": { label: "Chaos Warp — shuffle target permanent into its owner's library, they reveal the top card and may put a permanent onto the battlefield", effects: [{ type: "chaosWarpTarget" }], requiresTarget: true, targetKind: "permanent" },
  // Kicker isn't a general mechanism this app has -- modeled as an ordinary modal choice (reusing
  // the exact same "choose one" engine Rip Apart/Rakdos Charm already use) between the unkicked and
  // kicked effect, rather than a real optional-additional-cost prompt at cast time. The kicker's
  // extra {W} isn't automatically charged -- a disclosed simplification, same precedent as every
  // other narrowed cost/choice in this app.
  "orim's chant": { label: "Orim's Chant — choose one", modes: [
    { label: "Orim's Chant — target player can't cast spells this turn", requiresTarget: true, targetKind: "player", effects: [{ type: "restrictCantCastSpells" }] },
    { label: "Orim's Chant, kicked (pay {W} more) — target player can't cast spells, and creatures can't attack, this turn", requiresTarget: true, targetKind: "player", effects: [{ type: "restrictCantCastSpells" }, { type: "restrictCreaturesCantAttack" }] }
  ] },
  // "Until your next turn, your life total can't change and you gain protection from everything.
  // All permanents you control phase out. Exile Teferi's Protection." The card exiles ITSELF as
  // part of resolving, instead of going to the graveyard like every other instant/sorcery --
  // exileInsteadOfGraveyard (read by resolveStackTop) is the one flag needed for that, reusable by
  // any future self-exiling spell.
  "teferi's protection": { label: "Teferi's Protection — life total can't change, protection from everything, phase out all your permanents until your next turn", effects: [{ type: "teferisProtection" }], exileInsteadOfGraveyard: true },
  // "The next time a source of your choice would deal damage to you this turn, prevent that
  // damage. If damage is prevented this way, Deflecting Palm deals that much damage to that
  // source's controller." Real oracle text has no "target" keyword at all -- it's a CHOICE, not a
  // target, so Hexproof/Shroud/Protection shouldn't actually stop it from being chosen. This app's
  // target-choice engine has no separate "choice, not target" concept, so it's modeled as an
  // ordinary "target creature" choice (the overwhelmingly common real use case -- punching back an
  // attacking creature) -- a disclosed, narrow inaccuracy shared with every other "choice" this app
  // has ever represented as a target. See applyLifeLoss for where the actual redirect happens.
  "deflecting palm": { label: "Deflecting Palm — the next time target creature would deal you damage this turn, prevent it and deal that much to its controller instead", effects: [{ type: "deflectingPalm" }], requiresTarget: true, targetKind: "creature" },
  // Batch added from a live-decklist gap-analysis pass (exported real decks cross-referenced
  // against what's already automated) -- every entry below maps directly onto an existing (or, for
  // a few shared shapes, a small new) EFFECTS function; oracle text confirmed against each card's
  // own real Scryfall-derived text captured in this app's card archive. Modal ("Choose one/two —")
  // spells, Overload/alternate-cost effects, and a handful of genuinely bespoke mechanics were left
  // out of this pass -- see the "not automated yet" note in this codebase's own memory for the full
  // list and why.
  "negate": { label: "Negate — counter target spell", effects: [{ type: "counterTargetSpell" }], requiresTarget: true, targetKind: "spell" },
  "rampant growth": { label: "Rampant Growth — search for a basic land, tapped", effects: [{ type: "searchLandTypes", types: ["Plains", "Island", "Swamp", "Mountain", "Forest"], basicOnly: true, entersTapped: true }] },
  // "Search for up to two basic lands, put ONE onto the battlefield tapped and the OTHER into your
  // hand" -- two sequential fetch prompts (this one, then a second one via thenEffects once the
  // first is actually done). Declining the first prompt skips the second entirely, same "search is
  // always optional" simplification real Magic's own "up to two" wording already implies for zero.
  "cultivate": { label: "Cultivate — search for a basic land tapped, then another to hand", effects: [{ type: "searchLandTypes", types: ["Plains", "Island", "Swamp", "Mountain", "Forest"], basicOnly: true, entersTapped: true, thenEffects: [{ type: "tutorToHand", typeFilter: "basic land" }] }] },
  "wheel of fortune": { label: "Wheel of Fortune — each player discards their hand, then draws seven", effects: [{ type: "wheelEffect", amount: 7 }] },
  "windfall": { label: "Windfall — each player discards their hand, then draws cards equal to the most any player discarded", effects: [{ type: "wheelEffect", matchGreatestDiscard: true }] },
  "farseek": { label: "Farseek — search for a Plains, Island, Swamp, or Mountain, tapped", effects: [{ type: "searchLandTypes", types: ["Plains", "Island", "Swamp", "Mountain"], entersTapped: true }] },
  "anguished unmaking": { label: "Anguished Unmaking — exile target nonland permanent, lose 3 life", effects: [{ type: "exileTarget" }, { type: "loseLife", target: "controller", amount: 3 }], requiresTarget: true, targetKind: "permanent" },
  "vandalblast": { label: "Vandalblast — destroy target artifact", effects: [{ type: "destroyTarget" }], requiresTarget: true, targetKind: "artifact" },
  "damn": { label: "Damn — destroy target creature", effects: [{ type: "destroyTarget" }], requiresTarget: true, targetKind: "creature" },
  "cyclonic rift": { label: "Cyclonic Rift — return target nonland permanent to its owner's hand", effects: [{ type: "bounceTargetToHand" }], requiresTarget: true, targetKind: "permanent" },
  "beast within": { label: "Beast Within — destroy target permanent, its controller gets a 3/3 Beast", effects: [{ type: "destroyTargetCreateTokenForController", tokenName: "Beast", tokenType: "Token Creature — Beast", power: "3", toughness: "3", colors: ["G"] }], requiresTarget: true, targetKind: "permanent" },
  "generous gift": { label: "Generous Gift — destroy target permanent, its controller gets a 3/3 Elephant", effects: [{ type: "destroyTargetCreateTokenForController", tokenName: "Elephant", tokenType: "Token Creature — Elephant", power: "3", toughness: "3", colors: ["G"] }], requiresTarget: true, targetKind: "permanent" },
  "reanimate": { label: "Reanimate — put target creature card from a graveyard onto the battlefield, lose life equal to its mana value", effects: [{ type: "reanimateLoseLifeEqualToCmc" }], requiresTarget: true, targetKind: "anyGraveyardCreature" },
  "vampiric tutor": { label: "Vampiric Tutor — search your library for a card, put it on top, lose 2 life", effects: [{ type: "tutorToHand", toTopOfLibrary: true, lifeLoss: 2 }] },
  // Wave 18 -- "As an additional cost to cast this spell, sacrifice a land/creature." The first two
  // cards needing a real additional cost to cast (see attemptPlay's new addlCost handling, the
  // single choke point both playCard and changeZone's hand-cast branch already share) -- everything
  // past the cost itself reuses existing effects verbatim (searchLandTypes/tutorToHand).
  "crop rotation": { label: "Crop Rotation — sacrifice a land, search for a land, put it onto the battlefield", additionalCost: { sacrificeType: "land" }, effects: [{ type: "searchLandTypes", types: ["Land"] }] },
  "diabolic intent": { label: "Diabolic Intent — sacrifice a creature, search for a card, put it into your hand", additionalCost: { sacrificeType: "creature" }, effects: [{ type: "tutorToHand" }] },
  "brave the elements": { label: "Brave the Elements — choose a color", modes: ["White", "Blue", "Black", "Red", "Green"].map((color) => ({
    label: `Brave the Elements — white creatures you control gain protection from ${color} until end of turn`,
    requiresTarget: false,
    effects: [{ type: "grantProtectionToOwnColorCreatures", creatureColor: "W", quality: color.toLowerCase() }]
  })) },
  "distant melody": { label: "Distant Melody — choose a creature type, draw a card for each permanent you control of that type", requiresTarget: true, targetKind: "creatureType", effects: [{ type: "drawForPermanentsOfChosenType" }] },
  // Brokers Charm -- 2 of its real 3 modes. The dropped mode ("Target creature you control gets
  // +1/+0 until end of turn. It deals damage equal to its power to target creature or planeswalker
  // an opponent controls") needs TWO independently-typed targets (your own creature, then an
  // opponent's creature/planeswalker) in a single ability -- this engine's target-choice queue only
  // ever resolves one target per queued entry, so a genuinely two-target mode has no home here
  // without a new multi-target choice mechanism. Disclosed and skipped rather than half-modeled.
  "brokers charm": { label: "Brokers Charm — choose one", modes: [
    { label: "Brokers Charm — destroy target enchantment", requiresTarget: true, targetKind: "typeList", typeFilter: ["enchantment"], effects: [{ type: "destroyTarget" }] },
    { label: "Brokers Charm — draw two cards", requiresTarget: false, effects: [{ type: "drawCards", amount: 2 }] }
  ] },
  // Cycling {2} needs no table entry (already generic, see cyclingCostFromText).
  "clear": { label: "Clear — destroy target enchantment", effects: [{ type: "destroyTarget" }], requiresTarget: true, targetKind: "typeList", typeFilter: ["enchantment"] },
  "faithless looting": { label: "Faithless Looting — draw two cards, then discard two cards", effects: [{ type: "drawCards", amount: 2 }, { type: "targetPlayerDiscards", self: true, amount: 2 }] },
  // "Draw two cards, then discard two cards. Untap up to three lands." Same self-discard shape as
  // Faithless Looting above, plus EFFECTS.untapUpToNOwnLands (auto-picks the first N tapped lands --
  // see its own comment). The discard is a genuinely pending/async step (pendingDiscard), but
  // untapping lands has no real dependency on which cards end up discarded, so it's safe as a plain
  // sibling effect here rather than needing the thenEffects-bundling scryN/searchLandTypes require.
  "frantic search": { label: "Frantic Search — draw two, discard two, untap up to three lands", effects: [{ type: "drawCards", amount: 2 }, { type: "targetPlayerDiscards", self: true, amount: 2 }, { type: "untapUpToNOwnLands", amount: 3 }] },
  "doomskar": { label: "Doomskar — destroy all creatures", effects: [{ type: "destroyAllCreatures" }] },
  "time wipe": { label: "Time Wipe — return a creature you control to hand, then destroy all creatures", effects: [{ type: "bounceTargetToHand" }, { type: "destroyAllCreatures" }], requiresTarget: true, targetKind: "ownCreature" },
  "chain reaction": { label: "Chain Reaction — deals damage to each creature equal to the number of creatures on the battlefield", effects: [{ type: "damageAllCreaturesTable" }] },
  "blasphemous act": { label: "Blasphemous Act — deals damage to each creature equal to the number of creatures on the battlefield", effects: [{ type: "damageAllCreaturesTable" }] },
  "swan song": { label: "Swan Song — counter target enchantment, instant, or sorcery spell, its controller gets a 2/2 flying Bird", effects: [{ type: "counterTargetSpellCreateTokenForController", tokenName: "Bird", tokenType: "Token Creature — Bird", power: "2", toughness: "2", colors: ["U"], keywords: ["Flying"] }], requiresTarget: true, targetKind: "spell" },
  // Wave 11 gap-analysis batch.
  // "Counter target noncreature spell." Real card restricts to noncreature -- same disclosed
  // "target spell, no type check" simplification Swan Song's own "enchantment, instant, or sorcery"
  // restriction already uses (this app doesn't validate a countered spell's own type against any
  // targetKind:"spell" entry). counterTargetSpellCreateTokenForController's new params.amount (see
  // its own comment) makes the token count a one-line change from Swan Song's shape.
  "an offer you can't refuse": { label: "An Offer You Can't Refuse — counter target spell, its controller creates two Treasure tokens", effects: [{ type: "counterTargetSpellCreateTokenForController", tokenName: "Treasure", tokenType: "Token Artifact — Treasure", img: "https://cards.scryfall.io/normal/front/6/8/68894c85-fb43-4c9a-9de3-2fa1c9c31543.jpg", amount: 2 }], requiresTarget: true, targetKind: "spell" },
  // "Counter target spell. Its controller may draw up to two cards at the beginning of the next
  // turn's upkeep. You draw a card at the beginning of the next turn's upkeep." See
  // EFFECTS.counterTargetSpellDelayedDraws for the "may... up to two" -> unconditional draw
  // simplification and the new queueDelayedTrigger(firesAtPhase:"Upkeep") usage.
  "arcane denial": { label: "Arcane Denial — counter target spell, both players draw at the next upkeep", effects: [{ type: "counterTargetSpellDelayedDraws" }], requiresTarget: true, targetKind: "spell" },
  // "Return target artifact or enchantment card from your graveyard to your hand." New
  // ownGraveyardTypeList targetKind (see resolveChosenTarget's own comment) plus a matching effect.
  "argivian find": { label: "Argivian Find — return target artifact or enchantment card from your graveyard to hand", effects: [{ type: "returnOwnGraveyardEntryToHand" }], requiresTarget: true, targetKind: "ownGraveyardTypeList", typeFilter: ["artifact", "enchantment"] },
  // "Destroy target nonland permanent. Proliferate." -- reuses the existing targetKind:"permanent"
  // (creature/artifact only, same disclosed nonland-permanent narrowing as Anguished Unmaking/
  // Cyclonic Rift's own entries) plus the new proliferateAll effect (see its own comment for what's
  // simplified -- affects every counter/poison on the table, not a real per-target choice).
  "atomize": { label: "Atomize — destroy target permanent, proliferate", effects: [{ type: "destroyTarget" }, { type: "proliferateAll" }], requiresTarget: true, targetKind: "permanent" },
  // "Add {R} for each creature you control."
  "battle hymn": { label: "Battle Hymn — Add {R} for each creature you control", effects: [{ type: "addManaEqualToCreatureCount", color: "R" }] },
  // "Search your library for up to three creature cards, put them into your graveyard, then
  // shuffle." Three REAL, interactive searches (not an auto-pick -- which three creatures matters a
  // lot for a reanimator deck) chained via thenEffects, same nested shape Myriad Landscape already
  // established for its own "up to two" fetch. Cancelling any of the three stops the chain early,
  // matching "up to three" rather than forcing all of them.
  "buried alive": { label: "Buried Alive — search for up to three creature cards, put them into your graveyard", effects: [{ type: "tutorToHand", toGraveyard: true, typeFilter: "creature", thenEffects: [{ type: "tutorToHand", toGraveyard: true, typeFilter: "creature", thenEffects: [{ type: "tutorToHand", toGraveyard: true, typeFilter: "creature" }] }] }] },
  // "Each player exiles all creature cards from their graveyard, then sacrifices all creatures they
  // control, then puts all cards they exiled this way onto the battlefield." No targeting -- see
  // EFFECTS.livingDeathAll's own comment for the exact ordering this follows.
  "living death": { label: "Living Death — each player reanimates their graveyard creatures after sacrificing their board", effects: [{ type: "livingDeathAll" }] },
  // "Choose two target creature cards in your graveyard. Sacrifice a creature. If you do, return the
  // chosen cards to the battlefield tapped." Two sequential graveyard target choices (chained via
  // victimizeChooseSecond, carrying the first pick's id forward as a plain extra field) followed by
  // the actual sacrifice+reanimate -- see victimizeSacrificeAndReanimateBoth's own comment for the
  // auto-picked sacrifice.
  "victimize": { label: "Victimize — choose two creature cards in your graveyard, sacrifice a creature, return both tapped", effects: [{ type: "victimizeChooseSecond" }], requiresTarget: true, targetKind: "ownGraveyardCreature" },
  // Real modal spells, using the SAME `modes` mechanism Rip Apart/Rakdos Charm already established
  // above (mode picked via the pendingTargetChoices queue at cast time, then a real target choice
  // if that mode needs one) -- these aren't a new gap needing new infrastructure, just table entries
  // that hadn't been written yet. Austere Command's real "choose TWO" is narrowed to choose-one (this
  // engine's modal system only supports picking a single mode) -- a disclosed simplification, same
  // spirit as every other "the effect works, one rules nuance doesn't" narrowing in this file.
  "abrade": { label: "Abrade — choose one", modes: [
    { label: "Abrade — deal 3 damage to target creature", requiresTarget: true, targetKind: "creature", effects: [{ type: "damageTarget", amount: 3 }] },
    { label: "Abrade — destroy target artifact", requiresTarget: true, targetKind: "artifact", effects: [{ type: "destroyTarget" }] }
  ] },
  "cleansing nova": { label: "Cleansing Nova — choose one", modes: [
    { label: "Cleansing Nova — destroy all creatures", requiresTarget: false, effects: [{ type: "destroyAllCreatures" }] },
    { label: "Cleansing Nova — destroy all artifacts and enchantments", requiresTarget: false, effects: [{ type: "destroyAllMatching", typeIncludes: ["artifact", "enchantment"] }] }
  ] },
  "crux of fate": { label: "Crux of Fate — choose one", modes: [
    { label: "Crux of Fate — destroy all Dragon creatures", requiresTarget: false, effects: [{ type: "destroyAllMatching", zoneTypeFilter: "creature", typeIncludes: ["dragon"] }] },
    { label: "Crux of Fate — destroy all non-Dragon creatures", requiresTarget: false, effects: [{ type: "destroyAllMatching", zoneTypeFilter: "creature", typeExcludes: ["dragon"] }] }
  ] },
  "pick your poison": { label: "Pick Your Poison — choose one", modes: [
    { label: "Pick Your Poison — each opponent sacrifices an artifact", requiresTarget: false, effects: [{ type: "eachOpponentSacrifices", typeIncludes: ["artifact"] }] },
    { label: "Pick Your Poison — each opponent sacrifices an enchantment", requiresTarget: false, effects: [{ type: "eachOpponentSacrifices", typeIncludes: ["enchantment"] }] },
    { label: "Pick Your Poison — each opponent sacrifices a creature with flying", requiresTarget: false, effects: [{ type: "eachOpponentSacrifices", zoneTypeFilter: "creature", keywordIncludes: ["flying"] }] }
  ] },
  "austere command": { label: "Austere Command — choose one", modes: [
    { label: "Austere Command — destroy all artifacts", requiresTarget: false, effects: [{ type: "destroyAllMatching", typeIncludes: ["artifact"], typeExcludes: ["enchantment"] }] },
    { label: "Austere Command — destroy all enchantments", requiresTarget: false, effects: [{ type: "destroyAllMatching", typeIncludes: ["enchantment"] }] },
    { label: "Austere Command — destroy all creatures with mana value 3 or less", requiresTarget: false, effects: [{ type: "destroyAllMatching", zoneTypeFilter: "creature", cmcMax: 3 }] },
    { label: "Austere Command — destroy all creatures with mana value 4 or greater", requiresTarget: false, effects: [{ type: "destroyAllMatching", zoneTypeFilter: "creature", cmcMin: 4 }] }
  ] },
  // Preordain's "Scry 2, then draw a card" is a direct match for scryN + drawCards. Ponder's real
  // text ("look at the top three, put them back in any order, you may shuffle instead") has no
  // "bottom" option and an optional shuffle rather than scry's send-to-bottom -- approximated with
  // the same scryN(3) prompt (reorder by keeping all 3 on top in the chosen order; sending some/all
  // to the bottom approximates "shuffle" well enough) -- a disclosed simplification, not an exact
  // match to Ponder's own wording.
  "preordain": { label: "Preordain — scry 2, then draw a card", effects: [{ type: "scryN", amount: 2, thenEffects: [{ type: "drawCards", amount: 1 }] }] },
  "ponder": { label: "Ponder — look at the top 3, reorder or send some to the bottom, then draw a card", effects: [{ type: "scryN", amount: 3, thenEffects: [{ type: "drawCards", amount: 1 }] }] },
  // Wave 20 -- the draw needs to see the POST-scry library order, so it's bundled into scryN's
  // own thenEffects (see scryN's comment for why a flat sibling would draw against the stale
  // pre-reorder library) -- same shape as Preordain/Ponder just above.
  "opt": { label: "Opt — scry 1, then draw a card", effects: [{ type: "scryN", amount: 1, thenEffects: [{ type: "drawCards", amount: 1 }] }] },
  "consider": { label: "Consider — surveil 1, then draw a card", effects: [{ type: "surveilN", amount: 1, thenEffects: [{ type: "drawCards", amount: 1 }] }] },
  // Serum Visions draws BEFORE scrying (opposite order from Opt/Preordain) -- the draw doesn't
  // depend on the reorder here, so a flat sibling is correct, not thenEffects.
  "serum visions": { label: "Serum Visions — draw a card, then scry 2", effects: [{ type: "drawCards", amount: 1 }, { type: "scryN", amount: 2 }] },
  "read the bones": { label: "Read the Bones — scry 2, then draw two cards, lose 2 life", effects: [{ type: "scryN", amount: 2, thenEffects: [{ type: "drawCards", amount: 2 }] }, { type: "loseLife", target: "controller", amount: 2 }] },
  // Wave 13 gap-analysis batch.
  // "Destroy target tapped creature. You gain 1 life for each creature you control with flying."
  // New "tappedCreature" targetKind (see index.html's targetKindMatchesCard) -- the first card in
  // this app needing a target restricted by its CURRENT tapped state rather than its type/ownership.
  "aerial assault": { label: "Aerial Assault — destroy target tapped creature, gain 1 life per creature you control with flying", effects: [{ type: "destroyTargetGainLifePerFlying" }], requiresTarget: true, targetKind: "tappedCreature" },
  // Real modal spell, same "choose one" mechanism as Abrade/Rakdos Charm above. Its indestructible
  // and double-strike modes both reuse grantTemporaryKeyword (see its own comment) -- a real "until
  // end of turn" grant, not the permanent-grant simplification older cards in this file used before
  // that mechanism existed. New "playerOrPlaneswalker" targetKind (see index.html's
  // targetKindMatchesCard) for the burn mode -- EFFECTS.damageTarget already handles a player id or
  // a card id generically, so no new effect logic was needed there, only client-side legality.
  "boros charm": { label: "Boros Charm — choose one", modes: [
    { label: "Boros Charm — deal 4 damage to target player or planeswalker", requiresTarget: true, targetKind: "playerOrPlaneswalker", effects: [{ type: "damageTarget", amount: 4 }] },
    { label: "Boros Charm — permanents you control gain indestructible until end of turn", requiresTarget: false, effects: [{ type: "grantIndestructibleToAllYours" }] },
    { label: "Boros Charm — target creature gains double strike until end of turn", requiresTarget: true, targetKind: "creature", effects: [{ type: "grantTemporaryKeywordToTarget", keyword: "Double strike" }] }
  ] },
  // Wave 14 gap-analysis batch. "You may choose both if you control a commander" isn't modeled --
  // see grantTemporaryKeywordsToAllYours's own comment.
  "akroma's will": { label: "Akroma's Will — choose one", modes: [
    { label: "Akroma's Will — creatures you control gain flying, vigilance, and double strike until end of turn", requiresTarget: false, effects: [{ type: "grantTemporaryKeywordsToAllYours", keywords: ["Flying", "Vigilance", "Double strike"] }] },
    { label: "Akroma's Will — creatures you control gain lifelink, indestructible, and protection until end of turn", requiresTarget: false, effects: [{ type: "grantTemporaryKeywordsToAllYours", keywords: ["Lifelink", "Indestructible", "Protection"] }] }
  ] },
  // Wave 15 gap-analysis batch.
  "day of judgment": { label: "Day of Judgment — destroy all creatures", effects: [{ type: "destroyAllCreatures" }] },
  "damnation": { label: "Damnation — destroy all creatures, they can't be regenerated", effects: [{ type: "destroyAllCreatures", noRegen: true }] },
  // The optional "pay {2} more to cast as though it had flash" alternative cost is a real,
  // disclosed narrowing left unmodeled (same as elsewhere in this file) -- the core wipe is
  // identical to Damnation's own entry above, just cast at normal sorcery speed.
  "rout": { label: "Rout — destroy all creatures, they can't be regenerated", effects: [{ type: "destroyAllCreatures", noRegen: true }] },
  "depopulate": { label: "Depopulate — each player with a multicolored creature draws a card, then destroy all creatures", effects: [{ type: "drawForMulticoloredControllersThenDestroyAllCreatures" }] },
  "end hostilities": { label: "End Hostilities — destroy all creatures and all permanents attached to creatures", effects: [{ type: "destroyAllCreaturesAndAttachments" }] },
  "dragon fodder": { label: "Dragon Fodder — create two Goblin tokens", effects: [{ type: "createToken", amount: 2, name: "Goblin", tokenType: "Token Creature — Goblin", power: "1", toughness: "1", colors: ["R"] }] },
  // Storm isn't modeled (no spell-cast-count-this-turn tracking anywhere in this engine) -- the base
  // "create two Goblins" half works unconditionally, a disclosed narrower simplification.
  "empty the warrens": { label: "Empty the Warrens — create two Goblin tokens", effects: [{ type: "createToken", amount: 2, name: "Goblin", tokenType: "Token Creature — Goblin", power: "1", toughness: "1", colors: ["R"] }] },
  "cut a deal": { label: "Cut a Deal — each opponent draws a card, then you draw a card for each that did", effects: [{ type: "cutADealDraws" }] },
  // Wave 17 gap-analysis batch.
  "krenko's command": { label: "Krenko's Command — create two Goblin tokens", effects: [{ type: "createToken", amount: 2, name: "Goblin", tokenType: "Token Creature — Goblin", power: "1", toughness: "1", colors: ["R"] }] },
  "goblin rally": { label: "Goblin Rally — create four Goblin tokens", effects: [{ type: "createToken", amount: 4, name: "Goblin", tokenType: "Token Creature — Goblin", power: "1", toughness: "1", colors: ["R"] }] },
  "hordeling outburst": { label: "Hordeling Outburst — create three Goblin tokens", effects: [{ type: "createToken", amount: 3, name: "Goblin", tokenType: "Token Creature — Goblin", power: "1", toughness: "1", colors: ["R"] }] },
  "hive stirrings": { label: "Hive Stirrings — create two Sliver tokens", effects: [{ type: "createToken", amount: 2, name: "Sliver", tokenType: "Token Creature — Sliver", power: "1", toughness: "1", colors: [] }] },
  // Identical shape to Cultivate (search two basics, one to battlefield tapped, the other to hand).
  "kodama's reach": { label: "Kodama's Reach — search for a basic land tapped, then another to hand", effects: [{ type: "searchLandTypes", types: ["Plains", "Island", "Swamp", "Mountain", "Forest"], basicOnly: true, entersTapped: true, thenEffects: [{ type: "tutorToHand", typeFilter: "basic land" }] }] },
  // "Look at target player's hand" isn't modeled -- no "temporarily reveal a hand to one viewer" UI
  // exists anywhere in this engine, a disclosed narrowing; the draw half is unconditional and real.
  "gitaxian probe": { label: "Gitaxian Probe — draw a card", effects: [{ type: "drawCards", amount: 1 }] },
  // Reuses grantIndestructibleToAllYours' newly-generalized keywords param (see its own comment) --
  // already permanent-wide, not creature-restricted, so no other change was needed for this card.
  "heroic intervention": { label: "Heroic Intervention — permanents you control gain hexproof and indestructible until end of turn", effects: [{ type: "grantIndestructibleToAllYours", keywords: ["Hexproof", "Indestructible"] }] }
};
function getSpellAbility(cardName) {
  return SPELL_ABILITIES[archiveKey(cardName)] || null;
}
// Alternative costs for casting FROM HAND ("you may pay X rather than pay this spell's mana
// cost") -- a genuinely different shape from SPELL_ABILITIES (which is about what a spell DOES
// once cast, not how it's paid for). Scoped to the one real pattern this deck needed: a flat mana
// amount plus tapping N untapped creatures matching a keyword. Which specific creatures get tapped
// isn't a real choice worth prompting for (they're interchangeable as a cost) -- the server just
// tapstype the first N that qualify, a disclosed simplification. See castWithAltCost.
const ALT_COSTS = {
  "sephara, sky's blade": { label: "Sephara, Sky's Blade — pay {W} and tap four untapped creatures you control with flying, rather than pay its mana cost", mana: "{W}", tapCount: 4, tapKeyword: "flying" }
};
function getAltCost(cardName) {
  return ALT_COSTS[archiveKey(cardName)] || null;
}
// Cards whose real automation lives entirely in a dedicated function rather than any of the three
// main tables (fireBreathOfFuryTrigger, in this case) -- tracked here purely so the coverage
// indicator (getAllAutomatedCardNames/isCardAutomated) counts them; add to this list alongside any
// future card built the same way.
const DEDICATED_FUNCTION_CARDS = ["breath of fury", "vilis, broker of blood", "chrome mox", "mox diamond"];
// Union of every card name with SOME automation -- a trigger, an activated ability, a spell
// effect, OR one of the smaller "checked by name in a dedicated function, not a table" mechanisms
// this engine has grown (replacement effects, attack/cast restrictions, enters-tapped statics).
// Sent once at auth time (see authOk) so the client can compute "how much of this deck is
// automated" locally and instantly as a deck is built/imported, without a round trip per change.
// NOTE: mechanisms detected by TEXT PATTERN rather than by name (shocklands' pay-life choice,
// Command Tower-style commander-color-identity mana, Exotic Orchard-style opponent-land mana) are
// NOT included here -- there's no fixed name list to enumerate for those, so a deck's real
// automation coverage is always at least as high as this count suggests, never lower.
function getAllAutomatedCardNames() {
  return [...new Set([
    ...Object.keys(CARD_ABILITIES), ...Object.keys(ACTIVATED_ABILITIES), ...Object.keys(SPELL_ABILITIES),
    ...ENTERS_TAPPED_FOR_OPPONENTS, ...ATTACK_ALONE_CARDS, ...DAMAGE_DOUBLING_CARDS, ...SELF_DAMAGE_HALVING_CARDS,
    ...GRAVEYARD_REDIRECT_CREATURE_ONLY, ...GRAVEYARD_REDIRECT_ANY_CARD, ...Object.keys(ALT_COSTS), ...DEDICATED_FUNCTION_CARDS
  ])];
}
function isCardAutomated(cardName) {
  const key = archiveKey(cardName);
  return !!(CARD_ABILITIES[key] || ACTIVATED_ABILITIES[key] || SPELL_ABILITIES[key]
    || ENTERS_TAPPED_FOR_OPPONENTS.includes(key) || ATTACK_ALONE_CARDS.includes(key) || DAMAGE_DOUBLING_CARDS.includes(key) || SELF_DAMAGE_HALVING_CARDS.includes(key)
    || GRAVEYARD_REDIRECT_CREATURE_ONLY.includes(key) || GRAVEYARD_REDIRECT_ANY_CARD.includes(key) || ALT_COSTS[key] || DEDICATED_FUNCTION_CARDS.includes(key));
}

// Each effect handler runs as (lobby, ctx, params) where ctx = {controllerId, sourceCard}. No
// targeting exists in this vocabulary on purpose -- see the CARD_ABILITIES comment above.
function effectTargets(lobby, controllerId, target) {
  const ids = Object.keys(lobby.players);
  if (target === "eachOpponent") return ids.filter((id) => id !== controllerId);
  if (target === "eachPlayer") return ids;
  return [controllerId]; // "controller" (default)
}
const EFFECTS = {
  drawCards(lobby, ctx, params) { drawN(lobby, ctx.controllerId, params.amount || 1); },
  // Cephalid Coliseum -- "Target player draws three cards, then discards three cards." The
  // target-player counterpart to drawCards (which always draws for the controller), same
  // self/chosenTargetId convention targetPlayerDiscards already uses -- chosenTargetId is merged
  // into every effect in the array when a real target is chosen, so this and a following
  // targetPlayerDiscards entry naturally act on the same player.
  targetPlayerDraws(lobby, ctx, params) {
    const playerId = params.self ? ctx.controllerId : params.chosenTargetId;
    drawN(lobby, playerId, params.amount || 1);
  },
  // Temur Ascendancy -- "Whenever a creature you control with power 4 or greater enters, you may
  // draw a card." The auto-merged `amount` from fireGlobalOtherCreatureEtbTriggers (the entering
  // creature's own power) is read here purely as a THRESHOLD gate, never as the draw count itself
  // -- always draws exactly 1, same "amount means two different things to two different effects"
  // situation the amount-merge fix's own comment describes.
  drawCardIfEnteringPowerAtLeast(lobby, ctx, params) {
    if ((params.amount || 0) < (params.threshold || 0)) return;
    drawN(lobby, ctx.controllerId, 1);
  },
  eachPlayerDrawsCards(lobby, ctx, params) {
    Object.keys(lobby.players).forEach((id) => drawN(lobby, id, params.amount || 1));
  },
  // Geier Reach Sanitarium -- "each player draws a card, then discards a card." The existing
  // pendingDiscard mechanism is a single slot (one player's discard pending at a time -- see its own
  // comment), so queuing a real per-player choice for EVERY player here isn't a fit without turning
  // it into a genuine queue. Auto-discards the first card in each player's hand instead (which may
  // be the card they just drew) -- a disclosed simplification, same "auto-pick over new UI" precedent
  // as untapUpToNOwnLands/searchAllMatchingToTop above.
  eachPlayerDrawsThenAutoDiscards(lobby, ctx) {
    for (const id in lobby.players) {
      drawN(lobby, id, 1);
      const hand = Object.values(lobby.cards).filter((c) => c.owner === id && c.zoneType === "hand");
      if (hand.length) sendToGraveyardInternal(lobby, hand[0]);
    }
    broadcastPlayers(lobby);
  },
  // Wheel of Fortune / Windfall -- "each player discards their hand, then draws [N / cards equal to
  // the greatest number of cards a player discarded this way]." Snapshotted hand lists BEFORE
  // discarding anyone's (sendToGraveyardInternal deletes from lobby.cards as it goes, same
  // "snapshot with Object.values() first" precedent as destroyAllLands above) -- a commander
  // sitting in hand correctly redirects to the Command Zone instead of the graveyard, same as any
  // other discard, since this reuses the exact same sendToGraveyardInternal every hand-discard site
  // already goes through.
  wheelEffect(lobby, ctx, params) {
    const discardCounts = {};
    for (const pid in lobby.players) {
      const handCards = Object.values(lobby.cards).filter((c) => c.owner === pid && c.zoneType === "hand");
      discardCounts[pid] = handCards.length;
      handCards.forEach((c) => sendToGraveyardInternal(lobby, c));
    }
    const drawAmount = params.matchGreatestDiscard ? Math.max(0, ...Object.values(discardCounts)) : (params.amount || 7);
    for (const pid in lobby.players) drawN(lobby, pid, drawAmount);
    broadcastPlayers(lobby);
  },
  // Armageddon -- every land, everyone's, not just the caster's (real Magic has no "friendly fire"
  // exception here, and neither does this). Snapshotted via Object.values() before iterating since
  // sendToGraveyardInternal deletes from lobby.cards as it goes.
  destroyAllLands(lobby, ctx, params) {
    Object.values(lobby.cards).filter((c) => c.zoneType === "mana").forEach((card) => {
      fireDeathTriggers(lobby, card);
      sendToGraveyardInternal(lobby, card);
    });
  },
  gainLife(lobby, ctx, params) {
    effectTargets(lobby, ctx.controllerId, params.target).forEach((id) => applyLifeGain(lobby, id, params.amount || 0));
  },
  // Kardur, Doomscourge -- starts the "until your next turn" forced-attack duration for this
  // permanent's controller. The actual enforcement lives in declareAttackers (see
  // lobby.kardurForcedAttackControllers); this just begins the window.
  startKardurForcedAttack(lobby, ctx) {
    if (!lobby.kardurForcedAttackControllers) lobby.kardurForcedAttackControllers = [];
    if (!lobby.kardurForcedAttackControllers.includes(ctx.controllerId)) lobby.kardurForcedAttackControllers.push(ctx.controllerId);
  },
  // Archon of Cruelty -- "target opponent... loses 3 life," a real player TARGET (chosen via
  // requiresTarget/targetKind:"player" and baked into chosenTargetId), unlike every prior loseLife
  // user which only ever needed "you"/"each opponent" (no real choice). chosenTargetId takes
  // priority over the effectTargets() shortcut when present -- never set by any existing entry, so
  // this is purely additive.
  loseLife(lobby, ctx, params) {
    const sourceCardId = ctx.sourceCard && ctx.sourceCard.id;
    const targets = params.chosenTargetId ? [params.chosenTargetId] : effectTargets(lobby, ctx.controllerId, params.target);
    targets.forEach((id) => {
      if (applyLifeLoss(lobby, id, params.amount || 0, sourceCardId)) {
        io.to(lobby.id).emit("spellDamage", { targetId: id, amount: params.amount || 0, sourceCardId });
      }
    });
  },
  // Gray Merchant of Asphodel -- "each opponent loses X life, where X is your devotion to black.
  // You gain life equal to the life lost this way." The gain is the SUM of what opponents actually
  // lost (via applyLifeLoss's own lifeLocked/Deflecting-Palm-aware return value), not just X flat,
  // matching the real card's "equal to the life lost this way" wording exactly.
  drainForDevotion(lobby, ctx, params) {
    const amount = devotionToColor(lobby, ctx.controllerId, params.color || "B");
    if (amount <= 0) return;
    let totalLost = 0;
    Object.keys(lobby.players).forEach((id) => {
      if (id === ctx.controllerId) return;
      if (applyLifeLoss(lobby, id, amount)) totalLost += amount;
    });
    if (totalLost > 0) applyLifeGain(lobby, ctx.controllerId, totalLost);
    broadcastPlayers(lobby);
  },
  // Teferi's Protection -- "until your next turn, your life total can't change and you gain
  // protection from everything. All permanents you control phase out." Phasing (CR 702.26) is
  // modeled the same way graveyard/exile already are: move the real card objects out of
  // lobby.cards into a player-scoped array (player.phasedOut), restored at the controller's own
  // next Untap step (see advanceOnePhase) -- the same moment lifeLocked/protectionFromEverything
  // also clear, matching the real "phase in before you untap" + "until your next turn" timing.
  // Anything ATTACHED to a phased permanent (an aura/equipment this same player also controls) is
  // already included in this same filter, so it naturally phases out alongside its host; an
  // opponent's aura on one of this player's permanents is not un-attached -- a disclosed, rare edge
  // case (no reparenting/detach step exists for that scenario).
  // Deflecting Palm -- sets up the pending redirect; the actual prevent-and-redirect logic lives in
  // applyLifeLoss (the one shared hook every life-loss site already routes through), keyed off
  // player.deflectingPalmSource matching the damage's sourceCardId.
  deflectingPalm(lobby, ctx, params) {
    const p = lobby.players[ctx.controllerId];
    const source = lobby.cards[params.chosenTargetId];
    if (!p || !source) return;
    p.deflectingPalmSource = params.chosenTargetId;
    pushLog(lobby, `${p.name} readies Deflecting Palm against ${source.name || "a creature"}`);
  },
  teferisProtection(lobby, ctx) {
    const p = lobby.players[ctx.controllerId];
    if (!p) return;
    p.lifeLocked = true;
    p.protectionFromEverything = true;
    const toPhase = Object.values(lobby.cards).filter((c) => c.owner === ctx.controllerId && c.zoneType !== "hand" && c.zoneType !== "stack");
    p.phasedOut = (p.phasedOut || []).concat(toPhase);
    toPhase.forEach((c) => {
      delete lobby.cards[c.id];
      delete lobby.targets[c.id];
      io.to(lobby.id).emit("cardRemove", c.id);
      delete lobby.combat.attackers[c.id];
      delete lobby.combat.blocks[c.id];
      Object.keys(lobby.combat.blocks).forEach((atkId) => {
        lobby.combat.blocks[atkId] = (lobby.combat.blocks[atkId] || []).filter((bid) => bid !== c.id);
      });
    });
    broadcastCombat(lobby);
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name}'s life total can't change and they gain protection from everything -- all their permanents phase out (Teferi's Protection)`);
  },
  damageEachOpponent(lobby, ctx, params) {
    const sourceCardId = ctx.sourceCard && ctx.sourceCard.id;
    effectTargets(lobby, ctx.controllerId, "eachOpponent").forEach((id) => {
      if (applyLifeLoss(lobby, id, params.amount || 0, sourceCardId)) {
        io.to(lobby.id).emit("spellDamage", { targetId: id, amount: params.amount || 0, sourceCardId });
      }
    });
  },
  millCards(lobby, ctx, params) {
    effectTargets(lobby, ctx.controllerId, params.target).forEach((id) => {
      const p = lobby.players[id]; if (!p) return;
      for (let i = 0; i < (params.amount || 1) && p.library.length > 0; i++) {
        p.graveyard.push(p.library.shift());
      }
    });
  },
  // `tokenType` (the token's own type line), NOT `type` -- an effect's dispatch key IS `type`
  // ("createToken", read by executeAbilityEffects via `EFFECTS[params.type]`), so a params object
  // can't also use `type` for anything else: a duplicate `type` key in the same object literal
  // silently keeps only the LAST one, which for years quietly overwrote "createToken" with whatever
  // the token's type line was, making `EFFECTS[params.type]` look up a nonexistent handler and
  // silently no-op -- Hornet Queen and every other createToken entry created zero tokens in
  // practice despite looking correct in the table and resolving "cleanly" off the stack. Found while
  // adding Windcrag Siege's token trigger, which copied the exact same (broken) shape.
  createToken(lobby, ctx, params) {
    const n = (params.amount || 1) * tokenMultiplierFor(lobby, ctx.controllerId);
    for (let i = 0; i < n; i++) {
      spawnBattlefieldCard(lobby, {
        name: params.name || "Token", type: params.tokenType || "Token Creature", img: params.img || "",
        power: params.power, toughness: params.toughness, colors: params.colors || [],
        keywords: params.keywords || [], owner: ctx.controllerId, zoneType: classifyType(params.tokenType || "Token Creature"),
        tapped: !!params.tapped
      });
    }
  },
  // Forbidden Orchard -- "target opponent creates a 1/1 colorless Spirit creature token." The
  // chosen-target counterpart to createToken (which always makes tokens for the controller) --
  // owner: params.chosenTargetId instead of ctx.controllerId, same "owner override" shape
  // counterTargetSpellCreateTokenForController already uses for a different card.
  createTokenForTargetPlayer(lobby, ctx, params) {
    const ownerId = params.chosenTargetId;
    if (!lobby.players[ownerId]) return;
    const n = params.amount || 1;
    for (let i = 0; i < n; i++) {
      spawnBattlefieldCard(lobby, {
        name: params.name || "Token", type: params.tokenType || "Token Creature", img: params.img || "",
        power: params.power, toughness: params.toughness, colors: params.colors || [],
        keywords: params.keywords || [], owner: ownerId, zoneType: classifyType(params.tokenType || "Token Creature")
      });
    }
  },
  // Krenko, Mob Boss -- "Create X 1/1 red Goblin creature tokens, where X is the number of Goblins
  // you control." Computed fresh here (params.typeFilter, e.g. ["goblin"]) rather than threaded in
  // as an amount, same "the activated-ability path has no generic dynamic-amount pipeline, so the
  // effect just computes what it needs" approach as damageAllCreaturesTable above. Krenko himself
  // counts toward his own total (he's a Goblin), matching the real card.
  createTokensEqualToTypeCountControlled(lobby, ctx, params) {
    const filter = params.typeFilter || [];
    const n = Object.values(lobby.cards).filter((c) => c.owner === ctx.controllerId && c.zoneType === "creature" && filter.some((t) => (c.type || "").toLowerCase().includes(t))).length * tokenMultiplierFor(lobby, ctx.controllerId);
    for (let i = 0; i < n; i++) {
      spawnBattlefieldCard(lobby, {
        name: params.name || "Token", type: params.tokenType || "Token Creature", img: params.img || "",
        power: params.power, toughness: params.toughness, colors: params.colors || [],
        keywords: params.keywords || [], owner: ctx.controllerId, zoneType: classifyType(params.tokenType || "Token Creature")
      });
    }
  },
  // Old Gnawbone -- "create that many Treasure tokens" (that many = the just-dealt combat damage
  // amount, baked in as params.dealtToPlayerAmount by fireGlobalCombatDamageToPlayerTrigger/
  // fireCombatDamageToPlayerTriggers). The dynamic-amount sibling of createToken just above.
  createTokensEqualToDealtDamage(lobby, ctx, params) {
    const n = (params.dealtToPlayerAmount || 0) * tokenMultiplierFor(lobby, ctx.controllerId);
    for (let i = 0; i < n; i++) {
      spawnBattlefieldCard(lobby, {
        name: params.name || "Token", type: params.tokenType || "Token Creature", img: params.img || "",
        power: params.power, toughness: params.toughness, colors: params.colors || [],
        keywords: params.keywords || [], owner: ctx.controllerId, zoneType: classifyType(params.tokenType || "Token Creature")
      });
    }
  },
  // Krenko, Tin Street Kingpin -- "put a +1/+1 counter on it, THEN create a number of tokens equal
  // to Krenko's power" -- the counter-add effect (addCountersToSelf) runs first in this ability's
  // own effects array, so by the time this one runs, looking the card back up fresh from
  // lobby.cards already reflects the just-added counter (effects in one array resolve strictly in
  // order, not in a single snapshot) -- no separate "current power" plumbing needed.
  createTokensEqualToSelfPower(lobby, ctx, params) {
    const card = ctx.sourceCard && lobby.cards[ctx.sourceCard.id];
    if (!card) return;
    const bonus = attachedBonusFor(lobby, card);
    const stat = staticBonusFor(lobby, card);
    const n = Math.max(0, parsePT(card.power) + (card.counters || 0) + bonus.powerBonus + stat.powerBonus) * tokenMultiplierFor(lobby, ctx.controllerId);
    for (let i = 0; i < n; i++) {
      spawnBattlefieldCard(lobby, {
        name: params.name || "Token", type: params.tokenType || "Token Creature", img: params.img || "",
        power: params.power, toughness: params.toughness, colors: params.colors || [],
        keywords: params.keywords || [], owner: ctx.controllerId, zoneType: classifyType(params.tokenType || "Token Creature")
      });
    }
  },
  // Only meaningful for an ETB trigger -- by the time a death trigger resolves, the source card is
  // already gone. No-ops safely rather than modeling "last known information."
  // Hardened Scales -- "If one or more +1/+1 counters would be put on a creature you control, that
  // many PLUS ONE are put on it instead" (an additive +1, not a doubling -- 1 becomes 2, 3 becomes
  // 4). See bonusCountersFor for the text-pattern detection; only applied when actually adding a
  // positive amount, matching the real card's "one or more... would be put" trigger condition.
  // City of Traitors -- "sacrifice this land." Reads the source card back live (not the possibly-
  // stale ctx.sourceCard reference) same "must re-look-up before removal" precedent every other
  // sacrifice/death path in this app already follows.
  sacrificeSelf(lobby, ctx) {
    const card = ctx.sourceCard && lobby.cards[ctx.sourceCard.id];
    if (!card) return;
    fireDeathTriggers(lobby, card);
    sendToGraveyardInternal(lobby, card);
  },
  addCountersToSelf(lobby, ctx, params) {
    const card = ctx.sourceCard && lobby.cards[ctx.sourceCard.id];
    if (!card) return;
    const amount = params.amount || 1;
    const bonus = amount > 0 ? bonusCountersFor(lobby, card.owner) : 0;
    // Corpsejack Menace / Branching Evolution's doubling applies AFTER Hardened Scales' additive
    // +1 -- see counterMultiplierFor's own comment.
    const mult = amount > 0 ? counterMultiplierFor(lobby, card.owner) : 1;
    card.counters = (card.counters || 0) + (amount + bonus) * mult;
    broadcastCard(lobby, card);
  },
  // Idyllic Grange -- addCountersToSelf's targeted counterpart: "put a +1/+1 counter on TARGET
  // creature you control" instead of the source itself. Same Hardened Scales/doubling hooks.
  addCountersToTarget(lobby, ctx, params) {
    const card = lobby.cards[params.chosenTargetId];
    if (!card) return;
    const amount = params.amount || 1;
    const bonus = amount > 0 ? bonusCountersFor(lobby, card.owner) : 0;
    const mult = amount > 0 ? counterMultiplierFor(lobby, card.owner) : 1;
    card.counters = (card.counters || 0) + (amount + bonus) * mult;
    broadcastCard(lobby, card);
  },
  // Cathars' Crusade -- addCountersToSelf's controller-wide counterpart: "put a +1/+1 counter on
  // EACH creature you control" (including whichever creature just entered and triggered this),
  // not just the source. Same Hardened Scales/doubling hooks, applied per matching creature.
  addCountersToAllYourCreatures(lobby, ctx, params) {
    const amount = params.amount || 1;
    const bonus = amount > 0 ? bonusCountersFor(lobby, ctx.controllerId) : 0;
    const mult = amount > 0 ? counterMultiplierFor(lobby, ctx.controllerId) : 1;
    Object.values(lobby.cards).filter((c) => c.owner === ctx.controllerId && c.zoneType === "creature").forEach((c) => {
      c.counters = (c.counters || 0) + (amount + bonus) * mult;
      broadcastCard(lobby, c);
    });
  },
  // Atomize -- "Proliferate." Real Magic lets you choose WHICH permanents/players with a counter
  // already on them get another (and skip the rest, e.g. to avoid also boosting an opponent's own
  // +1/+1 counters) -- this app has no per-choice multi-select UI for that, so it auto-affects EVERY
  // card with any counters and every player with any poison, a disclosed simplification (the
  // opposite-of-favorable case -- proliferating an opponent's counters too -- is rare enough in
  // practice not to block shipping this on its own). Only `counters` (this app's one generic bucket,
  // covering +1/+1 and Atomize/The One Ring's own burden counters alike) and `poison` are anything
  // this app actually tracks as a "counter" -- no loyalty-ability system exists yet to proliferate.
  proliferateAll(lobby) {
    Object.values(lobby.cards).forEach((c) => { if (c.counters > 0) { c.counters += 1; broadcastCard(lobby, c); } });
    Object.values(lobby.players).forEach((p) => { if (p.poison > 0) p.poison += 1; });
    broadcastPlayers(lobby);
  },
  // The One Ring -- "{T}: Put a burden counter on The One Ring, then draw a card for each burden
  // counter on The One Ring." Placed as a SEPARATE effect right after addCountersToSelf in the same
  // ability's effects array (not folded into one function) so the counter is already incremented by
  // the time this runs -- effects in one array resolve strictly in order, same precedent as Krenko,
  // Tin Street Kingpin's own counter-then-tokens ability.
  drawCardsEqualToSelfCounters(lobby, ctx) {
    const card = ctx.sourceCard && lobby.cards[ctx.sourceCard.id];
    if (!card) return;
    drawN(lobby, ctx.controllerId, card.counters || 0);
  },
  // The One Ring's upkeep trigger -- "you lose 1 life for each burden counter on The One Ring."
  // Reads the card's OWN current counters, computed fresh at fire time (same "the activated-ability/
  // trigger dispatch path has no generic dynamic-amount pipeline" reasoning as destroyAllCreatures
  // and friends) rather than threaded in as a fixed amount.
  loseLifeEqualToSelfCounters(lobby, ctx) {
    const card = ctx.sourceCard && lobby.cards[ctx.sourceCard.id];
    if (!card || !(card.counters > 0)) return;
    applyLifeLoss(lobby, ctx.controllerId, card.counters);
    checkEliminations(lobby);
  },
  // The One Ring's ETB -- "you gain protection from everything until your next turn." Reuses
  // Teferi's Protection's own protectionFromEverything flag/clearing (already cleared at this
  // player's own next Untap step, matching "until your next turn" exactly) but WITHOUT
  // teferisProtection's lifeLocked/phase-out side effects, which The One Ring's wording doesn't
  // grant. "If you cast it" isn't checked -- this app has no "was this permanent cast, vs. put onto
  // the battlefield some other way" tracking anywhere, a disclosed simplification shared with every
  // other ETB trigger in this file that doesn't distinguish how a permanent arrived.
  grantProtectionFromEverything(lobby, ctx) {
    const p = lobby.players[ctx.controllerId];
    if (!p) return;
    p.protectionFromEverything = true;
    broadcastPlayers(lobby);
  },
  // Records a "choose one" ETB-style pick (e.g. Windcrag Siege's "choose Mardu or Jeskai") directly
  // on the source card, for other abilities' `condition` to key off of and for the client to show.
  // Modeled as a player-activated ability (see ACTIVATED_ABILITIES) rather than a real automatic ETB
  // trigger, since this app has no generic "choose one of these modes" prompt -- reusing the
  // existing per-card activated-ability button list (each mode its own entry, self-hidden via
  // `condition` once a mode is already chosen) needed no new UI at all.
  chooseMode(lobby, ctx, params) {
    const card = ctx.sourceCard && lobby.cards[ctx.sourceCard.id];
    if (card) { card.chosenMode = params.mode; broadcastCard(lobby, card); }
  },
  // The four targeted effects -- params.chosenTargetId is baked in by chooseTargetFor before this
  // ever runs (see queueTargetChoice), so resolveStackTop/passPriority need no knowledge of
  // targeting at all. If the target already left play before this resolved (a legal response
  // removed it, etc.), these all just no-op -- matches a real Magic spell/ability fizzling for
  // lack of a legal target, not fully modeled but close enough.
  destroyTarget(lobby, ctx, params) {
    const card = lobby.cards[params.chosenTargetId];
    if (!card) return;
    // CR 702.12b -- a "destroy" effect doesn't destroy an indestructible permanent. Same check
    // dealtLethal uses for combat.
    if (effectiveKeywords(lobby, card).some((k) => (k || "").toLowerCase() === "indestructible")) return;
    // CR 701.16d -- regeneration REPLACES destruction (not just combat lethal damage). Same shield
    // consumed by the combat-lethal check in resolveCombatDamage's processDeaths.
    if (card.regenerationShield > 0) {
      card.regenerationShield -= 1;
      card.tapped = true;
      broadcastCard(lobby, card);
      pushLog(lobby, `${card.name || "A creature"} regenerates instead of being destroyed`);
      return;
    }
    fireDeathTriggers(lobby, card);
    sendToGraveyardInternal(lobby, card);
  },
  // Aerial Assault -- "Destroy target tapped creature. You gain 1 life for each creature you
  // control with flying." The life gain is unconditional (not "if it was destroyed"), so this just
  // reuses destroyTarget as-is for the destroy half rather than duplicating its
  // indestructible/regeneration handling.
  destroyTargetGainLifePerFlying(lobby, ctx, params) {
    EFFECTS.destroyTarget(lobby, ctx, params);
    const flyingCount = Object.values(lobby.cards).filter((c) => c.owner === ctx.controllerId && c.zoneType === "creature" && effectiveKeywords(lobby, c).some((k) => (k || "").toLowerCase() === "flying")).length;
    if (flyingCount > 0) applyLifeGain(lobby, ctx.controllerId, flyingCount);
  },
  // Thousand-Year Elixir's activated ability -- a plain targeted untap, no card in this app's
  // vocabulary needed one before now.
  untapTarget(lobby, ctx, params) {
    const card = lobby.cards[params.chosenTargetId];
    if (!card || !card.tapped) return;
    card.tapped = false;
    broadcastCard(lobby, card);
  },
  // Boros Charm's "permanents you control gain indestructible until end of turn" mode -- applies
  // grantTemporaryKeyword (see its own comment) to every permanent the controller has, not just one.
  // Generalized to any keyword list (default ["Indestructible"], Boros Charm's own case unchanged)
  // for Heroic Intervention's "gain hexproof AND indestructible" -- already permanent-wide, not
  // creature-restricted, so no other change was needed for that card.
  grantIndestructibleToAllYours(lobby, ctx, params) {
    const keywords = params.keywords || ["Indestructible"];
    Object.values(lobby.cards).forEach((c) => {
      if (c.owner === ctx.controllerId && c.zoneType !== "hand" && c.zoneType !== "stack") keywords.forEach((k) => grantTemporaryKeyword(lobby, c, k));
    });
  },
  // The single-target counterpart to grantIndestructibleToAllYours -- "target creature gains X until
  // end of turn" (Boros Charm's double strike mode), reusable for any future single-target
  // temporary-keyword grant.
  grantTemporaryKeywordToTarget(lobby, ctx, params) {
    const card = lobby.cards[params.chosenTargetId];
    if (card) grantTemporaryKeyword(lobby, card, params.keyword);
  },
  // Kyodai, Soul of Kamigawa -- "another target permanent gains indestructible for as long as you
  // control Kyodai." Stores the SOURCE's own id (Kyodai, via ctx.sourceCard) on the target; see
  // effectiveKeywords' own comment for how this gets read back live, with no cleanup needed.
  grantIndestructibleWhileSourceControlled(lobby, ctx, params) {
    const card = lobby.cards[params.chosenTargetId];
    if (!card || !ctx.sourceCard) return;
    card.grantedIndestructibleWhileSourceId = ctx.sourceCard.id;
    broadcastCard(lobby, card);
  },
  // Kor Haven -- "Prevent all combat damage that would be dealt by target attacking creature this
  // turn." See resolveCombatDamage's own dealingPower helper for where this is actually enforced.
  preventCombatDamageFromTarget(lobby, ctx, params) {
    const card = lobby.cards[params.chosenTargetId];
    if (!card) return;
    card.preventCombatDamageUntilEndOfTurn = true;
    broadcastCard(lobby, card);
  },
  // Shadowspear -- "Permanents your opponents control lose hexproof and indestructible until end of
  // turn." Same per-card temporary-flag shape as preventCombatDamageFromTarget just above (set here,
  // read in effectiveKeywords, swept in cleanupTemporaryKeywords), applied table-wide to every
  // opponent permanent instead of one chosen target -- this ability has no target of its own.
  removeHexproofIndestructibleFromOpponents(lobby, ctx) {
    Object.values(lobby.cards).forEach((c) => {
      if (c.owner !== ctx.controllerId && c.zoneType !== "hand" && c.zoneType !== "stack") {
        c.loseHexproofIndestructibleUntilEndOfTurn = true;
        broadcastCard(lobby, c);
      }
    });
  },
  // Chameleon Colossus's own activated ability ("{2}{G}{G}: This creature gets +X/+X until end of
  // turn, where X is its power") -- reads its OWN current power (including any equipment/anthem/
  // earlier-this-turn temporaryPT bonus, same computation Terror of the Peaks' trigger already
  // uses) and grants that much more via grantTemporaryPT, so repeated activations compound
  // correctly (each one X's off whatever power it has grown to by then, matching real Magic).
  grantTemporaryPTEqualToSelfPower(lobby, ctx) {
    const card = ctx.sourceCard && lobby.cards[ctx.sourceCard.id];
    if (!card) return;
    const bonus = attachedBonusFor(lobby, card), stat = staticBonusFor(lobby, card);
    const power = Math.max(0, parsePT(card.power) + bonus.powerBonus + stat.powerBonus);
    grantTemporaryPT(lobby, card, power, power);
  },
  // Beast Within / Generous Gift -- "Destroy target permanent. Its controller creates a 3/3 green
  // [X] creature token." The token goes to the DESTROYED permanent's own controller, not the
  // caster, so its owner has to be captured BEFORE destruction removes the card from lobby.cards.
  // Same indestructible/regeneration handling as destroyTarget just above -- duplicated rather than
  // shared since it's only these two cards, same "small duplication over a shared helper for two
  // call sites" precedent as the rest of this file.
  destroyTargetCreateTokenForController(lobby, ctx, params) {
    const card = lobby.cards[params.chosenTargetId];
    if (!card) return;
    const tokenOwnerId = card.owner;
    if (effectiveKeywords(lobby, card).some((k) => (k || "").toLowerCase() === "indestructible")) return;
    if (card.regenerationShield > 0) {
      card.regenerationShield -= 1;
      card.tapped = true;
      broadcastCard(lobby, card);
      pushLog(lobby, `${card.name || "A creature"} regenerates instead of being destroyed`);
      return;
    }
    fireDeathTriggers(lobby, card);
    sendToGraveyardInternal(lobby, card);
    spawnBattlefieldCard(lobby, {
      name: params.tokenName || "Token", type: params.tokenType || "Token Creature", img: params.img || "",
      power: params.power, toughness: params.toughness, colors: params.colors || [],
      keywords: params.keywords || [], owner: tokenOwnerId, zoneType: classifyType(params.tokenType || "Token Creature")
    });
  },
  exileTarget(lobby, ctx, params) {
    const card = lobby.cards[params.chosenTargetId];
    if (card) exileCardInternal(lobby, card);
  },
  // Sacrifice (CR 701.19), not destroy -- ignores Indestructible on purpose, unlike destroyTarget.
  // Used for the "pay by sacrificing a permanent of your own choice" branch of an optional-payment
  // cost (Rakdos, Patron of Chaos and its functional cousins) -- see queueOptionalPayment.
  sacrificeTarget(lobby, ctx, params) {
    const card = lobby.cards[params.chosenTargetId];
    if (!card) return;
    fireDeathTriggers(lobby, card);
    sendToGraveyardInternal(lobby, card);
  },
  // Rakdos, Patron of Chaos: "target opponent may sacrifice two nonland, nontoken permanents of
  // their choice. If they don't, you draw two cards." chosenTargetId (baked in by chooseTargetFor
  // from the normal targetKind:"player" flow) is who gets offered the choice -- distinct from
  // ctx.controllerId, who benefits if they decline. sourceCard is looked up fresh since this may
  // resolve well after the source left the stack (it's already off the stack by the time this
  // runs, being an ability's own effect).
  offerSacrificeOrDraw(lobby, ctx, params) {
    const targetPlayerId = params.chosenTargetId;
    if (!lobby.players[targetPlayerId]) return;
    const src = (ctx.sourceCard && lobby.cards[ctx.sourceCard.id]) || null;
    const srcName = (src && src.name) || "An ability";
    queueOptionalPayment(lobby, {
      playerId: targetPlayerId, controllerId: ctx.controllerId, sourceCard: ctx.sourceCard,
      label: `${srcName} — sacrifice ${params.sacrificeCount || 2} nonland permanents, or its controller draws ${params.declinedDraw || 2} cards`,
      costLabel: `Sacrifice ${params.sacrificeCount || 2} permanents`,
      cost: { sacrificeCount: params.sacrificeCount || 2 },
      declinedEffects: [{ type: "drawCards", amount: params.declinedDraw || 2 }]
    });
  },
  // Swords to Plowshares -- "Its controller gains life equal to its power": the life goes to the
  // EXILED creature's own controller (card.owner), not necessarily whoever cast this, since the
  // target is very often an opponent's creature. Power is computed the same way combat damage does
  // (base + equipment/aura + static anthem bonuses) so a pumped-up creature gives the right amount.
  exileTargetGainLifeEqualToPower(lobby, ctx, params) {
    const card = lobby.cards[params.chosenTargetId];
    if (!card) return;
    const basePower = parseInt(card.power, 10) || 0;
    const bonus = attachedBonusFor(lobby, card);
    const staticBonus = staticBonusFor(lobby, card);
    const power = Math.max(0, basePower + bonus.powerBonus + staticBonus.powerBonus);
    const recipientId = card.owner;
    exileCardInternal(lobby, card);
    if (power > 0) applyLifeGain(lobby, recipientId, power);
  },
  // Chaos Warp: "The owner of target permanent shuffles it into their library, then reveals the top
  // card of their library. If it's a permanent card, they put it onto the battlefield." A real
  // shuffle (this app's existing shuffle() helper), not a fake/simplified reorder -- and a genuine
  // reveal-and-conditionally-play off the ACTUAL post-shuffle top card, not a scripted outcome.
  chaosWarpTarget(lobby, ctx, params) {
    const card = lobby.cards[params.chosenTargetId];
    if (!card) return;
    const ownerId = card.originalOwner || card.owner;
    const owner = lobby.players[ownerId];
    if (!owner) return;
    delete lobby.cards[card.id];
    if (lobby.targets[card.id]) delete lobby.targets[card.id];
    io.to(lobby.id).emit("cardRemove", card.id);
    clearCommanderRef(lobby, card);
    detachDependents(lobby, card);
    // Same Command Zone replacement as sendToGraveyardInternal/exileCardInternal (CR 903.9a covers
    // library moves too, not just graveyard/exile) -- skip the shuffle-into-library entirely.
    if (card.isCommander) {
      pushLog(lobby, `${owner.name}'s ${card.name || "commander"} returned to the Command Zone instead of being shuffled away`);
      broadcastPlayers(lobby);
      return;
    }
    const entry = toEntry(card);
    owner.library.push(entry);
    shuffle(owner.library);
    pushLog(lobby, `Chaos Warp shuffles ${entry.name || "a permanent"} into ${owner.name}'s library`);
    const revealed = owner.library.shift();
    if (!revealed) { broadcastPlayers(lobby); return; }
    if (isInstantOrSorcery(revealed.type)) {
      owner.library.unshift(revealed); // not a permanent card -- stays on top, per the real text
      pushLog(lobby, `${owner.name} reveals ${revealed.name || "a card"} off the top of their library — not a permanent, it stays there`);
    } else {
      const newCard = spawnBattlefieldCard(lobby, { ...revealed, owner: ownerId, faceDown: false, zoneType: classifyType(revealed.type) });
      pushLog(lobby, `${owner.name} reveals ${revealed.name || "a card"} off the top of their library — a permanent, put onto the battlefield`);
      if (lobby.turn.started) fireEtbTriggers(lobby, newCard);
    }
    broadcastPlayers(lobby);
  },
  bounceTargetToHand(lobby, ctx, params) {
    const card = lobby.cards[params.chosenTargetId];
    if (card) bounceCardToHandInternal(lobby, card);
  },
  // Ominous Cemetery -- "target creature's owner shuffles it into their library." Same Command
  // Zone replacement (CR 903.9a) sendToGraveyardInternal/exileCardInternal already apply, just
  // shuffled into the library instead when it's not a commander.
  shuffleTargetIntoLibrary(lobby, ctx, params) {
    const card = lobby.cards[params.chosenTargetId];
    if (!card) return;
    const owner = lobby.players[card.originalOwner || card.owner];
    if (!owner) return;
    delete lobby.cards[card.id];
    if (lobby.targets[card.id]) delete lobby.targets[card.id];
    io.to(lobby.id).emit("cardRemove", card.id);
    clearCommanderRef(lobby, card);
    detachDependents(lobby, card);
    if (card.isCommander) {
      pushLog(lobby, `${owner.name}'s ${card.name || "commander"} returned to the Command Zone`);
    } else {
      owner.library.push(toEntry(card));
      shuffle(owner.library);
      pushLog(lobby, `${card.name || "A creature"} was shuffled into ${owner.name}'s library`);
    }
    broadcastPlayers(lobby);
  },
  // Orim's Chant -- "target player can't cast spells this turn." Cleared at the same end-of-turn
  // cleanup as temporaryKeywords (see cleanupTemporaryKeywords); enforced in playCard/freeCastCard
  // via canCastSpells, the one choke point both real cast paths already share.
  restrictCantCastSpells(lobby, ctx, params) {
    const p = lobby.players[params.chosenTargetId];
    if (!p) return;
    p.cantCastSpells = true;
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} can't cast spells this turn`);
  },
  // Emergence Zone -- "you may cast spells this turn as though they had flash." cantCastSpells's own
  // exact mirror (checkTiming's own isInstantSpeed check, cleared at the same end-of-turn cleanup).
  grantFlashUntilEndOfTurn(lobby, ctx) {
    const p = lobby.players[ctx.controllerId];
    if (!p) return;
    p.hasFlashUntilEndOfTurn = true;
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} may cast spells this turn as though they had flash`);
  },
  // Orim's Chant, kicked -- "creatures can't attack this turn." Table-wide (the real wording has
  // no "you control"), enforced in declareAttackers, cleared at the same cleanup.
  restrictCreaturesCantAttack(lobby, ctx, params) {
    lobby.creaturesCantAttack = true;
    pushLog(lobby, `Creatures can't attack this turn`);
  },
  tapTarget(lobby, ctx, params) {
    const card = lobby.cards[params.chosenTargetId];
    if (card) { card.tapped = true; broadcastCard(lobby, card); }
  },
  // A shockland declining to pay its life cost (see checkShockLandChoice) -- taps the SOURCE
  // itself, not a chosen target.
  tapSelf(lobby, ctx, params) {
    const card = ctx.sourceCard && lobby.cards[ctx.sourceCard.id];
    if (card) { card.tapped = true; broadcastCard(lobby, card); }
  },
  // Dragon Tempest's "it gains haste until end of turn" -- enteringCardId is baked in by
  // fireGlobalOtherCreatureEtbTriggers at fire time (the target here is fixed by the trigger
  // itself, not a player choice). Genuinely "until end of turn" now (see grantTemporaryKeyword) --
  // no longer the permanent-grant simplification this used before that mechanism existed.
  grantHasteToEnteringCreature(lobby, ctx, params) {
    const card = lobby.cards[params.enteringCardId];
    if (!card) return;
    grantTemporaryKeyword(lobby, card, "Haste");
  },
  // Skithiryx's "{B}: gains haste until end of turn" -- self-targeted off an activated ability
  // instead of a trigger, otherwise identical to grantHasteToEnteringCreature.
  grantHasteToSelf(lobby, ctx, params) {
    const card = ctx.sourceCard && lobby.cards[ctx.sourceCard.id];
    if (!card) return;
    grantTemporaryKeyword(lobby, card, "Haste");
  },
  // Skithiryx's "{B}{B}: Regenerate" -- see the regenerationShield checks in destroyTarget and
  // resolveCombatDamage's processDeaths for where the shield actually gets spent.
  grantRegenerationShield(lobby, ctx, params) {
    const card = ctx.sourceCard && lobby.cards[ctx.sourceCard.id];
    if (!card) return;
    card.regenerationShield = (card.regenerationShield || 0) + 1;
    broadcastCard(lobby, card);
  },
  // Crypt Sliver's granted "{T}: Regenerate target [Type]" -- the single-target counterpart to
  // grantRegenerationShield above, for a granted ability that targets rather than self-buffs.
  grantRegenerationShieldToTarget(lobby, ctx, params) {
    const card = lobby.cards[params.chosenTargetId];
    if (!card) return;
    card.regenerationShield = (card.regenerationShield || 0) + 1;
    broadcastCard(lobby, card);
  },
  // Hibernation Sliver's granted "Pay 2 life: Return this permanent to its owner's hand" -- a
  // self-targeting counterpart to bounceTargetToHand, same shape as grantTemporaryKeywordToSelf-
  // style self effects elsewhere in this file.
  bounceSelfToHand(lobby, ctx) {
    const card = ctx.sourceCard && lobby.cards[ctx.sourceCard.id];
    if (card) bounceCardToHandInternal(lobby, card);
  },
  // Deathless Angel's "target creature gains indestructible UNTIL END OF TURN" -- a genuinely
  // reusable primitive (not a one-off) for any future "target creature gains keyword" card.
  // params.permanent opts into a real permanent grant instead (a future aura-shaped card, say) --
  // defaults to temporary since "until end of turn" combat tricks are the far more common real
  // wording for this shape of effect.
  grantKeywordToTarget(lobby, ctx, params) {
    const card = lobby.cards[params.chosenTargetId];
    if (!card || !params.keyword) return;
    if (params.permanent) {
      if (!(card.keywords || []).includes(params.keyword)) { card.keywords = [...(card.keywords || []), params.keyword]; broadcastCard(lobby, card); }
    } else {
      grantTemporaryKeyword(lobby, card, params.keyword);
    }
  },
  // Giver of Runes / Mother of Runes -- "target creature you control gains protection from the
  // color of your choice UNTIL END OF TURN." params.quality (baked into the ACTIVATED_ABILITIES
  // entry, one per color/colorless -- see the card's own comment there for why) is a plain quality
  // string in the exact format allProtectionQualities already expects. card.grantedProtections is
  // the granted-side counterpart to card.temporaryKeywords, swept at the same cleanup point.
  grantProtectionUntilEOT(lobby, ctx, params) {
    const card = lobby.cards[params.chosenTargetId];
    if (!card || !params.quality) return;
    if (!card.grantedProtections) card.grantedProtections = [];
    if (!card.grantedProtections.includes(params.quality)) {
      card.grantedProtections.push(params.quality);
      broadcastCard(lobby, card);
    }
  },
  // Brave the Elements -- "Choose a color. White creatures you control gain protection from the
  // chosen color until end of turn." Only ONE real choice (which color to protect from) -- "white
  // creatures you control" is fixed in the actual oracle text, not itself a variable. Modeled as
  // one mode per color (same "one button per color" precedent as Mother of Runes' ACTIVATED_
  // ABILITIES array, since this engine has no single-step 5-way color-picker), each granting the
  // same real, functional card.grantedProtections Mother/Giver of Runes use (it actually gates
  // targeting when lobby.settings.enforceTargetingRestrictions is on), not a cosmetic no-op.
  grantProtectionToOwnColorCreatures(lobby, ctx, params) {
    const quality = params.quality;
    if (!quality) return;
    Object.values(lobby.cards).forEach((c) => {
      if (c.owner !== ctx.controllerId || c.zoneType !== "creature") return;
      if (params.creatureColor && !(c.colors || []).includes(params.creatureColor)) return;
      if (!c.grantedProtections) c.grantedProtections = [];
      if (!c.grantedProtections.includes(quality)) {
        c.grantedProtections.push(quality);
        broadcastCard(lobby, c);
      }
    });
  },
  // Cursed Mirror -- "become a copy of any creature on the battlefield until end of turn, except
  // it has haste." CR 707 copying is deep (a copy takes on every COPIABLE value -- name, type line,
  // mana cost, colors, P/T, text, keywords/abilities, image; NOT counters or other permanents'
  // temporary bonuses like equipment, which aren't copiable characteristics) -- scoped to exactly
  // what this one card needs rather than a general copy-effect framework, same "seed the mechanism
  // with the real card that needs it" precedent as every other subsystem this session. Snapshots
  // every overwritten field on card._copyOriginal so cleanupTemporaryKeywords can revert them at
  // end of turn, the same "this turn" sweep every other temporary grant in this app already uses.
  becomeCopyUntilEOT(lobby, ctx, params) {
    const mirror = lobby.cards[ctx.sourceCard.id];
    const source = lobby.cards[params.chosenTargetId];
    if (!mirror || !source || mirror.id === source.id || mirror._copyOriginal) return;
    const COPY_FIELDS = ["name", "type", "manaCost", "cmc", "colors", "colorIdentity", "power", "toughness", "text", "keywords", "img", "producedMana", "loyalty"];
    const original = {};
    COPY_FIELDS.forEach((f) => { original[f] = mirror[f]; });
    original.zoneType = mirror.zoneType;
    mirror._copyOriginal = original;
    COPY_FIELDS.forEach((f) => { mirror[f] = source[f]; });
    const hasHaste = (mirror.keywords || []).some((k) => (k || "").toLowerCase() === "haste");
    if (!hasHaste) mirror.keywords = [...(mirror.keywords || []), "Haste"];
    mirror.zoneType = classifyType(mirror.type);
    broadcastCard(lobby, mirror);
    const p = lobby.players[ctx.controllerId];
    pushLog(lobby, `${p ? p.name : "Someone"}'s Cursed Mirror becomes a copy of ${source.name || "a creature"}`);
  },
  // Mithril Coat -- "When Mithril Coat enters, attach it to target legendary creature you control."
  // The actual grant ("Equipped creature has indestructible") is already handled generically by
  // equipEffectsFromText/attachedBonusFor once attached -- this effect only needs to do the
  // attaching itself, same plain `attachedTo` assignment the manual attachCard handler uses.
  // "legendary" isn't checked -- this app's targetKind vocabulary has no legendary-status filter,
  // same disclosed simplification as Kiki-Jiki's "nonlegendary" restriction.
  attachSelfToTarget(lobby, ctx, params) {
    const self = lobby.cards[ctx.sourceCard.id];
    const target = lobby.cards[params.chosenTargetId];
    if (!self || !target) return;
    self.attachedTo = target.id;
    broadcastCard(lobby, self);
    const p = lobby.players[ctx.controllerId];
    pushLog(lobby, `${p ? p.name : "Someone"}'s ${self.name || "card"} attaches to ${target.name || "a creature"}`);
  },
  // Serra's Emissary -- chosenTargetId here is the chosen CARD TYPE STRING (e.g. "Creature"), not
  // a real card/player id, reusing the same chosenTargetId-baking chooseTargetFor already does for
  // every other target kind. See cardTypeProtectionBlocks for where this actually gets enforced.
  grantPlayerProtectionFromCardType(lobby, ctx, params) {
    const p = lobby.players[ctx.controllerId];
    if (!p || !params.chosenTargetId) return;
    p.protectionFromCardType = params.chosenTargetId;
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} and their creatures gain protection from ${params.chosenTargetId}`);
  },
  // The generic Treasure token's own real ability -- "{T}, Sacrifice this artifact: Add one mana of
  // any color." Since the source is already sacrificed by the time this runs (cost-paying always
  // happens before effects), there's no live card left to hang a chooseMana prompt off of the usual
  // way (resolveManaChoice needs card.producedMana) -- uses a per-PLAYER pending-choice flag instead
  // (p.pendingFreeManaChoice), resolved by the same client-side chooseMana modal via a "__free__"
  // sentinel cardId. Goldspan Dragon's "Treasures you control have '...Add TWO mana of any one
  // color'" upgrade (checked by text-scan, no fixed name list) is threaded through the same flow.
  chooseManaAnyColor(lobby, ctx, params) {
    const p = lobby.players[ctx.controllerId];
    if (!p) return;
    const upgraded = Object.values(lobby.cards).some((c) => c.owner === ctx.controllerId && c.zoneType !== "hand" && c.zoneType !== "stack" && /treasures you control have .*add two mana of any one color/i.test(c.text || ""));
    p.pendingFreeManaChoice = { amount: upgraded ? 2 : 1 };
    const sock = io.sockets.sockets.get(ctx.controllerId);
    if (sock) sock.emit("chooseMana", { cardId: "__free__", cardName: params.sourceName || "Mana source", options: ["W", "U", "B", "R", "G"] });
  },
  // Cascading Cataracts -- "Add five mana in any combination of colors," a real INDEPENDENT choice
  // per mana (unlike chooseManaAnyColor's own `amount`, which adds several mana of the SAME picked
  // color in one shot, e.g. an upgraded Treasure). remainingPicks re-prompts resolveManaChoice's
  // own "__free__" branch instead of clearing pendingFreeManaChoice after the first pick.
  chooseManaAnyColorRepeated(lobby, ctx, params) {
    const p = lobby.players[ctx.controllerId];
    if (!p) return;
    p.pendingFreeManaChoice = { amount: 1, remainingPicks: params.count || 1 };
    const sock = io.sockets.sockets.get(ctx.controllerId);
    if (sock) sock.emit("chooseMana", { cardId: "__free__", cardName: params.sourceName || "Mana source", options: ["W", "U", "B", "R", "G"] });
  },
  // Horizon Canopy / Silent Clearing-style painlands -- "{T}, Pay 1 life: Add [X] or [Y]." The
  // fixed-two-color counterpart to chooseManaAnyColor, same "__free__" sentinel pending-choice
  // flow (reused here purely for consistency with the rest of this file's mana-choice pattern,
  // even though the source card is still alive when this runs, unlike Treasure's own case).
  chooseManaFromColors(lobby, ctx, params) {
    const p = lobby.players[ctx.controllerId];
    if (!p) return;
    p.pendingFreeManaChoice = { amount: 1 };
    const sock = io.sockets.sockets.get(ctx.controllerId);
    if (sock) sock.emit("chooseMana", { cardId: "__free__", cardName: params.sourceName || "Mana source", options: params.colors || [] });
  },
  // The "Thriving" land cycle -- "As it enters, choose a color other than [X]." A ONE-TIME choice
  // made at ETB and remembered for the rest of the game (card.chosenColor), distinct from every
  // other chooseMana-shaped prompt in this app, which all resolve immediately into mana. Reuses the
  // client's existing chooseMana modal purely for the UI (a real cardId, not the "__free__"
  // sentinel, so resolveManaChoice's own new pendingColorChoice branch -- checked before either of
  // its two existing branches -- can tell this apart and store instead of adding mana).
  chooseColorOtherThan(lobby, ctx, params) {
    const card = lobby.cards[ctx.sourceCard.id];
    if (!card) return;
    card.pendingColorChoice = true;
    broadcastCard(lobby, card);
    const sock = io.sockets.sockets.get(ctx.controllerId);
    const options = ["W", "U", "B", "R", "G"].filter((c) => c !== params.excludeColor);
    if (sock) sock.emit("chooseMana", { cardId: card.id, cardName: card.name || "Land", options });
  },
  // The Thriving cycle's own ongoing mana ability -- "{T}: Add [X] or one mana of the chosen
  // color." Computed fresh at activation (own color is a fixed param, the second is whatever
  // chooseColorOtherThan stored on this exact card instance) rather than baked into the table entry
  // like chooseManaFromColors' fixed pair, since the second color varies per permanent. Falls back
  // to a single-color choice (no prompt at all) if the ETB choice was somehow never made -- should
  // never happen in practice (the ETB effect always fires first), just a safe default.
  chooseManaOwnOrChosenColor(lobby, ctx, params) {
    const card = lobby.cards[ctx.sourceCard.id];
    const p = lobby.players[ctx.controllerId];
    if (!p) return;
    const colors = (card && card.chosenColor) ? [params.ownColor, card.chosenColor] : [params.ownColor];
    if (colors.length === 1) { p.mana[colors[0]] = (p.mana[colors[0]] || 0) + 1; broadcastPlayers(lobby); return; }
    p.pendingFreeManaChoice = { amount: 1 };
    const sock = io.sockets.sockets.get(ctx.controllerId);
    if (sock) sock.emit("chooseMana", { cardId: "__free__", cardName: (card && card.name) || "Land", options: colors });
  },
  // Battle Cry Goblin -- "Goblins you control get +1/+0 and gain haste until end of turn." Generic
  // on typeFilter (a type-line substring), reusing grantTemporaryPT/grantTemporaryKeyword for the
  // real "until end of turn" duration rather than a permanent-grant simplification.
  grantTemporaryPTAndKeywordsToType(lobby, ctx, params) {
    const filter = (params.typeFilter || "").toLowerCase();
    Object.values(lobby.cards).forEach((c) => {
      if (c.owner !== ctx.controllerId || c.zoneType !== "creature" || !(c.type || "").toLowerCase().includes(filter)) return;
      if (params.power || params.toughness) grantTemporaryPT(lobby, c, params.power || 0, params.toughness || 0);
      (params.keywords || []).forEach((k) => grantTemporaryKeyword(lobby, c, k));
    });
  },
  // Kessig Wolf Run -- "Target creature gets +X/+0 and gains trample until end of turn," X being
  // the amount paid for the ability's own {X} cost (params.xAmount, baked in by fireTrigger/
  // activateAbility's own manaAbility branch). power/toughness stay fixed bonuses on TOP of X, so a
  // future card needing "+X/+0 and +1/+1" isn't boxed out.
  grantTemporaryPTAndKeywordsToTarget(lobby, ctx, params) {
    const card = lobby.cards[params.chosenTargetId];
    if (!card) return;
    const power = (params.power || 0) + (params.xAmount || 0);
    const toughness = (params.toughness || 0) + (params.xToughness ? (params.xAmount || 0) : 0);
    if (power || toughness) grantTemporaryPT(lobby, card, power, toughness);
    (params.keywords || []).forEach((k) => grantTemporaryKeyword(lobby, card, k));
  },
  // Kyodai, Soul of Kamigawa -- "{W}{U}{B}{R}{G}: Kyodai gets +5/+5 until end of turn." A pure self
  // buff with no targeting at all, unlike grantTemporaryPTAndKeywordsToTarget just above -- reuses
  // the same shared grantTemporaryPT helper directly on ctx.sourceCard.
  grantTemporaryPTToSelf(lobby, ctx, params) {
    const card = ctx.sourceCard && lobby.cards[ctx.sourceCard.id];
    if (card) grantTemporaryPT(lobby, card, params.power || 0, params.toughness || 0);
  },
  // Icon of Ancestry / Cavern of Souls -- "As this permanent enters, choose a creature type." Free
  // text (targetKind:"creatureType"), not validated against a real creature-type list -- same
  // "players self-police" trust model as everywhere else in this app. Read back by staticBonusFor
  // (Icon of Ancestry's own anthem) and lookTopNRevealTypesToHand (its dig ability).
  chooseCreatureType(lobby, ctx, params) {
    const card = ctx.sourceCard && lobby.cards[ctx.sourceCard.id];
    if (!card || !params.chosenTargetId) return;
    card.chosenCreatureType = params.chosenTargetId;
    broadcastCard(lobby, card);
    pushLog(lobby, `${card.name || "A permanent"}'s controller chooses ${params.chosenTargetId}`);
  },
  // Distant Melody -- "Choose a creature type. Draw a card for each permanent you control of that
  // type." A ONE-SHOT use of the same free-text creatureType targetKind, unlike Icon of Ancestry/
  // Cavern of Souls' PERSISTENT chosenCreatureType above -- read straight off params.chosenTargetId
  // (baked in by chooseTargetFor for any castSpell-kind target choice) instead of stashing it on a
  // card. Matches the real wording ("permanent," not "creature") -- counts any permanent whose type
  // line includes the chosen text, not creature-zoned cards only.
  drawForPermanentsOfChosenType(lobby, ctx, params) {
    const type = (params.chosenTargetId || "").toLowerCase();
    if (!type) return;
    const count = Object.values(lobby.cards).filter((c) => c.owner === ctx.controllerId && c.zoneType !== "hand" && c.zoneType !== "stack" && (c.type || "").toLowerCase().includes(type)).length;
    if (count > 0) drawN(lobby, ctx.controllerId, count);
  },
  // Reya Dawnbringer / Necromancy -- puts a creature card from a graveyard onto the battlefield
  // under the CASTER's control (correct for both: Reya only ever searches her own controller's
  // graveyard in the first place, so "under the owner's control" and "under the caster's control"
  // are the same thing there; Necromancy explicitly wants the caster's control regardless of whose
  // graveyard it came from). Fires a real ETB (Necromancy's own "if it's on the battlefield" clause
  // and the full aura-reattachment/sacrifice-if-Necromancy-leaves mechanic aren't modeled -- just
  // the core reanimation, same narrowing precedent as everywhere else in this engine).
  reanimateFromGraveyard(lobby, ctx, params) {
    const found = findAndRemoveGraveyardEntry(lobby, params.chosenTargetId);
    if (!found) return;
    const card = spawnBattlefieldCard(lobby, { ...found.entry, owner: ctx.controllerId, zoneType: classifyType(found.entry.type) });
    broadcastPlayers(lobby); // the graveyard array just shrank
    fireEtbTriggers(lobby, card);
  },
  // Tortured Existence -- "Return target creature card from your graveyard to your HAND" (not the
  // battlefield) -- the one-zone-shallower counterpart to reanimateFromGraveyard, same
  // findAndRemoveGraveyardEntry primitive.
  returnGraveyardCardToHand(lobby, ctx, params) {
    const found = findAndRemoveGraveyardEntry(lobby, params.chosenTargetId);
    if (!found) return;
    spawnBattlefieldCard(lobby, { ...found.entry, owner: ctx.controllerId, faceDown: true, zoneType: "hand" });
    broadcastPlayers(lobby);
  },
  // Mistmoon Griffin -- "When this creature dies, exile it, then return the top creature card of
  // your graveyard to the battlefield." By the time this (requiresTarget:false, stack-resolved)
  // effect runs, the dying Griffin is ALREADY sitting in its owner's graveyard array (fireDeathTriggers
  // fires before sendToGraveyardInternal, but that's a synchronous non-blocking call, while this
  // effect only runs later once the stack actually resolves) -- "exile it" is just removing that
  // same entry back out without reanimating it. "The top creature card" is the most-recently-added
  // (highest index) creature card in the graveyard array, since sendToGraveyardInternal always
  // pushes onto the end -- searched AFTER removing the Griffin's own entry so it can never pick
  // itself back up.
  exileSelfAndReanimateTopGraveyardCreature(lobby, ctx) {
    const p = lobby.players[ctx.controllerId];
    if (!p || !ctx.sourceCard) return;
    const selfIdx = (p.graveyard || []).findIndex((e) => e.id === ctx.sourceCard.id);
    if (selfIdx !== -1) p.graveyard.splice(selfIdx, 1);
    for (let i = p.graveyard.length - 1; i >= 0; i--) {
      if ((p.graveyard[i].type || "").toLowerCase().includes("creature")) {
        const [entry] = p.graveyard.splice(i, 1);
        const card = spawnBattlefieldCard(lobby, { ...entry, owner: ctx.controllerId, zoneType: classifyType(entry.type) });
        broadcastPlayers(lobby);
        fireEtbTriggers(lobby, card);
        return;
      }
    }
    broadcastPlayers(lobby);
  },
  // Animate Dead -- same core reanimation as reanimateFromGraveyard, plus actually attaching the
  // Aura itself to the reanimated creature (so its own "Enchanted creature gets -1/-0" line applies
  // automatically via the existing attachedBonusFor/equipEffectsFromText machinery, zero extra code
  // needed for that part). Deliberately NOT modeled: "when this Aura leaves the battlefield, that
  // creature's controller sacrifices it" -- no general "when THIS permanent leaves play, do X to
  // something else" hook exists in this app (detachDependents only covers the opposite direction:
  // a creature dying takes its own attached aura with it, not an aura leaving taking the creature).
  // A disclosed simplification: the reanimated creature stays in play even if Animate Dead is later
  // removed, rather than being sacrificed as the real card would require.
  reanimateAndAttachAsAura(lobby, ctx, params) {
    const found = findAndRemoveGraveyardEntry(lobby, params.chosenTargetId);
    if (!found) return;
    const card = spawnBattlefieldCard(lobby, { ...found.entry, owner: ctx.controllerId, zoneType: classifyType(found.entry.type) });
    broadcastPlayers(lobby);
    fireEtbTriggers(lobby, card);
    const aura = ctx.sourceCard && lobby.cards[ctx.sourceCard.id];
    if (aura) { aura.attachedTo = card.id; broadcastCard(lobby, aura); }
  },
  // Living Death -- "Each player exiles all creature cards from their graveyard, then sacrifices
  // all creatures they control, then puts all cards they exiled this way onto the battlefield."
  // No targeting at all (every player is affected identically), so this is one self-contained
  // effect rather than a target-choice flow. Order matters and is followed exactly: graveyard
  // creatures are snapshotted and REMOVED first, so newly-sacrificed creatures from step 2 don't
  // get swept into the very reanimation this same spell just caused -- matches the real card's own
  // sequencing (its own three clauses happen in that fixed order for every player at once).
  livingDeathAll(lobby) {
    const snapshots = {}; // playerId -> [entry, entry, ...] pulled from their graveyard before anything else happens
    for (const pid in lobby.players) {
      const p = lobby.players[pid];
      const creatureEntries = (p.graveyard || []).filter((e) => (e.type || "").toLowerCase().includes("creature"));
      p.graveyard = (p.graveyard || []).filter((e) => !creatureEntries.includes(e));
      snapshots[pid] = creatureEntries;
    }
    Object.values(lobby.cards).filter((c) => c.zoneType === "creature").forEach((c) => {
      fireDeathTriggers(lobby, c);
      sendToGraveyardInternal(lobby, c);
    });
    for (const pid in snapshots) {
      snapshots[pid].forEach((entry) => {
        const card = spawnBattlefieldCard(lobby, { ...entry, owner: pid, zoneType: classifyType(entry.type) });
        fireEtbTriggers(lobby, card);
      });
    }
    broadcastPlayers(lobby);
  },
  // Victimize's second stage (after both graveyard targets are chosen -- see the ACTIVATED_ABILITIES-
  // style two-step queueTargetChoice chain in its own CARD_ABILITIES entry) -- "Sacrifice a creature.
  // If you do, return the chosen cards to the battlefield tapped." WHICH creature gets sacrificed to
  // pay for this isn't a real choice the way it matters for something like Ashnod's Altar (you'd
  // always rather keep your two freshly-reanimated threats than whatever you're feeding it), so this
  // auto-picks the controller's own first creature -- same disclosed auto-pick precedent as
  // Pashalik Mons/Ashnod's Altar's own cost-paying. If there's no creature at all to sacrifice, the
  // whole effect fizzles (matching "if you do" -- the reanimation is conditional on the sacrifice
  // actually happening), same CR-603.3c-style "no legal way to pay, nothing happens" precedent used
  // throughout this app for optional/conditional costs.
  victimizeSacrificeAndReanimateBoth(lobby, ctx, params) {
    const sacrifice = Object.values(lobby.cards).find((c) => c.owner === ctx.controllerId && c.zoneType === "creature");
    if (!sacrifice) return;
    fireDeathTriggers(lobby, sacrifice);
    sendToGraveyardInternal(lobby, sacrifice);
    [params.firstEntryId, params.chosenTargetId].forEach((entryId) => {
      const found = findAndRemoveGraveyardEntry(lobby, entryId);
      if (!found) return;
      const card = spawnBattlefieldCard(lobby, { ...found.entry, owner: ctx.controllerId, zoneType: classifyType(found.entry.type) });
      card.tapped = true;
      broadcastCard(lobby, card);
      fireEtbTriggers(lobby, card);
    });
    broadcastPlayers(lobby);
  },
  // Victimize's first stage -- the first of the two graveyard cards has now been chosen
  // (params.chosenTargetId), so queue the SECOND target choice, carrying the first pick's id along
  // as a plain extra field (chooseTargetFor's baking step only ever ADDS chosenTargetId, so a
  // pre-set field like this survives untouched into the next effect).
  victimizeChooseSecond(lobby, ctx, params) {
    queueTargetChoice(lobby, {
      controllerId: ctx.controllerId, sourceCard: ctx.sourceCard,
      label: "Victimize — choose the second creature card in your graveyard", targetKind: "ownGraveyardCreature",
      effects: [{ type: "victimizeSacrificeAndReanimateBoth", firstEntryId: params.chosenTargetId }]
    });
  },
  // Reanimate -- same core reanimation as reanimateFromGraveyard, plus "you lose life equal to that
  // card's mana value," a genuinely dynamic cost this engine has nowhere else to source except the
  // reanimated card's own entry. Life loss is applied AFTER the creature is already on the
  // battlefield (matches the real card's own clause order), so a lethal loss here still leaves the
  // reanimated creature in play -- checkEliminations handles the caster's own death normally.
  reanimateLoseLifeEqualToCmc(lobby, ctx, params) {
    const found = findAndRemoveGraveyardEntry(lobby, params.chosenTargetId);
    if (!found) return;
    const card = spawnBattlefieldCard(lobby, { ...found.entry, owner: ctx.controllerId, zoneType: classifyType(found.entry.type) });
    broadcastPlayers(lobby);
    fireEtbTriggers(lobby, card);
    applyLifeLoss(lobby, ctx.controllerId, found.entry.cmc || 0);
    checkEliminations(lobby);
    broadcastPlayers(lobby);
  },
  // Whip of Erebos's activated reanimation -- same core effect as reanimateFromGraveyard, plus
  // haste (temporary, via the real until-end-of-turn keyword system) and a real delayed trigger
  // exiling that SAME card at the next end step (not just "when it would leave the battlefield" --
  // the "exile instead of anywhere else" replacement clause on an early death isn't modeled, a
  // disclosed narrowing).
  reanimateWithHasteExileAtEndStep(lobby, ctx, params) {
    const found = findAndRemoveGraveyardEntry(lobby, params.chosenTargetId);
    if (!found) return;
    const card = spawnBattlefieldCard(lobby, { ...found.entry, owner: ctx.controllerId, zoneType: classifyType(found.entry.type) });
    broadcastPlayers(lobby);
    fireEtbTriggers(lobby, card);
    grantTemporaryKeyword(lobby, card, "Haste");
    queueDelayedTrigger(lobby, {
      firesAtPhase: "End Step", controllerId: ctx.controllerId, sourceCard: card,
      label: `${card.name || "A creature"} — exile (Whip of Erebos)`, effects: [{ type: "exileChosenCardById", targetCardId: card.id }]
    });
  },
  // Liesa, Forgotten Archangel's delayed return-to-hand -- entryId/ownerId baked in at queue time
  // (see fireLiesaReturnToHandTrigger). If the card already left that graveyard some other way by
  // the time this resolves (redirected to exile, reanimated elsewhere, etc.), it simply can't be
  // found and this fizzles -- matches real Magic's "the delayed trigger has no legal target
  // anymore" outcome, not a bug.
  returnGraveyardEntryToHandById(lobby, ctx, params) {
    const owner = lobby.players[params.ownerId];
    if (!owner) return;
    const idx = (owner.graveyard || []).findIndex((e) => e.id === params.entryId);
    if (idx === -1) return;
    const [entry] = owner.graveyard.splice(idx, 1);
    spawnBattlefieldCard(lobby, { ...entry, owner: params.ownerId, zoneType: "hand" });
    broadcastPlayers(lobby);
  },
  // Argivian Find -- "Return target artifact or enchantment card from your graveyard to your hand."
  // Same underlying move as returnGraveyardEntryToHandById just above, but reached through a real
  // target choice (chosenTargetId, baked in by chooseTargetFor) instead of a value pre-baked at
  // delayed-trigger queue time -- "your own graveyard" means the owner is always the caster.
  returnOwnGraveyardEntryToHand(lobby, ctx, params) {
    const owner = lobby.players[ctx.controllerId];
    if (!owner || !params.chosenTargetId) return;
    const idx = (owner.graveyard || []).findIndex((e) => e.id === params.chosenTargetId);
    if (idx === -1) return;
    const [entry] = owner.graveyard.splice(idx, 1);
    spawnBattlefieldCard(lobby, { ...entry, owner: ctx.controllerId, zoneType: "hand" });
    broadcastPlayers(lobby);
  },
  // Mortuary Mire / Hall of Heliod's Generosity -- "Put target [type] card from your graveyard on
  // top of your library." The top-of-library sibling of returnOwnGraveyardEntryToHand just above,
  // same chosenTargetId flow, just unshift onto the library instead of spawning into hand.
  putOwnGraveyardEntryOnTopOfLibrary(lobby, ctx, params) {
    const owner = lobby.players[ctx.controllerId];
    if (!owner || !params.chosenTargetId) return;
    const idx = (owner.graveyard || []).findIndex((e) => e.id === params.chosenTargetId);
    if (idx === -1) return;
    const [entry] = owner.graveyard.splice(idx, 1);
    owner.library.unshift(entry);
    broadcastPlayers(lobby);
  },
  // Mistveil Plains -- the bottom-of-library sibling of the above (push instead of unshift).
  putOwnGraveyardEntryOnBottomOfLibrary(lobby, ctx, params) {
    const owner = lobby.players[ctx.controllerId];
    if (!owner || !params.chosenTargetId) return;
    const idx = (owner.graveyard || []).findIndex((e) => e.id === params.chosenTargetId);
    if (idx === -1) return;
    const [entry] = owner.graveyard.splice(idx, 1);
    owner.library.push(entry);
    broadcastPlayers(lobby);
  },
  // A specific, pre-chosen card baked in at queue time (see queueDelayedTrigger) -- not a player
  // choice, so this doesn't go through the normal chosenTargetId flow.
  exileChosenCardById(lobby, ctx, params) {
    const card = lobby.cards[params.targetCardId];
    if (card) exileCardInternal(lobby, card);
  },
  // Kiki-Jiki, Mirror Breaker's delayed sacrifice -- same "specific pre-chosen card baked in at
  // queue time" shape as exileChosenCardById just above, sacrifice instead of exile. If the token
  // already left the battlefield some other way first (destroyed, bounced), this simply can't find
  // it and fizzles, matching a real delayed trigger with no legal target left.
  sacrificeChosenCardById(lobby, ctx, params) {
    const card = lobby.cards[params.targetCardId];
    if (!card) return;
    fireDeathTriggers(lobby, card);
    sendToGraveyardInternal(lobby, card);
  },
  // Kiki-Jiki, Mirror Breaker -- "{T}: Create a token that's a copy of another target nonlegendary
  // creature you control, except it has haste. Sacrifice it at the beginning of the next end
  // step." Unlike becomeCopyUntilEOT (which turns the SOURCE card itself into a temporary copy),
  // this spawns a genuinely new token permanent, reusing the same copiable-characteristics field
  // list. "Nonlegendary" isn't checked -- this app's targetKind vocabulary has no legendary-status
  // filter -- a disclosed simplification, same as Weathered Wayfarer's unchecked land-count
  // condition elsewhere in this table.
  createTokenCopyWithHaste(lobby, ctx, params) {
    const source = lobby.cards[params.chosenTargetId];
    if (!source) return;
    const COPY_FIELDS = ["name", "type", "manaCost", "cmc", "colors", "colorIdentity", "power", "toughness", "text", "keywords", "img", "producedMana", "loyalty"];
    const data = {};
    COPY_FIELDS.forEach((f) => { data[f] = source[f]; });
    const hasHaste = (data.keywords || []).some((k) => (k || "").toLowerCase() === "haste");
    if (!hasHaste) data.keywords = [...(data.keywords || []), "Haste"];
    data.owner = ctx.controllerId;
    data.zoneType = classifyType(data.type);
    const token = spawnBattlefieldCard(lobby, data);
    const p = lobby.players[ctx.controllerId];
    pushLog(lobby, `${p ? p.name : "Someone"} creates a token copy of ${source.name || "a creature"} (Kiki-Jiki, Mirror Breaker)`);
    // Look up the real Kiki-Jiki card (ctx.sourceCard here is often just {id} -- see
    // executeAbilityEffects) so the delayed stack item gets a real name/image, same as Whip of
    // Erebos's own delayed-exile trigger does.
    const kiki = (ctx.sourceCard && lobby.cards[ctx.sourceCard.id]) || ctx.sourceCard;
    queueDelayedTrigger(lobby, {
      firesAtPhase: "End Step", controllerId: ctx.controllerId, sourceCard: kiki,
      label: `Sacrifice the token copy of ${source.name || "a creature"} (Kiki-Jiki, Mirror Breaker)`,
      effects: [{ type: "sacrificeChosenCardById", targetCardId: token.id }]
    });
  },
  // Miirym, Sentinel Wyrm -- "create a token that's a copy of it [the entering Dragon], except the
  // token isn't legendary." Same copiable-characteristics field list as createTokenCopyWithHaste,
  // minus the haste/sacrifice-at-end-step wrapper (this copy is permanent) and with the Legendary
  // supertype stripped from the copied type line instead. enteringCardId is baked in by
  // fireGlobalOtherCreatureEtbTriggers itself (see its own comment), no target needed. Doesn't
  // re-fire the new token's own ETB triggers, same disclosed precedent as createTokenCopyWithHaste.
  createTokenCopyOfEnteringCreature(lobby, ctx, params) {
    const source = lobby.cards[params.enteringCardId];
    if (!source) return;
    const COPY_FIELDS = ["name", "type", "manaCost", "cmc", "colors", "colorIdentity", "power", "toughness", "text", "keywords", "img", "producedMana", "loyalty"];
    const data = {};
    COPY_FIELDS.forEach((f) => { data[f] = source[f]; });
    data.type = (data.type || "").replace(/\blegendary\s+/i, "");
    data.owner = ctx.controllerId;
    data.zoneType = classifyType(data.type);
    const token = spawnBattlefieldCard(lobby, data);
    const p = lobby.players[ctx.controllerId];
    pushLog(lobby, `${p ? p.name : "Someone"} creates a token copy of ${source.name || "a creature"}`);
  },
  // Hellkite Courser -- chosenTargetId here is the commander's SLOT (0 or 1, see the
  // ownCommanderInZone targetKind), not a card id. Puts it onto the battlefield with temporary
  // haste, then queues a delayed trigger returning it to the Command Zone at the next end step.
  putCommanderFromZoneWithHaste(lobby, ctx, params) {
    const p = lobby.players[ctx.controllerId];
    const slot = parseInt(params.chosenTargetId, 10);
    const cmd = p && p.commanders[slot];
    if (!cmd || cmd.battlefieldId) return;
    const card = spawnBattlefieldCard(lobby, { ...cmd, owner: ctx.controllerId, zoneType: classifyType(cmd.type), isCommander: true });
    cmd.battlefieldId = card.id;
    broadcastPlayers(lobby);
    fireEtbTriggers(lobby, card);
    grantTemporaryKeyword(lobby, card, "Haste");
    queueDelayedTrigger(lobby, {
      firesAtPhase: "End Step", controllerId: ctx.controllerId, sourceCard: card,
      label: `${card.name || "A commander"} — return to the Command Zone (Hellkite Courser)`, effects: [{ type: "returnCommanderToZoneById", targetCardId: card.id }]
    });
  },
  // A specific, pre-chosen commander (by its CURRENT battlefield id, baked in at queue time)
  // returning directly to the Command Zone -- not dying, so this bypasses
  // sendToGraveyardInternal's commander special-case entirely and just does the equivalent
  // directly (clearCommanderRef already resets battlefieldId to null, the same "docked commander
  // is castable again" state that special case relies on).
  returnCommanderToZoneById(lobby, ctx, params) {
    const card = lobby.cards[params.targetCardId];
    if (!card) return;
    const owner = lobby.players[card.owner];
    clearCommanderRef(lobby, card);
    delete lobby.cards[card.id];
    io.to(lobby.id).emit("cardRemove", card.id);
    if (owner) pushLog(lobby, `${owner.name}'s ${card.name || "commander"} returned to the Command Zone`);
  },
  // For "any target"/"creature" spells that deal damage. chosenTargetId can resolve to either a
  // player or a creature -- check players first since a player id never collides with a card id.
  // Sub-lethal damage to a creature has no persistent effect: this app never marks/tracks damage
  // between separate actions (combat damage is likewise computed fresh and instantaneous each time,
  // never stored on the card), so there's nothing to represent short of destroying it outright.
  // Hobgoblin Bandit Lord -- "damage equal to the number of Goblins that entered the battlefield
  // under your control THIS TURN." No separate per-turn counter needed: every permanent already
  // gets stamped with controllerSince = the turn number it entered (spawnBattlefieldCard, used for
  // summoning sickness) -- comparing that against the CURRENT turn number is exactly "entered this
  // turn," and it already covers tokens (Krenko/Hordeling Outburst, etc.) the same as real cards
  // since they go through the same spawn path. Delegates to damageTarget itself (not a separate
  // damage-application copy) so Twinflame Tyrant-style doubling and everything else damageTarget
  // already handles keeps working here for free.
  damageEqualToGoblinsEnteredThisTurn(lobby, ctx, params) {
    const amount = Object.values(lobby.cards).filter((c) => c.owner === ctx.controllerId && c.zoneType === "creature" && c.controllerSince === lobby.turn.turnNumber && (c.type || "").toLowerCase().includes("goblin")).length;
    EFFECTS.damageTarget(lobby, ctx, { ...params, amount });
  },
  damageTarget(lobby, ctx, params) {
    let amount = params.amount || 0;
    const sourceCardId = ctx.sourceCard && ctx.sourceCard.id;
    // Twinflame Tyrant doubling only applies to an OPPONENT (or their permanent) -- never to the
    // controller's own life total or creatures, matching its real "an opponent" wording.
    const p = lobby.players[params.chosenTargetId];
    if (p) {
      if (params.chosenTargetId !== ctx.controllerId) amount *= damageMultiplierFor(lobby, ctx.controllerId, ctx.sourceCard);
      amount = reduceDamageForVictim(lobby, params.chosenTargetId, amount);
      if (applyLifeLoss(lobby, params.chosenTargetId, amount, sourceCardId)) {
        io.to(lobby.id).emit("spellDamage", { targetId: params.chosenTargetId, amount, sourceCardId });
      }
      return;
    }
    const card = lobby.cards[params.chosenTargetId];
    if (!card) return;
    if (card.owner !== ctx.controllerId) amount *= damageMultiplierFor(lobby, ctx.controllerId, ctx.sourceCard);
    // Emitted for the visual burst regardless of whether this ends up lethal -- a creature target
    // taking sub-lethal damage still has nothing MECHANICAL to represent (see the comment on this
    // effect's doc block above), but there's no reason it shouldn't visibly react.
    io.to(lobby.id).emit("spellDamage", { targetId: card.id, amount, sourceCardId });
    const bonus = attachedBonusFor(lobby, card);
    const stat = staticBonusFor(lobby, card);
    const effToughness = parsePT(card.toughness) + (card.counters || 0) + bonus.toughnessBonus + stat.toughnessBonus;
    if (amount >= effToughness) {
      fireDeathTriggers(lobby, card);
      sendToGraveyardInternal(lobby, card);
    }
  },
  // chosenTargetId here refers to a STACK ITEM's own id (a cast spell or a triggered ability sitting
  // on the stack), not a card in play -- validated as such by resolveChosenTarget's "spell" targetKind
  // before this ever runs. Shares its removal logic with the manual Counter button (counterStackItem).
  counterTargetSpell(lobby, ctx, params) {
    // Rhythm of the Wild and its functional cousins -- see isProtectedFromCountering's own comment.
    // The spell survives untouched on the stack (a real "can't be countered" spell just keeps
    // resolving normally later), not sent to the graveyard the way a fizzled/no-legal-target effect
    // would be.
    const pending = lobby.stack.find((s) => s.id === params.chosenTargetId);
    if (isProtectedFromCountering(lobby, pending)) { pushLog(lobby, `${pending.name || "That spell"} can't be countered.`); return; }
    const item = removeStackItem(lobby, params.chosenTargetId);
    if (!item) return;
    const owner = lobby.players[item.owner];
    const caster = lobby.players[ctx.controllerId];
    if (owner) pushLog(lobby, `${caster ? caster.name : "Someone"} countered ${owner.name}'s ${item.name || "spell"}`);
  },
  // Arcane Denial -- "Counter target spell. Its controller may draw up to two cards at the beginning
  // of the next turn's upkeep. You draw a card at the beginning of the next turn's upkeep." Both
  // draws are queued as one-shot delayed triggers (queueDelayedTrigger, the same mechanism Hellkite
  // Courser/Whip of Erebos/Liesa use for "next end step", just firesAtPhase:"Upkeep" instead) --
  // "may... up to two" is resolved as an unconditional draw of the max amount, same "no real
  // downside to always taking it" simplification this app applies to other purely-beneficial
  // optional effects elsewhere, rather than building a real opt-out prompt for one clause.
  counterTargetSpellDelayedDraws(lobby, ctx, params) {
    const pendingDenial = lobby.stack.find((s) => s.id === params.chosenTargetId);
    if (isProtectedFromCountering(lobby, pendingDenial)) { pushLog(lobby, `${pendingDenial.name || "That spell"} can't be countered.`); return; }
    const item = removeStackItem(lobby, params.chosenTargetId);
    if (!item) return;
    const owner = lobby.players[item.owner];
    const caster = lobby.players[ctx.controllerId];
    if (owner) pushLog(lobby, `${caster ? caster.name : "Someone"} countered ${owner.name}'s ${item.name || "spell"}`);
    const src = ctx.sourceCard && lobby.cards[ctx.sourceCard.id];
    if (owner) queueDelayedTrigger(lobby, { firesAtPhase: "Upkeep", controllerId: item.owner, sourceCard: src, label: "Arcane Denial — draw up to two cards", effects: [{ type: "drawCards", amount: 2 }] });
    queueDelayedTrigger(lobby, { firesAtPhase: "Upkeep", controllerId: ctx.controllerId, sourceCard: src, label: "Arcane Denial — draw a card", effects: [{ type: "drawCards", amount: 1 }] });
  },
  // Swan Song -- "Counter target enchantment, instant, or sorcery spell. Its controller creates a
  // 2/2 blue Bird creature token with flying." The token goes to the COUNTERED SPELL's controller
  // (item.owner, captured by removeStackItem before the item is gone), not this spell's own caster --
  // same "capture the other player's identity before removal" shape as
  // destroyTargetCreateTokenForController.
  counterTargetSpellCreateTokenForController(lobby, ctx, params) {
    const pendingSwan = lobby.stack.find((s) => s.id === params.chosenTargetId);
    if (isProtectedFromCountering(lobby, pendingSwan)) { pushLog(lobby, `${pendingSwan.name || "That spell"} can't be countered.`); return; }
    const item = removeStackItem(lobby, params.chosenTargetId);
    if (!item) return;
    const owner = lobby.players[item.owner];
    const caster = lobby.players[ctx.controllerId];
    if (owner) pushLog(lobby, `${caster ? caster.name : "Someone"} countered ${owner.name}'s ${item.name || "spell"}`);
    // params.amount (An Offer You Can't Refuse -- TWO Treasures, not Swan Song's one) -- defaults to
    // 1 so every existing single-token entry is unaffected.
    for (let i = 0; i < (params.amount || 1); i++) {
      spawnBattlefieldCard(lobby, {
        name: params.tokenName || "Token", type: params.tokenType || "Token Creature", img: params.img || "",
        power: params.power, toughness: params.toughness, colors: params.colors || [],
        keywords: params.keywords || [], owner: item.owner, zoneType: classifyType(params.tokenType || "Token Creature")
      });
    }
  },
  // Reuses the exact same pendingDiscard mechanism as the existing "discard down to 7 cards" hand-
  // size check (resolveDiscard) -- it was already fully generic (any player, any count, any time),
  // just previously only ever set from the End Step overflow check. A second discard becoming due
  // before this one resolves would overwrite it (single slot, not a queue) -- accepted as a rare-
  // edge-case limitation, matching this app's existing no-queueing-of-that-particular-state precedent.
  // params.self (Faithless Looting/Frantic Search's OWN discard, no "target player" on the card at
  // all) routes this at the controller instead of requiring a real target choice -- same effect,
  // just skips queueTargetChoice entirely since there's nothing to choose.
  targetPlayerDiscards(lobby, ctx, params) {
    const playerId = params.self ? ctx.controllerId : params.chosenTargetId;
    const p = lobby.players[playerId];
    if (!p) return;
    const handCount = Object.values(lobby.cards).filter((c) => c.owner === playerId && c.zoneType === "hand").length;
    const count = Math.min(params.amount || 1, handCount);
    if (count <= 0) return;
    lobby.turn.pendingDiscard = { playerId, count };
    broadcastTurn(lobby);
    pushLog(lobby, `${p.name} must discard ${count} card${count === 1 ? "" : "s"}`);
  },
  // Connive (Ledger Shredder and any future connive card) -- "Draw a card, then discard a card. If
  // you discarded a nonland card this way, put a +1/+1 counter on this creature." The draw half is
  // immediate; the discard half reuses the exact same pendingDiscard/resolveDiscard pipeline as
  // targetPlayerDiscards just above, tagged with a `connive` marker resolveDiscard checks for its
  // own follow-up (adding the counter based on what was ACTUALLY discarded) -- see resolveDiscard's
  // own comment for why that check has to live there rather than here (this function returns long
  // before the player has picked a card).
  connive(lobby, ctx, params) {
    const p = lobby.players[ctx.controllerId];
    if (!p || !ctx.sourceCard) return;
    drawN(lobby, ctx.controllerId, 1);
    const handCount = Object.values(lobby.cards).filter((c) => c.owner === ctx.controllerId && c.zoneType === "hand").length;
    if (handCount <= 0) return;
    lobby.turn.pendingDiscard = { playerId: ctx.controllerId, count: 1, connive: { sourceCardId: ctx.sourceCard.id } };
    broadcastTurn(lobby);
    pushLog(lobby, `${p.name} connives (${ctx.sourceCard.name || "a creature"})`);
  },
  // Fetchlands ("Search your library for a Mountain or Plains card...") -- WHICH card to fetch is a
  // real choice among however many matches are in a 99-card library, not something automatable the
  // way a fixed-effect spell is. This sets up pendingFetch and prompts the controller to open their
  // own library (already viewable/searchable via the existing zone-modal) and pick one via the new
  // fetchLand handler, rather than trying to guess or list every match server-side. Search is always
  // optional in real Magic even with a legal target -- cancelFetch (also new) covers "find nothing."
  // params.thenEffects (Cultivate's own "...and the other into your hand") -- same "bundle the
  // follow-up, don't let it run as a plain sibling effect" fix as scryN's own comment explains;
  // fetchLand (below) is what actually runs it, once THIS fetch is really done.
  // params.untapIfLandCountAtLeast (Fabled Passage's "then if you control four or more lands,
  // untap that land") -- checked by fetchLand once the fetched land is already on the battlefield,
  // so the count naturally includes it, matching real Magic's own "after it enters" timing.
  searchLandTypes(lobby, ctx, params) {
    const p = lobby.players[ctx.controllerId];
    if (!p) return;
    p.pendingFetch = { types: params.types || [], basicOnly: !!params.basicOnly, forceTapped: !!params.entersTapped, thenEffects: params.thenEffects || null, sourceCardId: ctx.sourceCard && ctx.sourceCard.id, untapIfLandCountAtLeast: params.untapIfLandCountAtLeast || null };
    const sock = io.sockets.sockets.get(ctx.controllerId);
    if (sock) sock.emit("searchLibrary", { types: p.pendingFetch.types, basicOnly: p.pendingFetch.basicOnly });
  },
  // Field of Ruin -- "Each player searches their library for a basic land card, puts it onto the
  // battlefield, then shuffles." Same pendingFetch/searchLibrary flow as searchLandTypes just
  // above, looped over every real player at the table instead of only the ability's own controller
  // -- each player gets their own independent search prompt via the existing fetchLand handler.
  eachPlayerSearchesForBasicLand(lobby, ctx, params) {
    Object.keys(lobby.players).forEach((pid) => {
      EFFECTS.searchLandTypes(lobby, { controllerId: pid, sourceCard: ctx.sourceCard }, { types: ["Plains", "Island", "Swamp", "Mountain", "Forest"], basicOnly: true });
    });
  },
  // "Search your library for a card, put it into your hand" (Demonic Tutor and similar) -- same
  // "server sets up a pending choice, client prompts via the library zone-modal, a dedicated handler
  // finishes it" shape as searchLandTypes above, just landing in hand instead of onto the
  // battlefield and (optionally) restricted to a type substring instead of "must be a land". Life
  // loss (Grim Tutor) is paid immediately, same as any other cost -- real Magic never blocks it.
  // params.toTopOfLibrary (Vampiric Tutor: "...then shuffle and put that card on top") -- same
  // pending-choice flow as the plain hand-tutoring case, just a different final destination, see
  // the tutorCard handler.
  // params.toGraveyard (Buried Alive: "search for up to three creature cards, put them into your
  // graveyard") -- a third destination alongside hand/toTopOfLibrary, see the tutorCard handler.
  // params.thenEffects chains a repeat search (Myriad Landscape's own chained-second-fetch shape,
  // nested three deep here for "up to three" total picks) -- run by tutorCard once THIS pick
  // resolves, same "bundle the follow-up, don't let it fire as a premature sibling effect" reasoning
  // as scryN/searchLandTypes's own thenEffects. A player cancelling early (searchLibraryForHand's
  // own Cancel) correctly stops the chain rather than forcing all three, matching "up to N".
  tutorToHand(lobby, ctx, params) {
    const p = lobby.players[ctx.controllerId];
    if (!p) return;
    if (params.lifeLoss) { applyLifeLoss(lobby, ctx.controllerId, params.lifeLoss); checkEliminations(lobby); }
    p.pendingTutor = { typeFilter: params.typeFilter || null, toTopOfLibrary: !!params.toTopOfLibrary, toGraveyard: !!params.toGraveyard, thenEffects: params.thenEffects || null, sourceCardId: ctx.sourceCard && ctx.sourceCard.id };
    const sock = io.sockets.sockets.get(ctx.controllerId);
    if (sock) sock.emit("searchLibraryForHand", { typeFilter: p.pendingTutor.typeFilter });
    broadcastPlayers(lobby);
  },
  // Goblin Recruiter -- "search your library for any number of Goblin cards, reveal them, then
  // shuffle and put those cards on top in any order." Unlike tutorToHand/searchLandTypes (an
  // interactive search among however many matches, since WHICH one to take is a real choice), "any
  // number" here means EVERY match is taken at once -- deterministic, same "no real choice, just
  // grab them all" reasoning as lookTopNRevealTypesToHand (Kaalia) already established, just
  // searching the WHOLE library instead of a fixed top slice, and landing back on top instead of in
  // hand. The relative order the matches go back on top in isn't a real choice either way in this
  // app (no reorder UI for this), so they're stacked back on in whatever order they were found --
  // a disclosed simplification, same precedent as "any order"/"random order" everywhere else.
  searchAllMatchingToTop(lobby, ctx, params) {
    const p = lobby.players[ctx.controllerId];
    if (!p) return;
    const filter = params.typeFilter || [];
    const matched = p.library.filter((e) => filter.some((t) => (e.type || "").toLowerCase().includes(t)));
    if (!matched.length) { pushLog(lobby, `${p.name} finds no matching cards`); return; }
    p.library = p.library.filter((e) => !matched.includes(e));
    shuffle(p.library);
    matched.forEach((e) => p.library.unshift(e));
    pushLog(lobby, `${p.name} searches their library for ${matched.length} matching card${matched.length === 1 ? "" : "s"} and puts them on top`);
    broadcastPlayers(lobby);
  },
  // Frantic Search's "Untap up to three lands" -- auto-picks the first N currently-tapped lands the
  // caster controls rather than offering a real choice among them (which specific lands rarely
  // matters here, and no multi-select UI exists for this), same "auto-pick" precedent as
  // eachOpponentSacrifices. A no-op past however many are actually tapped, same as "up to" always is.
  untapUpToNOwnLands(lobby, ctx, params) {
    const lands = Object.values(lobby.cards).filter((c) => c.owner === ctx.controllerId && c.zoneType === "mana" && c.tapped).slice(0, params.amount || 1);
    lands.forEach((c) => { c.tapped = false; broadcastCard(lobby, c); });
  },
  // Scry N (Ponder/Preordain and a very common real keyword ability) -- looks at the top N cards
  // PRIVATELY (emitted only to this player's own socket, never broadcast) and lets them choose,
  // per card, top or bottom; cards kept on top can be reordered, cards sent to the bottom keep their
  // original relative order (a real, disclosed simplification -- true Magic lets you order those
  // too, not worth a second reorder UI for the rare case anyone cares which of several cards is
  // 3rd-from-bottom vs 4th). See the resolveScry handler for how the response is applied.
  // params.thenEffects (Preordain/Ponder's own "...then draw a card") -- a plain sibling effect in
  // the SAME effects array (e.g. [{type:"scryN"}, {type:"drawCards"}]) would run IMMEDIATELY after
  // this returns, since scryN itself only sets up the pending choice and returns right away rather
  // than blocking for the player's real response -- the draw would fire against the PRE-scry library
  // order, not the reordered one. Bundling the follow-up here instead means resolveScry (below) is
  // what actually runs it, correctly AFTER the reorder is applied.
  scryN(lobby, ctx, params) {
    const p = lobby.players[ctx.controllerId];
    if (!p) return;
    const n = Math.min(params.amount || 1, p.library.length);
    if (n === 0) {
      (params.thenEffects || []).forEach((e) => { const fn = EFFECTS[e.type]; if (fn) fn(lobby, ctx, e); });
      return;
    }
    p.pendingScry = { count: n, thenEffects: params.thenEffects || null, sourceCardId: ctx.sourceCard && ctx.sourceCard.id };
    const sock = io.sockets.sockets.get(ctx.controllerId);
    if (sock) sock.emit("scryPrompt", { cards: p.library.slice(0, n).map((e, i) => ({ index: i, name: e.name, img: e.img, type: e.type })) });
  },
  // Surveil N -- scryN's graveyard-instead-of-bottom sibling. Shares its whole shape (a private
  // pendingSurveil holding the real top-N slice, resolved by the client choosing which indices
  // stay on top) since the only real difference is where a not-kept card ends up.
  surveilN(lobby, ctx, params) {
    const p = lobby.players[ctx.controllerId];
    if (!p) return;
    const n = Math.min(params.amount || 1, p.library.length);
    if (n === 0) {
      (params.thenEffects || []).forEach((e) => { const fn = EFFECTS[e.type]; if (fn) fn(lobby, ctx, e); });
      return;
    }
    p.pendingSurveil = { count: n, thenEffects: params.thenEffects || null, sourceCardId: ctx.sourceCard && ctx.sourceCard.id };
    const sock = io.sockets.sockets.get(ctx.controllerId);
    if (sock) sock.emit("surveilPrompt", { cards: p.library.slice(0, n).map((e, i) => ({ index: i, name: e.name, img: e.img, type: e.type })) });
  },
  // Kaalia of the Vast's signature ability: puts the chosen hand card (already validated against
  // handTypeFilter by resolveChosenTarget) onto the battlefield tapped AND attacking the same
  // player/planeswalker the source (Kaalia) is currently attacking -- looked up fresh from
  // lobby.combat.attackers rather than baked in at trigger time, since by the time this actually
  // resolves off the stack a responding player could in principle have changed combat state.
  // Fires the new creature's own ETB and attack triggers (CR 508.3d: entering attacking still
  // counts as "this creature attacks" for its own triggers), and skips it entirely if Kaalia
  // somehow isn't attacking anymore (removed from combat by a response) rather than stranding a
  // creature attacking nothing.
  // Warren Instigator -- putFromHandAttacking's plain counterpart: onto the battlefield normally,
  // not forced into the current combat.
  putHandCardOntoBattlefield(lobby, ctx, params) {
    const card = lobby.cards[params.chosenTargetId];
    if (!card || card.zoneType !== "hand") return;
    card.zoneType = classifyType(card.type);
    card.faceDown = false;
    card.controllerSince = lobby.turn.turnNumber;
    if (entersTapped(card, lobby)) card.tapped = true;
    broadcastCard(lobby, card);
    const p = lobby.players[ctx.controllerId];
    pushLog(lobby, `${p ? p.name : "?"} put ${card.name || "a card"} onto the battlefield`);
    fireEtbTriggers(lobby, card);
  },
  putFromHandAttacking(lobby, ctx, params) {
    const card = lobby.cards[params.chosenTargetId];
    if (!card || card.zoneType !== "hand") return;
    const sourceId = ctx.sourceCard && ctx.sourceCard.id;
    const defenderId = sourceId ? lobby.combat.attackers[sourceId] : null;
    if (!defenderId) return;
    card.zoneType = classifyType(card.type);
    card.faceDown = false;
    card.tapped = true;
    card.controllerSince = lobby.turn.turnNumber;
    broadcastCard(lobby, card);
    lobby.combat.attackers[card.id] = defenderId;
    broadcastCombat(lobby);
    const p = lobby.players[ctx.controllerId];
    pushLog(lobby, `${p ? p.name : "?"} put ${card.name || "a card"} onto the battlefield tapped and attacking`);
    fireEtbTriggers(lobby, card);
    fireAttackTriggers(lobby, card);
    fireGlobalAttackTypeTriggers(lobby, card);
  },
  // Utvara Hellkite -- "whenever a Dragon you control attacks, create a 6/6 red Dragon creature
  // token with flying that's tapped and attacking." attackerDefenderId (baked in by
  // fireGlobalAttackTypeTriggers) is who the ORIGINAL attacking Dragon is attacking -- the new
  // token joins that same attack, exactly like Kaalia's putFromHandAttacking above.
  createAttackingToken(lobby, ctx, params) {
    const token = spawnBattlefieldCard(lobby, {
      name: params.name || "Token", type: params.tokenType || "Token Creature", img: params.img || "",
      power: params.power, toughness: params.toughness, colors: params.colors || [],
      keywords: params.keywords || [], owner: ctx.controllerId, zoneType: classifyType(params.tokenType || "Token Creature")
    });
    token.tapped = true;
    broadcastCard(lobby, token);
    if (params.attackerDefenderId) {
      lobby.combat.attackers[token.id] = params.attackerDefenderId;
      broadcastCombat(lobby);
      fireAttackTriggers(lobby, token);
    }
  },
  // Hellkite Tyrant -- "gain control of all artifacts that player controls." dealtToPlayerId is
  // baked in by fireCombatDamageToPlayerTriggers at the moment damage actually landed, since this
  // effect might not resolve off the stack until well after combat has moved on. The separate "if
  // you control 20+ artifacts, you win the game" upkeep clause is NOT modeled -- no win-condition
  // system beyond normal elimination exists in this app.
  gainControlOfArtifacts(lobby, ctx, params) {
    const defenderId = params.dealtToPlayerId;
    if (!defenderId) return;
    let count = 0;
    Object.values(lobby.cards).forEach((c) => {
      if (c.owner !== defenderId || c.zoneType === "hand" || c.zoneType === "stack") return;
      if (!(c.type || "").toLowerCase().includes("artifact")) return;
      c.owner = ctx.controllerId;
      broadcastCard(lobby, c);
      count++;
    });
    if (count) {
      const p = lobby.players[ctx.controllerId];
      pushLog(lobby, `${p ? p.name : "?"} gained control of ${count} artifact${count === 1 ? "" : "s"}`);
    }
    broadcastPlayers(lobby);
  },
  // Aurelia / Combat Celebrant -- "untap all [other] creatures you control, and after this phase
  // there is an additional combat phase." Combat Celebrant's real cost (exert -- it doesn't untap
  // during your next untap step) isn't modeled; this always triggers rather than being a player
  // choice, same "may" simplification precedent used elsewhere for a strictly-upside effect. The
  // once-per-turn guard lives in each CARD_ABILITIES entry's own `condition` (now passed `lobby`
  // too, not just the card, specifically so it can compare against the CURRENT turn number) --
  // without it, a creature that attacks again in the extra combat phase it just granted would
  // grant ANOTHER one, forever.
  grantExtraCombatPhase(lobby, ctx, params) {
    Object.values(lobby.cards).forEach((c) => {
      if (c.owner !== ctx.controllerId || c.zoneType !== "creature") return;
      if (params.excludeSelf && ctx.sourceCard && c.id === ctx.sourceCard.id) return;
      if (c.tapped) { c.tapped = false; broadcastCard(lobby, c); }
    });
    if (params.stampCard && ctx.sourceCard) {
      const src = lobby.cards[ctx.sourceCard.id];
      if (src) src.lastExtraCombatTurn = lobby.turn.turnNumber;
    }
    lobby.turn.extraCombatsPending = (lobby.turn.extraCombatsPending || 0) + 1;
    broadcastTurn(lobby);
    const p = lobby.players[ctx.controllerId];
    pushLog(lobby, `${p ? p.name : "?"} untaps creatures -- there will be an additional combat phase`);
  },
  // Breath of Fury -- the "sacrifice it and attach this Aura to a creature you control" half, run
  // once a legal new host has actually been chosen (see fireBreathOfFuryTrigger). Reattaches the
  // Aura BEFORE sacrificing the old host, so detachDependents (which fires inside
  // sendToGraveyardInternal and would otherwise send an Aura straight to the graveyard the instant
  // its host dies) sees attachedTo already pointing at the NEW creature and leaves it alone. "If you
  // do" (CR 603.3c is inapplicable here since the reattach already succeeded by construction --
  // fireBreathOfFuryTrigger only ever queues this when a legal host exists) always reaches the
  // untap/extra-combat half.
  breathOfFuryReattach(lobby, ctx, params) {
    const aura = lobby.cards[params.auraId];
    const sacrificed = lobby.cards[params.sacrificedCardId];
    const newHost = lobby.cards[params.chosenTargetId];
    if (!aura || !sacrificed || !newHost) return;
    aura.attachedTo = newHost.id;
    broadcastCard(lobby, aura);
    fireDeathTriggers(lobby, sacrificed);
    sendToGraveyardInternal(lobby, sacrificed);
    EFFECTS.grantExtraCombatPhase(lobby, ctx, {});
  },
  // Rakdos Charm's third mode -- "each creature deals 1 damage to its controller." Damage FROM
  // each creature TO its own controller's life total, not damage to the creature itself.
  eachCreatureDamagesController(lobby, ctx, params) {
    const amt = params.amount || 1;
    Object.values(lobby.cards).filter((c) => c.zoneType === "creature").forEach((c) => applyLifeLoss(lobby, c.owner, amt));
    broadcastPlayers(lobby);
    checkEliminations(lobby);
  },
  // Rakdos Charm's first mode -- "exile target player's graveyard."
  exilePlayerGraveyard(lobby, ctx, params) {
    const p = lobby.players[params.chosenTargetId];
    if (!p) return;
    p.exile.push(...p.graveyard);
    p.graveyard = [];
    broadcastPlayers(lobby);
  },
  // Balefire Dragon -- "whenever this creature deals combat damage to a player, it deals that much
  // damage to each creature that player controls." Same simple amount>=toughness lethality check
  // damageTarget already uses (no indestructible check there either -- only real COMBAT damage
  // checks it, per the existing dealtLethal precedent; this is non-combat damage from an ability).
  damageAllCreaturesOfPlayer(lobby, ctx, params) {
    const defenderId = params.dealtToPlayerId;
    const amount = params.dealtToPlayerAmount;
    if (!defenderId || !amount) return;
    Object.values(lobby.cards).filter((c) => c.owner === defenderId && c.zoneType === "creature").forEach((c) => {
      const bonus = attachedBonusFor(lobby, c);
      const stat = staticBonusFor(lobby, c);
      const effToughness = parsePT(c.toughness) + (c.counters || 0) + bonus.toughnessBonus + stat.toughnessBonus;
      if (amount >= effToughness) { fireDeathTriggers(lobby, c); sendToGraveyardInternal(lobby, c); }
    });
  },
  // A real board wipe (Doomskar and similar "Destroy all creatures" sorceries) -- same
  // indestructible/regeneration handling as destroyTarget, applied table-wide. Foretell/alternate
  // casting costs some of these cards have aren't modeled -- they just cast (and wipe) normally for
  // their printed mana cost, same "the effect works, the alt-cost timing trick doesn't" narrowing
  // already used elsewhere (Cursed Mirror's Haste, Whip of Erebos's exile timing).
  destroyAllCreatures(lobby, ctx, params) {
    Object.values(lobby.cards).filter((c) => c.zoneType === "creature").forEach((c) => {
      if (effectiveKeywords(lobby, c).some((k) => (k || "").toLowerCase() === "indestructible")) return;
      // Damnation -- "They can't be regenerated." params.noRegen bypasses the regeneration-shield
      // check below entirely, same shape as every other narrow per-card flag on a shared effect.
      if (!params.noRegen && c.regenerationShield > 0) {
        c.regenerationShield -= 1;
        c.tapped = true;
        broadcastCard(lobby, c);
        pushLog(lobby, `${c.name || "A creature"} regenerates instead of being destroyed`);
        return;
      }
      fireDeathTriggers(lobby, c);
      sendToGraveyardInternal(lobby, c);
    });
  },
  // Wave 15 gap-analysis batch.
  // Depopulate -- "Each player who controls a multicolored creature draws a card. Then destroy all
  // creatures." Reuses destroyAllCreatures as-is for the wipe half.
  drawForMulticoloredControllersThenDestroyAllCreatures(lobby, ctx, params) {
    const drawnFor = new Set();
    Object.values(lobby.cards).forEach((c) => {
      if (c.zoneType === "creature" && (c.colors || []).length > 1 && !drawnFor.has(c.owner)) {
        drawnFor.add(c.owner);
        drawN(lobby, c.owner, 1);
      }
    });
    EFFECTS.destroyAllCreatures(lobby, ctx, params);
  },
  // End Hostilities -- "Destroy all creatures and all permanents attached to creatures." Auras
  // already go to the graveyard automatically once their host dies (see detachDependents), but
  // Equipment deliberately stays on the battlefield unattached instead -- captured up front here
  // (before the wipe detaches it) and destroyed too, matching this card's own broader wording.
  destroyAllCreaturesAndAttachments(lobby, ctx, params) {
    const equipmentToDestroy = Object.values(lobby.cards).filter((c) => c.attachedTo && lobby.cards[c.attachedTo] && lobby.cards[c.attachedTo].zoneType === "creature");
    EFFECTS.destroyAllCreatures(lobby, ctx, params);
    equipmentToDestroy.forEach((c) => {
      if (!lobby.cards[c.id]) return;
      fireDeathTriggers(lobby, c);
      sendToGraveyardInternal(lobby, c);
    });
  },
  // Child of Alara -- "destroy all nonland permanents. They can't be regenerated." Same
  // indestructible/regeneration handling as destroyAllCreatures, just widened from the "creature"
  // zoneType alone to the creature+artifact pair -- this app's classifyType only ever buckets a
  // permanent into "mana" (land), "creature", or "artifact" (which also covers enchantments and
  // planeswalkers, see classifyType's own comment), so that pair already IS "every nonland
  // permanent" here. Unlike Boompile's flipCoinDestroyAllNonland just below (which skips the
  // indestructible/regen checks entirely as a deliberate, disclosed Boompile-only simplification),
  // this is a real destroy effect and respects both, same as destroyAllCreatures does.
  destroyAllNonlandPermanents(lobby, ctx, params) {
    Object.values(lobby.cards).filter((c) => c.zoneType === "creature" || c.zoneType === "artifact").forEach((c) => {
      if (effectiveKeywords(lobby, c).some((k) => (k || "").toLowerCase() === "indestructible")) return;
      if (!params.noRegen && c.regenerationShield > 0) {
        c.regenerationShield -= 1;
        c.tapped = true;
        broadcastCard(lobby, c);
        pushLog(lobby, `${c.name || "A permanent"} regenerates instead of being destroyed`);
        return;
      }
      fireDeathTriggers(lobby, c);
      sendToGraveyardInternal(lobby, c);
    });
  },
  // Boompile -- "{T}: Flip a coin. If you win the flip, destroy all nonland permanents." A
  // genuinely new coin-flip mechanism (this app's only prior random-outcome primitive is the d20
  // roll above) -- a plain 50/50, logged either way so a loss is visibly nothing-happened rather
  // than silent. "Nonland" is any permanent whose zoneType isn't "mana" (creature or artifact --
  // covers enchantments/planeswalkers too, per classifyType's own bucketing), Boompile itself
  // included, matching the real card's own lack of a self-exception.
  flipCoinDestroyAllNonland(lobby, ctx) {
    const p = lobby.players[ctx.controllerId];
    const won = Math.random() < 0.5;
    pushLog(lobby, `${p ? p.name : "?"} flips a coin for Boompile: ${won ? "wins" : "loses"}`);
    if (!won) return;
    Object.values(lobby.cards).filter((c) => c.zoneType === "creature" || c.zoneType === "artifact").forEach((c) => {
      fireDeathTriggers(lobby, c);
      sendToGraveyardInternal(lobby, c);
    });
  },
  // Cut a Deal -- "Each opponent draws a card, then you draw a card for each opponent who drew a
  // card this way." drawN's own return value (cards ACTUALLY drawn, 0 if that player's library was
  // empty) makes this exact, not an approximation -- no need to assume everyone had a card.
  cutADealDraws(lobby, ctx, params) {
    let totalDrawn = 0;
    Object.keys(lobby.players).forEach((id) => { if (id !== ctx.controllerId) totalDrawn += drawN(lobby, id, 1); });
    if (totalDrawn > 0) drawN(lobby, ctx.controllerId, totalDrawn);
  },
  // Coiling Oracle -- "reveal the top card of your library. If it's a land card, put it onto the
  // battlefield. Otherwise, put that card into your hand."
  revealTopCardLandToBattlefieldElseHand(lobby, ctx, params) {
    const p = lobby.players[ctx.controllerId];
    if (!p || !p.library.length) return;
    const entry = p.library.shift();
    if ((entry.type || "").toLowerCase().includes("land")) {
      spawnBattlefieldCard(lobby, { ...entry, owner: ctx.controllerId, zoneType: "mana" });
      pushLog(lobby, `${p.name} reveals ${entry.name || "a land"} and puts it onto the battlefield`);
    } else {
      spawnBattlefieldCard(lobby, { ...entry, owner: ctx.controllerId, faceDown: true, zoneType: "hand" });
      pushLog(lobby, `${p.name} reveals ${entry.name || "a card"} and puts it into their hand`);
    }
  },
  // Diregraf Colossus -- "enters with a +1/+1 counter for each Zombie card in your graveyard."
  // Generic on typeFilter (a lowercase type-line substring), reusable for any future "counters equal
  // to graveyard cards of type X" card.
  addCountersEqualToGraveyardTypeCount(lobby, ctx, params) {
    const p = lobby.players[ctx.controllerId];
    const card = ctx.sourceCard && lobby.cards[ctx.sourceCard.id];
    if (!p || !card) return;
    const filter = (params.typeFilter || "").toLowerCase();
    const count = (p.graveyard || []).filter((e) => (e.type || "").toLowerCase().includes(filter)).length;
    if (count > 0) { card.counters = (card.counters || 0) + count; broadcastCard(lobby, card); }
  },
  // Contagion Clasp -- "put a -1/-1 counter on target creature." The first card in this app needing
  // an automated NEGATIVE counter grant (card.counters is a single signed scalar already, per every
  // P/T computation that reads it -- a manual -1 Counter button already exists client-side, this is
  // just its automated-effect counterpart).
  addNegativeCounterTarget(lobby, ctx, params) {
    const card = lobby.cards[params.chosenTargetId];
    if (!card) return;
    card.counters = (card.counters || 0) - (params.amount || 1);
    broadcastCard(lobby, card);
  },
  // Archfiend of Ifnir -- "put a -1/-1 counter on each creature your opponents control." The
  // opposite scope from addCountersToAllYourCreatures (every OTHER player's creatures, not the
  // controller's own) -- kept as its own small effect rather than a parameterized "whose creatures"
  // flag on that one, since -1/-1 counters shouldn't run through bonusCountersFor/
  // counterMultiplierFor (those only ever apply to +1/+1-counter-adding effects).
  addNegativeCounterToEachOpponentCreature(lobby, ctx, params) {
    const amount = params.amount || 1;
    Object.values(lobby.cards).filter((c) => c.owner !== ctx.controllerId && c.zoneType === "creature").forEach((c) => {
      c.counters = (c.counters || 0) - amount;
      broadcastCard(lobby, c);
    });
  },
  // Generic "destroy every permanent matching a filter" -- covers every modal board-wipe MODE found
  // in the gap analysis (Austere Command's four, Crux of Fate's two, Cleansing Nova's second) with
  // one parameterized function instead of a near-copy per mode. zoneTypeFilter narrows to a real
  // zoneType ("creature"), typeIncludes/typeExcludes check substrings of the TYPE LINE TEXT itself
  // (not zoneType, which folds artifact/enchantment together -- see classifyType's own comment) so
  // "destroy all enchantments" and "destroy all artifacts" can actually be told apart, cmcMin/cmcMax
  // filter by mana value. Same indestructible/regeneration handling as destroyAllCreatures.
  // params.counterSelfAmount (Bane of Progress -- "put a +1/+1 counter on this creature for each
  // permanent destroyed this way") -- counts only permanents ACTUALLY destroyed (skips indestructible
  // ones and ones that regenerated instead, same as the real card's own "destroyed this way" wording
  // would), then applies that many counters to ctx.sourceCard, reusing addCountersToSelf's own
  // Hardened-Scales-aware math rather than duplicating it.
  destroyAllMatching(lobby, ctx, params) {
    let destroyedCount = 0;
    Object.values(lobby.cards).filter((c) => {
      if (params.zoneTypeFilter && c.zoneType !== params.zoneTypeFilter) return false;
      const type = (c.type || "").toLowerCase();
      if (params.typeIncludes && !params.typeIncludes.some((t) => type.includes(t))) return false;
      if (params.typeExcludes && params.typeExcludes.some((t) => type.includes(t))) return false;
      if (params.cmcMin !== undefined && (c.cmc || 0) < params.cmcMin) return false;
      if (params.cmcMax !== undefined && (c.cmc || 0) > params.cmcMax) return false;
      return true;
    }).forEach((c) => {
      if (effectiveKeywords(lobby, c).some((k) => (k || "").toLowerCase() === "indestructible")) return;
      if (c.regenerationShield > 0) {
        c.regenerationShield -= 1;
        c.tapped = true;
        broadcastCard(lobby, c);
        pushLog(lobby, `${c.name || "A permanent"} regenerates instead of being destroyed`);
        return;
      }
      fireDeathTriggers(lobby, c);
      sendToGraveyardInternal(lobby, c);
      destroyedCount++;
    });
    if (params.counterSelfAmount && destroyedCount > 0) EFFECTS.addCountersToSelf(lobby, ctx, { amount: destroyedCount });
  },
  // Pick Your Poison -- "each opponent sacrifices [a permanent matching filter] OF THEIR CHOICE."
  // WHICH one each opponent gives up is auto-picked (their own first qualifying match) rather than
  // prompted -- a real, disclosed simplification, same "auto-pick, don't build a whole multi-player
  // choice UI for one clause" precedent as Demon of Loathing's sacrifice trigger.
  eachOpponentSacrifices(lobby, ctx, params) {
    Object.keys(lobby.players).filter((id) => id !== ctx.controllerId).forEach((oppId) => {
      const match = Object.values(lobby.cards).find((c) => {
        if (c.owner !== oppId) return false;
        if (params.zoneTypeFilter && c.zoneType !== params.zoneTypeFilter) return false;
        const type = (c.type || "").toLowerCase();
        if (params.typeIncludes && !params.typeIncludes.some((t) => type.includes(t))) return false;
        if (params.keywordIncludes && !effectiveKeywords(lobby, c).some((k) => params.keywordIncludes.includes((k || "").toLowerCase()))) return false;
        return true;
      });
      if (match) { fireDeathTriggers(lobby, match); sendToGraveyardInternal(lobby, match); }
    });
  },
  // Archon of Cruelty -- "target opponent sacrifices a creature or planeswalker of their choice."
  // Same auto-pick precedent as eachOpponentSacrifices just above, but for the ONE player chosen via
  // a real target choice (chosenTargetId) rather than every opponent at once. Planeswalkers aren't
  // matched -- classifyType folds them into zoneType "artifact" alongside real artifacts, and there's
  // no separate flag distinguishing the two, so this is scoped to creatures only, a disclosed
  // narrowing (the far more common half of "creature or planeswalker" in practice).
  targetPlayerSacrifices(lobby, ctx, params) {
    const targetId = params.chosenTargetId;
    if (!targetId) return;
    const match = Object.values(lobby.cards).find((c) => c.owner === targetId && c.zoneType === "creature");
    if (match) { fireDeathTriggers(lobby, match); sendToGraveyardInternal(lobby, match); }
  },
  // Chain Reaction / Blasphemous Act -- "deals X damage to each creature, where X is the number of
  // creatures on the battlefield." X is computed fresh here (BEFORE anything dies, matching the real
  // card's "counted as the spell begins to resolve" timing) rather than threaded in as a param, since
  // nothing upstream of a plain SPELL_ABILITIES entry has any way to know it. Same no-indestructible-
  // check precedent as damageAllCreaturesOfPlayer just above (a deliberately narrower case than the
  // real combat-lethal/destroyTarget checks) -- Blasphemous Act's own dynamic cost reduction ("costs
  // {1} less for each creature") isn't modeled either, same "the effect works, the cost math
  // doesn't" narrowing as destroyAllCreatures above.
  damageAllCreaturesTable(lobby, ctx, params) {
    const amount = Object.values(lobby.cards).filter((c) => c.zoneType === "creature").length;
    if (!amount) return;
    Object.values(lobby.cards).filter((c) => c.zoneType === "creature").forEach((c) => {
      const bonus = attachedBonusFor(lobby, c);
      const stat = staticBonusFor(lobby, c);
      const effToughness = parsePT(c.toughness) + (c.counters || 0) + bonus.toughnessBonus + stat.toughnessBonus;
      if (amount >= effToughness) { fireDeathTriggers(lobby, c); sendToGraveyardInternal(lobby, c); }
    });
  },
  // Demon of Loathing -- "whenever this creature deals combat damage to a player, that player
  // sacrifices a creature of their choice." WHICH creature is auto-picked (their own first
  // creature found) rather than prompted -- a real, disclosed simplification, same shape as Lord
  // of the Void's reanimation target above, not worth a whole new choice-UI for one clause.
  sacrificeACreatureOfPlayer(lobby, ctx, params) {
    const defenderId = params.dealtToPlayerId;
    if (!defenderId) return;
    const victim = Object.values(lobby.cards).find((c) => c.owner === defenderId && c.zoneType === "creature");
    if (!victim) return;
    fireDeathTriggers(lobby, victim);
    sendToGraveyardInternal(lobby, victim);
    const p = lobby.players[ctx.controllerId];
    pushLog(lobby, `${lobby.players[defenderId] ? lobby.players[defenderId].name : "?"} sacrificed ${victim.name} to ${ctx.sourceCard ? (lobby.cards[ctx.sourceCard.id] || {}).name || "" : ""}`.trim());
  },
  // Ancient Copper Dragon -- "whenever this creature deals combat damage to a player, roll a d20.
  // You create a number of Treasure tokens equal to the result." Real d20 roll (Math.random, not
  // player-chosen), real tokens -- and since ACTIVATED_ABILITIES has a generic "treasure" entry
  // (any token literally named "Treasure" matches it, regardless of which effect created it), these
  // tokens get their real "{T}, Sacrifice: Add one mana of any color" ability for free.
  // Smothering Tithe's declined-payment consequence -- same real Treasure (see the generic
  // "treasure" ACTIVATED_ABILITIES entry) as rollD20CreateTreasures just below.
  createTreasureToken(lobby, ctx, params) {
    spawnBattlefieldCard(lobby, {
      name: "Treasure", type: "Token Artifact — Treasure", img: "https://cards.scryfall.io/normal/front/6/8/68894c85-fb43-4c9a-9de3-2fa1c9c31543.jpg",
      owner: ctx.controllerId, zoneType: "artifact"
    });
  },
  rollD20CreateTreasures(lobby, ctx, params) {
    const roll = 1 + Math.floor(Math.random() * 20);
    const p = lobby.players[ctx.controllerId];
    pushLog(lobby, `${p ? p.name : "?"} rolls a d20 for ${(ctx.sourceCard && lobby.cards[ctx.sourceCard.id] && lobby.cards[ctx.sourceCard.id].name) || "Ancient Copper Dragon"}: ${roll} -- creating ${roll} Treasure token${roll === 1 ? "" : "s"}`);
    for (let i = 0; i < roll; i++) {
      spawnBattlefieldCard(lobby, {
        name: "Treasure", type: "Token Artifact — Treasure", img: "https://cards.scryfall.io/normal/front/6/8/68894c85-fb43-4c9a-9de3-2fa1c9c31543.jpg",
        owner: ctx.controllerId, zoneType: "artifact"
      });
    }
  },
  // Kaalia, Zenith Seeker -- "When Kaalia enters, look at the top six cards of your library. You
  // may reveal an Angel card, a Demon card, and/or a Dragon card from among them and put them into
  // your hand. Put the rest on the bottom of your library in a random order." No real CHOICE here
  // (every matching card is taken, not one among several) -- deterministic reveal-and-sort, unlike
  // a real tutor. "Bottom in a random order" simplifies to "shuffled back into the library"
  // (this app's library has no concept of top/bottom ordering beyond draw-from-top).
  lookTopNRevealTypesToHand(lobby, ctx, params) {
    const p = lobby.players[ctx.controllerId];
    if (!p) return;
    const n = params.amount || 6;
    // Icon of Ancestry -- the type to reveal is a per-permanent CHOICE (see chooseCreatureType),
    // not a fixed list baked into the table entry, when params.types is absent. Real wording is "a
    // creature card" (singular) -- approximated the same "take every match, no real choice among
    // several" way Kaalia, Zenith Seeker's own use of this function already does, since a 3-card
    // sample rarely has more than one match anyway.
    let types = params.types || [];
    if (!types.length && params.typeFromChosenCreatureType) {
      const src = ctx.sourceCard && lobby.cards[ctx.sourceCard.id];
      if (src && src.chosenCreatureType) types = [src.chosenCreatureType];
    }
    const seen = [];
    for (let i = 0; i < n && p.library.length > 0; i++) seen.push(p.library.shift());
    const matched = seen.filter((e) => types.some((t) => (e.type || "").toLowerCase().includes(t.toLowerCase())));
    const rest = seen.filter((e) => !matched.includes(e));
    matched.forEach((e) => spawnBattlefieldCard(lobby, { ...e, owner: ctx.controllerId, faceDown: true, zoneType: "hand" }));
    rest.forEach((e) => p.library.push(e));
    shuffle(p.library);
    pushLog(lobby, `${p.name} reveals the top ${seen.length} card${seen.length === 1 ? "" : "s"} of their library: ${matched.length} matching card${matched.length === 1 ? "" : "s"} go to hand, the rest are shuffled back in`);
    broadcastPlayers(lobby);
  },
  // Lord of the Void -- "exile the top seven cards of that player's library, then put a creature
  // card from among them onto the battlefield under your control." The exile-and-reveal part is
  // fully real (cards genuinely move to that player's exile zone, visible via the normal zone
  // modal); WHICH creature to reanimate is auto-picked (first creature found among the exiled
  // cards) rather than prompted -- a real, disclosed simplification (this would need a whole new
  // "pick one from a batch of just-exiled cards" choice UI for one card's ability), not a silent
  // no-op the way most of this table's genuinely-skipped abilities are.
  exileTopNPutCreatureOntoBattlefield(lobby, ctx, params) {
    const defenderId = params.dealtToPlayerId;
    if (!defenderId) return;
    const defender = lobby.players[defenderId];
    if (!defender) return;
    const n = params.amount || 7;
    const exiled = [];
    for (let i = 0; i < n && defender.library.length > 0; i++) exiled.push(defender.library.shift());
    exiled.forEach((e) => defender.exile.push(e));
    const p = lobby.players[ctx.controllerId];
    pushLog(lobby, `${p ? p.name : "?"} exiled the top ${exiled.length} card${exiled.length === 1 ? "" : "s"} of ${defender.name}'s library`);
    const creatureIdx = exiled.findIndex((e) => (e.type || "").toLowerCase().includes("creature"));
    if (creatureIdx !== -1) {
      const entry = defender.exile.splice(defender.exile.length - exiled.length + creatureIdx, 1)[0];
      const card = spawnBattlefieldCard(lobby, { ...entry, owner: ctx.controllerId, faceDown: false, zoneType: classifyType(entry.type) });
      pushLog(lobby, `${p ? p.name : "?"} put ${card.name} onto the battlefield under their control`);
      fireEtbTriggers(lobby, card);
    }
    broadcastPlayers(lobby);
  },
  // Signets and similar mana rocks ("{1}, T: Add {W}{B}.") produce a FIXED set of colors all at
  // once -- not a choice among them the way a dual land's "add W or B" is. Only ever reached via
  // activateAbility's manaAbility fast path (see there for why mana abilities skip the stack
  // entirely), never via the plain tap-for-free-mana shortcut, since this one has a real cost.
  addFixedMana(lobby, ctx, params) {
    const p = lobby.players[ctx.controllerId];
    if (!p) return;
    (params.colors || []).forEach((c) => { if (["W", "U", "B", "R", "G", "C"].includes(c)) p.mana[c] = (p.mana[c] || 0) + 1; });
    broadcastPlayers(lobby);
  },
  // Battle Hymn -- "Add {R} for each creature you control." A genuinely dynamic amount computed
  // fresh at resolution (same "the effect just computes what it needs" precedent as
  // createTokensEqualToTypeCountControlled and friends), not threaded in as a param.
  addManaEqualToCreatureCount(lobby, ctx, params) {
    const p = lobby.players[ctx.controllerId];
    if (!p) return;
    const n = Object.values(lobby.cards).filter((c) => c.owner === ctx.controllerId && c.zoneType === "creature").length;
    if (n > 0) p.mana[params.color || "R"] = (p.mana[params.color || "R"] || 0) + n;
    broadcastPlayers(lobby);
  },
  // Wave 14 gap-analysis batch.
  // Bloom Tender -- "For each color among permanents you control, add one mana of that color." A
  // genuinely new mana shape (multiple DIFFERENT colors at once, keyed off the controller's own
  // board rather than a fixed color or a fixed count of one color) -- distinct from
  // addManaEqualToCreatureCount's "N mana of ONE color" and addFixedMana's fixed color list.
  addManaForEachColorControlled(lobby, ctx, params) {
    const p = lobby.players[ctx.controllerId];
    if (!p) return;
    const colors = new Set();
    Object.values(lobby.cards).forEach((c) => {
      if (c.owner === ctx.controllerId && c.zoneType !== "hand" && c.zoneType !== "stack") {
        (c.colors || []).forEach((col) => colors.add(col));
      }
    });
    colors.forEach((col) => { p.mana[col] = (p.mana[col] || 0) + 1; });
    broadcastPlayers(lobby);
  },
  // Aggravated Assault -- "Untap all creatures you control. After this main phase, there is an
  // additional combat phase followed by an additional main phase." Reuses turn.extraCombatsPending
  // exactly as-is (already generic, built for Aurelia/Combat Celebrant-style triggers -- see
  // advanceOnePhase's own comment) rather than a new mechanism; only scoped to CREATURES (not the
  // manual table-wide "Untap All" utility button's every-permanent scope), matching the real card's
  // own wording. "Activate only as a sorcery" isn't enforced -- no activated ability in this engine
  // currently checks cast-timing, a disclosed simplification shared with every other one.
  untapAllCreaturesAndExtraCombat(lobby, ctx, params) {
    Object.values(lobby.cards).forEach((c) => {
      if (c.owner === ctx.controllerId && c.zoneType === "creature" && c.tapped) { c.tapped = false; broadcastCard(lobby, c); }
    });
    lobby.turn.extraCombatsPending = (lobby.turn.extraCombatsPending || 0) + 1;
  },
  // Akroma's Will -- both modes grant several keywords at once "until end of turn" to every
  // creature the controller has, reusing grantTemporaryKeyword (a real duration-based grant, swept
  // at the next real-turn boundary) for each one. "You may choose both if you control a commander"
  // isn't modeled -- this engine's modal-spell system only ever supports picking a single mode
  // (same disclosed narrowing as Austere Command's real "choose two" -> "choose one" above), and a
  // CONDITIONAL "choose one vs. choose both" mode count has no shape here yet. Protection here is
  // the same bare, colorless-in-this-engine keyword every other "protection from [color/type]" card
  // in this file already grants as a cosmetic badge -- not a real color-scoped restriction.
  grantTemporaryKeywordsToAllYours(lobby, ctx, params) {
    const keywords = params.keywords || [];
    Object.values(lobby.cards).forEach((c) => {
      if (c.owner === ctx.controllerId && c.zoneType === "creature") keywords.forEach((k) => grantTemporaryKeyword(lobby, c, k));
    });
  }
};
// Shared by the manual Counter button (counterStackItem) and EFFECTS.counterTargetSpell -- pulls
// one item off the stack by id and sends it to its owner's graveyard (skipped for a triggered
// ability, which isn't a real card sendToGraveyardInternal could file away). Pure state mutation,
// no broadcast/logging -- callers still need to update priority state before broadcasting, and want
// different log phrasing (an ad-hoc manual counter vs. a real counterspell resolving), so both are
// left to them.
function removeStackItem(lobby, stackItemId) {
  const idx = lobby.stack.findIndex((s) => s.id === stackItemId);
  if (idx === -1) return null;
  const item = lobby.stack.splice(idx, 1)[0];
  if (item.kind !== "ability") sendToGraveyardInternal(lobby, item);
  return item;
}
function executeAbilityEffects(lobby, item) {
  const ctx = { controllerId: item.owner, sourceCard: item.sourceId ? { id: item.sourceId } : null };
  (item.effects || []).forEach((params) => {
    const fn = EFFECTS[params.type];
    if (fn) fn(lobby, ctx, params);
  });
  checkEliminations(lobby);
  broadcastPlayers(lobby);
}

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
    // Per-table rules toggles -- the seed of a future "casual/tournament/custom" ruleset picker.
    // Only one flag for now: whether Protection/Hexproof/Ward/Shroud are actually enforced as
    // targeting restrictions, or stay the cosmetic badges they've always been (this app's
    // long-standing "anyone can target anything, players self-police" trust model). Host-only to
    // change (see setLobbySetting), same precedent as deleteLobby.
    settings: { enforceTargetingRestrictions: true },
    creaturesCantAttack: false, // Orim's Chant, kicked -- "creatures can't attack this turn," cleared at cleanup
    cards: {},        // battlefield/hand cards, keyed by id
    players: {},      // socket.id -> player state
    targets: {},      // cardId -> [playerId, ...]
    gameState: { log: [] },
    chatLog: [],
    spectators: {}, // socket.id -> { username, name } -- watch-only, never touches lobby.players
    voiceParticipants: new Set(),
    turn: { started: false, order: [], activeIndex: 0, phase: "Main 1", turnNumber: 1, pendingDiscard: null, phaseStartedAt: null, extraCombatsPending: 0 },
    combat: { step: "none", attackers: {}, blocks: {}, defendersPending: [] },
    stack: [], // cast spells awaiting resolution, top = last element
    priority: { holderId: null, lastActorId: null }, // only meaningful while stack.length > 0
    // A target-requiring triggered ability queues here INSTEAD OF going on the stack until its
    // controller picks a legal target -- see queueTargetChoice. Only the front entry is actively
    // prompted; a second one firing before the first is resolved just waits its turn.
    pendingTargetChoices: [],
    // "That player may pay X; if they don't, Y happens" (Smothering Tithe, Esper Sentinel, Rakdos,
    // Patron of Chaos) -- see queueOptionalPayment. Addressed to the AFFECTED player (an opponent
    // of the ability's controller), not the controller themselves, unlike pendingTargetChoices.
    pendingOptionalPayments: [],
    // "At the beginning of the next end step" (or any other named phase) one-shot triggers -- see
    // queueDelayedTrigger.
    delayedTriggers: [],
    // Kardur, Doomscourge -- playerIds of controllers whose Kardur is currently forcing opponents
    // to attack "until your next turn." Cleared for a controller when their own next turn begins.
    kardurForcedAttackControllers: []
  };
}
function lobbySummaries() {
  return Object.values(lobbies).map((l) => ({
    id: l.id, name: l.name, playerCount: Object.keys(l.players).length, spectatorCount: Object.keys(l.spectators || {}).length,
    started: l.turn.started, locked: !!l.passwordHash, hostUsername: l.hostUsername
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
const LEAVE_GRACE_MS = 60 * 1000; // an explicit Leave Table click is a clear signal -- don't hold the seat as long as a genuine network blip

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
    if (!l.turn) l.turn = { started: false, order: [], activeIndex: 0, phase: "Main 1", turnNumber: 1, pendingDiscard: null, phaseStartedAt: null, extraCombatsPending: 0 };
    if (l.turn.pendingDiscard === undefined) l.turn.pendingDiscard = null;
    if (l.turn.phaseStartedAt === undefined) l.turn.phaseStartedAt = null;
    if (!l.stack) l.stack = [];
    if (!l.priority) l.priority = { holderId: null, lastActorId: null };
    if (!l.pendingTargetChoices) l.pendingTargetChoices = [];
    if (!l.pendingOptionalPayments) l.pendingOptionalPayments = [];
    if (!l.delayedTriggers) l.delayedTriggers = [];
    if (!l.kardurForcedAttackControllers) l.kardurForcedAttackControllers = [];
    if (!l.settings) l.settings = { enforceTargetingRestrictions: true };
    if (l.creaturesCantAttack === undefined) l.creaturesCantAttack = false;
    // Nobody is actually connected right after a restart — mark every seated player as
    // disconnected so the normal reconnect-grace mechanism below picks up the cleanup/resume.
    for (const sid in l.players) {
      l.players[sid].disconnectedAt = Date.now();
      if (l.players[sid].eliminated === undefined) l.players[sid].eliminated = false;
    }
    restored[id] = l;
  }
  return restored;
}

let lobbies = restoreLobbies(); // id -> lobby state

setInterval(saveLobbies, 20000);
process.on("SIGTERM", () => { saveLobbies(); process.exit(0); });

// Shared by removePlayerFromLobby (a real disconnect/leave) and eliminatePlayer (life <= 0 or
// 21+ damage from a single commander): removes socketId from turn.order, fixing up activeIndex
// and re-deriving priority the same way either kind of departure needs to. A departing player
// can't be left holding (or gating the close of) a pending stack -- that would soft-lock the
// table forever waiting on someone who's gone.
function spliceFromTurnOrder(lobby, socketId) {
  const turn = lobby.turn;
  const idx = turn.order.indexOf(socketId);
  const wasPriorityHolder = lobby.priority.holderId === socketId;
  const wasLastActor = lobby.priority.lastActorId === socketId;
  // Captured BEFORE the splice below (which shifts indices around) -- see
  // forceEndOfTurnForElimination's own comment for why a departing ACTIVE player needs their turn
  // ended right here, not left silently mid-phase for whoever slides into the same activeIndex.
  const wasActivePlayer = turn.started && idx !== -1 && idx === turn.activeIndex;
  if (idx !== -1) {
    turn.order.splice(idx, 1);
    if (turn.order.length === 0) turn.started = false;
    else if (idx < turn.activeIndex) turn.activeIndex--;
    else if (turn.activeIndex >= turn.order.length) turn.activeIndex = 0;
  }
  if (turn.order.length === 0) {
    lobby.priority.holderId = null;
    lobby.priority.lastActorId = null;
  } else if (lobby.stack.length > 0) {
    if (wasPriorityHolder) lobby.priority.holderId = turn.order[idx % turn.order.length];
    if (wasLastActor) lobby.priority.lastActorId = lobby.priority.holderId;
  }
  // Only forced when the stack is empty -- see forceEndOfTurnForElimination's own comment for why
  // a pending stack item makes this too risky to force through automatically.
  if (wasActivePlayer && turn.order.length > 0 && lobby.stack.length === 0) forceEndOfTurnForElimination(lobby);
}

// Not touched by a normal disconnect/leave (removePlayerFromLobby never cleaned this up either --
// a genuine departure mid-declareBlockers could permanently stall combat for the whole table,
// since defendersPending.length === 0 is what gates it moving forward and the stale id can never
// submit another declareBlockers). Shared so both paths get the fix.
function removeFromCombatRefs(lobby, socketId) {
  lobby.combat.defendersPending = (lobby.combat.defendersPending || []).filter((id) => id !== socketId);
  for (const attackerId in lobby.combat.attackers) {
    if (lobby.combat.attackers[attackerId] === socketId) delete lobby.combat.attackers[attackerId];
  }
}

function removePlayerFromLobby(lobby, socketId, verb) {
  const p = lobby.players[socketId];
  const uname = p ? p.username : null;
  delete lobby.players[socketId];
  lobby.voiceParticipants.delete(socketId);
  spliceFromTurnOrder(lobby, socketId);
  removeFromCombatRefs(lobby, socketId);
  discardPendingTargetChoices(lobby, socketId);
  if (Object.keys(lobby.players).length === 0 && Object.keys(lobby.spectators || {}).length === 0) {
    delete lobbies[lobby.id];
  } else {
    broadcastVoiceRoster(lobby);
    broadcastTurn(lobby);
    broadcastPlayers(lobby);
    broadcastStack(lobby);
    broadcastCombat(lobby);
    if (uname) pushLog(lobby, `${uname} ${verb} the table`);
    // A real departure (not an elimination) can just as validly bring the table down to one
    // remaining player -- eliminatePlayer already triggers this check, but a plain leave/
    // disconnect never did, so the game could quietly never end even after everyone else was
    // already eliminated and only one real departure was left to go.
    checkGameOver(lobby);
  }
  broadcastLobbyList();
}

// Marks a player eliminated (life <= 0, or 21+ damage from a single commander -- checked by
// checkEliminations below) WITHOUT deleting their player record or touching lobby.cards, unlike
// removePlayerFromLobby -- an eliminated player's board stays visible/frozen, matching real
// Commander etiquette, and they can keep spectating rather than being booted from the table.
function eliminatePlayer(lobby, socketId) {
  const p = lobby.players[socketId];
  if (!p || p.eliminated) return;
  p.eliminated = true;
  spliceFromTurnOrder(lobby, socketId);
  removeFromCombatRefs(lobby, socketId);
  discardPendingTargetChoices(lobby, socketId);
  pushLog(lobby, `${p.name} has been eliminated!`);
  io.to(lobby.id).emit("playerEliminated", socketId);
}

// Only meaningful once a game has actually started and someone was just eliminated -- turn.order
// by this point only contains players who are still in the game (eliminatePlayer already spliced
// the loser out), so its length alone tells the story: one player left standing is the winner,
// zero is a simultaneous-elimination draw.
function checkGameOver(lobby) {
  if (!lobby.turn.started) return;
  if (lobby.turn.order.length === 1) {
    const winner = lobby.players[lobby.turn.order[0]];
    if (!winner) return;
    pushLog(lobby, `${winner.name} wins the game!`);
    io.to(lobby.id).emit("gameOver", { winnerId: lobby.turn.order[0], winnerName: winner.name });
  } else if (lobby.turn.order.length === 0) {
    pushLog(lobby, `The game ends in a draw -- no players remaining.`);
    io.to(lobby.id).emit("gameOver", { winnerId: null, winnerName: null });
  }
}

// The single choke point for "did anyone just lose the game" -- called explicitly right before
// broadcastPlayers from every place life or commander damage actually changes (resolveCombatDamage,
// executeAbilityEffects, the statChange handler), rather than hooked into broadcastPlayers itself
// (which has ~12 unrelated call sites, e.g. setBoardMat/addMana, that have nothing to do with a
// win condition). Safe to call from inside resolveCombatDamage's damage loop: it's only ever
// invoked once, after both loops there finish and all of that combat's damage has fully settled.
function checkEliminations(lobby) {
  const newlyEliminated = [];
  for (const id in lobby.players) {
    const p = lobby.players[id];
    if (p.eliminated) continue;
    const cmdrLethal = p.cmdrDamage && Object.values(p.cmdrDamage).some((v) => v >= 21);
    if (p.life <= 0 || cmdrLethal || p.poison >= 10) newlyEliminated.push(id);
  }
  if (!newlyEliminated.length) return;
  newlyEliminated.forEach((id) => eliminatePlayer(lobby, id));
  broadcastTurn(lobby);
  broadcastStack(lobby);
  broadcastCombat(lobby);
  checkGameOver(lobby);
}

function scheduleGraceRemoval(lobby, socketId, ms) {
  setTimeout(() => {
    if (lobbies[lobby.id] !== lobby) return; // lobby already gone (e.g. everyone left)
    const p = lobby.players[socketId];
    if (p && p.disconnectedAt) removePlayerFromLobby(lobby, socketId, "timed out and left");
  }, ms || RECONNECT_GRACE_MS);
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

  // Reassigning ownership only updates server memory. The reconnecting player gets their own full,
  // correct board via lobbyJoined, but every other connected client's local card cache still holds
  // these cards under the old (now-orphaned) owner id unless told otherwise -- rendering that groups
  // cards by owner against the current players list would then show none of the reconnecting
  // player's cards to anyone else. Broadcasting each touched card keeps every client in sync.
  for (const id in lobby.cards) {
    const card = lobby.cards[id];
    let touched = false;
    if (card.owner === oldId) { card.owner = newId; touched = true; }
    // originalOwner (set only by takeControl, for a stolen permanent) is the same kind of stable-
    // reference-that-goes-stale-on-reconnect problem .owner has: every "which player does this
    // actually belong to" lookup (commanderSlotKey, moveOut/toHand's zone destination, etc.)
    // prefers originalOwner when set. Left un-rekeyed, a stolen permanent's true owner reconnecting
    // would make it file into lobby.players[oldId] -- which delete lobby.players[oldId] above just
    // removed -- silently landing in no one's graveyard/hand at all.
    if (card.originalOwner === oldId) { card.originalOwner = newId; touched = true; }
    if (touched) broadcastCard(lobby, card);
  }
  // Triggered-ability stack instances aren't in lobby.cards (they're not real cards), so the loop
  // above never sees them -- without this, a trigger pending on the stack when its controller
  // reconnects would resolve against a dead socket id and silently no-op.
  lobby.stack.forEach((item) => {
    if (item.kind === "ability" && item.owner === oldId) item.owner = newId;
  });
  for (const cardId in lobby.targets) {
    lobby.targets[cardId] = lobby.targets[cardId].map((pid) => (pid === oldId ? newId : pid));
  }
  lobby.turn.order = lobby.turn.order.map((id) => (id === oldId ? newId : id));
  if (lobby.turn.pendingDiscard && lobby.turn.pendingDiscard.playerId === oldId) lobby.turn.pendingDiscard.playerId = newId;
  if (lobby.priority.holderId === oldId) lobby.priority.holderId = newId;
  if (lobby.priority.lastActorId === oldId) lobby.priority.lastActorId = newId;
  for (const cardId in lobby.combat.attackers) {
    if (lobby.combat.attackers[cardId] === oldId) lobby.combat.attackers[cardId] = newId;
  }
  lobby.combat.defendersPending = (lobby.combat.defendersPending || []).map((id) => (id === oldId ? newId : id));
  lobby.pendingTargetChoices.forEach((c) => { if (c.controllerId === oldId) c.controllerId = newId; });
}

function buildLobbyJoinedPayload(lobby, socketId) {
  const maskedCards = {};
  for (const id in lobby.cards) maskedCards[id] = maskCard(lobby.cards[id], socketId, lobby);
  // If this reconnecting player is the one a pending trigger is actually waiting on, they need to
  // know -- the chooseTarget prompt only fires once, at the moment the trigger first queued, so a
  // fresh connection (a real reload, not just this socket) would otherwise never see it.
  const myPendingChoice = lobby.pendingTargetChoices.find((c, i) => i === 0 && c.controllerId === socketId);
  const myPendingPayment = lobby.pendingOptionalPayments.find((e) => e.playerId === socketId);
  return {
    lobbyId: lobby.id,
    lobbyName: lobby.name,
    cards: maskedCards,
    gameState: lobby.gameState,
    players: playersView(lobby, socketId),
    targets: lobby.targets,
    turn: lobby.turn,
    combat: lobby.combat,
    stack: lobby.stack.map((c) => maskCard(c, socketId, lobby)),
    priority: lobby.priority,
    pendingTargetChoice: myPendingChoice ? (() => { const src = myPendingChoice.spellCard || myPendingChoice.sourceCard; return { id: myPendingChoice.id, label: myPendingChoice.label, sourceImg: myPendingChoice.sourceCard.img, sourceColors: (src && src.colors) || [], sourceType: (src && src.type) || "", sourceCardId: myPendingChoice.sourceCard && myPendingChoice.sourceCard.id, targetKind: myPendingChoice.targetKind || myPendingChoice.targetZoneType || "creature", minCmc: myPendingChoice.minCmc || null, handTypeFilter: myPendingChoice.handTypeFilter || null, modes: myPendingChoice.modes ? myPendingChoice.modes.map((m) => m.label) : null, commanderChoices: myPendingChoice.commanderChoices || null }; })() : null,
    pendingOptionalPayment: myPendingPayment ? { id: myPendingPayment.id, label: myPendingPayment.label, costLabel: myPendingPayment.costLabel } : null,
    chat: lobby.chatLog,
    voiceRoster: Array.from(lobby.voiceParticipants),
    spectatorRoster: Object.values(lobby.spectators).map((s) => s.name),
    spectator: !!lobby.spectators[socketId],
    myId: socketId,
    settings: lobby.settings,
    isHost: !!(lobby.players[socketId] && lobby.hostUsername === lobby.players[socketId].username)
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

// Resolution-time distinction (type line only, not casting speed -- a Flash *creature* is still
// a permanent when it resolves). Instants/sorceries have no permanent form, so on resolution they
// go to the graveyard instead of the battlefield; their actual effect is manually adjudicated by
// the players, same as every other unautomated effect in this app.
function isInstantOrSorcery(type) {
  const t = (type || "").toLowerCase();
  return t.includes("instant") || t.includes("sorcery");
}

// A shockland ("Land -- Plains Swamp") carries TWO basic land types in its own type line -- real
// Magic rules, needed so fetchlands can find it -- so checking these one at a time and returning on
// the first match (the old bug) silently forced White on a Godless Shrine and never even looked for
// Swamp. Collect every basic type actually present and only treat it as unambiguous if there's
// exactly one; a genuine dual (or worse) type line falls through to producedMana's chooseMana
// prompt instead, same as any other multi-color source.
function basicLandColor(type) {
  if (!type) return null;
  const basics = [];
  if (type.includes("Plains")) basics.push("W");
  if (type.includes("Island")) basics.push("U");
  if (type.includes("Swamp")) basics.push("B");
  if (type.includes("Mountain")) basics.push("R");
  if (type.includes("Forest")) basics.push("G");
  return basics.length === 1 ? basics[0] : null;
}

// Cards that unconditionally enter tapped ("~ enters the battlefield tapped.") should actually
// enter tapped instead of always untapped. Cards with a real choice attached (shocklands' "you
// may pay life", etc.) are deliberately excluded — the player has a decision to make there that
// this app can't resolve automatically, so those stay untapped by default and can be tapped
// manually like today.
// Checklands/Arena of Glory-style "enters tapped unless you control a/an [Type]" is DIFFERENT --
// there's no real choice to make, just a battlefield fact this app can check for itself, so it's
// resolved generically here (checked against the card's own owner's other permanents) rather than
// falling into the "stays untapped, needs a table entry" bucket the way shocklands' genuine choice
// does. No table entry needed for any card matching this exact wording.
// Checklands (Clifftop Retreat: "unless you control a Mountain OR a Plains") name TWO land types,
// not one -- the original regex only ever captured the first, so a checkland with a Plains but no
// Mountain (or vice versa) was wrongly forced tapped even though either one alone is real Magic's
// actual condition. Same two-optional-capture-group shape revealFromHandChoiceFromText already uses
// for exactly this "Type (or Type)" pattern.
function conditionalEntersTappedTypes(text) {
  const m = (text || "").toLowerCase().match(/enters(?: the battlefield)? tapped unless you control an? ([a-z]+)(?:\s+or\s+(?:an? )?([a-z]+))?/);
  if (!m) return null;
  return [m[1], m[2]].filter(Boolean);
}
function entersTapped(card, lobby) {
  const text = (card.text || "").toLowerCase();
  if (!text.includes("enters the battlefield tapped") && !text.includes("enters tapped")) return false;
  const conditionalTypes = conditionalEntersTappedTypes(card.text);
  if (conditionalTypes) {
    if (!lobby || !card.owner) return true; // conservative fallback if lobby context isn't available
    const hasType = Object.values(lobby.cards).some((c) => c.owner === card.owner && c.zoneType === "mana" && conditionalTypes.some((t) => (c.type || "").toLowerCase().includes(t)));
    return !hasType;
  }
  if (text.includes("you may pay") || text.includes("unless you") || text.includes("if you don't") || text.includes("you may reveal")) return false;
  return true;
}

// Cycling ("Cycling {cost} ({cost}, Discard this card: Draw a card.)") -- a generic, NAME-
// INDEPENDENT text-pattern mechanism (like Command Tower's mana or shocklands' pay-life choice),
// detected straight from oracle text so it works for any card with this ability, no per-card table
// entry needed. "Basic landcycling" is the one common variant with a different resulting effect
// (search a land into hand instead of drawing) -- reuses tutorToHand's existing typeFilter:"land"
// shape, the same already-accepted "any land, not strictly a basic" simplification Weathered
// Wayfarer's activated ability already uses. Untyped "Cycling" is checked FIRST: "landcycling" has
// no word boundary before "cycling" (it's one continuous word), so the plain regex below correctly
// never matches inside "Basic landcycling" and doesn't need an explicit exclusion.
function cyclingCostFromText(text) {
  const t = text || "";
  let m = t.match(/\bbasic landcycling \{([^}]+)\}/i);
  if (m) return { kind: "basicLand", cost: `{${m[1]}}` };
  // Plainscycling/Islandcycling/Swampcycling/Mountaincycling/Forestcycling (Angel of the Ruins and
  // the whole real cycle they belong to) -- the SAME basic-landcycling effect, just restricted to
  // one specific basic type rather than any land. Checked before the untyped "landcycling" case
  // can't apply here anyway since none of these end in a bare "landcycling" word boundary, but
  // ordered first for clarity since they're the more specific pattern.
  m = t.match(/\b(plains|island|swamp|mountain|forest)cycling \{([^}]+)\}/i);
  if (m) return { kind: "basicLand", cost: `{${m[2]}}`, landType: m[1] };
  m = t.match(/\bcycling \{([^}]+)\}/i);
  if (m) return { kind: "draw", cost: `{${m[1]}}` };
  return null;
}

// "When this land/permanent/creature enters, scry N." -- a real, common, name-independent ETB
// template (the "Temple of ..." land cycle and others), detected straight from oracle text so it
// works for ANY card with this exact wording, no per-card table entry needed -- same precedent as
// cyclingCostFromText/landfall just above. Hooked directly into fireEtbTriggers's own EFFECTS call
// (not routed through CARD_ABILITIES/fireTrigger) since it needs no target and no table entry.
function scryOnEtbFromText(text) {
  const m = (text || "").match(/when this (?:land|permanent|creature) enters,\s*scry (\d+)\b/i);
  return m ? parseInt(m[1], 10) : null;
}
// The life-gain sibling of scryOnEtbFromText -- same real, common, name-independent ETB template
// (a gain-life land cycle: Rugged Highlands, Swiftwater Cliffs, etc.), same "resolve inline, no
// table entry" approach.
function gainLifeOnEtbFromText(text) {
  const m = (text || "").match(/when this (?:land|permanent|creature) enters,\s*you gain (\d+) life\b/i);
  return m ? parseInt(m[1], 10) : null;
}
// The draw sibling of scryOnEtbFromText/gainLifeOnEtbFromText -- same real, common,
// name-independent ETB template (Baleful Strix, Prophetic Prism), same "resolve inline, no table
// entry" approach. Deliberately excludes "you may draw..." phrasing (an optional draw is a
// different, less common template not covered here) to stay as narrowly scoped as its siblings.
function drawCardsOnEtbFromText(text) {
  const m = (text || "").match(/when this (?:artifact|creature|permanent) enters,\s*draw (a|\d+) cards?\b/i);
  if (!m) return null;
  return m[1].toLowerCase() === "a" ? 1 : parseInt(m[1], 10);
}

// Exotic Orchard / Reflecting Pool-style sources derive their color from OTHER permanents on the
// battlefield rather than having a fixed set of their own -- detected via oracle text since
// there's no structured field for it. Deliberately narrow to the opponent-facing wording so a
// card like Reflecting Pool ("...a land YOU control...") doesn't get treated the same way.
function dependsOnOpponentLands(card) {
  const text = (card.text || "").toLowerCase();
  return text.includes("opponent controls could produce") || text.includes("opponent controls can produce");
}

// Command Tower and its functional cousins: "Add one mana of any color in your commander's color
// identity." Scryfall's own producedMana field lists all five colors for this card (it can't know
// your deck), so without this it always offered a full 5-color choice regardless of what your
// actual commander(s) could cast -- narrows to the real color identity instead, same
// narrow-the-raw-producedMana-list pattern dependsOnOpponentLands/opponentLandColors already use.
function dependsOnCommanderColorIdentity(card) {
  return (card.text || "").toLowerCase().includes("commander's color identity");
}
function commanderColorIdentity(lobby, ownerId) {
  const p = lobby.players[ownerId];
  const colors = new Set();
  if (p) (p.commanders || []).forEach((cmd) => { if (cmd && Array.isArray(cmd.colorIdentity)) cmd.colorIdentity.forEach((c) => colors.add(c)); });
  return Array.from(colors);
}

// Chromatic Lantern -- "Lands you control have '{T}: Add one mana of any color.'" A blanket grant
// to every OTHER land the controller owns, checked by name (unlike dependsOnOpponentLands/
// dependsOnCommanderColorIdentity's text-pattern approach, since "lands you control have [X]" is
// this card's own specific grant, not a reusable oracle-text shape). Chromatic Lantern's own "{T}:
// Add one mana of any color" ability needs no table entry at all -- Scryfall's producedMana already
// lists all five colors for it, so the tap handler's existing multi-color prompt already covers it.
function controlsChromaticLantern(lobby, ownerId) {
  return Object.values(lobby.cards).some((c) => c.owner === ownerId && c.zoneType !== "hand" && c.zoneType !== "stack" && archiveKey(c.name) === "chromatic lantern");
}

// The actual set of colors any opponent's lands could currently produce, for a source like
// Exotic Orchard. Basic land types are unambiguous by type line; anything else falls back to
// the archive's producedMana list.
function opponentLandColors(lobby, ownerId) {
  const colors = new Set();
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.owner === ownerId || c.zoneType !== "mana") continue;
    const basic = basicLandColor(c.type);
    if (basic) colors.add(basic);
    if (Array.isArray(c.producedMana)) c.producedMana.forEach((col) => { if (["W", "U", "B", "R", "G", "C"].includes(col)) colors.add(col); });
  }
  return Array.from(colors);
}

function parsePT(v) {
  const n = parseInt(v, 10);
  return isNaN(n) ? 0 : n;
}

// Parses the two common equipment/aura patterns -- "Equipped/Enchanted creature gets +X/+Y"
// and "...has/have [keyword(s)]" -- into a stat bonus and keyword grant. Same substring/regex
// style as entersTapped/equipCostFromText: no tokenizer, just the specific wording these cards
// actually use. Anything more conditional (P/T scaling with something, "as long as" clauses,
// keywords outside KNOWN_KEYWORDS) is silently not picked up -- same "close approximation,
// adjudicate the rest manually" philosophy as everywhere else unautomated in this app.
function equipEffectsFromText(text) {
  const t = text || "";
  let powerBonus = 0, toughnessBonus = 0;
  const ptMatch = t.match(/(?:equipped|enchanted) creature gets ([+-]\d+)\/([+-]\d+)/i);
  if (ptMatch) { powerBonus = parseInt(ptMatch[1], 10) || 0; toughnessBonus = parseInt(ptMatch[2], 10) || 0; }
  const keywords = [];
  const hasMatch = t.match(/(?:equipped|enchanted) creature (?:gets [+-]\d+\/[+-]\d+ and )?has ([^.]+)\./i);
  if (hasMatch) {
    hasMatch[1].split(/,| and /i).map((s) => s.trim()).forEach((raw) => {
      const found = KNOWN_KEYWORDS.find((k) => k.toLowerCase() === raw.toLowerCase());
      if (found) keywords.push(found);
    });
  }
  return { powerBonus, toughnessBonus, keywords };
}

// Skullclamp and its functional cousins -- "Whenever equipped creature dies, draw N cards." A
// generic, name-independent, oracle-text-detected mechanism (same precedent as
// anthemKeywordsFromText/cyclingCostFromText/etc.) rather than a per-card table entry, since the
// shape ("equipped creature" + "dies" + "draw") is specific enough not to false-positive on
// anything else. Skullclamp's own static "+1/-1" half is already covered by equipEffectsFromText's
// existing "gets X/Y" pattern -- confirmed it already handles a negative toughness value.
const NUMBER_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
function equipDeathDrawFromText(text) {
  const m = (text || "").match(/when(?:ever)? equipped creature dies, draw (a|an|\d+|one|two|three|four|five|six) cards?/i);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  return NUMBER_WORDS[raw] || parseInt(raw, 10) || 0;
}
// Called from fireDeathTriggers, BEFORE the dying creature is actually removed from lobby.cards --
// same "must run before removal" contract the rest of that function's helpers already follow, since
// this needs to find equipment still attachedTo the dying card's own id.
function checkEquipmentDeathDraw(lobby, dyingCard) {
  if (dyingCard.zoneType !== "creature") return;
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.attachedTo !== dyingCard.id) continue;
    const n = equipDeathDrawFromText(c.text);
    if (!n) continue;
    drawN(lobby, c.owner, n);
    pushLog(lobby, `${(lobby.players[c.owner] || {}).name || "Someone"} draws ${n} card${n === 1 ? "" : "s"} (${c.name || "Equipment"} — equipped creature died)`);
  }
}

const COLOR_NAME_TO_LETTER = { white: "W", blue: "U", black: "B", red: "R", green: "G" };
// Griffin Guide and its functional cousins -- "Whenever equipped/enchanted creature dies, create a
// P/T COLOR TYPE creature token [with KEYWORDS]." A third variant of the same equipment/aura
// "reacts to its held creature dying" family as equipDeathDrawFromText just above, this one
// producing a token instead of cards, via the existing generic `createToken` effect.
function equipDeathTokenFromText(text) {
  const m = (text || "").match(/when(?:ever)? (?:equipped|enchanted) creature dies, create an? (\d+)\/(\d+) (\w+) (\w+) creature tokens?(?: with ([a-z, ]+?))?\.?$/im);
  if (!m) return null;
  const keywords = (m[5] || "").split(/,| and /i).map((s) => s.trim()).map((raw) => KNOWN_KEYWORDS.find((k) => k.toLowerCase() === raw.toLowerCase())).filter(Boolean);
  return { power: m[1], toughness: m[2], color: m[3].toLowerCase(), creatureType: m[4], keywords };
}
// Same "must run before removal, scans attachedTo" contract as checkEquipmentDeathDraw.
function checkEquipmentDeathToken(lobby, dyingCard) {
  if (dyingCard.zoneType !== "creature") return;
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.attachedTo !== dyingCard.id) continue;
    const parsed = equipDeathTokenFromText(c.text);
    if (!parsed) continue;
    EFFECTS.createToken(lobby, { controllerId: c.owner, sourceCard: c }, {
      name: parsed.creatureType, tokenType: `Token Creature — ${parsed.creatureType}`,
      power: parsed.power, toughness: parsed.toughness,
      colors: COLOR_NAME_TO_LETTER[parsed.color] ? [COLOR_NAME_TO_LETTER[parsed.color]] : [],
      keywords: parsed.keywords
    });
    pushLog(lobby, `${(lobby.players[c.owner] || {}).name || "Someone"} creates a token (${c.name || "Aura"} — enchanted creature died)`);
  }
}

// Rogue's Gloves / Curiosity / Ophidian Eye and their functional cousins -- "Whenever equipped/
// enchanted creature deals [combat] damage to a[n] player/opponent, you may draw a card." Same
// generic, name-independent, oracle-text-detected precedent as equipDeathDrawFromText just above
// (the "may" is a real choice in Magic, but this app has no standing "optional trigger" prompt
// anywhere else either -- same disclosed simplification as every other "you may" ETB/trigger this
// app auto-resolves as always-yes, since the upside is one-sided and no real decision exists).
function equipCombatDamageDrawFromText(text) {
  return /when(?:ever)? (?:equipped|enchanted) creature deals (?:combat )?damage to (?:a player|an opponent|opponents), you may draw a card\.?/i.test(text || "");
}
// Called from resolveCombatDamage right alongside fireCombatDamageToPlayerTriggers/
// fireBreathOfFuryTrigger (its two call sites, unblocked damage and trample overflow) -- same
// "already fired, still attached, still a real hit" precondition both of those already checked at
// their call site before calling in.
function checkEquipmentCombatDamageDraw(lobby, dealingCard) {
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.attachedTo !== dealingCard.id || !equipCombatDamageDrawFromText(c.text)) continue;
    drawN(lobby, c.owner, 1);
    pushLog(lobby, `${(lobby.players[c.owner] || {}).name || "Someone"} draws a card (${c.name || "Equipment"} — dealt combat damage to a player)`);
  }
}
// Power Fist's granted ability -- "Whenever this creature deals combat damage to a player, put
// that many +1/+1 counters on it." Same live-text-scan/attachedTo-scan shape and call sites as
// checkEquipmentCombatDamageDraw just above, adding counters equal to the actual damage amount
// dealt (routed through bonusCountersFor/counterMultiplierFor, same as any other real
// +1/+1-counter-adding effect -- a Doubling Season-style doubler should apply here too).
function equipCombatDamageCountersFromText(text) {
  // Power Fist's own wording quotes the granted ability in the CREATURE's voice ("this creature
  // deals...") rather than the equipment's own voice ("equipped creature deals..." -- Rogue's
  // Gloves' unquoted style) -- both phrasings mean the same thing here, so both are accepted.
  return /when(?:ever)? (?:equipped|enchanted|this) creature deals (?:combat )?damage to (?:a player|an opponent|opponents), put that many \+1\/\+1 counters on it\.?/i.test(text || "");
}
function checkEquipmentCombatDamageCounters(lobby, dealingCard, amount) {
  if (!amount) return;
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.attachedTo !== dealingCard.id || !equipCombatDamageCountersFromText(c.text)) continue;
    const bonus = bonusCountersFor(lobby, dealingCard.owner);
    const mult = counterMultiplierFor(lobby, dealingCard.owner);
    dealingCard.counters = (dealingCard.counters || 0) + (amount + bonus) * mult;
    broadcastCard(lobby, dealingCard);
    pushLog(lobby, `${dealingCard.name || "A creature"} gets ${amount} +1/+1 counter(s) (${c.name || "Equipment"} — dealt combat damage to a player)`);
  }
}
// The Reaver Cleaver's own granted ability -- "create that many Treasure tokens" (same "that many"
// = the actual damage dealt). Fifth variant in this same family; "or planeswalker" is left
// unmodeled the same way every other combat-damage-to-planeswalker case in this engine already is
// (this app has no planeswalker-damage tracking at all) -- the player-damage half is real and is
// the overwhelmingly common case anyway.
function equipCombatDamageTreasureFromText(text) {
  return /when(?:ever)? (?:equipped|enchanted|this) creature deals (?:combat )?damage to (?:a player|an opponent|opponents)(?: or planeswalker)?, create that many treasure tokens?\.?/i.test(text || "");
}
function checkEquipmentCombatDamageTreasure(lobby, dealingCard, amount) {
  if (!amount) return;
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.attachedTo !== dealingCard.id || !equipCombatDamageTreasureFromText(c.text)) continue;
    for (let i = 0; i < amount; i++) EFFECTS.createTreasureToken(lobby, { controllerId: dealingCard.owner });
    pushLog(lobby, `${(lobby.players[dealingCard.owner] || {}).name || "Someone"} creates ${amount} Treasure token${amount === 1 ? "" : "s"} (${c.name || "Equipment"} — dealt combat damage to a player)`);
  }
}
// Sting, the Glinting Dagger -- "At the beginning of each combat, untap equipped creature." A plain
// text-scan sweep (see advanceOnePhase's own call site comment for why this isn't a CARD_ABILITIES
// dispatch), checked once per real Combat-phase entry regardless of whose turn it is.
function checkStingUntapEquippedCreature(lobby) {
  Object.values(lobby.cards).forEach((c) => {
    if (!c.attachedTo || !/at the beginning of each combat, untap equipped creature/i.test(c.text || "")) return;
    const host = lobby.cards[c.attachedTo];
    if (host && host.tapped) { host.tapped = false; broadcastCard(lobby, host); }
  });
}
// Tarrian's Soulcleaver -- "Whenever another artifact or creature is put into a graveyard from the
// battlefield, put a +1/+1 counter on equipped creature." A genuinely GLOBAL death watch for an
// equipment (unlike the rest of this "reacts to its own held creature" family above, which only
// ever react to damage dealt BY the equipped creature) -- any artifact or creature dying anywhere
// on the table counts, regardless of controller. Called from fireDeathTriggers, the one real
// universal "this permanent just died from the battlefield" choke point (see its own comment) --
// but that runs BEFORE the dying card is deleted/detached, so this explicitly skips the case where
// the dying permanent IS the equipped host itself (no legal recipient left once it's gone, matching
// real Magic), rather than relying on deletion timing to make that true.
function checkTarrianSoulcleaverCounter(lobby, dyingCard) {
  const t = (dyingCard.type || "").toLowerCase();
  if (!t.includes("artifact") && !t.includes("creature")) return;
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.id === dyingCard.id || !c.attachedTo || c.attachedTo === dyingCard.id) continue;
    if (!/whenever another artifact or creature is put into a graveyard from the battlefield, put a \+1\/\+1 counter on equipped creature/i.test(c.text || "")) continue;
    const host = lobby.cards[c.attachedTo];
    if (!host) continue;
    const bonus = bonusCountersFor(lobby, host.owner);
    const mult = counterMultiplierFor(lobby, host.owner);
    host.counters = (host.counters || 0) + (1 + bonus) * mult;
    broadcastCard(lobby, host);
  }
}

// Live-computed, never stored on the card -- scans for anything currently attachedTo this card
// each time it's needed, so detaching (detachCard) or the host leaving (detachDependents, which
// already severs attachedTo in both the "equipment survives" and "aura dies" branches) requires
// zero new cleanup code; the bonus just stops applying because the scan no longer finds it.
function attachedBonusFor(lobby, card) {
  let powerBonus = 0, toughnessBonus = 0, keywords = [];
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.attachedTo !== card.id) continue;
    const eff = equipEffectsFromText(c.text);
    powerBonus += eff.powerBonus;
    toughnessBonus += eff.toughnessBonus;
    keywords = keywords.concat(eff.keywords);
  }
  return { powerBonus, toughnessBonus, keywords };
}
// A real "until end of turn" keyword grant -- distinct from mutating card.keywords directly
// (permanent), which is what every prior "until end of turn" effect in this app used as a
// disclosed simplification (no duration/cleanup system existed at all). Expires automatically at
// cleanup (see cleanupTemporaryKeywords), so callers no longer need to disclose "granted
// permanently instead" for new cards using this.
function grantTemporaryKeyword(lobby, card, keyword) {
  if (!card.temporaryKeywords) card.temporaryKeywords = [];
  if (!card.temporaryKeywords.some((tk) => tk.keyword === keyword)) {
    card.temporaryKeywords.push({ keyword });
    broadcastCard(lobby, card);
  }
}
// The numeric counterpart to grantTemporaryKeyword -- a real "until end of turn" P/T buff (Shared
// Animosity, Battle Cry Goblin), additive across multiple grants in the same turn (Shared Animosity
// can fire more than once per combat). Read by staticBonusFor -- see its own comment -- so every
// existing P/T computation (combat damage, damageTarget, activation conditions, etc.) already
// includes it with no call-site changes needed.
function grantTemporaryPT(lobby, card, powerDelta, toughnessDelta) {
  if (!card.temporaryPT) card.temporaryPT = { power: 0, toughness: 0 };
  card.temporaryPT.power += powerDelta;
  card.temporaryPT.toughness += toughnessDelta;
  broadcastCard(lobby, card);
}
// The subtype words after the em-dash in a creature's type line ("Creature — Human Knight" ->
// ["human","knight"]), lowercased for case-insensitive comparison. Generalizable for any future
// "shares a creature type" card, not just Shared Animosity below.
function creatureSubtypesOf(card) {
  const m = (card.type || "").match(/creature\s*[—-]\s*(.+)$/i);
  if (!m) return [];
  return m[1].split(/\s+/).map((s) => s.toLowerCase());
}
// Shared Animosity -- "Whenever a creature you control attacks, it gets +1/+0 until end of turn for
// each other attacking creature that shares a creature type with it." Computed once, right after
// declareAttackers locks in the full attacker set (every attacker's bonus depends on every OTHER
// attacker's types, so this can't be a simple per-creature trigger the way fireAttackTriggers is).
function applySharedAnimosity(lobby, attackerIds) {
  const attackers = attackerIds.map((id) => lobby.cards[id]).filter(Boolean);
  if (!attackers.length) return;
  const hasSharedAnimosity = (ownerId) => Object.values(lobby.cards).some((c) => c.owner === ownerId && c.zoneType !== "hand" && c.zoneType !== "stack" && /whenever a creature you control attacks, it gets \+1\/\+0 until end of turn for each other attacking creature that shares a creature type with it/i.test(c.text || ""));
  attackers.forEach((atk) => {
    if (!hasSharedAnimosity(atk.owner)) return;
    const atkTypes = creatureSubtypesOf(atk);
    if (!atkTypes.length) return;
    const count = attackers.filter((other) => other.id !== atk.id && creatureSubtypesOf(other).some((t) => atkTypes.includes(t))).length;
    if (count > 0) grantTemporaryPT(lobby, atk, count, 0);
  });
}
// Devotion to a color (CR 704.5v-ish) -- count of that color's mana symbols in the mana costs of
// permanents you control, including hybrid symbols mentioning that color. Doesn't attempt Phyrexian
// mana symbols. Reusable for any future devotion-scaling card, not just Gray Merchant of Asphodel.
function devotionToColor(lobby, ownerId, color) {
  let count = 0;
  Object.values(lobby.cards).forEach((c) => {
    if (c.owner !== ownerId || c.zoneType === "hand" || c.zoneType === "stack") return;
    const symbols = (c.manaCost || "").match(/\{[^}]+\}/g) || [];
    symbols.forEach((sym) => { if (sym.toUpperCase().includes(color)) count++; });
  });
  return count;
}
// Battle cry -- a real named keyword ("Whenever this creature attacks, each OTHER attacking
// creature gets +1/+0 until end of turn"). Applies regardless of controller (the real reminder text
// has no "you control" restriction, unlike Shared Animosity), matching every attacker present.
function applyBattleCry(lobby, attackerIds) {
  const attackers = attackerIds.map((id) => lobby.cards[id]).filter(Boolean);
  if (!attackers.length) return;
  const battleCriers = attackers.filter((c) => /\bbattle cry\b/i.test(c.text || ""));
  if (!battleCriers.length) return;
  attackers.forEach((atk) => {
    const bonus = battleCriers.filter((bc) => bc.id !== atk.id).length;
    if (bonus > 0) grantTemporaryPT(lobby, atk, bonus, 0);
  });
}
// Goblin Piledriver-style "Whenever this creature attacks, it gets +X/+0 until end of turn for each
// other attacking [Type]" -- self-only (unlike Shared Animosity's dynamic "shares a type with it"),
// counting every OTHER currently-attacking creature (any controller, matching the real card's own
// unrestricted wording) against one FIXED type named in the source's own text.
function applySelfAttackTypeCountPump(lobby, attackerIds) {
  const attackers = attackerIds.map((id) => lobby.cards[id]).filter(Boolean);
  attackers.forEach((atk) => {
    const m = (atk.text || "").match(/whenever this creature attacks, it gets \+(\d+)\/\+0 until end of turn for each other attacking (\w+)/i);
    if (!m) return;
    const perAmount = parseInt(m[1], 10) || 0;
    const type = m[2].toLowerCase();
    const count = attackers.filter((other) => other.id !== atk.id && (other.type || "").toLowerCase().includes(type)).length;
    if (count > 0) grantTemporaryPT(lobby, atk, perAmount * count, 0);
  });
}
// Exalted (a real named keyword, CR 702.83) -- "Whenever a creature you control attacks alone,
// that creature gets +1/+1 until end of turn," once per Exalted source the ATTACKING PLAYER
// controls (not just the lone attacker's own text, unlike battle cry/piledriver-style pumps above
// which scale off OTHER attackers -- Exalted scales off other non-attacking permanents entirely,
// so it's checked once against the whole attack, not per-attacker). Only ever relevant when
// exactly one attacker was declared, matching the "alone" condition literally rather than trying
// to model "would still count if blocked" nuance no other part of this engine tracks either.
function applyExalted(lobby, attackerIds, controllerId) {
  if (attackerIds.length !== 1) return;
  const atk = lobby.cards[attackerIds[0]];
  if (!atk) return;
  const count = Object.values(lobby.cards).filter((c) => c.owner === controllerId && c.zoneType !== "hand" && c.zoneType !== "stack" && /\bexalted\b/i.test(c.text || "")).length;
  if (count > 0) grantTemporaryPT(lobby, atk, count, count);
}
// Called once per real new turn (the End Step -> next Untap wraparound in advanceOnePhase) --
// every temporary keyword granted at any point during the turn that just ended is now expired,
// same real-Magic cleanup-step timing (CR 514) "until end of turn" effects actually follow. Also
// clears every other "this turn" restriction this app tracks (Orim's Chant's cast-restriction and
// its kicked "creatures can't attack" clause) -- one shared cleanup point for anything scoped to
// "this turn", rather than teaching advanceOnePhase about each one individually.
function cleanupTemporaryKeywords(lobby) {
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    // Giver of Runes/Mother of Runes' granted protection is "until end of turn" too -- swept
    // alongside temporaryKeywords in the same pass rather than a second loop over lobby.cards.
    const hasTempKw = c.temporaryKeywords && c.temporaryKeywords.length;
    const hasGrantedProt = c.grantedProtections && c.grantedProtections.length;
    const hasTempPT = c.temporaryPT && (c.temporaryPT.power || c.temporaryPT.toughness);
    // Cursed Mirror -- "until end of turn" copy revert. Restores every field
    // EFFECTS.becomeCopyUntilEOT overwrote, using the snapshot it took before copying.
    const hasCopy = !!c._copyOriginal;
    // Kor Haven -- "this turn" combat damage prevention, same sweep as everything else here.
    const hasDamagePrevention = !!c.preventCombatDamageUntilEndOfTurn;
    // Shadowspear -- "until end of turn" hexproof/indestructible loss, same sweep.
    const hasHexproofIndestructibleLoss = !!c.loseHexproofIndestructibleUntilEndOfTurn;
    if (hasTempKw || hasGrantedProt || hasTempPT || hasCopy || hasDamagePrevention || hasHexproofIndestructibleLoss) {
      c.temporaryKeywords = [];
      c.grantedProtections = [];
      c.temporaryPT = null;
      if (hasCopy) {
        Object.assign(c, c._copyOriginal);
        c._copyOriginal = null;
      }
      if (hasDamagePrevention) c.preventCombatDamageUntilEndOfTurn = false;
      if (hasHexproofIndestructibleLoss) c.loseHexproofIndestructibleUntilEndOfTurn = false;
      broadcastCard(lobby, c);
    }
  }
  let restrictionsChanged = false;
  for (const pid in lobby.players) {
    const p = lobby.players[pid];
    if (p.cantCastSpells) { p.cantCastSpells = false; restrictionsChanged = true; }
    // Emergence Zone -- "this turn," the exact mirror of cantCastSpells just above.
    if (p.hasFlashUntilEndOfTurn) { p.hasFlashUntilEndOfTurn = false; restrictionsChanged = true; }
    // Deflecting Palm -- "this turn," swept here if the chosen source never actually dealt damage.
    if (p.deflectingPalmSource) { p.deflectingPalmSource = null; restrictionsChanged = true; }
  }
  if (restrictionsChanged) broadcastPlayers(lobby);
  if (lobby.creaturesCantAttack) lobby.creaturesCantAttack = false;
}
// A card's keywords plus whatever any attached equipment/aura grants, plus whatever any OTHER
// permanent's static keyword-anthem grants it -- the one thing that matters for gameplay
// (Haste-gated summoning sickness, Indestructible in dealtLethal/destroyTarget, and anything else
// that reads keywords).
function effectiveKeywords(lobby, card) {
  const bonus = attachedBonusFor(lobby, card);
  let extra = [...(card.keywords || []), ...bonus.keywords, ...(card.temporaryKeywords || []).map((tk) => tk.keyword)];
  // Serra Ascendant -- "As long as you have N or more life, this creature ... has [keyword]." A
  // self-referential CONDITIONAL grant (unlike the anthem loop below, which reacts to OTHER
  // permanents) -- narrowly scoped to this exact template, same precedent as every other
  // name-independent text-scan mechanism in this file.
  const lifeKwMatch = (card.text || "").match(/as long as you have (\d+) or more life,.*\bhas ([a-z]+)\b/i);
  if (lifeKwMatch) {
    const p = lobby.players[card.owner];
    const kw = KNOWN_KEYWORDS.find((k) => k.toLowerCase() === lifeKwMatch[2].toLowerCase());
    if (p && kw && p.life >= parseInt(lifeKwMatch[1], 10)) extra.push(kw);
  }
  // Kyodai, Soul of Kamigawa -- "target permanent gains indestructible for as long as you control
  // Kyodai." A LINKED-duration grant (not "until end of turn," tied to a specific OTHER permanent's
  // continued presence) -- stored as a source id on the card itself, checked LIVE here rather than
  // swept by cleanupTemporaryKeywords, so it naturally keeps applying across turns and just as
  // naturally stops the moment that source is gone, with zero cleanup code needed. Applies to any
  // permanent type (not gated by the creature-only anthem loop below), matching this function's own
  // non-creature callers (destroyAllNonlandPermanents, etc.).
  if (card.grantedIndestructibleWhileSourceId && lobby.cards[card.grantedIndestructibleWhileSourceId]) {
    extra.push("Indestructible");
  }
  // Sting, the Glinting Dagger -- "Equipped creature has first strike as long as it's blocking or
  // blocked by a Goblin or Orc." A combat-state-dependent granted keyword, checked LIVE against
  // lobby.combat's own attacker/blocks maps (attackerId -> defenderId, attackerId -> [blockerIds])
  // rather than anything stored on the card -- "blocking" means this card's id appears in some
  // attacker's blocks list; "blocked" means this card is itself an attacker with a Goblin/Orc among
  // ITS OWN blockers.
  if (card.zoneType === "creature" && lobby.combat) {
    const isGoblinOrOrc = (id) => { const c = lobby.cards[id]; return c && /goblin|orc/i.test(c.type || ""); };
    for (const id in lobby.cards) {
      const c = lobby.cards[id];
      if (c.attachedTo !== card.id || !/equipped creature has first strike as long as it'?s blocking or blocked by a goblin or orc/i.test(c.text || "")) continue;
      const isBlocking = Object.entries(lobby.combat.blocks || {}).some(([atkId, blockerIds]) => (blockerIds || []).includes(card.id) && isGoblinOrOrc(atkId));
      const isBlockedByGoblinOrOrc = (lobby.combat.blocks[card.id] || []).some(isGoblinOrOrc);
      if (isBlocking || isBlockedByGoblinOrOrc) extra.push("First Strike");
      break;
    }
  }
  if (card.zoneType === "creature") {
    for (const id in lobby.cards) {
      const c = lobby.cards[id];
      if (c.owner !== card.owner || c.zoneType === "hand" || c.zoneType === "stack") continue;
      const anthem = anthemKeywordsFromText(c.text);
      if (!anthem.keywords.length) continue;
      if (id === card.id && !anthem.includesSelf) continue; // an "other creatures" anthem doesn't grant to its own source
      if (anthem.keywordFilter && !(card.keywords || []).some((k) => (k || "").toLowerCase() === anthem.keywordFilter.toLowerCase())) continue;
      if (anthem.typeFilter && !(card.type || "").toLowerCase().includes(anthem.typeFilter)) continue;
      extra = extra.concat(anthem.keywords);
    }
  }
  // Shadowspear -- "Permanents your opponents control lose hexproof and indestructible until end of
  // turn." Filtering here (rather than at the grant site) means every existing hexproof/indestructible
  // check (targetIsUntargetableBy, dealtLethal, destroyTarget's own guard, etc.) respects the loss for
  // free, since they all already read through this one function.
  if (card.loseHexproofIndestructibleUntilEndOfTurn) {
    extra = extra.filter((k) => !["hexproof", "indestructible"].includes((k || "").toLowerCase()));
  }
  return [...new Set(extra)];
}

// Toggleable (lobby.settings.enforceTargetingRestrictions) targeting-legality checks for
// Hexproof/Shroud/Ward/Protection -- see targetIsUntargetableBy's own comment for the actual
// rules being modeled and what's deliberately simplified. Scoped to TARGETING only (not
// Protection's other three DEBT facets -- damage prevention, can't-block, can't-enchant/equip --
// which stay unmodeled, same "targeting is the one that matters most for an automated table"
// narrowing as everywhere else in this file).
function parsedProtectionQualities(card) {
  // No trailing period required -- a card whose entire text is one keyword line (e.g. Baneslayer
  // Angel: "Flying, first strike, lifelink, protection from Demons and from Dragons") has no
  // period at all, since Magic's own convention omits one for keyword-only lines.
  const m = (card.text || "").match(/protection from ([^.\n]+)/i);
  if (!m) return [];
  return m[1].split(/,| and /i).map((s) => s.replace(/^\s*from\s+/i, "").trim().toLowerCase()).filter(Boolean);
}
const PROTECTION_COLOR_WORDS = { white: "W", blue: "U", black: "B", red: "R", green: "G" };
// Serra's Emissary's "choose a card type" ETB choice -- the real card types a permanent/spell can
// meaningfully have (Tribal/Kindred and Battle omitted as vanishingly unlikely to come up in
// practice; easy to extend later).
const CARD_TYPE_CHOICES = ["Creature", "Instant", "Sorcery", "Artifact", "Enchantment", "Planeswalker", "Land"];
// Does `sourceCard` (the spell being cast, or the permanent whose ability is targeting) match any
// of `targetCard`'s printed "protection from X" qualities? X can be a color ("from black") or a
// creature type ("from Demons and from Dragons", matched via simple singular/plural stemming
// against the source's own type line) -- "protection from everything" (Progenitus-style) always
// matches. No sourceCard (e.g. a triggered ability with no real card object) never matches.
// Union of a creature's PRINTED protection (parsedProtectionQualities) and any GRANTED protection
// (Giver of Runes/Mother of Runes -- "target creature you control gains protection from the color
// of your choice UNTIL END OF TURN") -- the latter stored as card.grantedProtections, an array of
// plain quality strings in the exact same format parsedProtectionQualities already produces, swept
// at the same end-of-turn cleanup point as card.temporaryKeywords.
function allProtectionQualities(card) {
  return parsedProtectionQualities(card).concat(card.grantedProtections || []);
}
function sourceMatchesProtection(targetCard, sourceCard) {
  const qualities = allProtectionQualities(targetCard);
  if (!qualities.length || !sourceCard) return false;
  return qualities.some((q) => {
    if (q === "everything") return true;
    if (q === "colorless") return (sourceCard.colors || []).length === 0;
    if (PROTECTION_COLOR_WORDS[q]) return (sourceCard.colors || []).includes(PROTECTION_COLOR_WORDS[q]);
    const singular = q.replace(/s$/, "");
    return (sourceCard.type || "").toLowerCase().includes(singular);
  });
}
// The one check both resolveChosenTarget (spells/abilities) and declareBlockers (Protection's
// can't-be-blocked-by facet is a natural extension of the same "does the source match?" question)
// can share. `controllerId` is whoever is doing the targeting/blocking; Hexproof/Ward only stop
// OPPONENTS, Shroud stops everyone including the target's own controller, Protection matches
// against the SOURCE card's own color/type regardless of who controls it. Ward is simplified to
// "the interaction just doesn't happen" rather than modeling its real "counter unless you pay a
// cost" wording -- this app has no "pay an optional cost to push a spell through" prompt anywhere.
function targetIsUntargetableBy(lobby, targetCard, controllerId, sourceCard) {
  if (!lobby.settings || !lobby.settings.enforceTargetingRestrictions) return false;
  const kw = effectiveKeywords(lobby, targetCard).map((k) => (k || "").toLowerCase());
  if (kw.includes("shroud")) return true;
  if (targetCard.owner === controllerId) return false; // Hexproof/Ward/Protection only ever restrict OPPONENTS
  if (kw.includes("hexproof") || kw.includes("ward")) return true;
  if (sourceMatchesProtection(targetCard, sourceCard)) return true;
  if (cardTypeProtectionBlocks(lobby, targetCard.owner, sourceCard)) return true;
  return false;
}
// Serra's Emissary: "You and creatures you control have protection from the chosen card type." A
// PLAYER-level protection (tracked on the player, not printed on any one card) -- checked at the
// same choke points as per-card Protection (targeting, blocking) and gated by the same toggle,
// following the same "opponents only" simplification the rest of this system already uses (see
// targetIsUntargetableBy's own comment) rather than introducing a special case that applies to
// your own sources too.
function cardTypeProtectionBlocks(lobby, protectedPlayerId, sourceCard) {
  if (!lobby.settings || !lobby.settings.enforceTargetingRestrictions) return false;
  const p = lobby.players[protectedPlayerId];
  if (!p || !sourceCard) return false;
  if (p.protectionFromEverything) return true; // Teferi's Protection
  if (!p.protectionFromCardType) return false;
  return (sourceCard.type || "").toLowerCase().includes(p.protectionFromCardType.toLowerCase());
}

// Parses a permanent's own oracle text for the anthem/lord pattern -- "Other [color] creatures you
// control get +X/+Y", with an optional COLOR restriction ("Other red creatures...", "Other white
// creatures..."). A single card can carry more than one such clause (Balefire Liege has two, one
// per color), so this returns an ARRAY of clauses instead of a single flat bonus -- each with its
// own colorFilter (null for the plain untyped "Other creatures..." wording, unrestricted).
// Deliberately not attempting CREATURE-TYPE-restricted anthems ("Elves you control get...",
// "Angels you control get..."), which stay manual via the existing Manage Keywords tool -- the
// literal color-word alternation below means anything else (a creature-type word, "Legendary",
// etc.) simply doesn't match at all rather than being mis-treated as unrestricted.
function anthemEffectsFromText(text) {
  const t = text || "";
  const clauses = [];
  const re = /other (?:(red|white|blue|black|green) )?creatures you control get ([+-]\d+)\/([+-]\d+)/gi;
  let m;
  while ((m = re.exec(t))) {
    const colorFilter = m[1] ? PROTECTION_COLOR_WORDS[m[1].toLowerCase()] : null;
    clauses.push({ powerBonus: parseInt(m[2], 10) || 0, toughnessBonus: parseInt(m[3], 10) || 0, colorFilter });
  }
  // Type-scoped P/T anthem ("Other Goblins you control get +1/+1", "Other Goblin creatures you
  // control get +1/+1") -- the P/T counterpart to anthemKeywordsFromText's own type-scoped branch
  // (built for Goblin Warchief's haste grant). Excludes the 5 color words (already handled just
  // above) and the bare word "creature[s]" itself (the untyped case above already covers that
  // wording -- without this exclusion, "Other creatures you control get..." would double-match
  // here too, since "creature"+"s" fits the same (\w+?)s? shape as a real type word).
  const typeRe = /other (\w+?)s?(?: creatures)? you control get ([+-]\d+)\/([+-]\d+)/gi;
  let tm;
  while ((tm = typeRe.exec(t))) {
    const word = tm[1].toLowerCase();
    if (["red", "white", "blue", "black", "green", "creature"].includes(word)) continue;
    clauses.push({ powerBonus: parseInt(tm[2], 10) || 0, toughnessBonus: parseInt(tm[3], 10) || 0, colorFilter: null, typeFilter: word });
  }
  // Self-inclusive type-scoped anthem ("Legendary creatures you control get +1/+0", no "other") --
  // the P/T counterpart to anthemKeywordsFromText's own self-inclusive typed branch (built for
  // Whip of Erebos), which staticBonusFor never needed to check for until now since every prior
  // anthemEffectsFromText clause required "other". A plain lookbehind-based "not preceded by other"
  // regex turns out unsafe here (a failed lookbehind just makes the engine retry one character
  // later, silently matching a truncated word like "oblins" instead of "Goblins") -- verified
  // directly before shipping, so this instead runs the bare pattern first and then checks the 6
  // characters immediately before each match for a literal "other " to skip, exactly mirroring
  // what the "other"-prefixed branch above already consumed.
  const bareTypeRe = /\b(\w+?)s?(?: creatures)? you control get ([+-]\d+)\/([+-]\d+)/gi;
  let sm;
  while ((sm = bareTypeRe.exec(t))) {
    const word = sm[1].toLowerCase();
    if (["red", "white", "blue", "black", "green", "creature", "other"].includes(word)) continue;
    if (t.slice(Math.max(0, sm.index - 6), sm.index).toLowerCase() === "other ") continue;
    clauses.push({ powerBonus: parseInt(sm[2], 10) || 0, toughnessBonus: parseInt(sm[3], 10) || 0, colorFilter: null, typeFilter: word, includesSelf: true });
  }
  return clauses;
}
// Sedge Sliver -- "All Sliver creatures have 'This creature gets +1/+1 as long as you control a
// Swamp.'" A GRANTED self-referential conditional P/T (the granting permanent hands a whole quoted
// conditional ability to a type of creature, rather than a flat unconditional anthem bonus like
// anthemEffectsFromText above) -- narrow to this one real template rather than trying to generalize
// every possible granted-conditional shape.
function grantedConditionalLandPTFromText(text) {
  const m = (text || "").match(/all (\w+) creatures have "this creature gets \+(\d+)\/\+(\d+) as long as you control an? (\w+)\.?"/i);
  if (!m) return null;
  return { typeWord: m[1].toLowerCase(), powerBonus: parseInt(m[2], 10) || 0, toughnessBonus: parseInt(m[3], 10) || 0, landType: m[4].toLowerCase() };
}
// The keyword-granting counterpart to anthemEffectsFromText -- "Other creatures/permanents you
// control have X[, Y and Z]." (Avacyn, Angel of Hope) or the self-inclusive "Creatures you control
// have X." (Whip of Erebos -- no "other", so it also grants to itself if the source is itself a
// creature). Same untyped-only narrowing as the stat-bonus version.
function anthemKeywordsFromText(text) {
  const t = text || "";
  // Sephara, Sky's Blade-style: "Other creatures you control WITH FLYING have indestructible" --
  // a keyword-restricted grant (checked against the target's own PRINTED keywords only, not a
  // recursive effectiveKeywords call -- a disclosed narrowing, same spirit as the color-restricted
  // anthem work: won't catch a creature that only gained the qualifying keyword from another
  // source).
  let m = t.match(/other creatures you control with (\w+) have ([^.]+)\./i);
  if (m) {
    const keywordFilter = KNOWN_KEYWORDS.find((k) => k.toLowerCase() === m[1].toLowerCase()) || null;
    return { keywords: parseKeywordList(m[2]), includesSelf: false, keywordFilter };
  }
  m = t.match(/other (?:creatures|permanents) you control have ([^.]+)\./i);
  if (m) return { keywords: parseKeywordList(m[1]), includesSelf: false, keywordFilter: null };
  m = t.match(/creatures you control have ([^.]+)\./i);
  if (m) return { keywords: parseKeywordList(m[1]), includesSelf: true, keywordFilter: null };
  // Goblin Warchief-style: "TYPE(s) you control have KEYWORD" -- restricted by the TARGET's own
  // creature type (checked against its type line in effectiveKeywords), not a keyword it already
  // has. Checked after the plain "creatures"/"permanents" patterns above so those still win for
  // their own literal wording -- this only ever matches a real type name like "Goblins"/"Elves".
  m = t.match(/other (\w+)s you control have ([^.]+)\./i);
  if (m) return { keywords: parseKeywordList(m[2]), includesSelf: false, keywordFilter: null, typeFilter: m[1].toLowerCase() };
  m = t.match(/(\w+)s you control have ([^.]+)\./i);
  if (m) return { keywords: parseKeywordList(m[2]), includesSelf: true, keywordFilter: null, typeFilter: m[1].toLowerCase() };
  return { keywords: [], includesSelf: false, keywordFilter: null };
}
// Goblin Warchief-style "[Type] spells you cast cost {N} less to cast" -- pure text-scan (no fixed
// name list, same precedent as dependsOnCommanderColorIdentity), matched against the spell's own
// type line at cast time. Only ever reduces GENERIC mana -- real cost reduction never touches
// colored pips unless the text says so explicitly, which none of this app's seeded cards do.
function spellCostReductionFor(lobby, ownerId, card) {
  let reduction = 0;
  const typeLower = (card.type || "").toLowerCase();
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.owner !== ownerId || c.zoneType === "hand" || c.zoneType === "stack") continue;
    const m = (c.text || "").match(/(\w+) spells you cast cost \{(\d+)\} less to cast/i);
    if (m && typeLower.includes(m[1].toLowerCase())) reduction += parseInt(m[2], 10) || 0;
  }
  // Ghalta, Primal Hunger -- "This spell costs {X} less to cast, where X is the total power of
  // creatures you control." Self-referential (checked on the CARD BEING CAST's own text, not a
  // grant from another permanent) -- Ghalta itself hasn't entered yet while it's being cast, so
  // "creatures you control" only ever counts what's already on the battlefield, matching real
  // Magic's own timing. Uses each creature's real effective power (base + counters + equipment/
  // aura/anthem bonuses), same computation Bonders' Enclave's own condition already uses.
  if (/this spell costs \{x\} less to cast, where x is the total power of creatures you control/i.test(card.text || "")) {
    reduction += Object.values(lobby.cards)
      .filter((c) => c.owner === ownerId && c.zoneType === "creature")
      .reduce((sum, c) => sum + parsePT(c.power) + (c.counters || 0) + attachedBonusFor(lobby, c).powerBonus + staticBonusFor(lobby, c).powerBonus, 0);
  }
  return reduction;
}
// Rhythm of the Wild-style "Creature spells you control can't be countered" -- pure text scan, same
// no-fixed-name-list precedent as spellCostReductionFor above. Scoped to the real automated counter
// effects (EFFECTS.counterTargetSpell*) -- the manual ad-hoc Counter button stays a trusted freeform
// tool like every other manual action in this app, so it's deliberately not checked here.
function isProtectedFromCountering(lobby, stackItem) {
  if (!stackItem || stackItem.kind === "ability") return false;
  // Hit-Monkey and similar -- a spell's own printed "This spell can't be countered," checked
  // directly on the stack item's own text (pushToStack pushes the real card object, so .text
  // survives onto the stack). No anthem/grant needed for this self-referential case.
  if (/this spell can'?t be countered/i.test(stackItem.text || "")) return true;
  if (!(stackItem.type || "").toLowerCase().includes("creature")) return false;
  return Object.values(lobby.cards).some((c) => c.owner === stackItem.owner && c.zoneType !== "hand" && c.zoneType !== "stack" && /creature spells you control can'?t be countered/i.test(c.text || ""));
}
// Riot (Rhythm of the Wild grants it to all your nontoken creatures; some cards also print it as
// their own native keyword) -- real Magic lets the controller choose a +1/+1 counter or haste as it
// enters. No per-ETB modal-choice UI exists for something that could fire on every single creature
// ETB for the rest of the game (unlike Windcrag Siege's own mode, chosen ONCE via a repurposed
// activated-ability button) -- auto-picks the +1/+1 counter, a permanent value with no timing
// sensitivity, over haste, a disclosed simplification.
function checkRiot(lobby, card) {
  if (card.zoneType !== "creature") return;
  const isToken = (card.type || "").toLowerCase().includes("token");
  const hasNativeRiot = /\briot\b/i.test(card.text || "");
  let granted = false;
  if (!isToken) {
    for (const id in lobby.cards) {
      const c = lobby.cards[id];
      if (c.owner !== card.owner || c.id === card.id || c.zoneType === "hand" || c.zoneType === "stack") continue;
      if (/nontoken creatures you control have riot/i.test(c.text || "")) { granted = true; break; }
    }
  }
  if (!hasNativeRiot && !granted) return;
  const bonus = bonusCountersFor(lobby, card.owner);
  card.counters = (card.counters || 0) + 1 + bonus;
  broadcastCard(lobby, card);
  pushLog(lobby, `${card.name || "A creature"} enters with a +1/+1 counter (riot)`);
}
// Thousand-Year Elixir-style "you may activate abilities of creatures you control as though those
// creatures had haste" -- deliberately narrower than a real haste grant (effectiveKeywords), which
// would also incorrectly let the creature ATTACK the turn it enters. Checked only at the one gate
// this needs (summoning sickness for a {T}-costed activated ability), pure text-scan like every
// other no-fixed-name-list static check.
function canActivateAbilitiesAsThoughHaste(lobby, ownerId) {
  return Object.values(lobby.cards).some((c) => c.owner === ownerId && c.zoneType !== "hand" && c.zoneType !== "stack" && /activate abilities of creatures you control as though (those creatures |they )?had haste/i.test(c.text || ""));
}
// Anointed Procession / functional cousins -- "If an effect would create one or more tokens under
// your control, it creates twice that many of those tokens instead." Detected by oracle text, not
// by name (same "no fixed name list" precedent as commander-color-identity mana/shockland pay-life),
// so it stacks correctly if more than one is somehow in play. Applied by every createToken-family
// EFFECTS function, multiplying the count right before spawning.
function tokenMultiplierFor(lobby, ownerId) {
  let mult = 1;
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.owner !== ownerId || c.zoneType === "hand" || c.zoneType === "stack") continue;
    if (/create[s]? .*tokens? under your control.*it creates twice that many/i.test(c.text || "")) mult *= 2;
  }
  return mult;
}
// Hardened Scales -- see addCountersToSelf's own comment for why this is a flat +1, not a doubling.
function bonusCountersFor(lobby, ownerId) {
  let bonus = 0;
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.owner !== ownerId || c.zoneType === "hand" || c.zoneType === "stack") continue;
    if (/\+1\/\+1 counters? would be put on a creature you control, that many plus one/i.test(c.text || "")) bonus += 1;
  }
  return bonus;
}
// Corpsejack Menace / Branching Evolution -- the real DOUBLING counterpart to Hardened Scales'
// additive +1 above ("twice that many...instead", not "that many plus one"). Applied AFTER the
// additive bonus in addCountersToSelf (a controller-chooses-order replacement-effect nuance this
// app doesn't model -- same "pick one consistent order" precedent as everywhere else two static
// replacement effects could theoretically stack in either direction).
function counterMultiplierFor(lobby, ownerId) {
  let mult = 1;
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.owner !== ownerId || c.zoneType === "hand" || c.zoneType === "stack") continue;
    if (/\+1\/\+1 counters? would be put on a creature you control, twice that many/i.test(c.text || "")) mult *= 2;
  }
  return mult;
}
function parseKeywordList(raw) {
  return raw.split(/,| and /i).map((s) => s.trim())
    .map((r) => KNOWN_KEYWORDS.find((k) => k.toLowerCase() === r.toLowerCase()))
    .filter(Boolean);
}
// Live-computed like attachedBonusFor -- scans every OTHER permanent the same controller controls
// (source can be a creature "lord", artifact, or enchantment; classifyType buckets all three under
// zoneType "artifact" except creatures, so this only excludes hand/stack, not by type) for an anthem
// on its own text. "Other" is enforced structurally by skipping card.id, not by parsing the word.
// Faeburrow Elder -- "This creature gets +1/+1 for each color among permanents you control." A
// live-computed count of DISTINCT colors (each permanent's own printed color, not color identity --
// most lands/artifacts are colorless unless color-indicated) across everything the owner controls.
function colorsAmongPermanentsFor(lobby, ownerId) {
  const colors = new Set();
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.owner !== ownerId || c.zoneType === "hand" || c.zoneType === "stack") continue;
    (c.colors || []).forEach((col) => colors.add(col));
  }
  return colors.size;
}
function staticBonusFor(lobby, card) {
  let powerBonus = 0, toughnessBonus = 0;
  if (card.zoneType !== "creature") return { powerBonus, toughnessBonus };
  // grantTemporaryPT's own grant, read here (rather than at every P/T call site) since this
  // function is already the shared "how much extra P/T does this card have" aggregator.
  if (card.temporaryPT) { powerBonus += card.temporaryPT.power || 0; toughnessBonus += card.temporaryPT.toughness || 0; }
  // Faeburrow Elder's own self-referential dynamic P/T -- checked against the card's OWN text, same
  // "self, not other creatures" shape as the includesSelf anthem branch below, just name-independent
  // (no per-card table entry) like every other generic text-scan mechanism in this file.
  if (/gets \+1\/\+1 for each color among permanents you control/i.test(card.text || "")) {
    const n = colorsAmongPermanentsFor(lobby, card.owner);
    powerBonus += n; toughnessBonus += n;
  }
  // Serra Ascendant -- the P/T half of the same "as long as you have N or more life" self-
  // referential conditional (see effectiveKeywords' own comment for the keyword half).
  const lifePTMatch = (card.text || "").match(/as long as you have (\d+) or more life, this creature gets \+(\d+)\/\+(\d+)/i);
  if (lifePTMatch) {
    const p = lobby.players[card.owner];
    if (p && p.life >= parseInt(lifePTMatch[1], 10)) {
      powerBonus += parseInt(lifePTMatch[2], 10) || 0;
      toughnessBonus += parseInt(lifePTMatch[3], 10) || 0;
    }
  }
  const cardColors = card.colors || [];
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.owner !== card.owner || c.zoneType === "hand" || c.zoneType === "stack") continue;
    // Sedge Sliver -- "All Sliver creatures have 'This creature gets +1/+1 as long as you control a
    // Swamp.'" A GRANTED self-referential conditional (unlike Serra Ascendant's own printed-on-
    // itself version above) -- inherently self-inclusive by its own "All Xs have" wording (no
    // "other" qualifier), so this runs unconditionally for every permanent `c` including `card`
    // itself, before the self/other anthem branching below even applies. "You control a [land
    // type]" always means the GRANTED creature's own controller, i.e. card.owner, same as any other
    // "you control" in a granted ability.
    const grantedPT = grantedConditionalLandPTFromText(c.text);
    if (grantedPT && (card.type || "").toLowerCase().includes(grantedPT.typeWord)) {
      const hasLand = Object.values(lobby.cards).some((x) => x.owner === card.owner && x.zoneType === "mana" && (x.type || "").toLowerCase().includes(grantedPT.landType));
      if (hasLand) { powerBonus += grantedPT.powerBonus; toughnessBonus += grantedPT.toughnessBonus; }
    }
    // "Other creatures..." is enforced structurally by skipping card.id -- but a self-inclusive
    // anthem (Rising of the Day's own "Legendary creatures you control get +1/+0", no "other")
    // needs its OWN text checked against itself too, so the id===card.id skip only applies to
    // clauses that aren't includesSelf. Previously this loop always skipped id===card.id
    // unconditionally, since no self-inclusive P/T clause existed yet to need the exception.
    if (id === card.id) {
      anthemEffectsFromText(c.text).forEach((eff) => {
        if (!eff.includesSelf) return;
        if (eff.typeFilter && !(card.type || "").toLowerCase().includes(eff.typeFilter)) return;
        powerBonus += eff.powerBonus;
        toughnessBonus += eff.toughnessBonus;
      });
      continue;
    }
    anthemEffectsFromText(c.text).forEach((eff) => {
      if (eff.colorFilter && !cardColors.includes(eff.colorFilter)) return;
      if (eff.typeFilter && !(card.type || "").toLowerCase().includes(eff.typeFilter)) return;
      powerBonus += eff.powerBonus;
      toughnessBonus += eff.toughnessBonus;
    });
    // Icon of Ancestry-style "Creatures you control of the chosen type get +X/+Y" -- a DYNAMIC
    // anthem keyed off a per-permanent chosen value (see chooseCreatureType/targetKind:"creatureType"),
    // not a literal color/type word in the text, so it needs its own check here rather than fitting
    // anthemEffectsFromText's plain-text pattern.
    if (c.chosenCreatureType) {
      const m = (c.text || "").match(/creatures you control of the chosen type get ([+-]\d+)\/([+-]\d+)/i);
      if (m && (card.type || "").toLowerCase().includes(c.chosenCreatureType.toLowerCase())) {
        powerBonus += parseInt(m[1], 10) || 0;
        toughnessBonus += parseInt(m[2], 10) || 0;
      }
    }
  }
  return { powerBonus, toughnessBonus };
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

// Every other user-supplied string in this file (chat text, names, deck/mat names, avatar/mat
// URLs) gets coerced to a string and length-capped before it's trusted -- these two were the only
// ones that weren't, despite feeding straight into shared, broadcast game state. Length isn't a
// security boundary by itself (the client escapes on render), but it matches this app's standing
// "never trust a client string past a sane size cap" rule and keeps one huge string from bloating
// every other connected player's state.
function sanitizeCardStr(s, max) {
  return (s == null ? "" : String(s)).slice(0, max);
}
// img specifically also gets a scheme allowlist -- every legitimate value here is either a Scryfall
// CDN URL or our own /uploads/ path, so requiring http(s):// or /uploads/ costs nothing real and
// means a client that skips escaping some render path (now or in the future) still can't turn this
// into a javascript:/data: URI.
function sanitizeImgUrl(s) {
  const v = sanitizeCardStr(s, 2000).trim();
  return /^(https?:\/\/|\/uploads\/)/i.test(v) ? v : "";
}

// Real Scryfall token art for the same 8 "common" tokens the client's Create Token quick-presets
// already cover (see TOKEN_PRESETS in index.html) -- 5 real printings each, so a token created with
// no Art URL gets genuine art instead of the client's generated gradient placeholder (which is now
// only a fallback for a token name that doesn't match any of these, e.g. a custom-named one).
// Picked once at creation time and baked onto the card, matching how a real physical token has one
// fixed printing for its whole life -- not re-rolled on every render. Keyed by the token's own name
// lowercased/trimmed (case-insensitive, exact match against the SIMPLE token name, e.g. "Soldier" --
// a custom type line like "Zombie Soldier" won't match either list on purpose, since that's not
// unambiguously one of these two).
const DEFAULT_TOKEN_ART = {
  "soldier": [
    "https://cards.scryfall.io/normal/front/5/e/5ef2f34e-0ff2-4157-9d4a-73ecf4cd449b.jpg",
    "https://cards.scryfall.io/normal/front/e/c/ecd686bf-d14b-491c-b0c5-88fc8f0472f9.jpg",
    "https://cards.scryfall.io/normal/front/c/4/c459f2ec-2aa3-44f6-999f-b1467dd4e27c.jpg",
    "https://cards.scryfall.io/normal/front/6/4/6455d903-6996-448f-9148-9068febecb00.jpg",
    "https://cards.scryfall.io/normal/front/a/f/af191656-5e62-440f-b63a-705cfed314e7.jpg"
  ],
  "zombie": [
    "https://cards.scryfall.io/normal/front/4/c/4cecd5c6-d6c8-4cd5-97a3-cddaf051af15.jpg",
    "https://cards.scryfall.io/normal/front/b/8/b82be730-c63b-4c2b-99f4-476befdb95cb.jpg",
    "https://cards.scryfall.io/normal/front/8/1/8150833a-9c83-4d00-ae2f-470088700fdb.jpg",
    "https://cards.scryfall.io/normal/front/c/d/cd499ed5-f600-4551-a713-ac6b6e894fec.jpg",
    "https://cards.scryfall.io/normal/front/e/b/eb7b2c61-b903-4669-b9a3-110418a35593.jpg"
  ],
  "spirit": [
    "https://cards.scryfall.io/normal/front/0/0/004f2ea4-0477-49b2-ad06-5aac7991103d.jpg",
    "https://cards.scryfall.io/normal/front/f/2/f22410b3-5c0b-4282-9b0b-5ba61229b6e7.jpg",
    "https://cards.scryfall.io/normal/front/a/0/a0aa2f5e-9809-4e97-b9b2-9c9a322a8e21.jpg",
    "https://cards.scryfall.io/normal/front/1/d/1d9b18e5-d842-4114-b395-ff5dd42c94d9.jpg",
    "https://cards.scryfall.io/normal/front/5/7/57b674ef-f541-4ee8-9727-1c5b3c0c8f4e.jpg"
  ],
  "goblin": [
    "https://cards.scryfall.io/normal/front/0/9/09faad62-42ff-4e37-b8a5-d8e8a0f6d096.jpg",
    "https://cards.scryfall.io/normal/front/e/2/e265ca24-96c0-4654-a8f3-bbffe288970a.jpg",
    "https://cards.scryfall.io/normal/front/7/0/7072dea6-0d99-47fa-a83d-c8607e6a4bbd.jpg",
    "https://cards.scryfall.io/normal/front/c/d/cd6cd0d3-7973-49e6-9c1c-6f516a5d5fe5.jpg",
    "https://cards.scryfall.io/normal/front/9/8/98ce0500-d9b4-4218-bcc6-dd6194068958.jpg"
  ],
  "elemental": [
    "https://cards.scryfall.io/normal/front/0/0/008695e6-6d6f-4c16-bf05-377e8cc5f5ff.jpg",
    "https://cards.scryfall.io/normal/front/7/7/7737cbbf-659e-4a8d-9918-50652d6c0863.jpg",
    "https://cards.scryfall.io/normal/front/c/5/c5ad13b4-bbf5-4c98-868f-4d105eaf8833.jpg",
    "https://cards.scryfall.io/normal/front/d/b/db67bc06-b6c9-49a0-beef-4d35842497cb.jpg",
    "https://cards.scryfall.io/normal/front/b/7/b7047838-ac9f-4ca1-9827-73d87098124f.jpg"
  ],
  "treasure": [
    "https://cards.scryfall.io/normal/front/d/1/d1892b78-7663-4cbd-a732-9a4b0b18d4c8.jpg",
    "https://cards.scryfall.io/normal/front/c/6/c6e096bb-ad9e-4a8b-8b42-26852fa32c1d.jpg",
    "https://cards.scryfall.io/normal/front/0/b/0bb11342-bc1d-4eea-b0b0-94799be2602a.jpg",
    "https://cards.scryfall.io/normal/front/f/9/f909bd95-58a1-4299-9570-87724145fc85.jpg",
    "https://cards.scryfall.io/normal/front/b/4/b4f61b5e-9c53-40b1-b93e-3ffa351ff052.jpg"
  ],
  "clue": [
    "https://cards.scryfall.io/normal/front/5/e/5e644586-888f-4e2e-8d66-8aa02bd79ec1.jpg",
    "https://cards.scryfall.io/normal/front/c/3/c321b9e4-ab7e-4e8a-988f-5463c776d685.jpg",
    "https://cards.scryfall.io/normal/front/8/d/8db9a248-d380-48e9-850c-38b2907332c1.jpg",
    "https://cards.scryfall.io/normal/front/9/8/98bdb578-e81e-40f9-9c06-b2867158baef.jpg",
    "https://cards.scryfall.io/normal/front/4/c/4c9669e6-e093-4f88-9699-a1a32793bfa9.jpg"
  ],
  "food": [
    "https://cards.scryfall.io/normal/front/2/7/276dedb8-3d41-499c-8804-bb1471fcb06f.jpg",
    "https://cards.scryfall.io/normal/front/1/7/174eb62b-b02a-4533-8822-eacc9dcc0a20.jpg",
    "https://cards.scryfall.io/normal/front/1/1/110f41a6-1ca5-463e-8a6d-fdf021842b43.jpg",
    "https://cards.scryfall.io/normal/front/d/6/d6fbb5c7-9cc4-4528-8fc5-ec7a9d19a92e.jpg",
    "https://cards.scryfall.io/normal/front/d/4/d4a47380-3e51-4c1d-9ffa-472d4f97d36b.jpg"
  ]
};
function pickDefaultTokenArt(name) {
  const options = DEFAULT_TOKEN_ART[(name || "").trim().toLowerCase()];
  return options ? options[Math.floor(Math.random() * options.length)] : "";
}

// A crop/zoom transform for a custom image (pile art, board mat) -- scale is a zoom multiplier on
// top of a cover-fit baseline, x/y are the object-position percentages used to pan within it.
function sanitizeImgFit({ scale, x, y } = {}) {
  const clamp = (n, lo, hi, dflt) => { n = Number(n); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
  return { scale: clamp(scale, 1, 3, 1), x: clamp(x, 0, 100, 50), y: clamp(y, 0, 100, 50) };
}

// A handful of places turn a free-text, client-supplied string directly into an object key on a
// plain JS object (usernames on `users`, deck/mat names on `decks[username]`/`mats[username]`).
// "__proto__" as a key doesn't add an own property -- it reassigns that object's prototype, and
// "constructor"/"prototype" can shadow things real code relies on. None of this reaches the
// globally-shared Object.prototype here (every one of these is a single-level key on an object
// that's never itself reachable as `X.__proto__`), so it can't cross-contaminate other accounts --
// but it's cheap to reject outright rather than rely on that containment, particularly since the
// username case currently only fails by accident (the pre-existing "already taken" check happens to
// read as truthy for these names) rather than by a real, obvious guard.
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Shape used for cards resting in library/graveyard/exile/commander-zone —
// same attribute set as the archive, minus battlefield-only state (tapped, counters, etc).
function toEntry(c) {
  return {
    // Preserved so a graveyard/exile/library entry can be addressed as a real target (Reya
    // Dawnbringer, Necromancy, Whip of Erebos's reanimation ability) -- previously omitted since
    // nothing needed to target a card once it left the battlefield; every target-choice kind that
    // touches a zone list now relies on this being stable and unique (it's the same id the card
    // had while on the battlefield, never reused).
    id: c.id,
    name: sanitizeCardStr(c.name, 200), img: sanitizeImgUrl(c.img), type: sanitizeCardStr(c.type || "", 100), manaCost: sanitizeCardStr(c.manaCost || "", 50),
    cmc: c.cmc || 0, colors: c.colors || [], colorIdentity: c.colorIdentity || [],
    power: c.power, toughness: c.toughness, loyalty: c.loyalty,
    text: sanitizeCardStr(c.text || "", 3000), keywords: c.keywords || [], producedMana: c.producedMana || null,
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

function maskCard(card, viewerId, lobby) {
  if (card.faceDown && card.owner !== viewerId) {
    return {
      id: card.id, tapped: card.tapped, faceDown: true, zoneType: card.zoneType, owner: card.owner, ownerColor: card.ownerColor,
      name: null, img: null, type: null, manaCost: null, power: null, toughness: null, counters: 0, isCommander: card.isCommander,
      cmc: null, colors: null, colorIdentity: null, loyalty: null, text: null, keywords: null, producedMana: null
    };
  }
  // Same "live-computed, only shown when a real option exists" precedent as activatedAbilities
  // below, just for a HAND card's alternative-cost casting instead of a battlefield permanent's
  // activated ability -- see castWithAltCost. Cycling is checked alongside it (a card could in
  // principle have both, though none in this app's automation does yet) -- see the cycleCard handler.
  if (card.zoneType === "hand" && card.owner === viewerId) {
    const extra = {};
    const alt = getAltCost(card.name);
    if (alt) extra.altCastOption = { label: alt.label };
    const cyc = cyclingCostFromText(card.text);
    if (cyc) extra.cycleOption = { label: `Cycling ${cyc.cost}` };
    if (Object.keys(extra).length) return { ...card, ...extra };
  }
  // Live-computed, never stored on the card itself -- lets the client show a real, correctly-labeled
  // "Activate: ..." context-menu entry only when one actually exists. Safe to send: nothing secret,
  // and only attached once a name is actually visible to this viewer (the face-down branch above
  // never reaches here) and the card is somewhere an ability could be activated from.
  if (card.zoneType === "hand" || card.zoneType === "stack") return card;
  const abilities = getActivatedAbilities(card, lobby);
  if (!abilities.length) return card;
  // `index` has to stay the RAW index into the unfiltered array -- activateAbility looks the chosen
  // ability back up by that same index, so a filtered-out entry must not shift the numbering of the
  // ones still visible.
  const visible = abilities
    .map((a, index) => ({ a, index }))
    .filter(({ a }) => !a.condition || a.condition(card, lobby));
  if (!visible.length) return card;
  // manaAbility passed through so the client can offer double-click (the same gesture that already
  // taps a land/dork for its free mana) as a shortcut for a card whose ENTIRE activated-ability list
  // is just one mana ability (Sol Ring, signets, Temple of the False God) -- these are deliberately
  // excluded from the free single-tap-for-mana shortcut (see the tap handler's own comment), so
  // double-click previously did nothing at all for them, which reads exactly like "doesn't add mana".
  // hasX -- Kessig Wolf Run/Mirror Entity-style X-cost activated abilities need the client to
  // prompt for a value BEFORE emitting activateAbility, the same way it already does for casting an
  // X-cost SPELL (costHasX/requestPlayCard) -- computed from the ability's own real cost.mana text
  // rather than parsing it again client-side.
  return { ...card, activatedAbilities: visible.map(({ a, index }) => ({ index, label: a.label, manaAbility: !!a.manaAbility, hasX: !!(a.cost && typeof a.cost.mana === "string" && /\{x\}/i.test(a.cost.mana)) })) };
}

function broadcastCard(lobby, card) {
  for (const sid of lobbySocketIds(lobby)) {
    const sock = io.sockets.sockets.get(sid);
    if (sock) sock.emit("cardUpdate", maskCard(card, sid, lobby));
  }
}

function broadcastTargets(lobby) { io.to(lobby.id).emit("targets", lobby.targets); }
function broadcastTurn(lobby) { io.to(lobby.id).emit("turnState", lobby.turn); }
function broadcastCombat(lobby) { io.to(lobby.id).emit("combatState", lobby.combat); }
function broadcastVoiceRoster(lobby) { io.to(lobby.id).emit("voiceRoster", Array.from(lobby.voiceParticipants)); }

function playersView(lobby, viewerId) {
  const out = {};
  const started = lobby.turn.started;
  for (const id in lobby.players) {
    const p = lobby.players[id];
    // Before the game actually starts, another player's loaded deck (their commander(s), and how
    // many cards they've got) is hidden from everyone but themselves -- matches real-table etiquette
    // of not browsing someone's decklist before the game begins. Once turn.started flips true this
    // opens back up for everyone (a player's own view of THEIR OWN data is never masked either way).
    const revealDeck = started || id === viewerId;
    out[id] = {
      name: p.name,
      color: p.color,
      avatar: (users[p.username] && users[p.username].avatar) || null,
      life: p.life,
      cmdr: revealDeck ? p.cmdr : null,
      cmdrDamage: p.cmdrDamage || {},
      eliminated: !!p.eliminated,
      poison: p.poison,
      protectionFromCardType: p.protectionFromCardType || null,
      cantCastSpells: !!p.cantCastSpells,
      lifeLocked: !!p.lifeLocked,
      protectionFromEverything: !!p.protectionFromEverything,
      phasedOutCount: (p.phasedOut || []).length,
      boardMat: p.boardMat || null,
      boardMatFit: p.boardMatFit || null,
      pileArt: p.pileArt || { library: null, graveyard: null, exile: null },
      cursorColor: p.cursorColor || null,
      cursorIcon: p.cursorIcon || null,
      cursorIconFit: p.cursorIconFit || null,
      mulligans: p.mulligans,
      handKept: p.handKept,
      openingHandDrawn: !!p.openingHandDrawn,
      mana: p.mana,
      landsPlayedThisTurn: p.landsPlayedThisTurn,
      landDropBonus: p.landDropBonus,
      commanders: revealDeck ? p.commanders : (p.commanders || []).map(() => null),
      graveyard: p.graveyard,
      exile: p.exile,
      // Still lets the pre-game "NO DECK" ready-check badge work (real table etiquette: you CAN see
      // someone hasn't sleeved up yet) without revealing the real deck SIZE -- collapses any nonzero
      // count down to a sentinel 1 instead of sending the exact number.
      libraryCount: revealDeck ? p.library.length : (p.library.length > 0 ? 1 : 0),
      library: id === viewerId ? p.library : undefined,
      disconnected: !!p.disconnectedAt,
      disconnectedAt: p.disconnectedAt || null,
      graceMs: p.disconnectedAt ? (p.graceMs || RECONNECT_GRACE_MS) : null
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

// ---------------- single-slot per-player "undo my last action" ----------------
// Deliberately narrow: this is NOT a generic state-snapshot/replay system (which would need to
// reason correctly about every possible downstream trigger cascade -- a much bigger and riskier
// build). Instead, each undoable action captures its own hand-written revert closure at the exact
// moment it happens, covering only the small set of actions that are 100% safe to cleanly reverse
// with no side effects left dangling: tapping (see the `tap`/`resolveManaChoice` handlers, which
// only ever add mana as a side effect -- reverted exactly), a manual counter nudge, and a manual
// life/cmdr/poison nudge (only offered when nothing ELSE happened as a result -- see statChange's
// own stack-length/elimination check). Land drops, zone moves, and casting anything are NOT
// undoable here on purpose: any of those can cascade into ETB/death triggers, optional payments,
// or other players' reactions that a bare "put the card back" can't cleanly unwind.
// Single slot per player (a new undoable action simply replaces whatever was pending before -- you
// can only ever undo the MOST RECENT thing, not reach back further), and it expires both on a
// short TTL (checked at undo time, see the `undo` handler) and unconditionally the moment the
// phase changes (advanceOnePhase calls clearAllUndo) -- once anyone has had a chance to react to
// new game state, undoing something from before that point would be a retroactive surprise, not a
// misclick fix.
const UNDO_TTL_MS = 30000;
function setUndo(lobby, playerId, label, revert) {
  if (!lobby.lastAction) lobby.lastAction = {};
  lobby.lastAction[playerId] = { label, revert, ts: Date.now(), turnNumber: lobby.turn.turnNumber, phase: lobby.turn.phase };
  const sock = io.sockets.sockets.get(playerId);
  if (sock) sock.emit("undoAvailable", { label });
}
function clearUndo(lobby, playerId) {
  if (lobby.lastAction) delete lobby.lastAction[playerId];
  const sock = io.sockets.sockets.get(playerId);
  if (sock) sock.emit("undoAvailable", null);
}
function clearAllUndo(lobby) {
  if (!lobby.lastAction) return;
  for (const playerId in lobby.lastAction) clearUndo(lobby, playerId);
}

// Every legitimate way cards enter a lobby other than spawnCard/copyCard is naturally bounded (a
// deck is capped at 99 library entries, an opening hand is 7, commanders are at most 2) -- those
// two are the only genuinely unbounded paths, since either can be called in a tight client-side
// loop to manufacture cards from nothing. Gated at the call sites below, not in here, so this stays
// the one shared choke point every OTHER (already-bounded) caller keeps using without a check.
const MAX_CARDS_PER_LOBBY = 600;

function spawnBattlefieldCard(lobby, data) {
  const { owner, faceDown, zoneType, isCommander } = data;
  const p = lobby.players[owner];
  const id = newId();
  const resolvedZoneType = zoneType || classifyType(data.type);
  const sanitizedImg = sanitizeImgUrl(data.img);
  const card = {
    id, name: sanitizeCardStr(data.name, 200), img: sanitizedImg || pickDefaultTokenArt(data.name), type: sanitizeCardStr(data.type || "", 100), manaCost: sanitizeCardStr(data.manaCost || "", 50),
    cmc: data.cmc || 0, colors: data.colors || [], colorIdentity: data.colorIdentity || [],
    power: data.power, toughness: data.toughness, loyalty: data.loyalty,
    text: sanitizeCardStr(data.text || "", 3000), keywords: data.keywords || [], producedMana: data.producedMana || null,
    zoneType: resolvedZoneType,
    // Only applies when actually entering the battlefield — drawing into hand (zoneType "hand")
    // goes through this same function but obviously shouldn't come in "tapped".
    tapped: resolvedZoneType !== "hand" && entersTapped(data, lobby),
    faceDown: !!faceDown, counters: 0,
    owner, ownerColor: p ? p.color : "#999",
    isCommander: !!isCommander,
    attachedTo: null, // equipment/aura attachment link, set only via the attachCard handler
    originalOwner: null, // set only via takeControl -- who to give it back to via returnControl
    // Summoning sickness: stamped with the turn number it entered the battlefield. A creature is
    // sick (can't attack, can still block) if this still matches the CURRENT turn number when its
    // controller tries to attack with it — irrelevant for non-creatures, but harmless to set.
    controllerSince: lobby.turn.started ? lobby.turn.turnNumber : 0
  };
  lobby.cards[id] = card;
  broadcastCard(lobby, card);
  return card;
}

// Laboratory Maniac / Jace, Wielder of Mysteries -- "If you would draw a card while your library
// has no cards in it, you win the game instead." No base "lose by decking out" mechanic exists
// anywhere in this engine at all (a real, separate gap) -- but this replacement effect is fully
// self-contained regardless, so it doesn't need one to exist first to be meaningful.
function hasWinOnEmptyDraw(lobby, ownerId) {
  return Object.values(lobby.cards).some((c) => c.owner === ownerId && c.zoneType !== "hand" && c.zoneType !== "stack" && /if you would draw a card while your library has no cards in it, you win the game instead/i.test(c.text || ""));
}
function drawN(lobby, ownerId, n) {
  const p = lobby.players[ownerId];
  if (!p) return 0;
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    if (p.library.length === 0) {
      if (hasWinOnEmptyDraw(lobby, ownerId)) {
        pushLog(lobby, `${p.name} would draw from an empty library -- wins the game instead!`);
        io.to(lobby.id).emit("gameOver", { winnerId: ownerId, winnerName: p.name });
      }
      break;
    }
    const entry = p.library.shift();
    spawnBattlefieldCard(lobby, { ...entry, owner: ownerId, faceDown: true, zoneType: "hand" });
    drawn++;
  }
  fireGlobalOpponentDrawTriggers(lobby, ownerId, drawn);
  return drawn;
}
// Smothering Tithe: "Whenever an OPPONENT draws a card, that player may pay {2}. If they don't,
// you create a Treasure." Fires once per card actually drawn (a "draw 2" effect offers the payment
// twice, independently) -- gated on lobby.turn.started, same "pregame stays trigger-free"
// convention as every other trigger, so this correctly stays silent during the opening 7-card deal.
function fireGlobalOpponentDrawTriggers(lobby, drawingPlayerId, count) {
  if (!lobby.turn.started || count <= 0) return;
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.owner === drawingPlayerId || c.zoneType === "hand" || c.zoneType === "stack") continue;
    getAutomatedAbilities(c.name, "opponentDraws").forEach((ability) => {
      for (let i = 0; i < count; i++) {
        queueOptionalPayment(lobby, {
          playerId: drawingPlayerId, controllerId: c.owner, sourceCard: c,
          label: ability.label, costLabel: ability.costLabel, cost: ability.cost, declinedEffects: ability.declinedEffects
        });
      }
    });
  }
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

function attemptPlay(lobby, p, card, targetZoneType, xValue) {
  if (targetZoneType === "mana") {
    const allowed = 1 + (p.landDropBonus || 0);
    if ((p.landsPlayedThisTurn || 0) >= allowed) {
      return { ok: false, error: `You've already played your land${allowed > 1 ? "s" : ""} this turn (${allowed} allowed).` };
    }
    p.landsPlayedThisTurn = (p.landsPlayedThisTurn || 0) + 1;
    return { ok: true };
  }
  const cost = parseManaCost(card.manaCost);
  // Goblin Warchief and its functional cousins -- see spellCostReductionFor's own comment.
  const reduction = spellCostReductionFor(lobby, card.owner, card);
  if (reduction > 0) cost.generic = Math.max(0, cost.generic - reduction);
  // Crop Rotation / Diabolic Intent -- "as an additional cost to cast this spell, sacrifice a
  // [land/creature]." A real additional cost (paid alongside mana, not a triggered effect after the
  // fact), so it's checked and paid here in attemptPlay -- the single choke point both playCard and
  // changeZone's hand-casting branch already funnel through -- rather than as an EFFECTS step, which
  // would let the spell resolve even when nothing was ever actually paid. Auto-picks a qualifying
  // permanent (no target-choice-shaped cost exists in this engine, same disclosed simplification as
  // autoSacrificeFilter for activated abilities) and rejects BEFORE paying any mana if nothing
  // qualifies, matching real Magic (an unpayable additional cost means the spell can't be cast).
  const spellAbility = getSpellAbility(card.name);
  const addlCost = spellAbility && spellAbility.additionalCost;
  let sacrificeForCost = null;
  if (addlCost && addlCost.sacrificeType) {
    const zoneForFilter = addlCost.sacrificeType === "land" ? "mana" : "creature";
    sacrificeForCost = Object.values(lobby.cards).find((c) => c.owner === card.owner && c.zoneType === zoneForFilter && c.id !== card.id) || null;
    if (!sacrificeForCost) {
      return { ok: false, error: `You have no ${addlCost.sacrificeType} to sacrifice as an additional cost.` };
    }
  }
  const remaining = canAffordAndPay(p.mana, cost, xValue);
  if (!remaining) {
    return { ok: false, error: `Not enough mana to cast ${card.name || "this card"}.` };
  }
  p.mana = remaining;
  if (sacrificeForCost) {
    fireDeathTriggers(lobby, sacrificeForCost);
    sendToGraveyardInternal(lobby, sacrificeForCost);
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} sacrificed ${sacrificeForCost.name || "a permanent"} to cast ${card.name || "a spell"}`);
  }
  return { ok: true };
}

// Instants (and anything with Flash) can be played anytime; everything else is sorcery-speed —
// only on your own turn, during a main phase, with the stack empty. Before the game is actually
// started there's no turn structure yet, so pregame setup stays unrestricted.
// Quick Sliver -- "Any player may cast Sliver spells as though they had flash." A table-wide,
// ALL-players grant (unlike Emergence Zone's own hasFlashUntilEndOfTurn, which is per-player and
// temporary) -- scanning the whole battlefield for this exact template, same name-independent
// text-scan precedent as everywhere else in this file. Scoped to whatever type word the card names
// (e.g. "Sliver"), matched against the CAST card's own type line.
function anyPlayerFlashGrantAppliesTo(lobby, card) {
  const cardType = (card.type || "").toLowerCase();
  return Object.values(lobby.cards).some((c) => {
    if (c.zoneType === "hand" || c.zoneType === "stack") return false;
    const m = (c.text || "").match(/any player may cast (\w+) spells as though they had flash/i);
    return m && cardType.includes(m[1].toLowerCase());
  });
}
function checkTiming(lobby, socketId, card) {
  const text = (card.type || "").toLowerCase();
  // Emergence Zone -- "you may cast SPELLS this turn as though they had flash" never applies to a
  // land drop (playing a land is never "casting a spell" in real Magic), same exemption
  // canCastSpells's own cantCastSpells check already makes below.
  const isInstantSpeed = text.includes("instant") || (Array.isArray(card.keywords) && card.keywords.some((k) => (k || "").toLowerCase() === "flash"))
    || (!text.includes("land") && lobby.players[socketId] && lobby.players[socketId].hasFlashUntilEndOfTurn)
    || anyPlayerFlashGrantAppliesTo(lobby, card);
  if (lobby.stack.length > 0) {
    // A priority round is active: only the current holder may act, and only with an
    // instant-speed spell (which includes land drops? no -- lands are never instant-speed, so
    // this correctly blocks them too) -- sorcery-speed casting is never legal with something
    // already pending, same as real Magic.
    if (!isInstantSpeed) return { ok: false, error: `You can't play ${card.name || "that"} while something is on the stack.` };
    if (lobby.priority.holderId !== socketId) return { ok: false, error: "You don't have priority right now." };
    return { ok: true };
  }
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

// Orim's Chant's "can't cast spells this turn" -- checked at the same call sites as checkTiming
// (playCard, freeCastCard), but only for actual SPELLS: playing a LAND is never "casting a spell"
// in real Magic, so a land classification is exempt.
function canCastSpells(lobby, socketId, card) {
  if (classifyType(card.type) === "mana") return { ok: true };
  if (lobby.players[socketId] && lobby.players[socketId].cantCastSpells) {
    return { ok: false, error: `You can't cast spells this turn.` };
  }
  return { ok: true };
}

// ---------------- stack / priority ----------------

function nextInOrder(order, id) {
  const idx = order.indexOf(id);
  if (idx === -1 || order.length === 0) return null;
  return order[(idx + 1) % order.length];
}

function broadcastStack(lobby) { io.to(lobby.id).emit("stackState", { stack: lobby.stack, priority: lobby.priority }); }

// Pushes a cast spell onto the stack and (re)starts a priority round from the next player after
// the caster -- only the caster passing priority all the way back around, with nobody else
// adding anything new, closes the round and resolves it. Lands never call this; they're not
// spells and resolve immediately in the caller, same as today.
function pushToStack(lobby, card, casterId) {
  card.zoneType = "stack";
  card.faceDown = false; // casting is public information
  lobby.stack.push(card);
  lobby.priority.lastActorId = casterId;
  lobby.priority.holderId = nextInOrder(lobby.turn.order, casterId);
  broadcastCard(lobby, card);
  broadcastStack(lobby);
  // Fires after the spell is already on the stack, so a triggered youCastSpell ability lands on
  // TOP of it (LIFO) and resolves first -- matches real Magic's "cast trigger resolves before the
  // spell it triggered off of" ordering. Lands never reach this function (see the doc comment
  // above), so this can't misfire for a land drop.
  fireGlobalTrigger(lobby, "youCastSpell", casterId, card);
  fireGlobalOpponentFirstNoncreatureSpellTriggers(lobby, casterId, card);
  fireGlobalOpponentCastsSpellTriggers(lobby, casterId);
  fireGlobalOpponentCastsMatchingGraveyardCardTrigger(lobby, casterId, card);
  // Ledger Shredder -- "whenever A PLAYER casts their second spell each turn" watches every
  // player's cast count, not just the caster's own permanents (unlike every other fireGlobalTrigger
  // event, which only ever scans the acting player's own battlefield) -- see
  // fireGlobalTriggerAllPlayers' own comment for why this needed a separate function.
  const casterP = lobby.players[casterId];
  if (casterP) {
    casterP.spellsCastThisTurn = (casterP.spellsCastThisTurn || 0) + 1;
    if (casterP.spellsCastThisTurn === 2) fireGlobalTriggerAllPlayers(lobby, "secondSpellCastByAPlayer", card);
  }
}
// Esper Sentinel: "Whenever an opponent casts their FIRST noncreature spell each turn, draw a card
// unless that player pays {X}." Once-per-opponent-per-turn, tracked on the CASTING player (not the
// source card) since it's about their own cast history, not the source's -- p._firstNoncreatureSpellTurn
// stores the turn number it last fired, compared fresh each call (no separate reset needed, a new
// turn number just naturally stops matching). X is dynamic (the source's own power, incl. any
// equipment/anthem bonus), baked into the mana cost string at fire time.
function fireGlobalOpponentFirstNoncreatureSpellTriggers(lobby, casterId, spellCard) {
  if (!lobby.turn.started || (spellCard.type || "").toLowerCase().includes("creature")) return;
  const casterPlayer = lobby.players[casterId];
  if (!casterPlayer || casterPlayer._firstNoncreatureSpellTurn === lobby.turn.turnNumber) return;
  casterPlayer._firstNoncreatureSpellTurn = lobby.turn.turnNumber;
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.owner === casterId || c.zoneType === "hand" || c.zoneType === "stack") continue;
    getAutomatedAbilities(c.name, "opponentFirstNoncreatureSpell").forEach((ability) => {
      let xAmount = (ability.cost && ability.cost.manaAmount) || 0;
      if (ability.xFromPower) {
        const bonus = attachedBonusFor(lobby, c), stat = staticBonusFor(lobby, c);
        xAmount = Math.max(0, parsePT(c.power) + bonus.powerBonus + stat.powerBonus);
      }
      queueOptionalPayment(lobby, {
        playerId: casterId, controllerId: c.owner, sourceCard: c, label: ability.label,
        costLabel: `{${xAmount}}`, cost: { mana: `{${xAmount}}` }, declinedEffects: ability.declinedEffects
      });
    });
  }
}

// Rhystic Study and its functional cousins -- "Whenever an opponent casts a spell, you may draw a
// card unless that player pays {1}." Same optional-payment engine as
// fireGlobalOpponentFirstNoncreatureSpellTriggers just above (see Esper Sentinel's own entry for
// the identical shape), minus BOTH of that one's restrictions: no "noncreature only" filter, and no
// "just their first spell each turn" limit -- this taxes every single opponent spell cast.
function fireGlobalOpponentCastsSpellTriggers(lobby, casterId) {
  if (!lobby.turn.started) return;
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.owner === casterId || c.zoneType === "hand" || c.zoneType === "stack") continue;
    getAutomatedAbilities(c.name, "opponentCastsSpell").forEach((ability) => {
      queueOptionalPayment(lobby, {
        playerId: casterId, controllerId: c.owner, sourceCard: c, label: ability.label,
        costLabel: ability.costLabel || "{1}", cost: ability.cost || { mana: "{1}" }, declinedEffects: ability.declinedEffects
      });
    });
  }
}
// Dragonlord Kolaghan -- "Whenever an opponent casts a creature or planeswalker spell with the
// same name as a card in THEIR OWN graveyard, that player loses 10 life." Checked against the
// CASTER's own graveyard (not the ability's controller's), and the effect targets the CASTER too
// (loseLife already supports an explicit chosenTargetId override for exactly this "not the
// controller" shape) -- a real, different relationship from every other opponentCastsX dispatcher
// above, which all act on/for the ability's own controller.
function fireGlobalOpponentCastsMatchingGraveyardCardTrigger(lobby, casterId, card) {
  if (!lobby.turn.started) return;
  const t = (card.type || "").toLowerCase();
  if (!t.includes("creature") && !t.includes("planeswalker")) return;
  const casterP = lobby.players[casterId];
  if (!casterP || !(casterP.graveyard || []).some((e) => archiveKey(e.name) === archiveKey(card.name))) return;
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.owner === casterId || c.zoneType === "hand" || c.zoneType === "stack") continue;
    getAutomatedAbilities(c.name, "opponentCastsMatchingGraveyardCard").forEach((ability) => {
      const effects = (ability.effects || []).map((e) => ({ ...e, chosenTargetId: casterId }));
      pushAbilityToStack(lobby, { sourceCard: c, controllerId: c.owner, label: ability.label, effects });
    });
  }
}

// The single choke point for "a card in hand is being cast." A target-requiring instant/sorcery
// (SPELL_ABILITIES with requiresTarget) gets its target locked in as PART OF casting -- matching
// real Magic rules, and this file's existing pattern for triggered abilities (see fireTrigger just
// below) -- rather than being pushed to the stack and only prompted for a target once it resolves,
// which would leave a spell sitting on the stack with no visible sign it needs a target. The card
// stays in hand until a target is chosen; only then does it go on the stack, target already
// resolved. Untargeted spells, permanents, and lands never reach this at all.
function castSpell(lobby, card, casterId, logSuffix) {
  if (isInstantOrSorcery(card.type)) {
    const spellAbility = getSpellAbility(card.name);
    // Modal spell ("Choose one —") -- mode is picked BEFORE any target, since which target kind
    // even applies depends on which mode got picked. Reuses the exact same pendingTargetChoices
    // queue as a real target choice (kind: "chooseMode", targetKind: "mode") rather than a
    // parallel mechanism, so the Cancel escape hatch and reconnect-resume behavior both come for
    // free; chooseTargetFor's "chooseMode" branch (see its own comment) is what actually turns the
    // picked mode into either a real target choice or a straight-to-stack cast.
    if (spellAbility && spellAbility.modes) {
      queueTargetChoice(lobby, {
        kind: "chooseMode", controllerId: casterId, spellCard: card, sourceCard: card,
        label: spellAbility.label, modes: spellAbility.modes, targetKind: "mode",
        logSuffix: logSuffix || ""
      });
      return;
    }
    if (spellAbility && spellAbility.requiresTarget) {
      queueTargetChoice(lobby, {
        kind: "castSpell", controllerId: casterId, spellCard: card, sourceCard: card,
        label: spellAbility.label, effects: spellAbility.effects, targetKind: spellAbility.targetKind,
        minCmc: spellAbility.minCmc || null, typeFilter: spellAbility.typeFilter || null, logSuffix: logSuffix || ""
      });
      return;
    }
  }
  pushToStack(lobby, card, casterId);
  const p = lobby.players[casterId];
  if (p) pushLog(lobby, `${p.name} cast ${card.name || "a spell"}${logSuffix || ""}`);
}

// Pushes a triggered ability onto the stack -- deliberately NOT added to lobby.cards, since it
// isn't a real card (no broadcastCard/cardRemove bookkeeping needed). Shaped to satisfy the
// client's existing stack-item template (img/name/owner) with zero new client fields required.
// Opens a priority round the same way pushToStack does.
function pushAbilityToStack(lobby, { sourceCard, controllerId, label, effects }) {
  const item = {
    id: newAbilityId(), kind: "ability", name: label || `${sourceCard.name} trigger`,
    img: sourceCard.img, owner: controllerId, sourceId: sourceCard.id, sourceName: sourceCard.name, effects
  };
  lobby.stack.push(item);
  lobby.priority.lastActorId = controllerId;
  lobby.priority.holderId = nextInOrder(lobby.turn.order, controllerId);
  broadcastStack(lobby);
  return item;
}

// Queues a real "at the beginning of the next end step" (or any other named phase) one-shot
// trigger -- see the matching check in advanceOnePhase for where it actually fires. sourceCard is
// whatever object should be credited as the source in the stack UI; for effects that need to act
// on a SPECIFIC card (Whip of Erebos exiling the exact creature it just reanimated), bake that
// card's id into `effects` at queue time, the same "capture the dynamic bit now" pattern used
// throughout this engine (fireCombatDamageToPlayerTriggers, etc.) rather than re-resolving it later.
function queueDelayedTrigger(lobby, { firesAtPhase, controllerId, sourceCard, label, effects }) {
  if (!lobby.delayedTriggers) lobby.delayedTriggers = [];
  lobby.delayedTriggers.push({ firesAtPhase, controllerId, sourceCard, label, effects });
}

// "That player may pay X; if they don't, Y happens" (Smothering Tithe, Esper Sentinel, Rakdos,
// Patron of Chaos) -- a real Magic pattern distinct from pendingTargetChoices in one key way: the
// OPPONENT decides, not the ability's controller, and declining has its own real consequence
// rather than the ability just fizzling for lack of a target. Several of these can be pending for
// DIFFERENT players at once (each addressed to whoever the event happened to), so unlike the
// single-slot pendingTargetChoices queue, only the front entry FOR THAT SPECIFIC PLAYER is
// actively prompted -- other players' own pending payments are unaffected.
function queueOptionalPayment(lobby, choice) {
  const entry = { id: newAbilityId(), ...choice };
  lobby.pendingOptionalPayments.push(entry);
  if (lobby.pendingOptionalPayments.filter((e) => e.playerId === entry.playerId).length === 1) promptOptionalPayment(lobby, entry);
  return entry;
}
function promptOptionalPayment(lobby, entry) {
  const sock = io.sockets.sockets.get(entry.playerId);
  if (sock) sock.emit("optionalPayment", { id: entry.id, label: entry.label, costLabel: entry.costLabel });
}
function promptNextOptionalPayment(lobby, playerId) {
  const next = lobby.pendingOptionalPayments.find((e) => e.playerId === playerId);
  if (next) promptOptionalPayment(lobby, next);
}

// A target-requiring ability queues here instead of reaching the stack -- gating the PUSH, not
// resolution, is the whole reason resolveStackTop/passPriority need zero knowledge of targeting:
// by the time anything ever lands in lobby.stack, it's already fully resolvable, exactly like
// every other item there. Real Magic locks a target in at cast/trigger time too (not resolution),
// so this isn't just the path of least resistance. Only the front entry is actively prompted to
// its controller; a second target-requiring trigger firing before the first is resolved just
// waits in line.
function queueTargetChoice(lobby, choice) {
  const entry = { id: newAbilityId(), ...choice };
  lobby.pendingTargetChoices.push(entry);
  if (lobby.pendingTargetChoices.length === 1) promptTargetChoice(lobby, entry);
  return entry;
}
function promptTargetChoice(lobby, entry) {
  const sock = io.sockets.sockets.get(entry.controllerId);
  // targetKind tells the client WHICH clickable things (battlefield cards vs. stack items vs.
  // players) are actually legal here, so its banner/highlighting can match what resolveChosenTarget
  // will actually accept instead of always saying "click a battlefield card" regardless of the real
  // target kind -- previously a "target a spell"/"target a player" choice still showed that same
  // battlefield-only instruction and lit up every card as clickable, so a player naturally clicking
  // what they were told to click got a confusing rejection with no way to tell what went wrong.
  const targetKind = entry.targetKind || entry.targetZoneType || "creature";
  const src = entry.spellCard || entry.sourceCard;
  if (sock) sock.emit("chooseTarget", { id: entry.id, label: entry.label, sourceImg: entry.sourceCard.img, sourceColors: (src && src.colors) || [], sourceType: (src && src.type) || "", sourceCardId: entry.sourceCard && entry.sourceCard.id, targetKind, minCmc: entry.minCmc || null, handTypeFilter: entry.handTypeFilter || null, typeFilter: entry.typeFilter || null, modes: entry.modes ? entry.modes.map((m) => m.label) : null, commanderChoices: entry.commanderChoices || null });
}
// Discards any pending target choices belonging to a departing controller (a real disconnect/leave
// or an elimination) -- otherwise the table would be stuck forever waiting on a target that will
// never come. Mana/effects already spent stay spent, matching this app's existing no-undo
// precedent elsewhere. If discarding changes who's at the front of the queue, prompt them.
function discardPendingTargetChoices(lobby, socketId) {
  const before = lobby.pendingTargetChoices.length;
  lobby.pendingTargetChoices = lobby.pendingTargetChoices.filter((c) => c.controllerId !== socketId);
  if (lobby.pendingTargetChoices.length !== before && lobby.pendingTargetChoices.length > 0) {
    promptTargetChoice(lobby, lobby.pendingTargetChoices[0]);
  }
  // Same cleanup for optional payments addressed TO the departing player -- otherwise the table
  // waits forever on a decision that will never come. Payments addressed to OTHER players but
  // controlled by the departing one are left alone (the "if not" default still makes sense even if
  // the ability's controller has left).
  lobby.pendingOptionalPayments = lobby.pendingOptionalPayments.filter((e) => e.playerId !== socketId);
}
// Validates + resolves whatever the player clicked against what a pending choice actually wants.
// targetKind defaults to the pre-existing "creature" (zoneType-matching) behavior for full backward
// compatibility with every CARD_ABILITIES entry authored before spell targeting existed -- only
// SPELL_ABILITIES entries ever set targetKind to "player"/"any"/"spell". Returns { ok, error } or
// { ok: true }; doesn't mutate anything, just answers "is this a legal choice."
function resolveChosenTarget(lobby, entry, targetId) {
  const targetKind = entry.targetKind || entry.targetZoneType || "creature";
  if (targetKind === "player") {
    if (!lobby.players[targetId]) return { ok: false, error: "Choose a player." };
    if (cardTypeProtectionBlocks(lobby, targetId, entry.spellCard || entry.sourceCard)) return { ok: false, error: "That player has protection from this." };
    return { ok: true };
  }
  // Forbidden Orchard-style "target OPPONENT" -- same as "player" but the controller themselves is
  // never a legal choice, unlike plain "player" (Desolate Lighthouse-style self-discard, say).
  if (targetKind === "opponent") {
    if (!lobby.players[targetId]) return { ok: false, error: "Choose a player." };
    if (targetId === entry.controllerId) return { ok: false, error: "Choose an opponent." };
    if (cardTypeProtectionBlocks(lobby, targetId, entry.spellCard || entry.sourceCard)) return { ok: false, error: "That player has protection from this." };
    return { ok: true };
  }
  if (targetKind === "spell") {
    if (!lobby.stack.some((s) => s.id === targetId)) return { ok: false, error: "Choose a spell or ability on the stack." };
    return { ok: true };
  }
  if (targetKind === "any") {
    if (lobby.players[targetId]) {
      if (cardTypeProtectionBlocks(lobby, targetId, entry.spellCard || entry.sourceCard)) return { ok: false, error: "That player has protection from this." };
      return { ok: true };
    }
    const c = lobby.cards[targetId];
    if (!c || !(c.zoneType === "creature" || (c.type || "").toLowerCase().includes("planeswalker"))) return { ok: false, error: "Choose a creature, player, or planeswalker." };
    if (targetIsUntargetableBy(lobby, c, entry.controllerId, entry.spellCard || entry.sourceCard)) return { ok: false, error: `${c.name || "That permanent"} can't be targeted by this.` };
    return { ok: true };
  }
  // Boros Charm -- "target player or planeswalker" (excludes creatures/artifacts/enchantments,
  // unlike "any" above).
  if (targetKind === "playerOrPlaneswalker") {
    if (lobby.players[targetId]) {
      if (cardTypeProtectionBlocks(lobby, targetId, entry.spellCard || entry.sourceCard)) return { ok: false, error: "That player has protection from this." };
      return { ok: true };
    }
    const c = lobby.cards[targetId];
    if (!c || !(c.type || "").toLowerCase().includes("planeswalker")) return { ok: false, error: "Choose a player or planeswalker." };
    if (targetIsUntargetableBy(lobby, c, entry.controllerId, entry.spellCard || entry.sourceCard)) return { ok: false, error: `${c.name || "That planeswalker"} can't be targeted by this.` };
    return { ok: true };
  }
  // Aerial Assault -- "target tapped creature." The first card in this app needing a target
  // restricted by its CURRENT tapped state rather than its type/ownership.
  if (targetKind === "tappedCreature") {
    const c = lobby.cards[targetId];
    if (!c || c.zoneType !== "creature" || !c.tapped) return { ok: false, error: "Choose a tapped creature." };
    if (targetIsUntargetableBy(lobby, c, entry.controllerId, entry.spellCard || entry.sourceCard)) return { ok: false, error: `${c.name || "That creature"} can't be targeted by this.` };
    return { ok: true };
  }
  if (targetKind === "permanent") {
    const c = lobby.cards[targetId];
    if (!c || !(c.zoneType === "creature" || c.zoneType === "artifact")) return { ok: false, error: "Choose a permanent." };
    // Kyodai, Soul of Kamigawa -- "ANOTHER target permanent." Reuses the same excludeSelf naming
    // convention fireGlobalTrigger's own excludeSelf flag already established, just applied to a
    // real target choice instead of a global-trigger scan.
    if (entry.excludeSelf && entry.sourceCard && c.id === entry.sourceCard.id) return { ok: false, error: "Choose another permanent." };
    if (entry.minCmc && (c.cmc || 0) < entry.minCmc) return { ok: false, error: `${c.name || "That permanent"}'s mana value is too low to target with this.` };
    if (targetIsUntargetableBy(lobby, c, entry.controllerId, entry.spellCard || entry.sourceCard)) return { ok: false, error: `${c.name || "That permanent"} can't be targeted by this.` };
    return { ok: true };
  }
  // Acidic Slime ("target artifact, enchantment, or land"), Angel of the Ruins ("up to two target
  // artifacts and/or enchantments", narrowed to one -- see its own CARD_ABILITIES comment) -- a
  // flexible permanent-type-list target, since "permanent" above is hardcoded to creature/artifact
  // only (an existing, disclosed narrowing predating this) and neither an artifact-only nor a
  // creature/artifact-only kind fits a card whose real wording explicitly EXCLUDES creatures.
  // entry.typeFilter is an array of lowercase substrings checked against the target's own type line.
  if (targetKind === "typeList") {
    const c = lobby.cards[targetId];
    if (!c || !(c.zoneType === "creature" || c.zoneType === "artifact" || c.zoneType === "mana")) return { ok: false, error: "Choose a permanent." };
    const filter = entry.typeFilter || [];
    if (!filter.some((t) => (c.type || "").toLowerCase().includes(t))) return { ok: false, error: `Choose a ${filter.join("/")} permanent.` };
    if (targetIsUntargetableBy(lobby, c, entry.controllerId, entry.spellCard || entry.sourceCard)) return { ok: false, error: `${c.name || "That permanent"} can't be targeted by this.` };
    return { ok: true };
  }
  // Witch's Clinic -- "target commander," any player's, not restricted to your own the way
  // ownCreature is. isCommander is already stamped on the card at cast/battlefield time.
  if (targetKind === "commander") {
    const c = lobby.cards[targetId];
    if (!c || c.zoneType !== "creature" || !c.isCommander) return { ok: false, error: "Choose a commander." };
    if (targetIsUntargetableBy(lobby, c, entry.controllerId, entry.spellCard || entry.sourceCard)) return { ok: false, error: `${c.name || "That commander"} can't be targeted by this.` };
    return { ok: true };
  }
  // Kor Haven -- "target attacking creature," checked against the real live combat state (any
  // controller's, matching the real card's own unrestricted wording) rather than just "creature".
  if (targetKind === "attackingCreature") {
    const c = lobby.cards[targetId];
    if (!c || c.zoneType !== "creature" || !lobby.combat.attackers[targetId]) return { ok: false, error: "Choose an attacking creature." };
    if (targetIsUntargetableBy(lobby, c, entry.controllerId, entry.spellCard || entry.sourceCard)) return { ok: false, error: `${c.name || "That creature"} can't be targeted by this.` };
    return { ok: true };
  }
  // Izzet Boilerworks (the "bounce land" cycle) -- "return A LAND YOU CONTROL to its owner's
  // hand," self-inclusive (real Magic lets you bounce the source itself if it's your only land),
  // same shape as ownCreature but for zoneType "mana" instead.
  if (targetKind === "ownLand") {
    const c = lobby.cards[targetId];
    if (!c || c.owner !== entry.controllerId || c.zoneType !== "mana") return { ok: false, error: "Choose a land you control." };
    return { ok: true };
  }
  // Field of Ruin -- "target NONBASIC land an OPPONENT controls." First targetKind restricted to
  // lands with a real basic/nonbasic distinction (basicLandColor already does exactly this check
  // elsewhere for auto-mana purposes, reused here instead of a fresh regex).
  if (targetKind === "opponentNonbasicLand") {
    const c = lobby.cards[targetId];
    if (!c || c.zoneType !== "mana") return { ok: false, error: "Choose a land." };
    if (c.owner === entry.controllerId) return { ok: false, error: "Choose an opponent's land." };
    if (basicLandColor(c.type)) return { ok: false, error: "Choose a NONBASIC land." };
    if (targetIsUntargetableBy(lobby, c, entry.controllerId, entry.spellCard || entry.sourceCard)) return { ok: false, error: `${c.name || "That land"} can't be targeted by this.` };
    return { ok: true };
  }
  if (targetKind === "ownPermanent") {
    const c = lobby.cards[targetId];
    if (!c || c.owner !== entry.controllerId || !(c.zoneType === "creature" || c.zoneType === "artifact")) return { ok: false, error: "Choose a permanent you control." };
    return { ok: true };
  }
  if (targetKind === "cardType") {
    if (!CARD_TYPE_CHOICES.includes(targetId)) return { ok: false, error: "Choose a card type." };
    return { ok: true };
  }
  // Icon of Ancestry / Cavern of Souls -- free text, not checked against a real creature-type list
  // (hundreds exist; see chooseCreatureType's own comment for the trust-model precedent).
  if (targetKind === "creatureType") {
    if (typeof targetId !== "string" || !targetId.trim()) return { ok: false, error: "Choose a creature type." };
    return { ok: true };
  }
  // Mother of Runes -- "target creature you control." Self-targeting is always legal (protection
  // never restricts your own creatures from your own abilities, same precedent as
  // targetIsUntargetableBy's "owner === controller" bypass), so no untargetable check is needed.
  if (targetKind === "ownCreature") {
    const c = lobby.cards[targetId];
    if (!c || c.owner !== entry.controllerId || c.zoneType !== "creature") return { ok: false, error: "Choose a creature you control." };
    // Optional, generic exclusion (Breath of Fury -- can't reattach to the creature that's about
    // to be sacrificed) -- a plain id check rather than a dedicated targetKind like
    // otherOwnCreature's hardcoded sourceCard.id exclusion, since the excluded card here is neither
    // the ability's source nor a fixed relationship, just whatever the caller passes.
    if (entry.excludeCardId && targetId === entry.excludeCardId) return { ok: false, error: "Choose a DIFFERENT creature you control." };
    return { ok: true };
  }
  // Giver of Runes -- "ANOTHER target creature you control" -- same as ownCreature but excludes the
  // activating permanent itself.
  if (targetKind === "otherOwnCreature") {
    const c = lobby.cards[targetId];
    if (!c || c.owner !== entry.controllerId || c.zoneType !== "creature") return { ok: false, error: "Choose another creature you control." };
    if (entry.sourceCard && c.id === entry.sourceCard.id) return { ok: false, error: "Choose ANOTHER creature you control, not this one." };
    return { ok: true };
  }
  // Torch Courier -- "ANOTHER target creature," any controller's (unlike otherOwnCreature's
  // own-only restriction), excluding the source itself the same way.
  if (targetKind === "otherCreature") {
    const c = lobby.cards[targetId];
    if (!c || c.zoneType !== "creature") return { ok: false, error: "Choose another creature." };
    if (entry.sourceCard && c.id === entry.sourceCard.id) return { ok: false, error: "Choose ANOTHER creature, not this one." };
    if (targetIsUntargetableBy(lobby, c, entry.controllerId, entry.spellCard || entry.sourceCard)) return { ok: false, error: `${c.name || "That creature"} can't be targeted by this.` };
    return { ok: true };
  }
  if (targetKind === "ownGraveyardCreature") {
    const p = lobby.players[entry.controllerId];
    const found = p && (p.graveyard || []).find((e) => e.id === targetId && (e.type || "").toLowerCase().includes("creature"));
    if (!found) return { ok: false, error: "Choose a creature card from your own graveyard." };
    return { ok: true };
  }
  // Mistveil Plains -- "target card from your graveyard," genuinely unrestricted (unlike
  // ownGraveyardCreature/ownGraveyardTypeList/ownGraveyardMvFilter, all of which narrow to some
  // subset) -- any card of any type qualifies.
  if (targetKind === "ownGraveyard") {
    const p = lobby.players[entry.controllerId];
    const found = p && (p.graveyard || []).some((e) => e.id === targetId);
    if (!found) return { ok: false, error: "Choose a card from your own graveyard." };
    return { ok: true };
  }
  // Sun Titan -- "target PERMANENT card with mana value 3 or less" (any permanent type, unlike
  // ownGraveyardCreature's creature-only or ownGraveyardTypeList's fixed type list) -- same
  // ownGraveyard* shape, filtered on cmc instead of type, and excluding instants/sorceries the way
  // "permanent card" always does.
  if (targetKind === "ownGraveyardMvFilter") {
    const p = lobby.players[entry.controllerId];
    const found = p && (p.graveyard || []).find((e) => e.id === targetId && !isInstantOrSorcery(e.type) && (e.cmc || 0) <= (entry.maxCmc != null ? entry.maxCmc : Infinity));
    if (!found) return { ok: false, error: `Choose a permanent card with mana value ${entry.maxCmc} or less from your own graveyard.` };
    return { ok: true };
  }
  // Argivian Find ("artifact or enchantment card from your graveyard") -- same shape as
  // ownGraveyardCreature just above, generalized with a typeFilter list instead of a hardcoded
  // "creature" substring check, mirroring the battlefield-side typeList kind.
  if (targetKind === "ownGraveyardTypeList") {
    const p = lobby.players[entry.controllerId];
    const filter = entry.typeFilter || [];
    const found = p && (p.graveyard || []).find((e) => e.id === targetId && filter.some((t) => (e.type || "").toLowerCase().includes(t)));
    if (!found) return { ok: false, error: `Choose a ${filter.join("/")} card from your own graveyard.` };
    return { ok: true };
  }
  if (targetKind === "anyGraveyardCreature") {
    if (!findGraveyardEntry(lobby, targetId, "creature")) return { ok: false, error: "Choose a creature card in a graveyard." };
    return { ok: true };
  }
  if (targetKind === "ownCommanderInZone") {
    const p = lobby.players[entry.controllerId];
    const slot = parseInt(targetId, 10);
    if (!p || !Number.isInteger(slot) || !p.commanders[slot] || p.commanders[slot].battlefieldId) return { ok: false, error: "Choose a commander in your command zone." };
    return { ok: true };
  }
  if (targetKind === "mode") {
    const idx = parseInt(targetId, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= (entry.modes || []).length) return { ok: false, error: "Choose one of the modes." };
    return { ok: true };
  }
  if (targetKind === "handCard") {
    const c = lobby.cards[targetId];
    if (!c || c.owner !== entry.controllerId || c.zoneType !== "hand") return { ok: false, error: "Choose a card from your own hand." };
    const filter = entry.handTypeFilter || [];
    if (filter.length && !filter.some((t) => (c.type || "").toLowerCase().includes(t.toLowerCase()))) return { ok: false, error: `Choose a ${filter.join("/")} card.` };
    return { ok: true };
  }
  // Existing behavior: a card whose zoneType matches (default "creature").
  const c = lobby.cards[targetId];
  if (!c || c.zoneType !== targetKind) return { ok: false, error: `Choose a ${targetKind === "creature" ? "creature" : targetKind}.` };
  if (targetIsUntargetableBy(lobby, c, entry.controllerId, entry.spellCard || entry.sourceCard)) return { ok: false, error: `${c.name || "That permanent"} can't be targeted by this.` };
  return { ok: true };
}
// Runs a spell's effects immediately (no target needed, or the target was already baked into
// `effects` by chooseTargetFor) -- shared by resolveStackTop (no-target spells resolve instantly)
// and chooseTargetFor's spell-completion branch (target-requiring spells, once chosen).
function executeSpellEffectsNow(lobby, card, effects) {
  const ctx = { controllerId: card.owner, sourceCard: { id: card.id } };
  (effects || []).forEach((params) => {
    const fn = EFFECTS[params.type];
    if (fn) fn(lobby, ctx, params);
  });
  checkEliminations(lobby);
  broadcastPlayers(lobby);
}
// The tail end of resolveStackTop (priority-round bookkeeping + the "did the stack just drain while
// combat was waiting on it" check) -- factored out so chooseTargetFor's spell-completion branch can
// run the exact same logic when IT is what empties the stack (a target-requiring spell that just
// finished resolving), not just resolveStackTop itself.
function finishStackTail(lobby) {
  if (lobby.stack.length === 0) {
    lobby.priority.holderId = null;
    lobby.priority.lastActorId = null;
    if (lobby.combat.step === "damage" && lobby.pendingTargetChoices.length === 0) resolveCombatDamage(lobby);
  } else {
    const activeId = lobby.turn.order[lobby.turn.activeIndex] || null;
    lobby.priority.holderId = activeId;
    lobby.priority.lastActorId = activeId;
  }
  broadcastPlayers(lobby);
  broadcastStack(lobby);
}
// Shared by fireEtbTriggers/fireDeathTriggers/fireAttackTriggers/fireGlobalTrigger: either queues
// for a target or pushes straight to the stack, depending on the authored ability. An optional
// `condition(card)` gates on the SOURCE card's own runtime state (e.g. "only if this permanent's
// controller chose mode X") -- distinct from targeting or from fireGlobalTrigger's forPlayerId
// scoping, which are both about who the event happened to, not what state the source card is in.
// xValue (optional, 4th arg) -- Kessig Wolf Run/Mirror Entity-style X-cost ACTIVATED abilities
// only (never set for a real trigger, which has no player-chosen cost). Baked into a fresh copy of
// ability.effects as xAmount on each effect object, the same "clone effects with a dynamic field
// merged in" pattern fireGlobalOtherCreatureEtbTriggers already uses for `amount`/`enteringCardId` --
// never mutates the shared ability.effects template itself.
function fireTrigger(lobby, card, ability, xValue) {
  if (ability.condition && !ability.condition(card, lobby)) return;
  const effects = xValue ? (ability.effects || []).map((e) => ({ ...e, xAmount: xValue })) : ability.effects;
  if (ability.requiresTarget) {
    // "handCard" targets (Kaalia's own signature ability -- put a card of the given types from
    // hand onto the battlefield attacking) have no legal-targets check anywhere else in this
    // engine to lean on, unlike battlefield/player/spell targets which are always at least
    // theoretically satisfiable. Without this, the trigger would fire and prompt EVERY single
    // attack even on a turn where the attacking player's hand has nothing matching -- CR 603.3c's
    // real auto-fizzle-with-no-legal-target behavior, just checked up front here since nothing
    // downstream does it.
    if (ability.targetKind === "handCard") {
      const filter = ability.handTypeFilter || [];
      const hasMatch = Object.values(lobby.cards).some((c) => c.owner === card.owner && c.zoneType === "hand" && filter.some((t) => (c.type || "").toLowerCase().includes(t.toLowerCase())));
      if (!hasMatch) return;
    }
    // Reya Dawnbringer: same CR 603.3c auto-fizzle as handCard above, but for an EMPTY graveyard --
    // otherwise this would nag every single upkeep even when there's nothing to reanimate.
    if (ability.targetKind === "ownGraveyardCreature") {
      const p = lobby.players[card.owner];
      const hasMatch = p && (p.graveyard || []).some((e) => (e.type || "").toLowerCase().includes("creature"));
      if (!hasMatch) return;
    }
    // Mistveil Plains -- same CR 603.3c auto-fizzle, unrestricted graveyard kind.
    if (ability.targetKind === "ownGraveyard") {
      const p = lobby.players[card.owner];
      if (!p || !(p.graveyard || []).length) return;
    }
    // Griffin Dreamfinder/Sharuum the Hegemon-style "target artifact/enchantment card in your
    // graveyard" -- same CR 603.3c auto-fizzle as ownGraveyardCreature just above (this one was
    // missing it entirely -- an empty-of-that-type graveyard, the overwhelmingly common case for a
    // fresh ETB, would otherwise queue an unanswerable prompt and block anything behind it, the
    // exact same failure mode the typeList fix below was built for).
    if (ability.targetKind === "ownGraveyardTypeList") {
      const p = lobby.players[card.owner];
      const filter = ability.typeFilter || [];
      const hasMatch = p && (p.graveyard || []).some((e) => filter.some((t) => (e.type || "").toLowerCase().includes(t)));
      if (!hasMatch) return;
    }
    // Sun Titan: same CR 603.3c auto-fizzle as ownGraveyardTypeList just above, for the MV-filtered
    // graveyard kind instead -- otherwise this would nag on every single attack/ETB once the
    // graveyard has nothing cheap enough left.
    if (ability.targetKind === "ownGraveyardMvFilter") {
      const p = lobby.players[card.owner];
      const hasMatch = p && (p.graveyard || []).some((e) => !isInstantOrSorcery(e.type) && (e.cmc || 0) <= (ability.maxCmc != null ? ability.maxCmc : Infinity));
      if (!hasMatch) return;
    }
    // Hellkite Courser: "put a commander you own from the command zone onto the battlefield" --
    // there are only ever 1-2 real choices, so the eligible commanders (in the zone, not currently
    // on the battlefield) are computed here and sent as commanderChoices (slot + name) for the
    // client to render as real, named buttons rather than a battlefield click. Same CR 603.3c
    // auto-fizzle shape as the other targetKinds above if neither commander qualifies.
    let commanderChoices = null;
    if (ability.targetKind === "ownCommanderInZone") {
      const p = lobby.players[card.owner];
      commanderChoices = (p ? p.commanders : []).map((cmd, slot) => (cmd && !cmd.battlefieldId) ? { slot, name: cmd.name } : null).filter(Boolean);
      if (!commanderChoices.length) return;
    }
    // Same CR 603.3c auto-fizzle as the checks above, for "target artifact/enchantment/[whatever
    // typeFilter names]" -- without this, a trigger with no currently-legal target (Harmonic
    // Sliver's own "destroy target artifact or enchantment" once nothing of either type remains,
    // say) sits queued forever with nothing able to answer it, silently blocking every OTHER
    // target choice queued behind it (discovered via a granted-ETB-trigger test where a second
    // Sliver's own trigger could never get prompted because this one was stuck in front of it).
    if (ability.targetKind === "typeList") {
      const filter = ability.typeFilter || [];
      const hasMatch = Object.values(lobby.cards).some((c) => (c.zoneType === "creature" || c.zoneType === "artifact" || c.zoneType === "mana") && filter.some((t) => (c.type || "").toLowerCase().includes(t)));
      if (!hasMatch) return;
    }
    queueTargetChoice(lobby, { controllerId: card.owner, sourceCard: card, label: ability.label, effects, targetZoneType: ability.targetZoneType, targetKind: ability.targetKind, handTypeFilter: ability.handTypeFilter, typeFilter: ability.typeFilter, maxCmc: ability.maxCmc, excludeSelf: ability.excludeSelf, commanderChoices });
  } else {
    pushAbilityToStack(lobby, { sourceCard: card, controllerId: card.owner, label: ability.label, effects });
  }
}

// Fires every authored "enters the battlefield" ability for `card` (self-referential only -- see
// the CARD_ABILITIES comment). Pregame stays trigger-free, matching this file's existing
// "pregame is unrestricted" convention -- there's no meaningful turn.order/priority system yet.
function fireEtbTriggers(lobby, card) {
  if (!lobby.turn.started) return;
  applyEntersTappedByOpponentEffect(lobby, card);
  checkShockLandChoice(lobby, card);
  checkRevealFromHandChoice(lobby, card);
  checkChromeMoxImprint(lobby, card);
  checkMoxDiamondLandDiscard(lobby, card);
  checkRiot(lobby, card);
  getAutomatedAbilities(card.name, "etb").forEach((ability) => fireTrigger(lobby, card, ability));
  getGrantedTriggeredAbilities(card, lobby, "etb").forEach((ability) => fireTrigger(lobby, card, ability));
  // "When this land/permanent enters, scry N" -- see scryOnEtbFromText's own comment. No target,
  // no table entry -- calls EFFECTS.scryN directly rather than routing through fireTrigger/the
  // stack, matching landfall's own "generic text-detected, resolved inline" precedent just below.
  const scryAmount = scryOnEtbFromText(card.text);
  if (scryAmount) EFFECTS.scryN(lobby, { controllerId: card.owner, sourceCard: { id: card.id } }, { amount: scryAmount });
  const gainLifeAmount = gainLifeOnEtbFromText(card.text);
  // applyLifeGain itself never broadcasts (every other call site handles that downstream via
  // whatever ELSE it does after -- checkEliminations+broadcastPlayers, a spell's own
  // executeSpellEffectsNow, etc.) -- a real, silent bug caught here since this is the first call
  // site with nothing else after it to accidentally cover for the missing broadcast.
  if (gainLifeAmount) { applyLifeGain(lobby, card.owner, gainLifeAmount); broadcastPlayers(lobby); }
  const drawAmount = drawCardsOnEtbFromText(card.text);
  if (drawAmount) drawN(lobby, card.owner, drawAmount);
  fireGlobalOtherCreatureEtbTriggers(lobby, card);
  fireOpponentCreatureEtbTriggers(lobby, card);
  // Landfall (Tireless Tracker, etc.) -- "whenever a land enters the battlefield under your
  // control." zoneType "mana" is this app's own bucket for every land (see classifyType), already
  // set on `card` by every one of this function's callers before they call it, so no separate
  // "is this a land" check is needed. Covers a land played from hand AND one fetched by
  // searchLandTypes/fetchLand -- both routes call this same function, unlike real landfall's
  // "self" restriction which every one of those routes already satisfies (fetches only ever put
  // the land onto the fetching player's own battlefield).
  if (card.zoneType === "mana") fireGlobalTrigger(lobby, "landfall", card.owner, card);
}
// Shocklands ("As this land enters, you may pay 2 life. If you don't, it enters tapped.") -- a
// real ETB choice, previously just silently always-untapped-for-free (entersTapped() deliberately
// excludes this wording, since a real choice exists and the app can't resolve it automatically --
// see its own comment). Reuses the optional-payment engine built for Smothering Tithe/Esper
// Sentinel/Rakdos with a new cost.life shape -- the "payer" here is the land's OWN controller, not
// an opponent, which the engine already supports (playerId is just whoever answers the prompt).
// Skipped if the land is ALREADY tapped from something else (Blind Obedience, etc.) -- no reason
// to offer paying life for nothing.
function shockLandLifeCost(card) {
  const m = (card.text || "").match(/pay (\d+) life\.\s*if you don't,\s*it enters tapped/i);
  return m ? parseInt(m[1], 10) : null;
}
function checkShockLandChoice(lobby, card) {
  if (card.tapped) return;
  const lifeCost = shockLandLifeCost(card);
  if (!lifeCost) return;
  queueOptionalPayment(lobby, {
    playerId: card.owner, controllerId: card.owner, sourceCard: card,
    label: `${card.name} — pay ${lifeCost} life to have it enter untapped`, costLabel: `Pay ${lifeCost} life`,
    cost: { life: lifeCost }, declinedEffects: [{ type: "tapSelf" }]
  });
}
// "As this land enters, you may reveal a [Type] (or [Type]) card from your hand. If you don't,
// this land enters tapped." (Flamekin Village, Frostboil Snarl, Game Trail, and the whole real
// cycle they belong to) -- same shape as a shockland's life payment, just a REVEAL instead of a
// real resource cost, so cost is empty ({}) rather than {life: N} -- payOptionalCost only ever
// checks cost.mana/cost.life/cost.sacrificeCount, so an empty cost object correctly costs nothing
// and just resolves. Unlike a shockland (which is always a real choice), revealing is only a real
// choice when a qualifying card actually exists in hand -- same CR 603.3c "no legal way to satisfy
// it" auto-fizzle precedent used elsewhere in this file, so a hand with no match skips the prompt
// and goes straight to tapped, matching what real Magic would force anyway.
function revealFromHandChoiceFromText(text) {
  const m = (text || "").match(/as this land enters, you may reveal an? ([a-z]+)(?:\s+or\s+(?:an? )?([a-z]+))? card from (?:your )?hand\.\s*if you don'?t, this land enters tapped/i);
  if (!m) return null;
  return { types: [m[1], m[2]].filter(Boolean) };
}
function checkRevealFromHandChoice(lobby, card) {
  if (card.tapped) return;
  const rc = revealFromHandChoiceFromText(card.text);
  if (!rc) return;
  const hasMatch = Object.values(lobby.cards).some((c) => c.owner === card.owner && c.zoneType === "hand" && rc.types.some((t) => (c.type || "").toLowerCase().includes(t.toLowerCase())));
  if (!hasMatch) { card.tapped = true; broadcastCard(lobby, card); return; }
  const typeLabel = rc.types.join(" or ");
  const article = /^[aeiou]/i.test(typeLabel) ? "an" : "a";
  queueOptionalPayment(lobby, {
    playerId: card.owner, controllerId: card.owner, sourceCard: card,
    label: `${card.name} — reveal ${article} ${typeLabel} card from hand to have it enter untapped`, costLabel: `Reveal ${article} ${typeLabel} card`,
    cost: {}, declinedEffects: [{ type: "tapSelf" }]
  });
}
// Chrome Mox -- "Imprint -- When this artifact enters, you may exile a nonartifact, nonland card
// from your hand. {T}: Add one mana of any of the exiled card's colors." WHICH hand card to imprint
// is a real choice this app has no multi-card hand-picker UI for, so this auto-picks the first
// eligible one (same "auto-pick over building new UI" precedent as several other effects in this
// wave) and treats it as mandatory rather than optional -- a disclosed simplification; doing nothing
// when no eligible card exists in hand is preserved. The chosen colors are stashed directly on the
// permanent (card.imprintedColors) for the tap handler below to read instead of falling back to its
// raw (wrong -- a real 5-color) producedMana list.
function checkChromeMoxImprint(lobby, card) {
  if (!/imprint/i.test(card.text || "") || card.imprintedColors) return;
  const target = Object.values(lobby.cards).find((c) => c.owner === card.owner && c.zoneType === "hand" && !/artifact|land/i.test(c.type || ""));
  if (!target) return;
  card.imprintedColors = target.colors && target.colors.length ? target.colors : ["C"];
  lobby.players[card.owner].exile.push(toEntry(target));
  delete lobby.cards[target.id];
  delete lobby.targets[target.id];
  io.to(lobby.id).emit("cardRemove", target.id);
  broadcastCard(lobby, card);
  broadcastPlayers(lobby);
  pushLog(lobby, `${card.name} imprints ${target.name || "a card"} (exiled), producing {${card.imprintedColors.join("}{")}}`);
}
// Mox Diamond -- "If this artifact would enter, you may discard a land card instead. If you do, put
// this artifact onto the battlefield. If you don't, put it into its owner's graveyard." A true
// replacement effect (CR 614) would mean it never really "enters" at all if declined -- this app has
// no replacement-effect layer (flagged as a known, larger gap elsewhere), so this approximates it as
// a forced ETB choice instead: it genuinely enters first, then this check immediately discards a
// land (auto-picked, same imprint precedent above) to let it stay, or removes it right back off if
// none exists. The end state matches real Magic exactly either way; only the fine-grained "did it
// truly ever enter" timing differs, which nothing else in this app currently cares about.
function checkMoxDiamondLandDiscard(lobby, card) {
  if (archiveKey(card.name) !== "mox diamond") return;
  const land = Object.values(lobby.cards).find((c) => c.owner === card.owner && c.zoneType === "hand" && (c.type || "").toLowerCase().includes("land"));
  if (land) {
    sendToGraveyardInternal(lobby, land);
    pushLog(lobby, `${(lobby.players[card.owner] || {}).name || "Someone"} discards ${land.name || "a land"} to keep Mox Diamond`);
    return;
  }
  pushLog(lobby, `Mox Diamond has no land to discard and goes to its owner's graveyard`);
  delete lobby.cards[card.id];
  delete lobby.targets[card.id];
  io.to(lobby.id).emit("cardRemove", card.id);
  const p = lobby.players[card.owner];
  if (p) { p.graveyard.push(toEntry(card)); broadcastPlayers(lobby); }
}
// "Artifacts and creatures your opponents control enter tapped" (Blind Obedience) -- a static
// replacement effect (CR 614), checked at the same single fireEtbTriggers choke point every real
// battlefield entry already reaches. Extort (Blind Obedience's other half -- "whenever you cast a
// spell, you may pay {W/B}...") is a genuinely different shape (an optional cost offered to
// YOURSELF, not an opponent, unlike the pendingOptionalPayments engine built for Smothering
// Tithe/Esper Sentinel/Rakdos) and isn't modeled here.
const ENTERS_TAPPED_FOR_OPPONENTS = ["blind obedience", "authority of the consuls"];
function applyEntersTappedByOpponentEffect(lobby, enteringCard) {
  if (enteringCard.tapped || !(enteringCard.zoneType === "creature" || enteringCard.zoneType === "artifact")) return;
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.owner === enteringCard.owner || c.zoneType === "hand" || c.zoneType === "stack") continue;
    if (ENTERS_TAPPED_FOR_OPPONENTS.includes(archiveKey(c.name))) {
      enteringCard.tapped = true;
      broadcastCard(lobby, enteringCard);
      return;
    }
  }
}

// "Whenever ANOTHER creature enters the battlefield under your control" (Terror of the Peaks,
// Warstorm Surge-style triggers) -- distinct from the self-only loop just above and needs the
// entering creature's own power baked in dynamically (varies per creature and per any
// equipment/anthem bonus already in play the instant it resolves), same "capture the dynamic bit
// at fire time" approach fireCombatDamageToPlayerTriggers/fireGlobalAttackTypeTriggers already use.
// Only fires for CREATURE permanents entering (a land/artifact entering doesn't count) and excludes
// the entering card itself from the scan (the "another" in the wording) -- EXCEPT when
// ability.selfInclusive is set, for wording like Dragon Tempest's "whenever a Dragon you control
// enters" (no "another"), where the entering creature can itself be what's being watched for.
// ability.typeFilter/keywordFilter narrow WHICH entering creature qualifies (Dragon Tempest has two
// abilities on one card watching for two different things: any flier, and specifically Dragons).
// ability.amountSource picks what gets baked into the effects as `amount`: "power" (default, Terror
// of the Peaks) or "count" (Dragon Tempest's X = how many creatures matching countTypeFilter the
// controller has, counted AFTER the entering creature is already on the battlefield).
function fireGlobalOtherCreatureEtbTriggers(lobby, enteringCard) {
  if (!lobby.turn.started || enteringCard.zoneType !== "creature") return;
  const bonus = attachedBonusFor(lobby, enteringCard);
  const stat = staticBonusFor(lobby, enteringCard);
  const power = Math.max(0, parsePT(enteringCard.power) + bonus.powerBonus + stat.powerBonus);
  const enteringType = (enteringCard.type || "").toLowerCase();
  const enteringKeywords = effectiveKeywords(lobby, enteringCard).map((k) => (k || "").toLowerCase());
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.owner !== enteringCard.owner || c.zoneType === "hand" || c.zoneType === "stack") continue;
    getAutomatedAbilities(c.name, "otherCreatureEtb").forEach((ability) => {
      if (c.id === enteringCard.id && !ability.selfInclusive) return;
      // Miirym, Sentinel Wyrm -- "another NONTOKEN Dragon" -- without this, a token Dragon entering
      // (from Miirym's own copy effect, or any other token-Dragon source) would keep re-triggering
      // Miirym forever, a real infinite-loop risk, not just a flavor mismatch.
      if (ability.excludeTokenSources && enteringType.includes("token")) return;
      if (ability.typeFilter && !ability.typeFilter.some((t) => enteringType.includes(t.toLowerCase()))) return;
      if (ability.keywordFilter && !ability.keywordFilter.some((k) => enteringKeywords.includes(k.toLowerCase()))) return;
      // Welcoming Vampire -- "with power 2 or less."
      if (ability.maxPower != null && power > ability.maxPower) return;
      if (ability.condition && !ability.condition(c, lobby)) return;
      // Welcoming Vampire -- "This ability triggers only once each turn." A single per-card slot
      // (not a whole map) is enough for now, same narrow-to-what's-needed precedent as everywhere
      // else in this file -- no card yet has TWO different once-per-turn otherCreatureEtb abilities
      // at once. Compared against the turn NUMBER (not a boolean flag swept at cleanup), same
      // pattern Esper Sentinel's own once-per-opponent-per-turn tracking already uses.
      if (ability.oncePerTurn) {
        if (c._otherCreatureEtbOncePerTurnFiredTurn === lobby.turn.turnNumber) return;
        c._otherCreatureEtbOncePerTurnFiredTurn = lobby.turn.turnNumber;
      }
      let amount = power;
      if (ability.amountSource === "count") {
        const filter = ability.countTypeFilter || [];
        amount = Object.values(lobby.cards).filter((x) => x.owner === enteringCard.owner && x.zoneType === "creature" && filter.some((t) => (x.type || "").toLowerCase().includes(t.toLowerCase()))).length;
      }
      // Only fill in `amount` when the effect doesn't already specify a FIXED one of its own
      // (Corpse Knight/Cathars' Crusade/Impact Tremors/Lathliss all want a flat 1 regardless of the
      // entering creature's power, unlike Terror of the Peaks/Dragon Tempest which genuinely want
      // this dynamic value) -- a real bug found while testing Lathliss: this used to unconditionally
      // overwrite ANY already-set amount, silently scaling those cards' fixed effects by the
      // entering creature's power/count instead of the flat 1 their real text says.
      const effects = (ability.effects || []).map((e) => ({ ...e, amount: e.amount != null ? e.amount : amount, enteringCardId: enteringCard.id }));
      if (ability.requiresTarget) {
        queueTargetChoice(lobby, { controllerId: c.owner, sourceCard: c, label: ability.label, effects, targetKind: ability.targetKind });
      } else {
        pushAbilityToStack(lobby, { sourceCard: c, controllerId: c.owner, label: ability.label, effects });
      }
    });
  }
}

// Authority of the Consuls -- "Whenever a creature an opponent controls enters, you gain 1 life."
// The mirror image of fireGlobalOtherCreatureEtbTriggers (which only ever matches the SAME
// controller as the entering creature) -- this matches the OPPOSITE relationship instead. Kept as
// its own small function rather than folding an "opponent" mode into that one, since Authority's
// shape has none of the power/amountSource/keywordFilter machinery that function exists to support
// and adding an unused option set there for one card isn't worth the complexity.
function fireOpponentCreatureEtbTriggers(lobby, enteringCard) {
  if (!lobby.turn.started || enteringCard.zoneType !== "creature") return;
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.owner === enteringCard.owner || c.zoneType === "hand" || c.zoneType === "stack") continue;
    getAutomatedAbilities(c.name, "opponentCreatureEtb").forEach((ability) => fireTrigger(lobby, c, ability));
  }
}
// Archivist of Oghma -- "whenever an opponent searches their library." Same shape as
// fireOpponentCreatureEtbTriggers just above, keyed off the searching PLAYER's id instead of an
// entering card -- called at every real "a library search actually happened" site (fetchLand,
// tutorCard, drawSpecific, and their own cancel/find-nothing paths, since CR 701.19 counts a
// search as happening whether or not anything was found).
function fireOpponentSearchTrigger(lobby, searchingPlayerId) {
  if (!lobby.turn.started) return;
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.owner === searchingPlayerId || c.zoneType === "hand" || c.zoneType === "stack") continue;
    getAutomatedAbilities(c.name, "opponentSearchesLibrary").forEach((ability) => fireTrigger(lobby, c, ability));
  }
}

// Fires every authored "dies" ability for `card` (self-referential only). Must be called BEFORE
// the card is actually removed from lobby.cards, so its data (owner, etc.) is still intact to
// build the ability instance from.
function fireDeathTriggers(lobby, card) {
  if (!lobby.turn.started) return;
  // Client-visible signal for the color-coded death VFX (elemental burst keyed off the dying
  // creature's own colors) -- covers every death path in this app in one place, since they all
  // already route through this function. Emitted here (not folded into cardRemove, which ALSO
  // fires for bounce-to-hand/exile, neither of which is a "death") and BEFORE
  // sendToGraveyardInternal/exileCardInternal actually delete the card, so the client still has
  // the card's board position to play the burst at when this arrives.
  if (card.zoneType === "creature") io.to(lobby.id).emit("creatureDied", { id: card.id, colors: card.colors || [] });
  getAutomatedAbilities(card.name, "death").forEach((ability) => fireTrigger(lobby, card, ability));
  fireGlobalTrigger(lobby, "deathYouControl", card.owner, card);
  fireLiesaReturnToHandTrigger(lobby, card);
  fireKardurDoomscourgeDeathTrigger(lobby, card);
  checkEquipmentDeathDraw(lobby, card);
  checkEquipmentDeathToken(lobby, card);
  // Tarrian's Soulcleaver -- fireDeathTriggers is the ONE real universal choke point for "a
  // permanent genuinely died from the battlefield" (both the manual moveOut path and every
  // automated destroy/sacrifice site already call this before actually removing the card), unlike
  // sendToGraveyardInternal alone which ALSO fires for a plain hand discard. Runs while the dying
  // card is still fully live (not yet deleted/detached), so checkTarrianSoulcleaverCounter itself
  // has to guard against the dying permanent being the very host it would counter.
  checkTarrianSoulcleaverCounter(lobby, card);
}
// Kardur, Doomscourge -- "whenever an attacking creature dies, each opponent loses 1 life and you
// gain 1 life." Unlike deathYouControl (Zulaport Cutthroat, Venerated Stormsinger), this cares
// about ANY attacking creature dying table-wide, not just ones its own controller controls --
// Kardur is usually watching an OPPONENT's forced attacker die, per its own other half -- so this
// scans every Kardur on the battlefield directly instead of routing through fireGlobalTrigger's
// "one player's own permanents" model. Must run before the card leaves lobby.combat.attackers,
// same "called before removal" contract as the rest of fireDeathTriggers.
function fireKardurDoomscourgeDeathTrigger(lobby, dyingCard) {
  if (dyingCard.zoneType !== "creature") return;
  if (!lobby.combat || lobby.combat.attackers[dyingCard.id] === undefined) return;
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.zoneType !== "creature") continue;
    if (archiveKey(c.name) !== "kardur, doomscourge") continue;
    pushAbilityToStack(lobby, {
      sourceCard: c, controllerId: c.owner,
      label: `${dyingCard.name || "An attacking creature"} died — each opponent loses 1 life, you gain 1 life (Kardur, Doomscourge)`,
      effects: [{ type: "loseLife", target: "eachOpponent", amount: 1 }, { type: "gainLife", target: "controller", amount: 1 }]
    });
  }
}
// Liesa, Forgotten Archangel -- "Whenever another nontoken creature you control dies, return that
// card to its owner's hand at the beginning of the next end step." Aristocrats-style (scans the
// dying creature's controller's OTHER permanents for a real Liesa), but needs the dying card's own
// identity baked into a delayed trigger -- fireGlobalTrigger's generic dispatch has no way to
// carry that, so this is its own dedicated function, same shape as
// fireGlobalOtherCreatureEtbTriggers. Called from fireDeathTriggers, BEFORE the card is actually
// removed from lobby.cards, so card.id/name/originalOwner are all still valid to bake in.
// "Nontoken" isn't checked -- no isToken flag exists anywhere in this app's data model, a
// disclosed simplification shared with Rakdos, Patron of Chaos's identical gap.
function fireLiesaReturnToHandTrigger(lobby, dyingCard) {
  if (dyingCard.zoneType !== "creature") return;
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.id === dyingCard.id || c.owner !== dyingCard.owner || c.zoneType === "hand" || c.zoneType === "stack") continue;
    if (archiveKey(c.name) !== "liesa, forgotten archangel") continue;
    queueDelayedTrigger(lobby, {
      firesAtPhase: "End Step", controllerId: c.owner, sourceCard: c,
      label: `${dyingCard.name || "A creature"} — return to hand (Liesa, Forgotten Archangel)`,
      effects: [{ type: "returnGraveyardEntryToHandById", entryId: dyingCard.id, ownerId: dyingCard.originalOwner || dyingCard.owner }]
    });
  }
}

// The non-self-referential counterpart to fireEtbTriggers/fireDeathTriggers/fireAttackTriggers,
// which only ever check the trigger's own source card. Aristocrats-style wording ("whenever a
// creature you control dies", "whenever you gain life", "whenever you cast a spell") isn't about
// the source of the event at all -- it's about every OTHER permanent belonging to whoever the event
// happened to, so this scans the whole battlefield instead of one card. `forPlayerId` is whichever
// player the event actually happened to (the dying creature's controller, the player who gained
// life, the caster) -- only THEIR permanents are scanned, matching "you"/"you control" in the
// oracle text these trigger types exist to cover.
// eventCard is optional context for the event that just happened -- currently only used by
// "youCastSpell" abilities carrying a colorFilter (Balefire Liege: two separate triggers, one per
// color of spell cast), everything else ignores it exactly as before.
function fireGlobalTrigger(lobby, eventType, forPlayerId, eventCard) {
  if (!lobby.turn.started) return;
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.owner !== forPlayerId || c.zoneType === "hand" || c.zoneType === "stack") continue;
    getAutomatedAbilities(c.name, eventType).forEach((ability) => {
      if (ability.colorFilter && !(eventCard && (eventCard.colors || []).includes(ability.colorFilter))) return;
      // Guttersnipe-style "whenever you cast an INSTANT OR SORCERY spell" -- same shape as
      // colorFilter just above, checked against the cast card's own type line instead of its colors.
      if (ability.spellTypeFilter && !(eventCard && ability.spellTypeFilter.some((t) => (eventCard.type || "").toLowerCase().includes(t)))) return;
      // Tireless Tracker-style "whenever you sacrifice a Clue" -- a deathYouControl entry narrowed
      // to one specific dying card BY NAME, rather than any death table-wide. Reusable for any
      // future "whenever you sacrifice/lose a [specific token name]" card, not just this one.
      if (ability.sourceNameFilter && archiveKey((eventCard && eventCard.name) || "") !== ability.sourceNameFilter) return;
      // Pashalik Mons-style "whenever ~ or another Goblin you control dies" -- narrowed by the dying
      // permanent's own TYPE line instead of a specific name, same shape as colorFilter/
      // spellTypeFilter just above. deathYouControl already scans the dying card's own controller's
      // whole battlefield (itself included, since it's removed from lobby.cards AFTER this fires),
      // so no separate "selfInclusive" flag is needed the way otherCreatureEtb's is.
      if (ability.typeFilter && !(eventCard && (eventCard.type || "").toLowerCase().includes(ability.typeFilter))) return;
      // City of Traitors-style "when you play ANOTHER land" -- unlike landfall's own default
      // self-inclusive firing (Field of the Dead counts itself among "seven or more lands," no
      // exclusion wanted there), this permanent reacting needs to skip the case where IT is the one
      // that just entered. c/eventCard are the same object here (the entering land triggering its
      // own landfall against its controller's whole battlefield), so id equality is the right check.
      if (ability.excludeSelf && eventCard && c.id === eventCard.id) return;
      // The Scarab God-style "X, where X is the number of [Type] you control" -- same
      // amountSource:"count" shape fireGlobalOtherCreatureEtbTriggers already uses, baked into
      // every effect in the array so both halves of "each opponent loses X life and you scry X"
      // share the identical, freshly-computed X.
      let fireAbility = ability;
      if (ability.amountSource === "count") {
        const filter = ability.countTypeFilter || [];
        const amount = Object.values(lobby.cards).filter((x) => x.owner === forPlayerId && x.zoneType === "creature" && filter.some((t) => (x.type || "").toLowerCase().includes(t.toLowerCase()))).length;
        fireAbility = { ...ability, effects: (ability.effects || []).map((e) => ({ ...e, amount })) };
      }
      fireTrigger(lobby, c, fireAbility);
    });
  }
}
// Ledger Shredder-style "whenever A PLAYER casts their second spell each turn" -- unlike every
// fireGlobalTrigger event above (all scoped to "you"/"you control", i.e. only the acting player's
// own battlefield), this reacts regardless of WHO cast the spell, so every permanent on the whole
// table needs checking, not just one player's. Kept as its own small function rather than adding
// yet another flag to fireGlobalTrigger, since "scan everyone, not just forPlayerId" is a
// fundamentally different scope, not a narrowing filter on the same scan.
function fireGlobalTriggerAllPlayers(lobby, eventType, eventCard) {
  if (!lobby.turn.started) return;
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.zoneType === "hand" || c.zoneType === "stack") continue;
    getAutomatedAbilities(c.name, eventType).forEach((ability) => fireTrigger(lobby, c, ability));
  }
}

// The one hook point for any positive life change, so selfGainsLife triggers fire regardless of
// source (an EFFECTS.gainLife resolution, or the manual +life button in statChange) instead of two
// divergent raw `p.life +=` sites. Only actual gains route through here -- life loss never fires
// this, matching the real "whenever you gain life" wording these triggers exist to cover.
function applyLifeGain(lobby, playerId, amount) {
  const p = lobby.players[playerId];
  if (!p || amount <= 0) return;
  if (p.lifeLocked) return; // Teferi's Protection -- "your life total can't change"
  p.life += amount;
  fireGlobalTrigger(lobby, "selfGainsLife", playerId);
}
// The loss-side counterpart to applyLifeGain -- same lifeLocked check, no trigger to fire (nothing
// in this app currently cares about "whenever you lose life"). Every raw `p.life -=` site should
// route through this instead, so Teferi's Protection's lock is enforced uniformly rather than only
// at whichever sites happened to get updated. `sourceCardId`, when the caller can identify a real
// on-battlefield source of the damage (a combat-damage-dealing attacker, or a damage spell/ability's
// own card), is what lets Deflecting Palm's redirect trigger -- omit it for non-source-attributable
// life loss (mass effects, cost payments), which Deflecting Palm correctly can't intercept either.
// Returns true if `playerId` actually lost the life (the normal case -- callers that also track
// something ELSE alongside a life loss, like commander damage, should gate that on this return
// value too, since a locked/redirected hit means THIS player never really took the damage).
// Bloodletter of Aclazotz -- "If an opponent would lose life during YOUR turn, they lose twice
// that much life instead." A real CR 614 replacement effect on the single applyLifeLoss choke
// point everything (damage-derived loss included, per the card's own reminder text) already funnels
// through -- scoped to whoever's turn it currently is (the controller's), and only ever doubles an
// OPPONENT's loss, never the controller's own.
function bloodletterMultiplierFor(lobby, victimId) {
  if (!lobby.turn.started) return 1;
  const activeId = lobby.turn.order[lobby.turn.activeIndex];
  if (!activeId || victimId === activeId) return 1;
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.owner !== activeId || c.zoneType === "hand" || c.zoneType === "stack") continue;
    if (/if an opponent would lose life during your turn, they lose twice that much life instead/i.test(c.text || "")) return 2;
  }
  return 1;
}
function applyLifeLoss(lobby, playerId, amount, sourceCardId) {
  const p = lobby.players[playerId];
  if (!p || amount <= 0) return false;
  amount *= bloodletterMultiplierFor(lobby, playerId);
  if (p.lifeLocked) return false; // Teferi's Protection -- "your life total can't change"
  // Deflecting Palm -- "the next time a source of your choice would deal damage to you this turn,
  // prevent it; that source's controller takes that much instead." One-shot: consumed the first
  // time the chosen source actually deals this player damage, regardless of amount.
  if (sourceCardId && p.deflectingPalmSource === sourceCardId) {
    p.deflectingPalmSource = null;
    const source = lobby.cards[sourceCardId];
    const redirectTo = source ? source.owner : null;
    if (redirectTo && lobby.players[redirectTo]) {
      pushLog(lobby, `${p.name} deflects ${amount} damage from ${source.name || "its source"} back to ${lobby.players[redirectTo].name} (Deflecting Palm)`);
      applyLifeLoss(lobby, redirectTo, amount);
    }
    return false;
  }
  p.life -= amount;
  fireVilisDrawTrigger(lobby, playerId, amount);
  return true;
}
// Vilis, Broker of Blood -- "Whenever you lose life, draw that many cards." Needs the exact
// amount lost baked into the ability's own effects at fire time, which the generic
// fireGlobalTrigger/fireTrigger dispatch has no channel for (see queueDelayedTrigger's own comment
// on "bake the dynamic bit into effects now" -- the same reasoning applies here), so this is its
// own dedicated function, same shape as fireKardurDoomscourgeDeathTrigger/
// fireLiesaReturnToHandTrigger. Called from applyLifeLoss AFTER the loss actually lands -- a
// locked (Teferi's Protection) or fully-redirected (Deflecting Palm) life change never reaches
// here, matching "whenever you lose life" only firing for life YOU actually lost.
function fireVilisDrawTrigger(lobby, playerId, amount) {
  if (!lobby.turn.started || amount <= 0) return;
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.owner !== playerId || c.zoneType === "hand" || c.zoneType === "stack") continue;
    if (archiveKey(c.name) !== "vilis, broker of blood") continue;
    pushAbilityToStack(lobby, {
      sourceCard: c, controllerId: playerId,
      label: `${c.name} — draw ${amount} card${amount === 1 ? "" : "s"} (lost ${amount} life)`,
      effects: [{ type: "drawCards", amount }]
    });
  }
}

// Fires every authored "attacks" ability for `card` (self-referential only). Called from
// declareAttackers once combat.attackers is already committed -- combat-sequencing correctness
// (the trigger resolving BEFORE damage, not after) is handled by resolveStackTop's combat.step
// check AND declareAttackers' own pendingTargetChoices check, not by anything here.
function fireAttackTriggers(lobby, card) {
  if (!lobby.turn.started) return;
  // Battle Cry Goblin's Pack Tactics -- bakes in attackerDefenderId (who THIS card is attacking) the
  // same way fireGlobalAttackTypeTriggers already does for the "otherAttacks" variant, so
  // createAttackingToken can join a self-referential "attack" trigger's own attack too, not just the
  // non-self-referential one.
  const defenderId = lobby.combat.attackers[card.id];
  getAutomatedAbilities(card.name, "attack").forEach((ability) => {
    const effects = (ability.effects || []).map((e) => ({ ...e, attackerDefenderId: defenderId }));
    fireTrigger(lobby, card, { ...ability, effects });
  });
}

// The non-self-referential counterpart to fireAttackTriggers (Utvara Hellkite: "whenever a DRAGON
// you control attacks", not just itself) -- scans every OTHER permanent the attacker's controller
// owns for a matching "otherAttacks" entry, same aristocrats-style shape fireGlobalTrigger already
// uses for death/life-gain/cast events, just keyed by the attacking card's TYPE LINE (typeFilter)
// instead of a fixed event name. Bakes the attacker's own defender id into the effects (same
// "capture the dynamic bit at fire time" pattern as fireCombatDamageToPlayerTriggers), since a
// token this creates might itself need to join the SAME attack.
function fireGlobalAttackTypeTriggers(lobby, attackingCard) {
  if (!lobby.turn.started) return;
  const defenderId = lobby.combat.attackers[attackingCard.id];
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.owner !== attackingCard.owner || c.zoneType === "hand" || c.zoneType === "stack") continue;
    getAutomatedAbilities(c.name, "otherAttacks").forEach((ability) => {
      if (ability.condition && !ability.condition(c, lobby)) return;
      if (ability.typeFilter && !ability.typeFilter.some((t) => (attackingCard.type || "").toLowerCase().includes(t.toLowerCase()))) return;
      const effects = (ability.effects || []).map((e) => ({ ...e, attackerDefenderId: defenderId }));
      pushAbilityToStack(lobby, { sourceCard: c, controllerId: c.owner, label: ability.label, effects });
    });
  }
}

// "Whenever this creature deals combat damage to a PLAYER" (Hellkite Tyrant, Lord of the Void) --
// distinct from "attacks" (fires the instant attackers are declared, win or lose) and needs to know
// WHO was actually damaged, which fireTrigger's generic CARD_ABILITIES effects can't carry (a
// triggered ability goes onto the stack and may not resolve until well after resolveCombatDamage
// has already reset lobby.combat back to empty). Bypasses fireTrigger/queueTargetChoice entirely
// and bakes `dealtToPlayerId` directly into a cloned effects array instead -- same "bake the
// dynamic bit in at fire time" approach chooseTargetFor already uses for chosenTargetId.
function fireCombatDamageToPlayerTriggers(lobby, card, defenderId, amount) {
  if (!lobby.turn.started) return;
  getAutomatedAbilities(card.name, "combatDamageToPlayer").forEach((ability) => {
    if (ability.condition && !ability.condition(card)) return;
    const effects = (ability.effects || []).map((e) => ({ ...e, dealtToPlayerId: defenderId, dealtToPlayerAmount: amount }));
    // Warren Instigator -- "you may put a Goblin creature card from your hand onto the battlefield"
    // needs a real target choice, unlike every other self-only combatDamageToPlayer entry so far
    // (all of which go straight to the stack) -- purely additive, existing non-target entries are
    // completely unaffected since ability.requiresTarget is falsy for all of them.
    if (ability.requiresTarget) {
      // Same CR 603.3c auto-fizzle as fireTrigger's own handCard guard -- without this, dealing
      // combat damage with no matching card in hand would still queue an unanswerable prompt.
      if (ability.targetKind === "handCard") {
        const filter = ability.handTypeFilter || [];
        const hasMatch = Object.values(lobby.cards).some((c) => c.owner === card.owner && c.zoneType === "hand" && filter.some((t) => (c.type || "").toLowerCase().includes(t.toLowerCase())));
        if (!hasMatch) return;
      }
      queueTargetChoice(lobby, { controllerId: card.owner, sourceCard: card, label: ability.label, effects, targetKind: ability.targetKind, handTypeFilter: ability.handTypeFilter });
    } else {
      pushAbilityToStack(lobby, { sourceCard: card, controllerId: card.owner, label: ability.label, effects });
    }
  });
}
// Old Gnawbone / Zeriam, Golden Wind and similar -- "Whenever A CREATURE YOU CONTROL (optionally
// of a specific type) deals combat damage to a player, ..." Unlike fireCombatDamageToPlayerTriggers
// just above (which only ever checks the DEALING card's own name), the effect's real SOURCE here is
// a different, standing permanent reacting to ANY of its controller's creatures -- same "a standing
// permanent reacts to a different creature's event" shape fireGlobalOtherCreatureEtbTriggers already
// established for Terror of the Peaks/Dragon Tempest, just for combat damage instead of ETB. A new
// "anyCreatureCombatDamageToPlayer" trigger type (distinct from the self-only "combatDamageToPlayer"
// above) so existing self-only entries are never accidentally treated as global.
function fireGlobalCombatDamageToPlayerTrigger(lobby, dealingCard, defenderId, amount) {
  if (!lobby.turn.started) return;
  const dealingType = (dealingCard.type || "").toLowerCase();
  Object.values(lobby.cards).forEach((source) => {
    if (source.owner !== dealingCard.owner || source.zoneType === "hand" || source.zoneType === "stack") return;
    getAutomatedAbilities(source.name, "anyCreatureCombatDamageToPlayer").forEach((ability) => {
      if (ability.typeFilter && !ability.typeFilter.some((t) => dealingType.includes(t))) return;
      if (ability.condition && !ability.condition(source, lobby)) return;
      const effects = (ability.effects || []).map((e) => ({ ...e, dealtToPlayerId: defenderId, dealtToPlayerAmount: amount }));
      pushAbilityToStack(lobby, { sourceCard: source, controllerId: source.owner, label: ability.label, effects });
    });
  });
}
// Breath of Fury -- "When enchanted creature deals combat damage to a player, sacrifice it and
// attach this Aura to a creature you control. If you do, untap all creatures you control and
// after this phase, there is an additional combat phase." Not a CARD_ABILITIES entry keyed by the
// dealing creature's own name (this triggers off WHATEVER creature the Aura currently enchants,
// which changes every time it fires) -- a dedicated function that scans for the Aura by
// `attachedTo`, same "genuinely different trigger shape" precedent as fireLiesaReturnToHandTrigger/
// fireKardurDoomscourgeDeathTrigger. Called alongside fireCombatDamageToPlayerTriggers at both its
// call sites in resolveCombatDamage.
// Disclosed edge case: the actual sacrifice-and-reattach only runs once the player answers the
// queued choice below (see breathOfFuryReattach), which happens AFTER this same combat step's
// processDeaths() call. If the enchanted creature is ALSO lethally damaged by a blocker in the same
// exchange (mutual combat), processDeaths kills it first via the normal path, and
// breathOfFuryReattach then silently no-ops (sacrificedCardId no longer in lobby.cards) -- the
// trigger correctly fired, but the reattach/extra-combat half is lost for this narrow double-death
// case. The common cases (unblocked, or the enchanted creature survives its own combat) are
// unaffected.
function fireBreathOfFuryTrigger(lobby, attackerCard, defenderId, amount) {
  if (!lobby.turn.started) return;
  const aura = Object.values(lobby.cards).find((c) => c.attachedTo === attackerCard.id && archiveKey(c.name) === "breath of fury");
  if (!aura) return;
  const otherCreatures = Object.values(lobby.cards).some((c) => c.owner === aura.owner && c.zoneType === "creature" && c.id !== attackerCard.id);
  if (!otherCreatures) {
    // No legal creature to move the Aura to -- the sacrifice still happens (mandatory), but "if you
    // do" (the attach) fails, so untap/extra-combat never fires. The Aura falls off and heads to the
    // graveyard on its own via detachDependents, same as any Aura whose host leaves the battlefield.
    fireDeathTriggers(lobby, attackerCard);
    sendToGraveyardInternal(lobby, attackerCard);
    return;
  }
  queueTargetChoice(lobby, {
    controllerId: aura.owner, sourceCard: aura,
    label: `Breath of Fury — sacrifice ${attackerCard.name || "the enchanted creature"} and attach this Aura to a creature you control`,
    targetKind: "ownCreature", excludeCardId: attackerCard.id,
    effects: [{ type: "breathOfFuryReattach", sacrificedCardId: attackerCard.id, auraId: aura.id }]
  });
}

// Pops the top of the stack and resolves it: a triggered ability runs its effects; a permanent
// goes to the battlefield (identical placement logic to a normal cast --
// classifyType/entersTapped/controllerSince) and fires its own ETB triggers; instants and
// sorceries go to their controller's graveyard, since they have no permanent form. What a SPELL
// actually *does* is still adjudicated manually by the players -- only the narrow, hand-authored
// triggered abilities in CARD_ABILITIES are automated.
function resolveStackTop(lobby) {
  const item = lobby.stack.pop();
  if (!item) return;
  if (item.kind === "ability") {
    executeAbilityEffects(lobby, item);
    const owner = lobby.players[item.owner];
    if (owner) pushLog(lobby, `${owner.name}'s ${item.name} resolved`);
  } else {
    const card = item;
    const owner = lobby.players[card.owner];
    if (isInstantOrSorcery(card.type)) {
      // A target-requiring spell already had its target locked in at CAST time (see castSpell) --
      // the chosen target is baked into card._resolvedSpellEffects, so there's nothing left to
      // prompt for here. Falls back to the plain SPELL_ABILITIES effects for an untargeted spell.
      const effects = card._resolvedSpellEffects || (getSpellAbility(card.name) || {}).effects;
      if (effects) executeSpellEffectsNow(lobby, card, effects);
      // A handful of real cards (Teferi's Protection) exile themselves as part of resolving,
      // instead of the normal graveyard destination every other instant/sorcery uses.
      if ((getSpellAbility(card.name) || {}).exileInsteadOfGraveyard) exileCardInternal(lobby, card);
      else sendToGraveyardInternal(lobby, card);
      if (owner) pushLog(lobby, `${owner.name}'s ${card.name || "spell"} resolved`);
    } else {
      card.zoneType = classifyType(card.type);
      card.controllerSince = lobby.turn.started ? lobby.turn.turnNumber : 0;
      if (entersTapped(card, lobby)) card.tapped = true;
      broadcastCard(lobby, card);
      if (owner) pushLog(lobby, `${owner.name}'s ${card.name || "spell"} resolved onto the battlefield`);
      fireEtbTriggers(lobby, card);
    }
  }
  finishStackTail(lobby);
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
// again — clear the slot's battlefield reference so castCommander stops rejecting it. Uses
// originalOwner first: a stolen commander's battlefieldId lives in its TRUE owner's commander
// slot, not whoever currently controls it, so clearing via card.owner alone would leave that
// reference stale forever if the commander died while under someone else's control.
function clearCommanderRef(lobby, card) {
  const owner = lobby.players[card.originalOwner || card.owner];
  if (!owner || !card.isCommander) return;
  owner.commanders.forEach((c) => { if (c && c.battlefieldId === card.id) c.battlefieldId = null; });
}

// Real Commander tracks damage per COMMANDER, not per opponent -- partners can each independently
// reach the lethal 21. Keyed by owner+slot (not battlefieldId, which changes every time the
// commander leaves and re-enters play) so a damage total survives the commander dying/bouncing/
// being recast, matching the real rule that the total keeps counting regardless.
function commanderSlotKey(lobby, card) {
  if (!card.isCommander) return null;
  const owner = lobby.players[card.originalOwner || card.owner];
  if (!owner) return null;
  const slot = owner.commanders.findIndex((c) => c && c.battlefieldId === card.id);
  if (slot === -1) return null;
  return `${card.originalOwner || card.owner}:${slot}`;
}

// Equipment stays on the battlefield unattached when its host leaves; an aura has no legal host
// without one, so it goes to the graveyard too (a rough approximation of the real state-based
// action). Detected via type line since there's no structured "is this an aura" field.
function detachDependents(lobby, hostCard) {
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.attachedTo !== hostCard.id) continue;
    c.attachedTo = null;
    if ((c.type || "").toLowerCase().includes("aura")) {
      sendToGraveyardInternal(lobby, c);
    } else {
      broadcastCard(lobby, c);
    }
  }
}

// Parses "Equip {2}" / "Equip {1}{W}" from oracle text into a mana cost, or null if there isn't
// one (an Aura, or anything without a real equip cost -- attaching those is free).
function equipCostFromText(text) {
  const m = (text || "").match(/equip\s*((?:\{[^}]+\})+)/i);
  if (!m) return null;
  return parseManaCost(m[1]);
}

// Reanimation targeting (Reya Dawnbringer, Necromancy, Whip of Erebos) -- addresses a graveyard
// entry by the stable id toEntry() now preserves. Read-only lookup for validation
// (resolveChosenTarget); the find-AND-remove version below is for actually resolving the effect.
function findGraveyardEntry(lobby, entryId, typeFilter) {
  for (const pid in lobby.players) {
    const p = lobby.players[pid];
    const e = (p.graveyard || []).find((x) => x.id === entryId && (!typeFilter || (x.type || "").toLowerCase().includes(typeFilter)));
    if (e) return { entry: e, ownerId: pid };
  }
  return null;
}
function findAndRemoveGraveyardEntry(lobby, entryId) {
  for (const pid in lobby.players) {
    const p = lobby.players[pid];
    const idx = (p.graveyard || []).findIndex((x) => x.id === entryId);
    if (idx !== -1) {
      const [entry] = p.graveyard.splice(idx, 1);
      return { entry, ownerId: pid };
    }
  }
  return null;
}

// Liesa, Forgotten Archangel / Valgavoth, Terror Eater -- both read "if [some card] would die /
// be put into a graveyard, exile it instead," a real Magic replacement effect (CR 614) that
// intercepts a zone change BEFORE it happens rather than moving the card afterward. This app has
// no general replacement-effect layer, so this is scoped narrowly to the one shared shape both
// these cards need: checked once, at the single real choke point every "goes to graveyard" path
// already funnels through (sendToGraveyardInternal), same "one function, not every call site"
// precedent the commander-to-command-zone special case just below already established. Skips
// commanders (their owner already gets to choose the Command Zone instead, a strictly better
// outcome than exile that this app already automates -- not worth the added complexity of
// modeling a real choice between the two replacement effects).
const GRAVEYARD_REDIRECT_CREATURE_ONLY = ["liesa, forgotten archangel"];
const GRAVEYARD_REDIRECT_ANY_CARD = ["valgavoth, terror eater"];
function graveyardRedirectFor(lobby, card) {
  if (card.isCommander) return false;
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.zoneType === "hand" || c.zoneType === "stack" || c.owner === card.owner) continue;
    const key = archiveKey(c.name);
    // Liesa only redirects CREATURES; Valgavoth redirects any card type ("from anywhere").
    if (card.zoneType === "creature" && GRAVEYARD_REDIRECT_CREATURE_ONLY.includes(key)) return true;
    if (GRAVEYARD_REDIRECT_ANY_CARD.includes(key)) return true;
  }
  return false;
}
// Twinflame Tyrant / Gisela, Blade of Goldnight: both read "if a source you control would deal
// damage to an opponent (or their permanent), it deals double that damage instead" -- functionally
// identical CR 614 replacement effects, so one shared check covers both. Scoped to damage a PLAYER
// directly takes (combat hits/trample-over and targeted damage spells/abilities); doubling
// creature-vs-creature combat damage isn't modeled (would mean touching the multi-blocker damage-
// assignment loop's lethal-toughness math, a much higher-risk change for a less commonly relevant
// case) -- a disclosed narrowing, same precedent as every other scope-limited card in this engine.
const DAMAGE_DOUBLING_CARDS = ["twinflame tyrant", "gisela, blade of goldnight"];
function damageMultiplierFor(lobby, controllerId, sourceCard) {
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.owner !== controllerId || c.zoneType === "hand" || c.zoneType === "stack") continue;
    if (DAMAGE_DOUBLING_CARDS.includes(archiveKey(c.name))) return 2;
    // Neriv, Heart of the Storm -- "If a creature you control that entered this turn would deal
    // damage, it deals twice that much damage instead." Narrower than the flat controller-wide
    // doublers above: only applies when the actual damage SOURCE is a creature that entered THIS
    // turn (reuses controllerSince, same "entered this turn" check Hobgoblin Bandit Lord's own
    // effect already established), so it needs sourceCard threaded in, not just controllerId. A
    // non-creature source (a spell/ability's ctx.sourceCard) simply fails the zoneType check, no
    // false positive.
    if (sourceCard && sourceCard.zoneType === "creature" && sourceCard.controllerSince === lobby.turn.turnNumber
      && /if a creature you control that entered this turn would deal damage, it deals twice that much damage instead/i.test(c.text || "")) return 2;
  }
  return 1;
}
// Gisela, Blade of Goldnight's OTHER half -- "if a source would deal damage to you or a permanent
// you control, prevent half that damage, rounded up" -- i.e. the recipient only takes
// floor(amount/2). Keyed by the VICTIM's controller (the opposite direction from
// DAMAGE_DOUBLING_CARDS's "FROM its controller"), so it's a separate list/function even though
// Gisela happens to be on both. Same PLAYER-directed-only scope as the doubling half above (not
// creature-vs-creature combat damage) -- a disclosed narrowing, same precedent as everywhere else.
const SELF_DAMAGE_HALVING_CARDS = ["gisela, blade of goldnight"];
function reduceDamageForVictim(lobby, victimId, amount) {
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.owner === victimId && c.zoneType !== "hand" && c.zoneType !== "stack" && SELF_DAMAGE_HALVING_CARDS.includes(archiveKey(c.name))) return Math.floor(amount / 2);
  }
  return amount;
}
function sendToGraveyardInternal(lobby, card) {
  if (graveyardRedirectFor(lobby, card)) { exileCardInternal(lobby, card); return; }
  delete lobby.cards[card.id];
  if (lobby.targets[card.id]) delete lobby.targets[card.id];
  io.to(lobby.id).emit("cardRemove", card.id);
  clearCommanderRef(lobby, card);
  detachDependents(lobby, card);
  // A card's owner (where it goes when it leaves play) isn't necessarily who currently controls
  // it -- a permanent stolen via takeControl still belongs to whoever it was stolen from.
  const owner = lobby.players[card.originalOwner || card.owner];
  if (!owner) return;
  // Real Magic (CR 903.9a) lets a commander's owner move it to the Command Zone instead of any
  // other zone it would go to from the battlefield -- overwhelmingly the choice players actually
  // make (why one of Commander's defining rules exists at all), so this applies it automatically
  // rather than leaving the commander sitting in the graveyard with no obvious way back out.
  // clearCommanderRef just above already reset battlefieldId to null, so the Commander Zone dock
  // is already showing it as castable again -- this only decides whether a SEPARATE graveyard
  // entry also gets created, which would otherwise make it look stuck there even though it isn't.
  if (card.isCommander) {
    pushLog(lobby, `${owner.name}'s ${card.name || "commander"} returned to the Command Zone`);
    return;
  }
  owner.graveyard.push(toEntry(card));
}

// Same shape as sendToGraveyardInternal, for exileTarget -- kept as its own top-level function
// (rather than calling the socket-closure-scoped moveOut) since it needs to be callable from
// EFFECTS, which is defined outside any single connection's closure.
function exileCardInternal(lobby, card) {
  delete lobby.cards[card.id];
  if (lobby.targets[card.id]) delete lobby.targets[card.id];
  io.to(lobby.id).emit("cardRemove", card.id);
  clearCommanderRef(lobby, card);
  detachDependents(lobby, card);
  const owner = lobby.players[card.originalOwner || card.owner];
  if (!owner) return;
  // Same Command Zone replacement as sendToGraveyardInternal -- see its comment for why.
  if (card.isCommander) {
    pushLog(lobby, `${owner.name}'s ${card.name || "commander"} returned to the Command Zone`);
    return;
  }
  owner.exile.push(toEntry(card));
}

// Bounce returns to the card's true OWNER's hand (not necessarily its current controller -- a
// stolen permanent goes back to whoever it was taken from), same originalOwner-first convention
// as graveyard/exile.
function bounceCardToHandInternal(lobby, card) {
  const ownerId = card.originalOwner || card.owner;
  const owner = lobby.players[ownerId];
  delete lobby.cards[card.id];
  if (lobby.targets[card.id]) delete lobby.targets[card.id];
  io.to(lobby.id).emit("cardRemove", card.id);
  clearCommanderRef(lobby, card);
  detachDependents(lobby, card);
  if (!owner) return;
  spawnBattlefieldCard(lobby, {
    name: card.name, img: card.img, type: card.type, manaCost: card.manaCost, cmc: card.cmc,
    colors: card.colors, colorIdentity: card.colorIdentity, power: card.power, toughness: card.toughness,
    loyalty: card.loyalty, text: card.text, keywords: card.keywords, producedMana: card.producedMana,
    owner: ownerId, faceDown: true, zoneType: "hand"
  });
}

// ---------------- turn engine ----------------

// Untap/Upkeep/Draw never require a decision of their own (draw already happens automatically),
// and Combat is skipped too when the active player has no creature to attack with -- no need to
// make them click through three no-op phases (or an empty combat) every single turn. Stops short
// the instant something lands on the stack (an upkeep trigger firing mid-Upkeep, say) -- advancing
// straight through to Main 1 anyway would leave a real triggered ability stranded unresolved while
// the phase indicator claims the table's already past it, and the priority UI wouldn't even be
// showing yet to prompt for it.
function shouldAutoAdvance(lobby) {
  const turn = lobby.turn;
  if (!turn.started || turn.order.length === 0) return false;
  if (lobby.stack.length > 0) return false;
  if (turn.phase === "Untap" || turn.phase === "Upkeep" || turn.phase === "Draw") return true;
  if (turn.phase === "Combat") {
    const activeId = turn.order[turn.activeIndex];
    return !Object.values(lobby.cards).some((c) => c.owner === activeId && c.zoneType === "creature");
  }
  return false;
}

function advancePhase(lobby) {
  advanceOnePhase(lobby);
  while (shouldAutoAdvance(lobby)) advanceOnePhase(lobby);
}

// CR 800.4a: when a player leaves the game (concedes, is eliminated by life/damage, or disconnects)
// DURING THEIR OWN TURN, that turn simply ends right there and the next player begins a full fresh
// turn at Untap -- not "the same phase, just now attributed to someone else." Before this existed,
// spliceFromTurnOrder correctly slid the next player into the departing player's activeIndex slot,
// but left turn.phase exactly where it was -- so the new active player got dropped straight into
// whatever phase the game happened to be in (Main 2, say) with their lands never untapped, no card
// drawn, and landsPlayedThisTurn/attackedThisTurn never reset. Reported as "on concede, next
// player's untap doesn't trigger."
// Reuses advanceOnePhase's own turn-wraparound branch instead of duplicating its logic:
// pre-decrementing activeIndex here means that branch's own "+1 % length" lands back on the
// player spliceFromTurnOrder already correctly positioned, so setting phase to "End Step" and
// calling advancePhase (the exact same helper every normal turn transition already uses) produces
// a real, fully normal new-turn transition, auto-skipping Untap/Upkeep/Draw exactly like any other
// turn start.
function forceEndOfTurnForElimination(lobby) {
  const turn = lobby.turn;
  if (!turn.started || turn.order.length === 0) return;
  turn.activeIndex = (turn.activeIndex - 1 + turn.order.length) % turn.order.length;
  turn.phase = "End Step";
  advancePhase(lobby);
}

// Turn 1's Untap/Upkeep/Draw auto-advance (see advanceOnePhase's Draw-phase comment for why the
// player going first draws too, a deliberate house-rule departure from real Magic) used to run
// synchronously inside startGame itself, before anyone had even seen the Opening Hand prompt --
// the very first player's turn-1 draw landed in their hand, then the moment they clicked "Draw 7"
  // for their actual opening hand, returnAllHandToLibrary wiped that already-drawn card straight back
  // into the library along with it, which looked exactly like the game silently deleting a card.
// Called from keepHand every time a player finishes their opening hand, so it fires exactly once,
// right as the LAST player keeps theirs -- everyone's opening 7 is settled before turn 1 actually
// starts moving, same order real Magic uses.
function beginTurnFlowOnceHandsReady(lobby) {
  if (!lobby.turn.started || lobby.turn.turnNumber !== 1 || lobby.turn.phase !== "Untap") return;
  if (!Object.values(lobby.players).every((p) => p.handKept)) return;
  while (shouldAutoAdvance(lobby)) advanceOnePhase(lobby);
  broadcastTurn(lobby);
  broadcastCombat(lobby);
  broadcastPlayers(lobby);
}

function advanceOnePhase(lobby) {
  const turn = lobby.turn;
  if (!turn.started || turn.order.length === 0) return;
  clearAllUndo(lobby); // a new phase is a real "everyone's had a chance to see this" boundary
  const oldPhase = turn.phase;
  let idx = PHASES.indexOf(turn.phase);
  // An extra combat phase (Aurelia, Combat Celebrant, ...) re-enters Combat instead of advancing
  // to Main 2 -- the one place phase-to-phase movement actually happens, rather than teaching
  // every call site about it. turn.extraCombatsPending is reset to 0 every time a real new turn
  // starts (the idx>=PHASES.length branch below), so it can never leak into a later turn.
  if (oldPhase === "Combat" && (turn.extraCombatsPending || 0) > 0) {
    turn.extraCombatsPending--;
    idx = PHASES.indexOf("Combat");
  } else {
    idx++;
  }
  if (idx >= PHASES.length) {
    idx = 0;
    turn.activeIndex = (turn.activeIndex + 1) % turn.order.length;
    turn.turnNumber++;
    turn.extraCombatsPending = 0;
    // Ledger Shredder -- "whenever a player casts THEIR second spell EACH TURN" counts against one
    // shared game turn (any player's spells, incl. instants cast on someone else's turn), so this
    // resets for EVERY player here at the one real turn-wraparound point, not just the newly active
    // player -- a per-player-own-turn reset would silently undercount instants cast off-turn.
    Object.values(lobby.players).forEach((p) => { p.spellsCastThisTurn = 0; });
    cleanupTemporaryKeywords(lobby);
    // Kardur, Doomscourge -- "until your next turn" ends exactly when the new active player IS
    // that Kardur's own controller (their next turn has now begun).
    const newActiveId = turn.order[turn.activeIndex];
    if (lobby.kardurForcedAttackControllers && lobby.kardurForcedAttackControllers.includes(newActiveId)) {
      lobby.kardurForcedAttackControllers = lobby.kardurForcedAttackControllers.filter((id) => id !== newActiveId);
    }
  }
  turn.phase = PHASES[idx];
  turn.phaseStartedAt = Date.now(); // purely informational -- drives a passive client-side "how long has this phase been going" indicator, never used to auto-act for anyone
  const activeId = turn.order[turn.activeIndex];
  const activePlayer = lobby.players[activeId];

  // "At the beginning of the next end step" (Hellkite Courser, Whip of Erebos, Liesa) and similar
  // ONE-SHOT delayed triggers -- distinct from fireGlobalTrigger's "upkeep"/"endStep" (which fire
  // EVERY occurrence of that phase, forever): a delayed trigger fires exactly once, on the very
  // next occurrence of its target phase after being queued (whoever's turn it happens to be, same
  // as the real "the next end step" wording -- not necessarily the queuing player's own), then
  // removes itself. See queueDelayedTrigger.
  if (lobby.delayedTriggers && lobby.delayedTriggers.length) {
    const due = lobby.delayedTriggers.filter((dt) => dt.firesAtPhase === turn.phase);
    if (due.length) {
      lobby.delayedTriggers = lobby.delayedTriggers.filter((dt) => dt.firesAtPhase !== turn.phase);
      // A departing player's own delayed trigger is simply dropped -- nowhere sensible to resolve
      // it, same "discard rather than error" precedent discardPendingTargetChoices already follows.
      due.filter((dt) => lobby.players[dt.controllerId]).forEach((dt) => pushAbilityToStack(lobby, { sourceCard: dt.sourceCard, controllerId: dt.controllerId, label: dt.label, effects: dt.effects }));
    }
  }

  for (const pid in lobby.players) lobby.players[pid].mana = EMPTY_MANA(); // mana empties every step/phase

  if (oldPhase === "Combat" && turn.phase !== "Combat") {
    lobby.combat = { step: "none", attackers: {}, blocks: {}, defendersPending: [] };
  }
  if (turn.phase === "Combat") {
    lobby.combat = { step: "declareAttackers", attackers: {}, blocks: {}, defendersPending: [] };
  }
  // "At the beginning of combat on your turn" triggers (Howlsquad Heavy) -- same reuse of
  // fireGlobalTrigger as Upkeep/End Step below, just keyed to the Combat phase itself.
  if (activePlayer && turn.phase === "Combat") fireGlobalTrigger(lobby, "beginningOfCombat", activeId);
  // Sting, the Glinting Dagger -- "At the beginning of EACH combat, untap equipped creature." Unlike
  // Howlsquad Heavy just above (scoped to the active player's own turn via fireGlobalTrigger), this
  // fires regardless of whose turn it is, and isn't a real target-choosing/stack-pushing trigger at
  // all -- a direct text-scan sweep is simpler than inventing a whole new "any player's combat"
  // CARD_ABILITIES trigger scope for one card.
  if (turn.phase === "Combat") checkStingUntapEquippedCreature(lobby);

  if (activePlayer && turn.phase === "Untap") {
    activePlayer.landsPlayedThisTurn = 0;
    activePlayer.attackedThisTurn = false; // Raid (Searslicer Goblin and its functional cousins)
    // Teferi's Protection -- "until your next turn" and phased-out permanents both resolve right
    // here: permanents phase back in "before you untap during your untap step" (CR 702.26e), so
    // this runs BEFORE the untap loop below, letting that same loop untap anything that phases back
    // in tapped exactly as if it had been on the battlefield the whole time.
    if (activePlayer.phasedOut && activePlayer.phasedOut.length) {
      activePlayer.phasedOut.forEach((c) => { lobby.cards[c.id] = c; broadcastCard(lobby, c); });
      pushLog(lobby, `${activePlayer.name}'s permanents phase back in`);
      activePlayer.phasedOut = [];
    }
    activePlayer.lifeLocked = false;
    activePlayer.protectionFromEverything = false;
    for (const id in lobby.cards) {
      if (lobby.cards[id].owner === activeId && lobby.cards[id].tapped) {
        lobby.cards[id].tapped = false;
        broadcastCard(lobby, lobby.cards[id]);
      }
    }
  }
  // "At the beginning of your upkeep" triggers -- reuses fireGlobalTrigger exactly as it already
  // scans a player's own permanents for aristocrats-style non-self-referential triggers; an upkeep
  // trigger is likewise "whoever's upkeep this is", not about the source card's own history.
  if (activePlayer && turn.phase === "Upkeep") fireGlobalTrigger(lobby, "upkeep", activeId);
  // "At the beginning of your end step" triggers -- same reuse of fireGlobalTrigger as Upkeep above.
  if (activePlayer && turn.phase === "End Step") fireGlobalTrigger(lobby, "endStep", activeId);
  // Real Magic has the player going first skip their very first draw step -- deliberately NOT
  // followed here per an explicit house-rule request: everyone draws for the turn, including
  // whoever's turn 1 it is.
  if (activePlayer && turn.phase === "Draw") {
    const drew = drawN(lobby, activeId, 1);
    if (drew) pushLog(lobby, `${activePlayer.name} drew a card for the turn`);
  }
  broadcastTurn(lobby);
  broadcastCombat(lobby);
  broadcastPlayers(lobby);
  if (activePlayer) pushLog(lobby, `${activePlayer.name} — ${turn.phase}${turn.phase === "Untap" ? ` (Turn ${turn.turnNumber})` : ""}`);
}

// Combat damage in two sub-steps (first strike/double strike, then everyone else) so first strike
// actually does what it's for -- a first-strike creature that kills its blocker in the first
// sub-step never takes damage back, since the blocker is already dead before the normal sub-step
// runs. `marked` accumulates damage across both sub-steps per card (this function's own local
// state, not stored on the card -- matches this app's existing "damage is computed fresh each
// combat, never persisted" model) so a first-strike hit correctly counts toward lethal/trample math
// for a creature that then also takes normal-step damage (e.g. from a double-striker on either side).
function resolveCombatDamage(lobby) {
  const combat = lobby.combat;
  const dmgEvents = []; // purely for client-side damage-number animation, no gameplay effect
  const marked = {}; // cardId -> cumulative damage marked this combat
  const deathtouchHit = new Set(); // cardIds that have taken ANY damage from a deathtouch source this combat
  // Lifelink: applied at every point actual damage gets dealt below (attacker->blocker, trample
  // overflow->player, blocker->attacker, unblocked->player) via the shared applyLifeGain hook, same
  // as any other life gain in this app -- so a lifelinker's controller's OWN selfGainsLife triggers
  // (if any) correctly fire off combat damage too, not just spells/abilities that explicitly gain life.

  function hasKw(card, kw) {
    return effectiveKeywords(lobby, card).some((k) => (k || "").toLowerCase() === kw);
  }
  // Kor Haven -- "Prevent all combat damage that would be dealt by target attacking creature this
  // turn." Only zeroes the damage THIS creature deals (not damage dealt TO it, and not other
  // creatures it's paired with), so it's checked at each of the three points a creature's own power
  // actually turns into dealt damage below, rather than as a global combat-wide flag.
  function dealingPower(card) {
    return card.preventCombatDamageUntilEndOfTurn ? 0 : effPT(card).power;
  }
  function effPT(card) {
    const bonus = attachedBonusFor(lobby, card);
    const stat = staticBonusFor(lobby, card);
    return {
      power: parsePT(card.power) + (card.counters || 0) + bonus.powerBonus + stat.powerBonus,
      toughness: parsePT(card.toughness) + (card.counters || 0) + bonus.toughnessBonus + stat.toughnessBonus
    };
  }
  // How much MORE damage `card` needs to be considered lethally damaged, from here. Deathtouch
  // (either already-marked from an earlier sub-step, or being dealt right now) makes any nonzero
  // amount enough -- CR 702.2c, "even a single point of damage is enough."
  function remainingToKill(card, dealingDeathtouch) {
    const already = marked[card.id] || 0;
    if (dealingDeathtouch || deathtouchHit.has(card.id)) return already > 0 ? 0 : 1;
    return Math.max(0, effPT(card).toughness - already);
  }
  function markDamage(card, amount, isDeathtouch) {
    if (amount <= 0) return;
    marked[card.id] = (marked[card.id] || 0) + amount;
    if (isDeathtouch) deathtouchHit.add(card.id);
    dmgEvents.push({ targetId: card.id, amount });
  }
  function dealtLethal(card, dealtByDeathtouch) {
    // CR 702.12b: lethal damage doesn't destroy an indestructible permanent. This keyword was
    // previously only ever an icon badge -- present in KNOWN_KEYWORDS and shown on cards, but never
    // actually checked anywhere combat/destruction happens, so it did nothing.
    if (effectiveKeywords(lobby, card).some((k) => (k || "").toLowerCase() === "indestructible")) return false;
    if (dealtByDeathtouch || deathtouchHit.has(card.id)) return (marked[card.id] || 0) > 0;
    return (marked[card.id] || 0) >= effPT(card).toughness;
  }
  function processDeaths() {
    for (const id in marked) {
      const card = lobby.cards[id];
      if (!card || !dealtLethal(card, false)) continue;
      // Regeneration (CR 701.16) -- a shield consumed here instead of dying, tapped and (since this
      // app never persists combat damage past one resolution pass anyway -- `marked` is local to
      // this closure) implicitly "damage removed" for free, matching the real effect's full text
      // without needing to track it separately.
      if (card.regenerationShield > 0) {
        card.regenerationShield -= 1;
        card.tapped = true;
        broadcastCard(lobby, card);
        pushLog(lobby, `${card.name || "A creature"} regenerates instead of dying`);
        continue;
      }
      fireDeathTriggers(lobby, card); sendToGraveyardInternal(lobby, card);
    }
  }

  const pairs = Object.entries(combat.attackers)
    .map(([attackerId, defenderId]) => ({ attackerId, defenderId, blockerIds: combat.blocks[attackerId] || [] }))
    .filter((p) => lobby.cards[p.attackerId]);

  function dealStepDamage(isFirstStrikeStep) {
    for (const { attackerId, defenderId, blockerIds } of pairs) {
      const attacker = lobby.cards[attackerId];
      if (!attacker) continue; // died in an earlier sub-step
      const atkFS = hasKw(attacker, "first strike"), atkDS = hasKw(attacker, "double strike");
      const attackerActs = isFirstStrikeStep ? (atkFS || atkDS) : (!atkFS || atkDS);
      const blockers = blockerIds.map((id) => lobby.cards[id]).filter(Boolean); // drop any that died in an earlier sub-step

      if (blockers.length > 0) {
        if (attackerActs) {
          const atkPower = dealingPower(attacker);
          const atkDeathtouch = hasKw(attacker, "deathtouch");
          const atkTrample = hasKw(attacker, "trample");
          if (atkPower > 0) {
            // CR 510.1c: at least lethal to each blocker in order before the next gets any: without
            // trample the LAST blocker just soaks whatever's left (nowhere else for it to go); with
            // trample only the true leftover after every blocker has lethal spills to the player.
            // The order itself is simplified to declaration order rather than a separate
            // player-chosen damage-assignment-order UI -- only matters when multiple blockers are
            // involved (Menace, or a deliberate double-block), the less common case.
            let remaining = atkPower;
            blockers.forEach((blocker, i) => {
              if (remaining <= 0) return;
              const isLast = i === blockers.length - 1;
              const toThis = (isLast && !atkTrample) ? remaining : Math.min(remaining, remainingToKill(blocker, atkDeathtouch));
              markDamage(blocker, toThis, atkDeathtouch);
              remaining -= toThis;
            });
            const toPlayerBase = atkTrample ? remaining : 0;
            const toPlayer = reduceDamageForVictim(lobby, defenderId, toPlayerBase * damageMultiplierFor(lobby, attacker.owner, attacker));
            if (toPlayer > 0) {
              const defender = lobby.players[defenderId];
              // Teferi's Protection -- see the non-trample branch below for why the whole event is
              // skipped rather than just zeroing the life change.
              if (defender && !defender.protectionFromEverything) {
                // CR 702.90c -- infect converts combat damage to a PLAYER into that many poison
                // counters instead of life loss. Creature-vs-creature infect damage (-1/-1 counters
                // instead of marked damage) is NOT modeled -- falls back to normal lethal-toughness
                // marked damage against a blocker, a disclosed simplification; poisoning opponents
                // is infect's primary win condition and the part worth having.
                const tookIt = hasKw(attacker, "infect") ? (defender.poison = (defender.poison || 0) + toPlayer, true) : applyLifeLoss(lobby, defenderId, toPlayer, attacker.id);
                if (tookIt) {
                  dmgEvents.push({ targetId: defenderId, amount: toPlayer });
                  pushLog(lobby, `${attacker.name || "A face-down creature"} tramples ${toPlayer} over to ${defender.name}${hasKw(attacker, "infect") ? " (poison)" : ""}`);
                  fireCombatDamageToPlayerTriggers(lobby, attacker, defenderId, toPlayer);
                  fireGlobalCombatDamageToPlayerTrigger(lobby, attacker, defenderId, toPlayer);
                  fireBreathOfFuryTrigger(lobby, attacker, defenderId, toPlayer);
                  checkEquipmentCombatDamageDraw(lobby, attacker);
                  checkEquipmentCombatDamageCounters(lobby, attacker, toPlayer);
                  checkEquipmentCombatDamageTreasure(lobby, attacker, toPlayer);
                }
              }
            }
            if (hasKw(attacker, "lifelink")) applyLifeGain(lobby, attacker.owner, atkPower);
          }
        }
        let anyBlockerActed = false;
        blockers.forEach((blocker) => {
          const blkFS = hasKw(blocker, "first strike"), blkDS = hasKw(blocker, "double strike");
          const blockerActs = isFirstStrikeStep ? (blkFS || blkDS) : (!blkFS || blkDS);
          if (blockerActs && lobby.cards[blocker.id]) {
            anyBlockerActed = true;
            const defPower = dealingPower(blocker);
            markDamage(attacker, defPower, hasKw(blocker, "deathtouch"));
            if (defPower > 0 && hasKw(blocker, "lifelink")) applyLifeGain(lobby, blocker.owner, defPower);
          }
        });
        if (attackerActs || anyBlockerActed) {
          const atkAfter = effPT(attacker);
          const blockerDesc = blockers.map((b) => { const bpt = effPT(b); return `${b.name || "a face-down creature"} (${bpt.power}/${bpt.toughness})`; }).join(" and ");
          pushLog(lobby, `${attacker.name || "A face-down creature"} (${atkAfter.power}/${atkAfter.toughness}) fights ${blockerDesc}`);
        }
      } else if (attackerActs && archiveKey(attacker.name) === "master of cruelties") {
        // "Whenever this creature attacks a player and isn't blocked, that player's life total
        // becomes 1. This creature assigns no combat damage this combat" -- a life-total-SET
        // effect, not damage (so no lifelink/cmdr-damage/dmgEvents/combatDamageToPlayer trigger --
        // real Magic is explicit this creature deals no combat damage at all this combat).
        const defender = lobby.players[defenderId];
        if (defender && defender.life > 1 && !defender.lifeLocked) {
          defender.life = 1;
          pushLog(lobby, `${attacker.name} sets ${defender.name}'s life total to 1`);
        }
      } else if (attackerActs) {
        const atkPower = dealingPower(attacker);
        const defender = lobby.players[defenderId];
        // Teferi's Protection -- "protection from everything" means no source can deal this player
        // damage at all (CR 702.16e), not just that their life total happens not to move -- skip the
        // whole damage event (no poison, no commander-damage tracking either) rather than just
        // zeroing the life change.
        if (defender && atkPower > 0 && !defender.protectionFromEverything) {
          const dealt = reduceDamageForVictim(lobby, defenderId, atkPower * damageMultiplierFor(lobby, attacker.owner, attacker));
          // Deflecting Palm only intercepts real life loss -- infect's poison-counter conversion
          // (CR 702.90c) isn't a life change at all, so it's never redirectable and always lands.
          const tookIt = hasKw(attacker, "infect") ? (defender.poison = (defender.poison || 0) + dealt, true) : applyLifeLoss(lobby, defenderId, dealt, attacker.id);
          // A fully-redirected hit (Deflecting Palm) means this attacker never actually dealt ITS
          // defender any damage -- no commander-damage tracking, no lifelink, no
          // combat-damage-to-player trigger for a hit that didn't land.
          if (tookIt) {
            if (attacker.isCommander) {
              defender.cmdr = (defender.cmdr || 0) + dealt; // kept as the quick-glance total
              const key = commanderSlotKey(lobby, attacker);
              if (key) {
                if (!defender.cmdrDamage) defender.cmdrDamage = {};
                defender.cmdrDamage[key] = (defender.cmdrDamage[key] || 0) + dealt;
              }
            }
            pushLog(lobby, `${attacker.name || "A face-down creature"} hits ${defender.name} for ${dealt}${hasKw(attacker, "infect") ? " (poison)" : ""}`);
            dmgEvents.push({ targetId: defenderId, amount: dealt });
            if (hasKw(attacker, "lifelink")) applyLifeGain(lobby, attacker.owner, dealt);
            fireCombatDamageToPlayerTriggers(lobby, attacker, defenderId, dealt);
            fireGlobalCombatDamageToPlayerTrigger(lobby, attacker, defenderId, dealt);
            fireBreathOfFuryTrigger(lobby, attacker, defenderId, dealt);
            checkEquipmentCombatDamageDraw(lobby, attacker);
            checkEquipmentCombatDamageCounters(lobby, attacker, dealt);
            checkEquipmentCombatDamageTreasure(lobby, attacker, dealt);
          }
        }
      }
    }
  }

  dealStepDamage(true); // first strike / double strike
  processDeaths(); // a creature killed in the first-strike step never deals its normal-step damage
  dealStepDamage(false); // everyone else (and double strikers again)
  processDeaths();

  lobby.combat = { step: "none", attackers: {}, blocks: {}, defendersPending: [] };
  if (dmgEvents.length) io.to(lobby.id).emit("combatDamage", dmgEvents);
  broadcastCombat(lobby);
  checkEliminations(lobby);
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
      headers: { "Content-Type": "application/json", "User-Agent": "Archon/1.0" },
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
  if (UNSAFE_OBJECT_KEYS.has(username)) return res.json({ success: false, error: "That username isn't allowed." });
  if (password.length < 4) return res.json({ success: false, error: "Password must be at least 4 characters." });
  // Fresh from disk, not the long-lived in-memory copy -- the separate admin panel writes directly
  // to users.json (see admin-server.js), so a username an admin just deleted needs to read as
  // available again without waiting for this process to restart.
  users = loadJSON(USERS_FILE, users);
  if (users[username]) return res.json({ success: false, error: "That username is already taken." });
  const salt = crypto.randomBytes(16).toString("hex");
  // approved:false -- brand new accounts wait for admin approval before they can actually log in
  // (see /api/login below). No session token is issued here anymore; there's nothing to log into yet.
  users[username] = { salt, hash: hashPassword(password, salt), approved: false, sessionVersion: 0, createdAt: Date.now() };
  saveUsers();
  notifyNewAccountPending(username);
  res.json({ success: true, pending: true, message: "Account created. An admin needs to approve it before you can log in." });
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username) return res.json({ success: false, error: "Incorrect username or password." });
  if (isLockedOut(username)) return res.json({ success: false, error: "Too many failed attempts. Try again in a few minutes." });
  // Fresh from disk -- same cross-process-freshness reasoning as /api/register above, but here it's
  // specifically so an admin's just-clicked Approve is honored on the very next login attempt,
  // not whenever this process happens to restart.
  users = loadJSON(USERS_FILE, users);
  const u = users[username];
  if (!u || !verifyPassword(password || "", u.salt, u.hash)) {
    recordFailedLogin(username);
    return res.json({ success: false, error: "Incorrect username or password." });
  }
  if (!u.approved) return res.json({ success: false, error: "Your account is still waiting on admin approval." });
  clearFailedLogins(username);
  res.json({ success: true, token: issueSession(username), username });
});

app.post("/api/changePassword", (req, res) => {
  const { token, currentPassword, newPassword } = req.body || {};
  const username = sessionUsername(token);
  if (!username) return res.json({ success: false, error: "Not authenticated." });
  const u = users[username];
  if (!u || !verifyPassword(currentPassword || "", u.salt, u.hash)) {
    return res.json({ success: false, error: "Current password is incorrect." });
  }
  if (!newPassword || newPassword.length < 4) return res.json({ success: false, error: "New password must be at least 4 characters." });
  const salt = crypto.randomBytes(16).toString("hex");
  u.salt = salt;
  u.hash = hashPassword(newPassword, salt);
  // Bumping this invalidates every session issued before now -- including this very request's own
  // token, and any other device/browser logged in as this account. A fresh login is required
  // afterward, same as changing your password anywhere else usually behaves.
  u.sessionVersion = (u.sessionVersion || 0) + 1;
  saveUsers();
  res.json({ success: true, reauthRequired: true });
});

app.post("/api/spawn", async (req, res) => {
  try {
    const name = req.body.name || "";
    const cached = cardArchive[archiveKey(name)];
    if (cached) return res.json({ success: true, ...cached });
    const url = "https://api.scryfall.com/cards/named?fuzzy=" + encodeURIComponent(name);
    const r = await fetch(url, { headers: { "User-Agent": "Archon/1.0", "Accept": "application/json" } });
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

// Live art picker for Create Token -- "get all of the card art for each one and allow a selection."
// Unlike DEFAULT_TOKEN_ART (a fixed 5-per-name table used only as an automatic fallback when the
// player leaves Art blank entirely), this is a genuine live Scryfall search, so it works for ANY
// token name typed in the form, not just the quick-preset list -- that list is scoped to a fixed
// set of buttons for UI reasons, but "every possible token" is only actually achievable through a
// live lookup like this one, which needs no hardcoded name list at all.
// `kind` narrows the search to the right permanent type (a "Treasure" search with no type filter
// could otherwise surface an unrelated card that merely mentions the word) -- derived client-side
// from the token's own type line, same classifyType-style bucketing used everywhere else in this
// app (creature / artifact / enchantment, or omitted to search unrestricted).
app.get("/api/tokenArt", async (req, res) => {
  try {
    const name = (req.query.name || "").replace(/"/g, "").trim().slice(0, 100);
    if (!name) return res.json({ success: true, options: [] });
    const kind = (req.query.kind || "").toLowerCase();
    const typeClause = ["creature", "artifact", "enchantment"].includes(kind) ? ` type:${kind}` : "";
    const q = `is:token !"${name}"${typeClause}`;
    const url = "https://api.scryfall.com/cards/search?q=" + encodeURIComponent(q) + "&unique=art&order=released";
    const r = await fetch(url, { headers: { "User-Agent": "Archon/1.0", "Accept": "application/json" } });
    const json = await r.json();
    // Scryfall returns a 404 "error" object (not a thrown exception) when nothing matches a search
    // -- code "not_found" is a real, expected outcome (an obscure or made-up token name), not a
    // failure worth logging. Any OTHER error object (rate-limited, malformed query, etc.) is a real
    // failure -- surfaced as success:false so the client shows "couldn't reach Scryfall" instead of
    // incorrectly claiming this token genuinely has no art.
    if (json.object === "error") {
      if (json.code === "not_found") return res.json({ success: true, options: [] });
      return res.json({ success: false, options: [] });
    }
    // Double-faced tokens carry their art under card_faces instead of a top-level image_uris --
    // skipped rather than specially handled, same "narrow to the common case" precedent as
    // everywhere else art gets pulled from Scryfall in this app.
    const options = (json.data || [])
      .filter((c) => c.image_uris && c.image_uris.normal)
      .slice(0, 30)
      .map((c) => ({ id: c.id, img: c.image_uris.normal, set: c.set_name || "" }));
    res.json({ success: true, options });
  } catch (e) {
    res.json({ success: false, options: [] });
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
  if (!sessionUsername(token)) return res.status(401).json({ error: "Not authenticated" });
  const servers = [{ urls: "stun:stun.l.google.com:19302" }];
  if (process.env.TURN_URL) {
    servers.push({ urls: process.env.TURN_URL, username: process.env.TURN_USERNAME || undefined, credential: process.env.TURN_PASSWORD || undefined });
  }
  res.json({ iceServers: servers });
});

// Personal export, deliberately restricted to exactly one account ("wingus") -- not a general
// user-data-export feature, just a way to pull real card data out of this app and into a file that
// can be handed to a future session, to find real cards actually being played that aren't automated
// yet in CARD_ABILITIES/SPELL_ABILITIES. The username check is the actual security boundary
// (client-side button visibility is just so nobody else even sees it) -- every other account gets
// a plain 403, same as an unauthenticated request would.
// Deliberately server-wide, not just the requester's own decks -- `decks` (every account's saved
// decks, same {commanders, library} shape toEntry() produces) and `cardArchive` (lowercase card
// name -> full Scryfall-derived data, populated by /api/spawn every time ANY player has ever looked
// up a real card, whether or not it ended up in a saved deck -- broader coverage than decks alone).
// Deliberately excludes `users` (would mean shipping password hashes/session data) and saved board
// mats/pile art/avatars (irrelevant to card automation).
app.get("/api/export", (req, res) => {
  const token = req.query.token;
  const requestingUsername = sessionUsername(token);
  if (!requestingUsername) return res.status(401).json({ error: "Not authenticated" });
  if (requestingUsername !== "wingus") return res.status(403).json({ error: "This export is only available on the wingus account." });
  const payload = {
    exportedAt: new Date().toISOString(),
    requestedBy: requestingUsername,
    decksByAccount: decks,
    cardArchive
  };
  res.setHeader("Content-Disposition", `attachment; filename="archon-export-${Date.now()}.json"`);
  res.json(payload);
});

// Board mat / avatar image uploads, an alternative to pasting a URL (both feed the exact same
// boardMat/avatar string fields -- this just fills that field in for you instead of replacing it).
const UPLOAD_MIME_EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    // Never trust the client-supplied original filename -- a random name sidesteps any path-
    // traversal/overwrite concern entirely, same spirit as everywhere else in this app that treats
    // client input as untrusted.
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString("hex") + (UPLOAD_MIME_EXT[file.mimetype] || ""))
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB -- generous for a board mat/avatar, not for abuse
  fileFilter: (req, file, cb) => cb(null, !!UPLOAD_MIME_EXT[file.mimetype])
});
app.post("/api/upload", (req, res) => {
  // Same auth gate as /api/iceServers -- an open upload endpoint on an internet-reachable app
  // would let anyone who finds the URL fill up disk with arbitrary files, not just pod members.
  const token = req.query.token;
  if (!sessionUsername(token)) return res.status(401).json({ success: false, error: "Not authenticated" });
  upload.single("file")(req, res, (err) => {
    if (err) return res.json({ success: false, error: err.code === "LIMIT_FILE_SIZE" ? "File too large (5MB max)." : "Upload failed." });
    if (!req.file) return res.json({ success: false, error: "Only PNG, JPG, WEBP, or GIF images are supported." });
    res.json({ success: true, url: "/uploads/" + req.file.filename });
  });
});

// ---------------- Socket.IO ----------------

io.on("connection", (socket) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const username = sessionUsername(token);
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
  socket.emit("authOk", {
    username, decks: Object.keys(decks[username] || {}),
    mats: mats[username] || {},
    pileMats: pileMats[username] || {},
    avatar: (users[username] && users[username].avatar) || null,
    defaultName: (users[username] && users[username].defaultName) || null,
    defaultBoardMat: (users[username] && users[username].defaultBoardMat) || null,
    defaultPileArt: (users[username] && users[username].defaultPileArt) || null,
    defaultCursorColor: (users[username] && users[username].defaultCursorColor) || null,
    defaultCursorIcon: (users[username] && users[username].defaultCursorIcon) || null,
    defaultCursorIconFit: (users[username] && users[username].defaultCursorIconFit) || null,
    automatedCardNames: getAllAutomatedCardNames(),
    collection: collection[username] || {}
  });

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

    // Leaving and immediately rejoining the same table happens on the SAME still-connected
    // socket (no real disconnect ever occurred), so the held seat is sitting right here under
    // this exact socket.id already -- just resume it instead of falling through to either the
    // reclaim branch below (which only fires for a *different* id) or a fresh empty seat.
    if (lobby.players[socket.id]) {
      lobby.players[socket.id].disconnectedAt = null;
      lobby.players[socket.id].graceMs = null;
      socket.emit("lobbyJoined", buildLobbyJoinedPayload(lobby, socket.id));
      broadcastPlayers(lobby);
      broadcastLobbyList();
      pushLog(lobby, `${username} rejoined`);
      return;
    }

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

    // A fresh seat starts from this account's saved defaults (if any) rather than always blank --
    // same "account-wide preference, applied per new table" shape defaultName already used, just
    // for board mat / pile art instead of nickname.
    const acctDefaults = users[username] || {};
    const defaultBoardMat = acctDefaults.defaultBoardMat || null;
    const defaultPileArt = acctDefaults.defaultPileArt || {};
    // A saved default cursor COLOR still has to respect this lobby's own per-table uniqueness rule
    // (see setCursorColor) -- two players joining fresh with the same saved default would otherwise
    // silently collide. Falls back to no color (same as never having set one) rather than erroring
    // on join; the icon has no such uniqueness concept, so it always applies as-is.
    const defaultCursorColorTaken = acctDefaults.defaultCursorColor &&
      Object.values(lobby.players).some((other) => other.cursorColor === acctDefaults.defaultCursorColor);
    lobby.players[socket.id] = {
      username,
      name: acctDefaults.defaultName || username,
      color: nextColor(),
      life: 40, cmdr: 0, cmdrDamage: {}, eliminated: false, poison: 0,
      protectionFromCardType: null, // Serra's Emissary -- "you and creatures you control have protection from the chosen card type"
      lifeLocked: false, protectionFromEverything: false, phasedOut: [], // Teferi's Protection
      deflectingPalmSource: null, // Deflecting Palm -- id of the chosen source, cleared on first hit or at cleanup
      boardMat: defaultBoardMat ? defaultBoardMat.url : null,
      boardMatFit: defaultBoardMat ? sanitizeImgFit(defaultBoardMat) : null,
      pileArt: {
        library: defaultPileArt.library || null,
        graveyard: defaultPileArt.graveyard || null,
        exile: defaultPileArt.exile || null
      },
      library: [], graveyard: [], exile: [],
      commanders: [null, null],
      mulligans: 0, handKept: false, openingHandDrawn: false,
      mana: EMPTY_MANA(), landsPlayedThisTurn: 0, landDropBonus: 0,
      // Live cursor tracking's own style -- see setCursorColor/setCursorIcon; null color falls back
      // to the player's own `color` above. Seeded from the account's saved defaults, if any (see
      // setDefaultCursorColor/setDefaultCursorIcon), same "account-wide preference, applied per new
      // table" shape as boardMat/pileArt just above.
      cursorColor: (acctDefaults.defaultCursorColor && !defaultCursorColorTaken) ? acctDefaults.defaultCursorColor : null,
      cursorIcon: acctDefaults.defaultCursorIcon || null,
      cursorIconFit: acctDefaults.defaultCursorIcon ? (acctDefaults.defaultCursorIconFit || null) : null
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
    // Leaving works like a disconnect, not an instant wipe: the seat -- board, hand, library,
    // graveyard, exile, commanders, turn-order position, everything -- stays held for a short
    // grace window instead of being torn down immediately. The old immediate-removal behavior
    // deleted the player record (commander/library/graveyard/exile) but never touched the
    // matching lobby.cards entries, which stayed valid since Leave-then-rejoin without an actual
    // page reload reuses the exact same socket.id -- so battlefield/hand cards would silently
    // reappear on rejoin while everything else came back empty, and turn order got disturbed by
    // the full removal in between. A shorter grace window than a genuine disconnect (60s vs 3min)
    // since clicking Leave is a clear, deliberate signal, not an ambiguous network blip.
    const p = lobby.players[socket.id];
    if (!p) return;
    p.disconnectedAt = Date.now();
    p.graceMs = LEAVE_GRACE_MS;
    broadcastPlayers(lobby);
    broadcastLobbyList();
    pushLog(lobby, `${username} left the table`);
    scheduleGraceRemoval(lobby, socket.id, LEAVE_GRACE_MS);
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

  // Only the table's creator can tear it down outright -- everyone else uses Leave Table, which
  // just vacates their own seat. Immediate, not a grace-period leave: the whole table is gone, not
  // just one seat, so there's nothing to hold open for a reconnect.
  socket.on("deleteLobby", (data) => {
    const id = typeof data === "string" ? data : (data && data.id);
    const lobby = lobbies[id];
    if (!lobby) return;
    if (lobby.hostUsername !== username) { socket.emit("actionError", "Only the table's creator can delete it."); return; }
    for (const sid of lobbySocketIds(lobby)) {
      const sock = io.sockets.sockets.get(sid);
      if (!sock) continue;
      sock.emit("lobbyDeleted", { name: lobby.name });
      sock.leave(lobby.id);
      sock.data.lobbyId = null;
    }
    delete lobbies[id];
    saveLobbies();
    broadcastLobbyList();
  });

  // Host-only per-table rules toggle -- currently just enforceTargetingRestrictions, but keyed
  // generically so more toggles (the eventual casual/tournament/custom ruleset picker) slot in
  // here later without a new handler each time.
  socket.on("setLobbySetting", ({ key, value } = {}) => {
    const lobby = currentLobby(); if (!lobby) return;
    if (lobby.hostUsername !== username) { socket.emit("actionError", "Only the table's creator can change table rules."); return; }
    if (!Object.prototype.hasOwnProperty.call(lobby.settings, key)) return;
    lobby.settings[key] = !!value;
    io.to(lobby.id).emit("lobbySettings", lobby.settings);
    pushLog(lobby, `${username} set "${key}" to ${!!value}`);
  });

  socket.on("setName", (name) => {
    const lobby = currentLobby(); if (!lobby || !lobby.players[socket.id]) return;
    lobby.players[socket.id].name = (name || "Player").toString().slice(0, 24);
    broadcastPlayers(lobby);
  });

  socket.on("updateAccount", ({ avatar, defaultName } = {}) => {
    if (!users[username]) return;
    const oldAvatar = users[username].avatar;
    users[username].avatar = sanitizeImgUrl(avatar) || null;
    users[username].defaultName = (defaultName || "").toString().trim().slice(0, 24) || null;
    saveUsers();
    if (oldAvatar && oldAvatar !== users[username].avatar) deleteUploadIfOrphaned(oldAvatar, username);
    const lobby = currentLobby();
    if (lobby && lobby.players[socket.id]) {
      lobby.players[socket.id].name = users[username].defaultName || username;
      broadcastPlayers(lobby);
    }
  });

  socket.on("setBoardMat", (url) => {
    const lobby = currentLobby(); if (!lobby || !lobby.players[socket.id]) return;
    const clean = sanitizeImgUrl(url);
    const p = lobby.players[socket.id];
    const oldMat = p.boardMat;
    p.boardMat = clean || null;
    // A crop/zoom set for the OLD photo would frame a totally different image now -- reset to the
    // default cover/center fit whenever the mat itself actually changes, not just on every re-set
    // of the same URL (e.g. immediately followed by a real setBoardMatFit from the crop editor).
    if (oldMat !== p.boardMat) p.boardMatFit = null;
    broadcastPlayers(lobby);
    if (oldMat && oldMat !== p.boardMat) deleteUploadIfOrphaned(oldMat, username);
  });

  socket.on("setBoardMatFit", (fit) => {
    const lobby = currentLobby(); if (!lobby || !lobby.players[socket.id]) return;
    lobby.players[socket.id].boardMatFit = sanitizeImgFit(fit);
    broadcastPlayers(lobby);
  });

  socket.on("setPileArt", ({ zone, url, scale, x, y } = {}) => {
    const lobby = currentLobby(); if (!lobby || !lobby.players[socket.id]) return;
    if (!["library", "graveyard", "exile"].includes(zone)) return;
    const p = lobby.players[socket.id];
    if (!p.pileArt) p.pileArt = { library: null, graveyard: null, exile: null };
    const oldEntry = p.pileArt[zone];
    const clean = sanitizeImgUrl(url);
    p.pileArt[zone] = clean ? { url: clean, ...sanitizeImgFit({ scale, x, y }) } : null;
    broadcastPlayers(lobby);
    if (oldEntry && oldEntry.url && oldEntry.url !== clean) deleteUploadIfOrphaned(oldEntry.url, username);
  });

  // Account-wide defaults, applied to a fresh seat at ANY future table (see joinLobbyInternal) --
  // distinct from the existing named saved-mats/saved-pile-art libraries, which have to be picked
  // and applied by hand each time. Not swept by deleteUploadIfOrphaned's reference check (that only
  // looks at the named libraries) -- a known, small gap: an uploaded photo used ONLY as a default
  // and later replaced won't get cleaned up automatically. Acceptable for a small trusted pod.
  socket.on("setDefaultBoardMat", ({ url, scale, x, y } = {}) => {
    if (!users[username]) return;
    const clean = sanitizeImgUrl(url);
    users[username].defaultBoardMat = clean ? { url: clean, ...sanitizeImgFit({ scale, x, y }) } : null;
    saveUsers();
    socket.emit("defaultArtUpdated", { boardMat: users[username].defaultBoardMat, pileArt: users[username].defaultPileArt || null });
  });

  socket.on("setDefaultPileArt", ({ zone, url, scale, x, y } = {}) => {
    if (!users[username] || !["library", "graveyard", "exile"].includes(zone)) return;
    if (!users[username].defaultPileArt) users[username].defaultPileArt = { library: null, graveyard: null, exile: null };
    const clean = sanitizeImgUrl(url);
    users[username].defaultPileArt[zone] = clean ? { url: clean, ...sanitizeImgFit({ scale, x, y }) } : null;
    saveUsers();
    socket.emit("defaultArtUpdated", { boardMat: users[username].defaultBoardMat || null, pileArt: users[username].defaultPileArt });
  });

  // Same account-wide-default shape as setDefaultBoardMat/setDefaultPileArt above, just for the
  // cursor style -- applied to every FRESH seat at any future table (see joinLobbyInternal), not
  // retroactively to the CURRENT seat (matches setDefaultBoardMat's own behavior: saving a default
  // doesn't reach back and change what's already applied at a table you're sitting at right now).
  socket.on("setDefaultCursorColor", (color) => {
    if (!users[username]) return;
    users[username].defaultCursorColor = CURSOR_COLORS.includes(color) ? color : null;
    saveUsers();
    socket.emit("defaultCursorUpdated", { color: users[username].defaultCursorColor, icon: users[username].defaultCursorIcon || null, iconFit: users[username].defaultCursorIconFit || null });
  });

  socket.on("setDefaultCursorIcon", (data) => {
    if (!users[username]) return;
    const { url, scale, x, y } = typeof data === "string" ? { url: data } : (data || {});
    const clean = url ? sanitizeImgUrl(url) : null;
    users[username].defaultCursorIcon = clean;
    users[username].defaultCursorIconFit = clean ? sanitizeImgFit({ scale, x, y }) : null;
    saveUsers();
    socket.emit("defaultCursorUpdated", { color: users[username].defaultCursorColor || null, icon: users[username].defaultCursorIcon, iconFit: users[username].defaultCursorIconFit });
  });

  socket.on("statChange", ({ key, val }) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p || !["life", "cmdr", "poison"].includes(key)) return;
    const before = p[key];
    const stackLenBefore = lobby.stack.length;
    if (key === "life" && val > 0) applyLifeGain(lobby, socket.id, val);
    else if (key === "life" && val < 0) applyLifeLoss(lobby, socket.id, -val);
    else p[key] += val;
    // Manual life adjustment can trigger elimination just like combat can; the manual cmdr/poison
    // buttons only ever touch the flat aggregate/poison counters, never cmdrDamage[key] itself
    // (only resolveCombatDamage writes that), so this is really just the life <= 0 path in
    // practice for this call site -- included anyway since checkEliminations checks both.
    checkEliminations(lobby);
    broadcastPlayers(lobby);
    // Only offer undo when nothing ELSE happened as a side effect of this change -- a life change
    // that fired a real trigger (Vilis drawing cards, Ajani's Pridemate's counter, both routed
    // through the stack) or that just eliminated the player can't be cleanly reverted by putting
    // the number back alone, so this stays un-undoable rather than silently leaving those other
    // effects in place. Also skips entirely if the value didn't actually move (Teferi's
    // Protection's lifeLocked silently no-ops applyLifeGain/applyLifeLoss) -- nothing to undo.
    const delta = p[key] - before;
    if (delta !== 0 && lobby.stack.length === stackLenBefore && !p.eliminated) {
      setUndo(lobby, socket.id, `${key} ${delta > 0 ? "+" : ""}${delta}`, () => {
        const pp = lobby.players[socket.id];
        if (pp) { pp[key] -= delta; broadcastPlayers(lobby); }
      });
    }
  });

  // A voluntary version of what checkEliminations does automatically -- reuses eliminatePlayer
  // as-is (board stays visible/frozen, you can keep spectating, checkGameOver fires naturally if
  // this was the last player standing), so this is just exposing the existing elimination system
  // for a player to trigger on themselves.
  socket.on("concede", () => {
    const lobby = currentLobby(); if (!lobby || !lobby.players[socket.id]) return;
    eliminatePlayer(lobby, socket.id);
    broadcastTurn(lobby);
    broadcastStack(lobby);
    broadcastCombat(lobby);
    broadcastPlayers(lobby);
    checkGameOver(lobby); // eliminatePlayer alone doesn't check this -- checkEliminations normally does, for its own callers
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

  // amount (Create Token's own new field) lets a player create several copies of the SAME token in
  // one action instead of clicking Create Token repeatedly -- e.g. Goblin Rally's "create three 1/1
  // red Goblins" is otherwise a real click-three-times chore for a manually-adjudicated card. No
  // upper bound of its own -- MAX_CARDS_PER_LOBBY (checked before EACH card in the loop below) is
  // already the real ceiling, so a huge request just creates as many as fit and stops there, same
  // as a modest one that happens to hit the table limit. Untouched (defaults to a single card) for
  // every other spawnCard caller -- deck-testing's "spawn any card" tool, drawn face-down cards,
  // etc. -- since none of those ever set `amount`.
  socket.on("spawnCard", (data) => {
    const lobby = currentLobby(); if (!lobby || !lobby.players[socket.id]) return;
    const who = lobby.players[socket.id].name;
    const amount = Math.max(1, parseInt(data.amount, 10) || 1);
    let created = 0;
    let lastCard = null;
    for (let i = 0; i < amount; i++) {
      if (Object.keys(lobby.cards).length >= MAX_CARDS_PER_LOBBY) break;
      const card = spawnBattlefieldCard(lobby, { ...data, owner: socket.id, zoneType: classifyType(data.type) });
      if (card.zoneType !== "hand") fireEtbTriggers(lobby, card);
      lastCard = card;
      created++;
    }
    if (created === 0) { socket.emit("actionError", "This table has hit its card limit — clean up unused tokens before spawning more."); return; }
    if (created < amount) socket.emit("actionError", `Table card limit reached -- only created ${created} of ${amount}.`);
    if (amount > 1) {
      pushLog(lobby, `${who} created ${created} ${lastCard.name || "token"}${created === 1 ? "" : "s"}`);
    } else {
      pushLog(lobby, data.faceDown ? `${who} spawned a card face down` : `${who} spawned ${data.name}`);
    }
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
      const castCheck = canCastSpells(lobby, socket.id, card);
      if (!castCheck.ok) { socket.emit("actionError", castCheck.error); return; }
      // Whether this is a land drop (free, no stack) or a spell cast (pays a cost, uses the stack)
      // is always the CARD's own real type, never the client-supplied `zoneType` -- that value is
      // purely "which Y-pixel row was the mouse over when released" (see zoneForY in index.html),
      // with no relationship to what the card actually is. Trusting it directly meant a land
      // dropped even slightly outside the Lands row got miscast as a spell straight onto the stack
      // (and, the other direction, a spell dropped in the Lands row got played for free as a land)
      // -- a real, reported bug ("lands randomly get added to the stack"), not a hypothetical.
      const realZoneType = classifyType(card.type);
      const result = attemptPlay(lobby, p, card, realZoneType, x);
      if (!result.ok) { socket.emit("actionError", result.error); return; }
      if (realZoneType === "mana" || !lobby.turn.started) {
        // Lands aren't spells -- no stack, no priority window, resolves immediately like today.
        // Pregame (no turn structure yet, no turn.order to hold a priority round) stays
        // unrestricted the same way it always has -- everything just resolves immediately.
        card.zoneType = realZoneType;
        card.faceDown = false;
        // A card sitting in hand was stamped with whatever turn it was drawn on (or 0, pregame) --
        // that's stale the moment it actually enters the battlefield, which is what summoning
        // sickness needs to key off. Same story for entersTapped: spawnBattlefieldCard already
        // applies it for cards created straight onto the battlefield, but a card played from hand
        // never goes through that function again, so it was silently skipped.
        card.controllerSince = lobby.turn.started ? lobby.turn.turnNumber : 0;
        if (entersTapped(card, lobby)) card.tapped = true;
        broadcastCard(lobby, card);
        broadcastPlayers(lobby);
        pushLog(lobby, `${p.name} played ${card.name || "a card"}`);
        fireEtbTriggers(lobby, card);
      } else {
        // Same broadcast gap as playCard below -- attemptPlay above already deducted the mana cost,
        // but castSpell itself never tells anyone the caster's mana pool changed.
        broadcastPlayers(lobby);
        castSpell(lobby, card, socket.id);
      }
      return;
    }
    if (card.zoneType === "stack") return; // can't yank a pending spell straight onto the battlefield, bypassing resolution
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
    const castCheck = canCastSpells(lobby, socket.id, card);
    if (!castCheck.ok) { socket.emit("actionError", castCheck.error); return; }
    const result = attemptPlay(lobby, p, card, targetZoneType, xValue);
    if (!result.ok) { socket.emit("actionError", result.error); return; }
    if (targetZoneType === "mana" || !lobby.turn.started) {
      card.zoneType = targetZoneType;
      card.faceDown = false;
      card.controllerSince = lobby.turn.started ? lobby.turn.turnNumber : 0;
      if (entersTapped(card, lobby)) card.tapped = true;
      broadcastCard(lobby, card);
      broadcastPlayers(lobby);
      pushLog(lobby, `${p.name} played ${card.name || "a card"}`);
      fireEtbTriggers(lobby, card);
    } else {
      // attemptPlay already deducted the mana cost above -- castSpell itself only ever
      // broadcastCard/broadcastStack (pushToStack) or prompts a target (queueTargetChoice), neither
      // of which tells anyone the caster's mana pool just changed. Without this, the caster's own
      // client kept showing the PRE-cast mana total until some unrelated broadcastPlayers happened
      // to fire later (e.g. the next phase change, which resets it to zero anyway) -- looking like
      // casting a spell didn't charge anything, or charged the wrong amount.
      broadcastPlayers(lobby);
      castSpell(lobby, card, socket.id);
    }
  });

  // Represents an effect like Cascade or Through the Breach -- "you may cast this without paying
  // its mana cost." Skips checkTiming and attemptPlay entirely, since this isn't the player
  // playing a card through normal channels; it's a manual tool for whatever already-resolved
  // effect earned the free cast (same trust model as everything else this app leaves to the
  // players to use honestly). Still goes through the stack like any other cast -- a free-cast
  // spell can still be responded to.
  socket.on("freeCastCard", (id) => {
    const lobby = currentLobby(); if (!lobby) return;
    const card = lobby.cards[id];
    const p = lobby.players[socket.id];
    if (!card || !p || card.owner !== socket.id || card.zoneType !== "hand") return;
    const castCheck = canCastSpells(lobby, socket.id, card);
    if (!castCheck.ok) { socket.emit("actionError", castCheck.error); return; }
    const targetZoneType = classifyType(card.type);
    if (targetZoneType === "mana" || !lobby.turn.started) {
      card.zoneType = targetZoneType;
      card.faceDown = false;
      card.controllerSince = lobby.turn.started ? lobby.turn.turnNumber : 0;
      if (entersTapped(card, lobby)) card.tapped = true;
      broadcastCard(lobby, card);
      pushLog(lobby, `${p.name} played ${card.name || "a card"} without paying its cost`);
      fireEtbTriggers(lobby, card);
    } else {
      castSpell(lobby, card, socket.id, " without paying its mana cost");
    }
  });

  // Cycling -- "{cost}, Discard this card: Draw a card" (or, for Basic landcycling, search a land
  // into hand instead). Not a spell cast at all (no stack, no timing restriction -- real Magic
  // allows cycling any time you have priority, including at instant speed on any turn), so this
  // skips checkTiming/canCastSpells entirely, same "this isn't really casting" precedent freeCastCard
  // above already establishes for a different reason.
  socket.on("cycleCard", (id) => {
    const lobby = currentLobby(); if (!lobby) return;
    const card = lobby.cards[id];
    const p = lobby.players[socket.id];
    if (!card || !p || card.owner !== socket.id || card.zoneType !== "hand") return;
    const cyc = cyclingCostFromText(card.text);
    if (!cyc) return;
    const remaining = canAffordAndPay(p.mana, parseManaCost(cyc.cost), 0);
    if (!remaining) { socket.emit("actionError", `Not enough mana to cycle ${card.name || "this card"}.`); return; }
    p.mana = remaining;
    sendToGraveyardInternal(lobby, card);
    pushLog(lobby, `${p.name} cycles ${card.name || "a card"}`);
    // Cycling IS discarding (CR 702.28e) -- Archfiend of Ifnir's own "whenever you cycle OR
    // discard" spells this out explicitly, but even a plain "whenever you discard a card" ability
    // is real Magic-correct to fire here too.
    fireGlobalTrigger(lobby, "youDiscard", socket.id, card);
    if (cyc.kind === "basicLand") EFFECTS.tutorToHand(lobby, { controllerId: socket.id }, { typeFilter: cyc.landType || "land" });
    else drawN(lobby, socket.id, 1);
    broadcastPlayers(lobby);
  });

  // Sephara, Sky's Blade and any future ALT_COSTS card -- "you may pay X rather than pay this
  // spell's mana cost." A real way to cast the spell (unlike freeCastCard's manual-bypass trust
  // model above), so it goes through the same timing/cantCastSpells gating playCard does; only the
  // cost-payment step itself differs. WHICH qualifying creatures get tapped isn't a real choice
  // (see ALT_COSTS's own comment) -- just taps the first N that qualify.
  socket.on("castWithAltCost", (id) => {
    const lobby = currentLobby(); if (!lobby) return;
    const card = lobby.cards[id];
    const p = lobby.players[socket.id];
    if (!card || !p || card.owner !== socket.id || card.zoneType !== "hand") return;
    const alt = getAltCost(card.name);
    if (!alt) return;
    const timing = checkTiming(lobby, socket.id, card);
    if (!timing.ok) { socket.emit("actionError", timing.error); return; }
    const castCheck = canCastSpells(lobby, socket.id, card);
    if (!castCheck.ok) { socket.emit("actionError", castCheck.error); return; }
    const qualifying = Object.values(lobby.cards).filter((c) =>
      c.owner === socket.id && c.zoneType === "creature" && !c.tapped &&
      effectiveKeywords(lobby, c).some((k) => (k || "").toLowerCase() === alt.tapKeyword)
    );
    if (qualifying.length < alt.tapCount) {
      socket.emit("actionError", `You need ${alt.tapCount} untapped creatures with ${alt.tapKeyword} to pay ${card.name}'s alternative cost (only have ${qualifying.length}).`);
      return;
    }
    const remaining = alt.mana ? canAffordAndPay(p.mana, parseManaCost(alt.mana), 0) : p.mana;
    if (!remaining) { socket.emit("actionError", `Not enough mana to pay ${card.name}'s alternative cost.`); return; }
    p.mana = remaining;
    qualifying.slice(0, alt.tapCount).forEach((c) => { c.tapped = true; broadcastCard(lobby, c); });
    broadcastPlayers(lobby);
    castSpell(lobby, card, socket.id, " using its alternative cost");
  });

  // Painlands ("{T}: Add X [or Y]. This land deals 1 damage to you.") -- Adarkar Wastes, Cephalid
  // Coliseum, and the whole real cycle. A pure text-scan on the land's own printed text, no per-card
  // table entry needed, checked at both real "tapped for mana and it actually resolved" choke
  // points below (the free single-color shortcut in "tap", and the real multi-color choice in
  // "resolveManaChoice") -- same precedent as everywhere else in this file reading a land's own
  // text directly rather than keying off its name.
  function applyPainlandDamageIfNeeded(lobby, card, playerId) {
    if (!/this land deals 1 damage to you/i.test(card.text || "")) return;
    applyLifeLoss(lobby, playerId, 1);
    checkEliminations(lobby); // a real way to die, checked immediately -- same as any other life-loss cost
    broadcastPlayers(lobby);
  }
  // Forbidden Orchard -- "Whenever you tap this land for mana, target opponent creates a 1/1
  // colorless Spirit creature token." Same text-scan/two-choke-point shape as the painland check
  // just above, but this one needs a REAL target choice (the new "opponent" targetKind), not an
  // automatic effect, so it goes through queueTargetChoice like any other triggered ability instead
  // of resolving inline.
  function checkLandTapOpponentTokenTrigger(lobby, card, playerId) {
    const m = (card.text || "").match(/whenever you tap this land for mana, target opponent creates an? (\d+)\/(\d+) (\w+) (\w+) creature tokens?\.?/i);
    if (!m) return;
    queueTargetChoice(lobby, {
      controllerId: playerId, sourceCard: card, label: `${card.name || "This land"} — target opponent creates a token`,
      targetKind: "opponent",
      effects: [{ type: "createTokenForTargetPlayer", tokenType: `Token Creature — ${m[4]}`, power: m[1], toughness: m[2], colors: m[3].toLowerCase() === "colorless" ? [] : [COLOR_NAME_TO_LETTER[m[3].toLowerCase()]].filter(Boolean), name: m[4] }]
    });
  }
  socket.on("tap", (id) => {
    const lobby = currentLobby(); if (!lobby) return;
    const card = lobby.cards[id];
    if (!card || card.owner !== socket.id || card.zoneType === "hand" || card.zoneType === "stack") return;
    // One-way now: this only ever taps. Real Magic has no "double-click to untap at will" —
    // untapping only happens automatically each Untap step (or via Untap All for effects that
    // untap things). Letting a player freely toggle back and forth on the same land was a way to
    // mint unlimited mana just by clicking it repeatedly.
    if (card.tapped) return;
    card.tapped = true;
    broadcastCard(lobby, card);
    // The mana half (if any) is filled in below once it's known -- manaAdded stays untouched (no
    // mana to revert) for a plain tap-only source, or for one that only ever emits a chooseMana
    // prompt (untapping here already invalidates that prompt, since resolveManaChoice itself checks
    // card.tapped before adding anything).
    const manaAdded = { color: null };
    setUndo(lobby, socket.id, `Tap ${card.name || "a card"}`, () => {
      const c = lobby.cards[id];
      if (c && c.tapped) { c.tapped = false; broadcastCard(lobby, c); }
      if (manaAdded.color) {
        const pp = lobby.players[socket.id];
        if (pp) { pp.mana[manaAdded.color] = Math.max(0, (pp.mana[manaAdded.color] || 0) - 1); broadcastPlayers(lobby); }
      }
    });
    // A card with its own real ACTIVATED_ABILITIES manaAbility entry (a signet: "{1}, T: Add {W}
    // {B}.") has a genuine mana COST to pay and/or produces more than one color simultaneously --
    // neither of which this auto-mana shortcut (built for free, single-choice sources) can
    // represent. Skip it entirely here; the player activates the real ability instead, same as any
    // other costed activated ability, rather than getting free or wrong mana from a plain tap.
    if (getActivatedAbilities(card, lobby).some((a) => a.manaAbility)) return;
    // Auto-add mana for any tapped source with an unambiguous color — lands, rocks, and dorks
    // alike — not just basics. Basic land types are unambiguous by their type line; anything else
    // (rocks, dorks, nonbasic lands) is unambiguous only when the archive says it produces exactly
    // one color. A source that can produce more than one color (Command Tower, most signets/
    // talismans, City of Brass, mana dorks with a choice) prompts the player to pick instead of
    // silently guessing or staying fully manual.
    let options = null;
    if (dependsOnOpponentLands(card)) {
      // Exotic Orchard and the like: narrow to what opponents' lands could actually produce
      // right now, instead of the card's raw (all-five) producedMana list.
      options = opponentLandColors(lobby, socket.id);
    } else if (dependsOnCommanderColorIdentity(card)) {
      // Command Tower and the like: narrow to the real commander's color identity instead of the
      // raw (all-five) producedMana list Scryfall reports.
      options = commanderColorIdentity(lobby, socket.id);
    } else if (classifyType(card.type) === "mana" && controlsChromaticLantern(lobby, socket.id)) {
      // Chromatic Lantern grants every land you control (even a plain Forest) the ability to add
      // any color -- checked after the two text-pattern cases above since a card like Command Tower
      // already has a real, narrower rule to apply instead of the blanket 5-color grant.
      options = ["W", "U", "B", "R", "G"];
    }
    let color = options ? (options.length === 1 ? options[0] : null) : basicLandColor(card.type);
    if (!color && !options && Array.isArray(card.producedMana) && card.producedMana.length === 1) {
      color = card.producedMana[0];
    }
    if (color && ["W", "U", "B", "R", "G", "C"].includes(color)) {
      const p = lobby.players[socket.id];
      p.mana[color] = (p.mana[color] || 0) + 1;
      manaAdded.color = color;
      broadcastPlayers(lobby);
      pushLog(lobby, `${p.name} tapped ${card.name} for {${color}}`);
      applyPainlandDamageIfNeeded(lobby, card, socket.id);
      checkLandTapOpponentTokenTrigger(lobby, card, socket.id);
    } else if (options ? options.length > 1 : (Array.isArray(card.producedMana) && card.producedMana.length > 1)) {
      const finalOptions = (options || card.producedMana).filter((c) => ["W", "U", "B", "R", "G", "C"].includes(c));
      if (finalOptions.length) socket.emit("chooseMana", { cardId: card.id, cardName: card.name, options: finalOptions });
    } else if (options && options.length === 0) {
      const reason = dependsOnCommanderColorIdentity(card) ? "your commander has no color identity right now" : "no opponent controls a land right now";
      socket.emit("actionError", `${reason.charAt(0).toUpperCase() + reason.slice(1)}, so ${card.name} can't produce mana.`);
    }
  });

  // Player's answer to the "chooseMana" prompt above, for a tapped source with more than one
  // possible color.
  socket.on("resolveManaChoice", ({ cardId, color }) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p) return;
    // Treasure (and anything else that sacrifices its source as part of the cost) -- the card is
    // already gone by the time this resolves, see chooseManaAnyColor's own comment, so there's no
    // producedMana to validate against; any of the 5 colors is always legal here.
    if (cardId === "__free__") {
      if (!p.pendingFreeManaChoice || !["W", "U", "B", "R", "G", "C"].includes(color)) return;
      const amount = p.pendingFreeManaChoice.amount || 1;
      const remaining = (p.pendingFreeManaChoice.remainingPicks || 1) - 1;
      p.mana[color] = (p.mana[color] || 0) + amount;
      pushLog(lobby, `${p.name} adds {${color}}${amount > 1 ? ` x${amount}` : ""}`);
      // Cascading Cataracts-style "N independent picks" -- re-prompt for the next one instead of
      // clearing pendingFreeManaChoice, see chooseManaAnyColorRepeated's own comment.
      if (remaining > 0) {
        p.pendingFreeManaChoice = { amount, remainingPicks: remaining };
        broadcastPlayers(lobby);
        const sock = io.sockets.sockets.get(socket.id);
        if (sock) sock.emit("chooseMana", { cardId: "__free__", cardName: "Mana source", options: ["W", "U", "B", "R", "G"] });
        return;
      }
      p.pendingFreeManaChoice = false;
      broadcastPlayers(lobby);
      return;
    }
    // The Thriving cycle's one-time ETB "choose a color" (chooseColorOtherThan) -- STORES the pick
    // on the card instead of adding mana, checked before the tapped-mana-source branch below since
    // this card is neither tapped nor being tapped for mana right now, just entering.
    const pendingColorCard = lobby.cards[cardId];
    if (pendingColorCard && pendingColorCard.pendingColorChoice) {
      if (pendingColorCard.owner !== socket.id || !["W", "U", "B", "R", "G"].includes(color)) return;
      pendingColorCard.pendingColorChoice = false;
      pendingColorCard.chosenColor = color;
      broadcastCard(lobby, pendingColorCard);
      pushLog(lobby, `${p.name} chose ${color} for ${pendingColorCard.name || "a land"}`);
      return;
    }
    const card = lobby.cards[cardId];
    if (!card || card.owner !== socket.id || !card.tapped) return;
    if (!Array.isArray(card.producedMana) || !card.producedMana.includes(color) || !["W", "U", "B", "R", "G", "C"].includes(color)) return;
    p.mana[color] = (p.mana[color] || 0) + 1;
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} tapped ${card.name} for {${color}}`);
    applyPainlandDamageIfNeeded(lobby, card, socket.id);
    checkLandTapOpponentTokenTrigger(lobby, card, socket.id);
    setUndo(lobby, socket.id, `Tap ${card.name || "a card"} for {${color}}`, () => {
      const c = lobby.cards[cardId];
      if (c && c.tapped) { c.tapped = false; broadcastCard(lobby, c); }
      const pp = lobby.players[socket.id];
      if (pp) { pp.mana[color] = Math.max(0, (pp.mana[color] || 0) - 1); broadcastPlayers(lobby); }
    });
  });

  socket.on("flip", (id) => {
    const lobby = currentLobby(); if (!lobby) return;
    const card = lobby.cards[id];
    // Hand cards are already always faceDown for non-owners via maskCard; flipping one to
    // faceDown:false would leak its identity to every other player at the table. A card on the
    // stack is already public (face up) and shouldn't be hideable either.
    if (!card || card.owner !== socket.id || card.zoneType === "hand" || card.zoneType === "stack") return;
    card.faceDown = !card.faceDown;
    broadcastCard(lobby, card);
    const who = lobby.players[socket.id] ? lobby.players[socket.id].name : "Someone";
    pushLog(lobby, `${who} flipped a card`);
  });

  socket.on("counter", ({ id, delta }) => {
    const lobby = currentLobby(); if (!lobby) return;
    const card = lobby.cards[id];
    if (!card || card.owner !== socket.id || card.zoneType === "hand" || card.zoneType === "stack") return;
    card.counters = (card.counters || 0) + delta;
    broadcastCard(lobby, card);
    setUndo(lobby, socket.id, `${delta > 0 ? "+" : ""}${delta} counter on ${card.name || "a card"}`, () => {
      const c = lobby.cards[id];
      if (c) { c.counters = (c.counters || 0) - delta; broadcastCard(lobby, c); }
    });
  });

  // Activates a player-initiated ability from ACTIVATED_ABILITIES (see its comment for scope).
  // Checks affordability of ALL costs before paying ANY of them -- no partial payment on a failed
  // check partway through. Once costs are validated, pays them, then hands off to fireTrigger --
  // the exact same requiresTarget-or-straight-to-stack branch CARD_ABILITIES entries already use,
  // so resolveStackTop needs zero changes regardless of how an item reached the stack.
  socket.on("activateAbility", ({ cardId, abilityIndex, x }) => {
    const lobby = currentLobby(); if (!lobby) return;
    const card = lobby.cards[cardId];
    const p = lobby.players[socket.id];
    if (!p || !card || card.owner !== socket.id || card.zoneType === "hand" || card.zoneType === "stack") return;
    // Pregame has no turn.order, so nextInOrder(pushAbilityToStack's priority handoff) would return
    // null and this would get stuck on the stack forever with no one able to pass priority to
    // resolve it -- same "pregame stays trigger-free" rule fireEtbTriggers/fireDeathTriggers/
    // fireAttackTriggers already follow, just enforced with a real error here since this is a
    // player-initiated action, not a silent automatic trigger.
    if (!lobby.turn.started) { socket.emit("actionError", "You can't activate abilities before the game starts."); return; }
    const ability = getActivatedAbilities(card, lobby)[abilityIndex];
    if (!ability) return;
    // Reject BEFORE paying anything if this ability could never find a legal target right now --
    // Whip of Erebos with an empty graveyard, say. Without this the player would pay the full
    // mana/tap cost for an ability that's about to silently fizzle (fireTrigger's own CR 603.3c
    // check further down would catch the empty-graveyard case too, but only AFTER the cost is
    // already spent).
    if (ability.requiresTarget && ability.targetKind === "ownGraveyardCreature") {
      const hasMatch = (p.graveyard || []).some((e) => (e.type || "").toLowerCase().includes("creature"));
      if (!hasMatch) { socket.emit("actionError", "There's no creature card in your graveyard to target."); return; }
    }
    // Mistveil Plains -- same "reject before paying" reason, for the unrestricted graveyard kind.
    if (ability.requiresTarget && ability.targetKind === "ownGraveyard") {
      if (!(p.graveyard || []).length) { socket.emit("actionError", "There's no card in your graveyard to target."); return; }
    }
    // Hall of Heliod's Generosity-style -- same "reject before paying" reason as
    // ownGraveyardCreature just above, for the TYPE-FILTERED graveyard targetKind instead.
    if (ability.requiresTarget && ability.targetKind === "ownGraveyardTypeList") {
      const filter = ability.typeFilter || [];
      const hasMatch = (p.graveyard || []).some((e) => filter.some((t) => (e.type || "").toLowerCase().includes(t)));
      if (!hasMatch) { socket.emit("actionError", `There's no matching card in your graveyard to target.`); return; }
    }
    // Witch's Clinic -- same "reject before paying" reason, for when no commander is on the
    // battlefield at all (any player's, not just yours).
    if (ability.requiresTarget && ability.targetKind === "commander") {
      const hasMatch = Object.values(lobby.cards).some((c) => c.zoneType === "creature" && c.isCommander);
      if (!hasMatch) { socket.emit("actionError", "There's no commander on the battlefield to target."); return; }
    }
    // Kor Haven -- same "reject before paying" reason, for when nothing is currently attacking.
    if (ability.requiresTarget && ability.targetKind === "attackingCreature") {
      const hasMatch = Object.keys(lobby.combat.attackers || {}).length > 0;
      if (!hasMatch) { socket.emit("actionError", "There's no attacking creature to target."); return; }
    }
    // Torch Courier -- same "reject before paying" reason, for when there's no OTHER creature on
    // the battlefield to target (checked before this creature sacrifices itself as part of the cost).
    if (ability.requiresTarget && ability.targetKind === "otherCreature") {
      const hasMatch = Object.values(lobby.cards).some((c) => c.zoneType === "creature" && c.id !== card.id);
      if (!hasMatch) { socket.emit("actionError", "There's no other creature to target."); return; }
    }
    // Temple of the False God -- "Activate only if you control five or more lands." A real
    // activation-condition gate, checked before anything is paid, same "reject before paying" reason
    // as the ownGraveyardCreature check just above. Reusable for any future card with its own
    // arbitrary activation condition, same shape as CARD_ABILITIES entries' own `condition(card, lobby)`.
    if (ability.condition && !ability.condition(card, lobby)) {
      socket.emit("actionError", ability.conditionError || `You can't activate ${card.name}'s ability right now.`);
      return;
    }
    const cost = ability.cost || {};
    // Pashalik Mons-style "Sacrifice a Goblin" -- a cost naming a FILTER rather than "this permanent"
    // (cost.sacrifice) or a real player choice (no target-choice-shaped cost exists in this engine).
    // Auto-picks the first qualifying creature OTHER than the activating card itself, falling back to
    // the card itself only when it's the sole match -- a disclosed simplification (real Magic lets
    // you choose), chosen to avoid destroying the activating permanent whenever a better option exists.
    let autoSacrificeCard = null;
    if (cost.autoSacrificeFilter) {
      const filter = cost.autoSacrificeFilter;
      const candidates = Object.values(lobby.cards).filter((c) => c.owner === socket.id && c.zoneType === "creature" && (filter === "creature" || (c.type || "").toLowerCase().includes(filter)));
      // Razaketh-style "Sacrifice ANOTHER creature" -- unlike Pashalik Mons's "a Goblin" (where
      // sacrificing itself is legal and only a fallback), "another" means the ability simply can't
      // be activated at all when no OTHER qualifying creature exists, never self-sacrifice instead.
      autoSacrificeCard = cost.excludeSelf
        ? candidates.find((c) => c.id !== card.id) || null
        : candidates.find((c) => c.id !== card.id) || candidates.find((c) => c.id === card.id) || null;
      if (!autoSacrificeCard) { socket.emit("actionError", `You have no ${cost.excludeSelf ? "other " : ""}${filter === "creature" ? "creature" : filter} to sacrifice.`); return; }
    }
    // Tortured Existence-style "Discard a creature card" / Hollowhead Sliver-style "Discard a
    // card" -- same auto-pick-the-first-qualifying-card shape as autoSacrificeFilter just above,
    // for hand cards instead of battlefield creatures. "card" (not a real type substring) matches
    // ANYTHING in hand.
    let autoDiscardCard = null;
    if (cost.autoDiscardFilter) {
      const filter = cost.autoDiscardFilter;
      const candidates = Object.values(lobby.cards).filter((c) => c.owner === socket.id && c.zoneType === "hand" && (filter === "card" || (c.type || "").toLowerCase().includes(filter)));
      autoDiscardCard = candidates[0] || null;
      if (!autoDiscardCard) { socket.emit("actionError", `You have no ${filter === "card" ? "card" : filter} card to discard.`); return; }
    }

    if (cost.tap) {
      if (card.tapped) { socket.emit("actionError", `${card.name} is already tapped.`); return; }
      // Summoning sickness (CR 302.6) only ever restricts CREATURES -- a plain artifact/other
      // permanent with a {T} cost is never subject to it, same as the client's own isSummoningSick
      // helper already correctly gates on zoneType. Missing this check here meant a same-turn
      // artifact's tap ability was incorrectly blocked, caught via a Campfire ({1},{T}: gain 2 life)
      // activation test.
      if (card.zoneType === "creature") {
        const hasHaste = effectiveKeywords(lobby, card).some((k) => (k || "").toLowerCase() === "haste");
        // Thousand-Year Elixir-style ability-only haste exception -- see canActivateAbilitiesAsThoughHaste.
        if (card.controllerSince === lobby.turn.turnNumber && !hasHaste && !canActivateAbilitiesAsThoughHaste(lobby, socket.id)) {
          socket.emit("actionError", `${card.name} has summoning sickness.`); return;
        }
      }
    }
    // Kessig Wolf Run/Mirror Entity-style X-cost ability -- only meaningful when the ability's own
    // real cost actually contains {X} (parseManaCost's own cost.x flag), so a plain non-X ability
    // ignores whatever x the client happens to send rather than demanding phantom extra mana.
    let remainingMana = null;
    let xVal = 0;
    if (cost.mana) {
      const parsedCost = parseManaCost(cost.mana);
      xVal = parsedCost.x ? Math.max(0, parseInt(x, 10) || 0) : 0;
      remainingMana = canAffordAndPay(p.mana, parsedCost, xVal);
      if (!remainingMana) { socket.emit("actionError", `Not enough mana to activate ${card.name}'s ability.`); return; }
    }
    // cost.sacrifice has nothing to validate -- you already own it and it's on the battlefield.
    // cost.life (a plain number, e.g. fetchlands' "Pay 1 life", OR a function(lobby, controllerId)
    // for a dynamic amount like War Room's "life equal to the number of colors in your commanders'
    // color identity") has nothing to validate either -- real Magic never blocks paying life as a
    // cost, even at 1 life or below; it can legally kill you.
    const lifeCost = typeof cost.life === "function" ? cost.life(lobby, socket.id) : cost.life;

    if (cost.tap) { card.tapped = true; broadcastCard(lobby, card); }
    if (cost.mana) { p.mana = remainingMana; broadcastPlayers(lobby); }
    if (lifeCost) {
      applyLifeLoss(lobby, socket.id, lifeCost);
      checkEliminations(lobby); // paying life is a real way to die -- check immediately, not just at resolution
      broadcastPlayers(lobby);
    }
    pushLog(lobby, `${p.name} activated: ${ability.label}`);
    if (cost.sacrifice) {
      // Paid as part of the cost, immediately -- same as real Magic (costs are paid on activation,
      // not on resolution). The card object itself stays valid for fireTrigger below even after
      // this: sendToGraveyardInternal only removes it from lobby.cards, it doesn't mutate the object.
      fireDeathTriggers(lobby, card);
      sendToGraveyardInternal(lobby, card);
    }
    // Ominous Cemetery-style "Exile this land" as a cost -- same "paid immediately, card object
    // stays valid" reasoning as cost.sacrifice, just a different destination (no death triggers,
    // exiling isn't dying).
    if (cost.exile) { exileCardInternal(lobby, card); }
    if (autoSacrificeCard) {
      pushLog(lobby, `${p.name} sacrifices ${autoSacrificeCard.name || "a creature"} to pay the cost`);
      fireDeathTriggers(lobby, autoSacrificeCard);
      sendToGraveyardInternal(lobby, autoSacrificeCard);
    }
    if (autoDiscardCard) {
      pushLog(lobby, `${p.name} discards ${autoDiscardCard.name || "a card"} to pay the cost`);
      sendToGraveyardInternal(lobby, autoDiscardCard);
      fireGlobalTrigger(lobby, "youDiscard", socket.id, autoDiscardCard);
    }
    if (ability.manaAbility) {
      // Real Magic (CR 605): a mana ability never uses the stack -- it resolves the instant it's
      // activated, precisely because its mana usually needs to be available immediately to help
      // pay for whatever prompted tapping this in the first place. Every other activated ability
      // still goes through fireTrigger/the stack below.
      const ctx = { controllerId: socket.id, sourceCard: { id: card.id } };
      const effects = xVal ? (ability.effects || []).map((e) => ({ ...e, xAmount: xVal })) : ability.effects;
      (effects || []).forEach((params) => { const fn = EFFECTS[params.type]; if (fn) fn(lobby, ctx, params); });
    } else {
      fireTrigger(lobby, card, ability, xVal);
    }
  });

  // Manually granted keywords -- represents an aura/equipment/anthem/etc. effect, since none of
  // those are automated. Replaces the whole set at once (the client sends the full checked list)
  // rather than individual add/remove events, so there's no way for the two sides to desync.
  socket.on("setKeywords", ({ id, keywords }) => {
    const lobby = currentLobby(); if (!lobby) return;
    const card = lobby.cards[id];
    if (!card || card.owner !== socket.id || card.zoneType === "hand" || card.zoneType === "stack") return;
    card.keywords = Array.isArray(keywords) ? [...new Set(keywords)].filter((k) => KNOWN_KEYWORDS.includes(k)) : [];
    broadcastCard(lobby, card);
  });

  // Attaching represents equipping (pays the real Equip cost, parsed from oracle text, if there
  // is one) or an aura settling onto what it enchants (free -- its real cost was already paid via
  // the stack when it was cast). No ownership restriction on the target, same trust model as
  // targeting -- your Pacifism attaching to an opponent's creature is the normal case, not an
  // exception. Detaching is always free, a manual correction/undo tool.
  socket.on("attachCard", ({ id, targetId }) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    const card = lobby && lobby.cards[id];
    const target = lobby && lobby.cards[targetId];
    if (!p || !card || !target || card.owner !== socket.id || card.id === target.id) return;
    if (card.zoneType === "hand" || card.zoneType === "stack") return;
    if (target.zoneType === "hand" || target.zoneType === "stack") return;
    const cost = equipCostFromText(card.text);
    if (cost) {
      const remaining = canAffordAndPay(p.mana, cost, 0);
      if (!remaining) { socket.emit("actionError", `Not enough mana to equip ${card.name || "this"}.`); return; }
      p.mana = remaining;
      broadcastPlayers(lobby);
    }
    card.attachedTo = targetId;
    broadcastCard(lobby, card);
    pushLog(lobby, `${p.name} attached ${card.name || "a card"} to ${target.name || "a card"}`);
  });

  socket.on("detachCard", (id) => {
    const lobby = currentLobby(); if (!lobby) return;
    const card = lobby.cards[id];
    if (!card || card.owner !== socket.id || !card.attachedTo) return;
    card.attachedTo = null;
    broadcastCard(lobby, card);
  });

  // Taking control represents an effect like Control Magic -- open to anyone on anyone's
  // permanent, same trust model as targeting, since the whole point is acting on someone else's
  // card. The true owner is remembered (only on the FIRST hand-off, so a card that changes hands
  // more than once still remembers who it originally belonged to) so returnControl can hand it
  // back later; how long the effect actually lasts isn't tracked automatically, same as every
  // other effect duration in this app -- players return it manually when it should end.
  socket.on("takeControl", (id) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    const card = lobby && lobby.cards[id];
    if (!p || !card || card.owner === socket.id || card.zoneType === "hand" || card.zoneType === "stack") return;
    if (card.originalOwner === null) card.originalOwner = card.owner;
    const prevOwner = lobby.players[card.owner];
    card.owner = socket.id;
    card.ownerColor = p.color;
    // Changing control resets summoning sickness for the new controller, same as a freshly cast
    // creature -- real Magic treats a stolen creature as sick until your next turn too.
    card.controllerSince = lobby.turn.started ? lobby.turn.turnNumber : 0;
    broadcastCard(lobby, card);
    pushLog(lobby, `${p.name} took control of ${card.name || "a card"}${prevOwner ? ` from ${prevOwner.name}` : ""}`);
  });

  socket.on("returnControl", (id) => {
    const lobby = currentLobby(); if (!lobby) return;
    const card = lobby.cards[id];
    if (!card || !card.originalOwner || (card.owner !== socket.id && card.originalOwner !== socket.id)) return;
    const trueOwner = lobby.players[card.originalOwner];
    if (!trueOwner) return; // the real owner isn't seated anymore -- nowhere sensible to send it back to
    card.owner = card.originalOwner;
    card.ownerColor = trueOwner.color;
    card.originalOwner = null;
    card.controllerSince = lobby.turn.started ? lobby.turn.turnNumber : 0;
    broadcastCard(lobby, card);
    pushLog(lobby, `${trueOwner.name} got ${card.name || "a card"} back`);
  });

  // Represents an effect like Clone -- a fresh token sharing the target's current PRINTED
  // characteristics (name/type/P/T/text/keywords/colors), not its counters, attachments, or any
  // equipment-derived bonus -- matching how a real copy effect works. Available on anyone's
  // permanent, same trust model as Target, except a face-down card that isn't the copier's own:
  // the server always holds the real data regardless of faceDown (only the outbound broadcast to
  // other players masks it), so allowing that would let a player materialize a duplicate of an
  // opponent's hidden card with its real name/text/image, leaking exactly the information a
  // face-down card exists to hide.
  socket.on("copyCard", (id) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    const original = lobby && lobby.cards[id];
    if (!p || !original || original.zoneType === "hand" || original.zoneType === "stack") return;
    if (original.faceDown && original.owner !== socket.id) return;
    if (Object.keys(lobby.cards).length >= MAX_CARDS_PER_LOBBY) { socket.emit("actionError", "This table has hit its card limit — clean up unused tokens before copying more."); return; }
    const copy = spawnBattlefieldCard(lobby, {
      name: original.name, img: original.img, type: original.type, manaCost: original.manaCost,
      cmc: original.cmc, colors: original.colors, colorIdentity: original.colorIdentity,
      power: original.power, toughness: original.toughness, loyalty: original.loyalty,
      text: original.text, keywords: original.keywords, producedMana: original.producedMana,
      owner: socket.id, faceDown: false, zoneType: original.zoneType, isCommander: false
    });
    pushLog(lobby, `${p.name} created a copy of ${original.name || "a card"}`);
    fireEtbTriggers(lobby, copy);
  });

  socket.on("removeCard", (id) => {
    const lobby = currentLobby(); if (!lobby) return;
    const card = lobby.cards[id];
    // A card on the stack can't be removed this way -- lobby.stack still holds the same object
    // reference and has no idea it's gone, which would double-process it when it resolves.
    if (!card || card.owner !== socket.id || card.zoneType === "stack") return;
    delete lobby.cards[id];
    if (lobby.targets[id]) { delete lobby.targets[id]; broadcastTargets(lobby); }
    io.to(lobby.id).emit("cardRemove", id);
    clearCommanderRef(lobby, card);
    detachDependents(lobby, card);
  });

  // Deliberate "this permanent is being bounced/returned to hand" action — represents a bounce
  // effect or similar, since there's no general rule that lets a permanent just go back to hand.
  socket.on("toHand", (id) => {
    const lobby = currentLobby(); if (!lobby) return;
    const card = lobby.cards[id];
    const p = lobby.players[socket.id];
    if (!card || !p || card.owner !== socket.id || card.zoneType === "hand" || card.zoneType === "stack") return;
    delete lobby.cards[id];
    if (lobby.targets[id]) { delete lobby.targets[id]; broadcastTargets(lobby); }
    io.to(lobby.id).emit("cardRemove", id);
    clearCommanderRef(lobby, card);
    detachDependents(lobby, card);
    // Bounces to its true OWNER's hand, not the current controller's -- a stolen permanent still
    // belongs to whoever it was taken from.
    const destOwnerId = card.originalOwner || card.owner;
    const destOwner = lobby.players[destOwnerId];
    spawnBattlefieldCard(lobby, { ...toEntry(card), owner: destOwnerId, faceDown: true, zoneType: "hand" });
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} returned ${card.name || "a face-down card"} to ${destOwner ? destOwner.name + "'s" : "their"} hand`);
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

  // A separate handler from toggleTarget on purpose -- toggleTarget is a purely cosmetic, unlinked
  // "anyone can ring the bell on any card" annotation, never consumed by resolution logic. This one
  // resolves a SPECIFIC pending triggered ability's real target and actually pushes it to the stack.
  socket.on("chooseTargetFor", ({ id, targetId }) => {
    const lobby = currentLobby(); if (!lobby) return;
    const idx = lobby.pendingTargetChoices.findIndex((c) => c.id === id);
    if (idx === -1) return;
    const entry = lobby.pendingTargetChoices[idx];
    if (entry.controllerId !== socket.id) return; // only the controller who's actually being prompted may answer
    const resolved = resolveChosenTarget(lobby, entry, targetId);
    if (!resolved.ok) { socket.emit("actionError", resolved.error); return; }
    lobby.pendingTargetChoices.splice(idx, 1);
    // Modal spell: the "target" just chosen is actually a MODE INDEX, not a real target -- pick
    // that mode's own effects and either queue a REAL target choice for it (if that mode needs
    // one) or cast straight to the stack (if it doesn't), instead of the generic chosenTargetId
    // baking-in below, which doesn't apply here at all.
    if (entry.kind === "chooseMode") {
      const mode = entry.modes[parseInt(targetId, 10)];
      socket.emit("targetChoiceResolved", id);
      if (mode.requiresTarget) {
        // Brokers Charm's "Destroy target enchantment" mode (targetKind:"typeList") surfaced a
        // real gap here: this branch used to forward only targetKind, silently dropping
        // typeFilter/minCmc -- fields resolveChosenTarget's typeList/permanent branches need to
        // validate the target at all. The top-level castSpell requiresTarget branch just above
        // already forwards both; a mode needs the exact same fields for the exact same reason.
        queueTargetChoice(lobby, {
          kind: "castSpell", controllerId: entry.controllerId, spellCard: entry.spellCard, sourceCard: entry.spellCard,
          label: mode.label, effects: mode.effects, targetKind: mode.targetKind,
          minCmc: mode.minCmc || null, typeFilter: mode.typeFilter || null, logSuffix: entry.logSuffix || ""
        });
      } else {
        entry.spellCard._resolvedSpellEffects = mode.effects;
        pushToStack(lobby, entry.spellCard, entry.controllerId);
        const owner = lobby.players[entry.controllerId];
        if (owner) pushLog(lobby, `${owner.name} cast ${entry.spellCard.name || "a spell"}${entry.logSuffix || ""}`);
      }
      if (lobby.pendingTargetChoices.length > 0) promptTargetChoice(lobby, lobby.pendingTargetChoices[0]);
      return;
    }
    const effects = entry.effects.map((e) => ({ ...e, chosenTargetId: targetId }));
    if (entry.kind === "castSpell") {
      // Target chosen as part of casting, matching real Magic -- the prompt fires immediately when
      // the spell is cast, not whenever it happens to resolve. The spell goes on the stack with its
      // chosen target baked into _resolvedSpellEffects so resolveStackTop just runs it directly
      // later, no second prompt.
      entry.spellCard._resolvedSpellEffects = effects;
      pushToStack(lobby, entry.spellCard, entry.controllerId);
      const owner = lobby.players[entry.controllerId];
      if (owner) pushLog(lobby, `${owner.name} cast ${entry.spellCard.name || "a spell"}${entry.logSuffix || ""}`);
    } else {
      pushAbilityToStack(lobby, { sourceCard: entry.sourceCard, controllerId: entry.controllerId, label: entry.label, effects });
    }
    socket.emit("targetChoiceResolved", id);
    if (lobby.pendingTargetChoices.length > 0) promptTargetChoice(lobby, lobby.pendingTargetChoices[0]);
  });

  // A manual escape hatch for a pending target choice -- real Magic auto-fizzles a triggered
  // ability the instant it has zero legal targets (CR 603.3c), which this app doesn't check for
  // when queuing one, so a player could otherwise be stuck forever facing a choice with no target
  // they're actually able to satisfy (or one they simply don't want to pay attention to). A
  // castSpell-kind entry needs no cleanup -- the card just stays sitting in hand, never having left
  // it (see castSpell); any other kind is a triggered ability that just never resolves, same as a
  // real one with no legal target would.
  socket.on("cancelTargetChoice", (id) => {
    const lobby = currentLobby(); if (!lobby) return;
    const idx = lobby.pendingTargetChoices.findIndex((c) => c.id === id);
    if (idx === -1) return;
    const entry = lobby.pendingTargetChoices[idx];
    if (entry.controllerId !== socket.id) return;
    lobby.pendingTargetChoices.splice(idx, 1);
    const who = lobby.players[socket.id] ? lobby.players[socket.id].name : "Someone";
    pushLog(lobby, `${who} canceled: ${entry.label}`);
    socket.emit("targetChoiceResolved", id);
    if (lobby.pendingTargetChoices.length > 0) promptTargetChoice(lobby, lobby.pendingTargetChoices[0]);
  });

  // A player choosing to PAY an optional-payment cost (Smothering Tithe, Esper Sentinel, Rakdos
  // Patron of Chaos) -- see queueOptionalPayment. Only the addressed player (entry.playerId) may
  // answer their own prompt. A sacrifice-shaped cost (Rakdos) queues real target choices (of the
  // payer's OWN permanents) to complete it -- reusing the existing target-choice engine rather than
  // a parallel "pick N cards" mechanism.
  socket.on("payOptionalCost", (id) => {
    const lobby = currentLobby(); if (!lobby) return;
    const idx = lobby.pendingOptionalPayments.findIndex((e) => e.id === id);
    if (idx === -1) return;
    const entry = lobby.pendingOptionalPayments[idx];
    if (entry.playerId !== socket.id) return;
    const p = lobby.players[socket.id];
    if (entry.cost && entry.cost.mana) {
      const remaining = canAffordAndPay(p.mana, parseManaCost(entry.cost.mana), 0);
      if (!remaining) { socket.emit("actionError", "Not enough mana to pay this cost."); return; }
      p.mana = remaining;
      broadcastPlayers(lobby);
    }
    if (entry.cost && entry.cost.life) {
      // Real Magic never blocks paying life as a cost, even at 1 or below -- same precedent as
      // fetchlands' cost.life.
      applyLifeLoss(lobby, socket.id, entry.cost.life);
      checkEliminations(lobby);
      broadcastPlayers(lobby);
    }
    lobby.pendingOptionalPayments.splice(idx, 1);
    pushLog(lobby, `${p ? p.name : "Someone"} paid for: ${entry.label}`);
    socket.emit("optionalPaymentResolved", id);
    if (entry.cost && entry.cost.sacrificeCount) {
      for (let i = 0; i < entry.cost.sacrificeCount; i++) {
        queueTargetChoice(lobby, {
          controllerId: socket.id, sourceCard: entry.sourceCard,
          label: `${entry.label} — choose a permanent to sacrifice`, effects: [{ type: "sacrificeTarget" }], targetKind: "ownPermanent"
        });
      }
    }
    promptNextOptionalPayment(lobby, socket.id);
  });
  // Declining an optional-payment cost -- runs its real consequence (the ability's controller
  // benefits), same "real Magic auto-resolves the 'if not' branch" behavior the card text describes.
  socket.on("declineOptionalCost", (id) => {
    const lobby = currentLobby(); if (!lobby) return;
    const idx = lobby.pendingOptionalPayments.findIndex((e) => e.id === id);
    if (idx === -1) return;
    const entry = lobby.pendingOptionalPayments[idx];
    if (entry.playerId !== socket.id) return;
    lobby.pendingOptionalPayments.splice(idx, 1);
    const who = lobby.players[socket.id] ? lobby.players[socket.id].name : "Someone";
    pushLog(lobby, `${who} declined to pay for: ${entry.label}`);
    socket.emit("optionalPaymentResolved", id);
    if (entry.declinedEffects && entry.declinedEffects.length && entry.sourceCard) {
      pushAbilityToStack(lobby, { sourceCard: entry.sourceCard, controllerId: entry.controllerId, label: `${entry.label} (declined)`, effects: entry.declinedEffects });
    }
    promptNextOptionalPayment(lobby, socket.id);
  });

  // ---- zone transitions: battlefield -> graveyard/exile/library (owner only) ----

  function moveOut(lobby, cardId, zone, pos) {
    const card = lobby.cards[cardId];
    // A card on the stack can't be moved this way -- lobby.stack still holds the same object
    // reference and has no idea it's gone, which would double-process it when it resolves.
    if (!card || card.owner !== socket.id || card.zoneType === "stack") return;
    // Only the current controller can decide to move it, but it goes to its true OWNER's zone --
    // a stolen permanent still belongs to whoever it was taken from.
    const owner = card.originalOwner || card.owner;
    // A manual "move to graveyard" click is how removal-spell/wrath-style death gets represented in
    // this app (there's no automated spell-effect execution) -- covering only combat-lethal death
    // would silently miss the majority of actual EDH deaths. Only fires for something that was
    // really on the battlefield -- discarding a hand card or moving an exiled card isn't a death.
    if (zone === "graveyard" && ["creature", "artifact", "mana"].includes(card.zoneType)) {
      fireDeathTriggers(lobby, card);
    }
    delete lobby.cards[cardId];
    if (lobby.targets[cardId]) { delete lobby.targets[cardId]; broadcastTargets(lobby); }
    io.to(lobby.id).emit("cardRemove", cardId);
    clearCommanderRef(lobby, card);
    detachDependents(lobby, card);
    if (!lobby.players[owner]) return;
    const ownerName = lobby.players[owner].name;
    // Same Command Zone replacement sendToGraveyardInternal/exileCardInternal apply automatically
    // (CR 903.9a) -- this is the separate manual "send to zone" path (right-click, or the
    // combat-lethal branch just above), so it needs the same check rather than only ever leaving a
    // commander stuck-looking in the graveyard when moved there this way.
    if (card.isCommander && (zone === "graveyard" || zone === "exile")) {
      broadcastPlayers(lobby);
      pushLog(lobby, `${ownerName}'s ${card.name || "commander"} returned to the Command Zone`);
      return;
    }
    const entry = toEntry(card);
    if (zone === "graveyard") lobby.players[owner].graveyard.push(entry);
    else if (zone === "exile") lobby.players[owner].exile.push(entry);
    else if (zone === "library") {
      if (pos === "top") lobby.players[owner].library.unshift(entry);
      else lobby.players[owner].library.push(entry);
    }
    broadcastPlayers(lobby);
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
    const card = spawnBattlefieldCard(lobby, { ...entry, owner: socket.id, faceDown: false, zoneType: classifyType(entry.type) });
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} returned ${entry.name} to the battlefield`);
    fireEtbTriggers(lobby, card);
  });

  socket.on("zoneToHand", ({ zone, index }) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p || !p[zone] || !p[zone][index]) return;
    const entry = p[zone].splice(index, 1)[0];
    spawnBattlefieldCard(lobby, { ...entry, owner: socket.id, faceDown: true, zoneType: "hand" });
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} returned a card to their hand`);
  });

  // Manual cleanup tool for a commander sitting in the graveyard/exile from before
  // sendToGraveyardInternal/exileCardInternal/moveOut started redirecting it to the Command Zone
  // automatically -- clearCommanderRef already reset its battlefieldId to null the moment it left
  // the battlefield, so the Command Zone dock has been castable this whole time regardless; this
  // just removes the now-redundant, confusing-looking duplicate sitting in the zone list.
  socket.on("commanderToCommandZone", ({ zone, index }) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p || (zone !== "graveyard" && zone !== "exile") || !p[zone] || !p[zone][index]) return;
    const entry = p[zone][index];
    if (!entry.isCommander) return;
    p[zone].splice(index, 1);
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} moved ${entry.name || "their commander"} from ${zone} to the Command Zone`);
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

  // Purely informational -- doesn't restrict anything or reveal what was seen, just lets everyone
  // else know a library was browsed, for the same trust/transparency reason a real table would
  // notice you flipping through your deck.
  socket.on("browsedLibrary", () => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p) return;
    pushLog(lobby, `${p.name} looked through their library`);
  });

  socket.on("drawSpecific", (index) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p || !p.library[index]) return;
    const entry = p.library.splice(index, 1)[0];
    spawnBattlefieldCard(lobby, { ...entry, owner: socket.id, faceDown: true, zoneType: "hand" });
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} searched their library for a card`);
    fireOpponentSearchTrigger(lobby, socket.id);
  });

  // Answers a pending EFFECTS.searchLandTypes prompt (a fetchland) -- validates the chosen library
  // card is actually a legal fetch target (a land whose type line contains one of the wanted basic
  // types, and "basic land" specifically for a painless fetch like Evolving Wilds) before pulling it
  // onto the battlefield, same placement path zoneToBattlefield already uses. spawnBattlefieldCard's
  // own entersTapped check already handles a fetched shockland's own "unless you pay life" text
  // correctly on its own; forceTapped only applies an ADDITIONAL forced-tapped rule from the fetch
  // effect itself (Evolving Wilds-style), on top of whatever the fetched card would already do.
  socket.on("fetchLand", (index) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p || !p.pendingFetch || !p.library[index]) return;
    const entry = p.library[index];
    const typeLower = (entry.type || "").toLowerCase();
    const matchesType = typeLower.includes("land") && p.pendingFetch.types.some((t) => typeLower.includes(t.toLowerCase()));
    const matchesBasic = !p.pendingFetch.basicOnly || typeLower.includes("basic");
    if (!matchesType || !matchesBasic) { socket.emit("actionError", `${entry.name || "That card"} doesn't match what you're searching for.`); return; }
    p.library.splice(index, 1);
    shuffle(p.library);
    const card = spawnBattlefieldCard(lobby, { ...entry, owner: socket.id, faceDown: false, zoneType: classifyType(entry.type) });
    if (p.pendingFetch.forceTapped && !card.tapped) { card.tapped = true; broadcastCard(lobby, card); }
    // Fabled Passage -- "then if you control four or more lands, untap that land." Counted AFTER
    // the fetched land is already on the battlefield, so it counts itself, same as real Magic.
    const untapThreshold = p.pendingFetch.untapIfLandCountAtLeast;
    if (untapThreshold && card.tapped) {
      const landCount = Object.values(lobby.cards).filter((c) => c.owner === socket.id && c.zoneType === "mana").length;
      if (landCount >= untapThreshold) { card.tapped = false; broadcastCard(lobby, card); }
    }
    const thenEffects = p.pendingFetch.thenEffects;
    const sourceCardId = p.pendingFetch.sourceCardId;
    p.pendingFetch = null;
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} searched their library for ${entry.name}`);
    fireOpponentSearchTrigger(lobby, socket.id);
    fireEtbTriggers(lobby, card);
    // Cultivate's own "...and the other into your hand" -- see searchLandTypes' comment for why
    // this can't just be a sibling effect in the original effects array.
    if (thenEffects) {
      const ctx = { controllerId: socket.id, sourceCard: sourceCardId ? { id: sourceCardId } : null };
      thenEffects.forEach((e) => { const fn = EFFECTS[e.type]; if (fn) fn(lobby, ctx, e); });
    }
  });

  // Search is always optional in real Magic, even with a legal target sitting right there --
  // "find nothing" still shuffles (you looked through the whole library either way).
  socket.on("cancelFetch", () => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p || !p.pendingFetch) return;
    shuffle(p.library);
    p.pendingFetch = null;
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} found nothing`);
    fireOpponentSearchTrigger(lobby, socket.id);
  });

  // Answers a pending EFFECTS.tutorToHand prompt (Demonic Tutor and similar) -- same shape as
  // fetchLand just above, landing in hand instead of onto the battlefield. A null typeFilter means
  // "any card" (Demonic/Grim Tutor); a real one is a plain substring match against the type line
  // (e.g. "land" for Weathered Wayfarer, "demon" for Demonic Counsel/Rune-Scarred Demon).
  socket.on("tutorCard", (index) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p || !p.pendingTutor || !p.library[index]) return;
    const entry = p.library[index];
    const typeLower = (entry.type || "").toLowerCase();
    if (p.pendingTutor.typeFilter && !typeLower.includes(p.pendingTutor.typeFilter.toLowerCase())) {
      socket.emit("actionError", `${entry.name || "That card"} doesn't match what you're searching for.`);
      return;
    }
    p.library.splice(index, 1);
    const { toTopOfLibrary: toTop, toGraveyard, thenEffects, sourceCardId } = p.pendingTutor;
    shuffle(p.library);
    if (toTop) {
      p.library.unshift(entry);
      pushLog(lobby, `${p.name} searched their library and put a card on top`);
    } else if (toGraveyard) {
      p.graveyard.push(entry);
      pushLog(lobby, `${p.name} searched their library for ${entry.name} and put it into their graveyard`);
    } else {
      spawnBattlefieldCard(lobby, { ...entry, owner: socket.id, faceDown: true, zoneType: "hand" });
      pushLog(lobby, `${p.name} searched their library for ${entry.name}`);
    }
    p.pendingTutor = null;
    broadcastPlayers(lobby);
    fireOpponentSearchTrigger(lobby, socket.id);
    if (thenEffects) {
      const ctx = { controllerId: socket.id, sourceCard: sourceCardId ? { id: sourceCardId } : null };
      thenEffects.forEach((e) => { const fn = EFFECTS[e.type]; if (fn) fn(lobby, ctx, e); });
    }
  });
  // Answers a pending EFFECTS.scryN prompt. keepIndices is the FINAL top-to-bottom order (each a
  // real index into the original top-N slice) of cards being kept on top -- anything from that
  // slice NOT listed goes to the bottom, in their original relative order (see scryN's own comment
  // for why). An index appearing twice, or out of range, is just filtered out rather than erroring --
  // there's no way for a legitimate client to send that, so silently ignoring it is enough.
  socket.on("resolveScry", ({ keepIndices }) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p || !p.pendingScry) return;
    const { count: n, thenEffects, sourceCardId } = p.pendingScry;
    const top = p.library.slice(0, n);
    const rest = p.library.slice(n);
    const seen = new Set();
    const keepOrder = (Array.isArray(keepIndices) ? keepIndices : []).filter((i) => Number.isInteger(i) && i >= 0 && i < n && !seen.has(i) && seen.add(i));
    const keep = keepOrder.map((i) => top[i]);
    const toBottom = top.filter((_, i) => !seen.has(i));
    p.library = [...keep, ...rest, ...toBottom];
    p.pendingScry = null;
    pushLog(lobby, `${p.name} finished scrying`);
    // Run any bundled follow-up (Preordain/Ponder's own "then draw a card") now, AFTER the reorder
    // is actually applied -- see scryN's own comment for why this can't just be a sibling effect.
    if (thenEffects) {
      const ctx = { controllerId: socket.id, sourceCard: sourceCardId ? { id: sourceCardId } : null };
      thenEffects.forEach((e) => { const fn = EFFECTS[e.type]; if (fn) fn(lobby, ctx, e); });
    }
    broadcastPlayers(lobby);
  });
  // Surveil's own resolve handler -- same index-based "keep on top" selection as resolveScry, but
  // whatever's NOT kept goes to the graveyard instead of the bottom of the library.
  socket.on("resolveSurveil", ({ keepIndices }) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p || !p.pendingSurveil) return;
    const { count: n, thenEffects, sourceCardId } = p.pendingSurveil;
    const top = p.library.slice(0, n);
    const rest = p.library.slice(n);
    const seen = new Set();
    const keepOrder = (Array.isArray(keepIndices) ? keepIndices : []).filter((i) => Number.isInteger(i) && i >= 0 && i < n && !seen.has(i) && seen.add(i));
    const keep = keepOrder.map((i) => top[i]);
    const toGraveyard = top.filter((_, i) => !seen.has(i));
    p.library = [...keep, ...rest];
    p.graveyard = [...(p.graveyard || []), ...toGraveyard];
    p.pendingSurveil = null;
    pushLog(lobby, `${p.name} finished surveilling`);
    if (thenEffects) {
      const ctx = { controllerId: socket.id, sourceCard: sourceCardId ? { id: sourceCardId } : null };
      thenEffects.forEach((e) => { const fn = EFFECTS[e.type]; if (fn) fn(lobby, ctx, e); });
    }
    broadcastPlayers(lobby);
  });
  socket.on("cancelTutor", () => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p || !p.pendingTutor) return;
    shuffle(p.library);
    p.pendingTutor = null;
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} found nothing`);
    fireOpponentSearchTrigger(lobby, socket.id);
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

  // The very first draw only -- once used it's gone from the UI (openingHandDrawn), so this can't
  // be clicked again later to silently wipe an in-progress mulligan count back to 0. Any redraw
  // after this one goes through "mulligan" instead, which correctly keeps counting up.
  socket.on("drawOpeningHand", () => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p || p.openingHandDrawn) return;
    returnAllHandToLibrary(lobby, socket.id);
    shuffle(p.library);
    drawN(lobby, socket.id, 7);
    p.openingHandDrawn = true;
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
    p.openingHandDrawn = true;
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} took a mulligan (${p.mulligans}/2)`);
  });

  socket.on("keepHand", () => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p) return;
    p.handKept = true;
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} kept their hand and is ready`);
    beginTurnFlowOnceHandsReady(lobby);
  });

  // ---- persistent decks (account-scoped, not lobby-scoped) ----

  socket.on("saveDeck", ({ name, commanders, library }) => {
    name = (name || "").toString().trim().slice(0, 40);
    if (!name || UNSAFE_OBJECT_KEYS.has(name)) return;
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

  // ---- personal "I own this in real life" collection (account-scoped, independent of any deck) ----

  // Toggle, not a separate add/remove pair -- a card row's checkbox always reflects "is this
  // already in my collection," so one event that flips whichever way it currently isn't covers
  // both directions without the client needing to know which one to send.
  socket.on("toggleCollectionCard", (data) => {
    const key = archiveKey(data && data.name);
    if (!key || UNSAFE_OBJECT_KEYS.has(key)) return;
    if (!collection[username]) collection[username] = {};
    if (collection[username][key]) {
      delete collection[username][key];
    } else {
      // Only the display fields -- this isn't a second copy of the card archive, just enough to
      // render a row in the collection list without a card actually being on any board/deck.
      collection[username][key] = { name: sanitizeCardStr(data.name, 200), type: sanitizeCardStr(data.type || "", 100), img: sanitizeImgUrl(data.img) };
    }
    saveCollection();
    socket.emit("collectionUpdated", collection[username]);
  });

  // ---- saved board mats (account-scoped, like decks -- distinct from the per-table active
  // boardMat on lobby.players, which is unaffected by any of this) ----

  socket.on("saveMat", ({ name, url }) => {
    name = (name || "").toString().trim().slice(0, 40);
    const clean = sanitizeImgUrl(url);
    if (!name || !clean || UNSAFE_OBJECT_KEYS.has(name)) return;
    if (!mats[username]) mats[username] = {};
    mats[username][name] = clean;
    saveMats();
    socket.emit("matList", mats[username]);
  });

  socket.on("deleteMat", (name) => {
    if (!mats[username]) return;
    const url = mats[username][name];
    delete mats[username][name];
    saveMats();
    socket.emit("matList", mats[username]);
    if (url) deleteUploadIfOrphaned(url, username);
  });

  // ---- saved pile art (account-scoped, mirrors saved board mats above) -- stores the full crop
  // (url + scale/x/y), not just a bare URL, since re-applying a pile-art preset should bring its
  // framing back too, not force re-cropping the same photo again on every table. ----

  socket.on("savePileMat", ({ name, url, scale, x, y } = {}) => {
    name = (name || "").toString().trim().slice(0, 40);
    const clean = sanitizeImgUrl(url);
    if (!name || !clean || UNSAFE_OBJECT_KEYS.has(name)) return;
    if (!pileMats[username]) pileMats[username] = {};
    pileMats[username][name] = { url: clean, ...sanitizeImgFit({ scale, x, y }) };
    savePileMats();
    socket.emit("pileMatList", pileMats[username]);
  });

  socket.on("deletePileMat", (name) => {
    if (!pileMats[username]) return;
    const entry = pileMats[username][name];
    delete pileMats[username][name];
    savePileMats();
    socket.emit("pileMatList", pileMats[username]);
    if (entry && entry.url) deleteUploadIfOrphaned(entry.url, username);
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
    const automatedCount = p.library.filter((c) => isCardAutomated(c.name)).length + (deck.commanders || []).filter((c) => c && isCardAutomated(c.name)).length;
    socket.emit("importResult", { success: true, requested: p.library.length, found: p.library.length });
    pushLog(lobby, `${p.name} loaded deck "${name}" (${p.library.length} cards${cmdCount ? ` + ${cmdCount} commander${cmdCount > 1 ? "s" : ""}` : ""} — ${automatedCount} with some automation)`);
  });

  // Resolves a pasted decklist to full card data for the deck editor, without touching the
  // live game — the editor decides what to do with the result (add to its working library).
  // Not lobby-scoped — the editor works whether or not you're at a table.
  socket.on("resolveDeckPaste", async (text) => {
    try {
      // Uncapped first, THEN trimmed here (rather than passing 99 straight to parseDecklistNames,
      // which truncates internally with no way to tell afterward how many there really were) --
      // a pasted list frequently still has its commander header line still in it despite the
      // textarea's own placeholder saying not to (a real full decklist export naturally starts
      // with one), which silently pushed the true count to 100 and dropped the very LAST card with
      // zero indication anything was cut. Same truncation-visibility fix as importDeckFromUrl (PR
      // #86) for the same reason.
      const wanted = parseDecklistNames(text, 9999);
      if (wanted.length === 0) { socket.emit("deckPasteResult", { success: false, error: "Nothing parsed from that list." }); return; }
      const trueTotal = wanted.length;
      if (wanted.length > 99) wanted.length = 99;
      const found = await resolveCardNames(wanted);
      socket.emit("deckPasteResult", { success: true, requested: wanted.length, found, truncatedFrom: trueTotal > 99 ? trueTotal : null });
    } catch (e) {
      socket.emit("deckPasteResult", { success: false, error: "Resolve failed — check your connection and try again." });
    }
  });

  // Moxfield sits behind Cloudflare bot-detection that specifically fingerprints (almost
  // certainly via TLS/JA3, not headers -- an identical request with an identical User-Agent
  // succeeds from curl and gets a Cloudflare "Attention Required" 403 from Node's own fetch)
  // Node's own HTTP client and blocks it outright, confirmed via direct testing. Shelling out to
  // the system's real `curl` binary (installed in the Docker image specifically for this) routes
  // around that fingerprint since it presents curl's own TLS handshake instead of Node's. `url` is
  // untrusted (comes straight from the player's paste), so it's passed as its own execFile argument
  // -- never interpolated into a shell string -- to rule out command injection.
  function curlJson(url, headers) {
    return new Promise((resolve, reject) => {
      const args = ["-s", "-L", "--max-time", "10"];
      for (const k in headers) args.push("-H", `${k}: ${headers[k]}`);
      args.push(url);
      execFile("curl", args, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
        if (err) { reject(err); return; }
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
      });
    });
  }

  // Best-effort import from a Moxfield or Archidekt deck URL. Both are unofficial, undocumented
  // endpoints that could change or break without notice. Feeds the resulting card names into the
  // exact same pipeline as resolveDeckPaste above, and reuses its result event so the client needs
  // no new handler -- with one addition, `commanders`, since (unlike a plain paste, which has no
  // structured commander info at all) both sites DO tell us exactly which card(s) are the
  // commander, and the client uses that to auto-fill the Commander slots instead of dumping them
  // into the library like every other found card.
  socket.on("importDeckFromUrl", async (rawUrl) => {
    const fallbackMsg = "Couldn't import from that URL — try pasting the decklist directly instead.";
    try {
      const url = new URL((rawUrl || "").trim());
      const host = url.hostname.replace(/^www\./, "").toLowerCase();
      const commanderNames = [], libraryNames = [];
      if (host === "archidekt.com") {
        const m = url.pathname.match(/\/decks\/(\d+)/);
        if (!m) { socket.emit("deckPasteResult", { success: false, error: fallbackMsg }); return; }
        const r = await fetch(`https://archidekt.com/api/decks/${m[1]}/`, { headers: { "User-Agent": "Archon/1.0" } });
        if (!r.ok) { socket.emit("deckPasteResult", { success: false, error: fallbackMsg }); return; }
        const data = await r.json();
        // Archidekt lets a deck define its own categories (Sideboard, Maybeboard, custom labels
        // like "Ramp"/"Removal", ...), each independently flagged includedInDeck true/false --
        // that flag, not the category NAME, is the real signal for "is this actually part of the
        // deck." A card tagged into ANY excluded category (Maybeboard being the common one) is
        // left out entirely, even if it's also tagged into an included category. Previously this
        // pulled every single card regardless of category, which silently mixed maybeboard/cut
        // cards into the import.
        const excludedCategories = new Set((data.categories || []).filter((c) => c.includedInDeck === false).map((c) => c.name));
        (data.cards || []).forEach((entry) => {
          const cats = entry.categories || [];
          if (cats.some((c) => excludedCategories.has(c))) return;
          const name = entry.card && entry.card.oracleCard && entry.card.oracleCard.name;
          if (!name) return;
          const qty = entry.quantity || 1;
          const bucket = cats.includes("Commander") ? commanderNames : libraryNames;
          for (let i = 0; i < qty; i++) bucket.push(name);
        });
      } else if (host === "moxfield.com") {
        const m = url.pathname.match(/\/decks\/([A-Za-z0-9_-]+)/);
        if (!m) { socket.emit("deckPasteResult", { success: false, error: fallbackMsg }); return; }
        let data;
        try {
          data = await curlJson(`https://api2.moxfield.com/v3/decks/all/${m[1]}`, {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
            "Accept": "application/json"
          });
        } catch (e) {
          socket.emit("deckPasteResult", { success: false, error: fallbackMsg });
          return;
        }
        const boards = data.boards || {};
        for (const boardName of ["commanders", "mainboard"]) {
          const cards = (boards[boardName] && boards[boardName].cards) || {};
          const bucket = boardName === "commanders" ? commanderNames : libraryNames;
          for (const key in cards) {
            const entry = cards[key];
            const name = entry.card && entry.card.name;
            const qty = entry.quantity || 1;
            if (name) for (let i = 0; i < qty; i++) bucket.push(name);
          }
        }
      } else {
        socket.emit("deckPasteResult", { success: false, error: "Only Moxfield and Archidekt deck URLs are supported — try pasting the decklist directly instead." });
        return;
      }
      if (commanderNames.length === 0 && libraryNames.length === 0) { socket.emit("deckPasteResult", { success: false, error: fallbackMsg }); return; }
      // The 99-card cap only ever applies to the library -- commanders live in their own slots on
      // the client and were never counted against it anywhere else in this app either.
      const trueTotal = libraryNames.length;
      if (libraryNames.length > 99) libraryNames.length = 99;
      const [commanders, found] = await Promise.all([resolveCardNames(commanderNames.slice(0, 2)), resolveCardNames(libraryNames)]);
      socket.emit("deckPasteResult", { success: true, requested: libraryNames.length, found, commanders, truncatedFrom: trueTotal > 99 ? trueTotal : null });
    } catch (e) {
      socket.emit("deckPasteResult", { success: false, error: fallbackMsg });
    }
  });

  // Loads a deck's raw saved data into the editor (for the "Edit" button on a saved deck).
  socket.on("getDeckData", (name) => {
    const deck = decks[username] && decks[username][name];
    socket.emit("deckData", { name, data: deck || null });
  });

  // The user's own "card library" for building a new deck -- every unique card (by name) that
  // appears in ANY of their other saved decks (commander slots included), deduplicated, so the
  // Deck Editor can offer "add from what I already have elsewhere" instead of retyping/pasting a
  // full list every time. Independent of the "I own this" collection above -- this reads real
  // saved decklists, not the ownership checklist (see the two-separate-things scoping decision).
  // ---- bug-report tickets (read/closed from the separate admin panel, see admin-server.js) ----

  // Only the display-relevant fields, capped and sanitized the same way every other user-controlled
  // card-shaped payload in this file is (toEntry/spawnBattlefieldCard/toggleCollectionCard all follow
  // this same "just enough to render it back, nothing trusted verbatim" pattern) -- the client sends
  // whatever card/entry object it already has on hand (a battlefield card, a hand card, a graveyard/
  // library/exile row, or a stack item all have slightly different shapes), so this can't assume a
  // single fixed shape and just pulls out the fields that exist.
  function sanitizeTicketCardSnapshot(raw) {
    const c = raw || {};
    return {
      name: sanitizeCardStr(c.name, 200), type: sanitizeCardStr(c.type || "", 100), manaCost: sanitizeCardStr(c.manaCost || "", 50),
      text: sanitizeCardStr(c.text || "", 3000), power: c.power !== undefined ? sanitizeCardStr(String(c.power), 20) : null,
      toughness: c.toughness !== undefined ? sanitizeCardStr(String(c.toughness), 20) : null,
      keywords: Array.isArray(c.keywords) ? c.keywords.slice(0, 30).map((k) => sanitizeCardStr(k, 40)) : [],
      img: sanitizeImgUrl(c.img), zoneType: sanitizeCardStr(c.zoneType || "", 30),
      tapped: !!c.tapped, faceDown: !!c.faceDown, counters: typeof c.counters === "number" ? c.counters : 0
    };
  }
  socket.on("submitTicket", ({ cardSnapshot, description } = {}) => {
    const desc = sanitizeCardStr(description, 2000).trim();
    if (!desc) { socket.emit("actionError", "Describe the bug before submitting."); return; }
    const tickets = loadJSON(TICKETS_FILE, []);
    tickets.unshift({
      id: "t_" + Date.now() + "_" + randInt(100000), username, card: sanitizeTicketCardSnapshot(cardSnapshot),
      description: desc, status: "open", createdAt: Date.now(), closedAt: null
    });
    saveJSON(TICKETS_FILE, tickets);
    socket.emit("ticketSubmitted");
  });
  socket.on("getMyTickets", () => {
    const tickets = loadJSON(TICKETS_FILE, []);
    socket.emit("myTickets", tickets.filter((t) => t.username === username));
  });

  socket.on("getCardPool", () => {
    const seen = {};
    const pool = [];
    Object.values(decks[username] || {}).forEach((deck) => {
      [...(deck.commanders || []).filter(Boolean), ...(deck.library || [])].forEach((c) => {
        const key = archiveKey(c.name);
        if (!key || seen[key]) return;
        seen[key] = true;
        pool.push({ name: c.name, type: c.type || "", img: c.img || "" });
      });
    });
    pool.sort((a, b) => a.name.localeCompare(b.name));
    socket.emit("cardPool", pool);
  });

  // Applies an in-progress editor draft directly to the live game, without requiring a save first.
  socket.on("loadDeckDraft", ({ commanders, library }) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p) return;
    p.library = (Array.isArray(library) ? library : []).slice(0, 99).map((c) => toEntry(c));
    shuffle(p.library);
    applyCommandersToPlayer(p, commanders);
    broadcastPlayers(lobby);
    const automatedCount = p.library.filter((c) => isCardAutomated(c.name)).length + (commanders || []).filter((c) => c && isCardAutomated(c.name)).length;
    pushLog(lobby, `${p.name} loaded a deck draft into the game (${automatedCount} with some automation)`);
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
    // Casting a commander is a cast like any other -- same timing/stack rules, not a bypass.
    const timing = checkTiming(lobby, socket.id, cmd);
    if (!timing.ok) { socket.emit("actionError", timing.error); return; }
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
    // Pregame (no turn.order yet) stays unrestricted like every other cast -- spawnBattlefieldCard
    // already placed it straight on the battlefield, so there's nothing more to do (ETB triggers
    // are pregame-inert anyway, same as everywhere else -- there's no turn.order yet to open a
    // priority round with). Mid-game, the same card object fires ETB later via resolveStackTop
    // once it actually resolves off the stack.
    if (lobby.turn.started) pushToStack(lobby, card, socket.id);
    broadcastPlayers(lobby);
    pushLog(lobby, `${p.name} cast their commander: ${cmd.name} (tax now ${cmd.tax})`);
  });

  // ---- turn structure ----

  socket.on("startGame", () => {
    const lobby = currentLobby(); if (!lobby || !lobby.players[socket.id]) return;
    // Everyone needs an actual deck to draw from before the game can begin -- reject the whole
    // start (not just silently proceed) and name whoever's missing one, so the table knows who
    // to wait on instead of starting into a game where someone has nothing to draw.
    const noDeck = Object.values(lobby.players).filter((p) => p.library.length === 0);
    if (noDeck.length > 0) {
      socket.emit("actionError", `Everyone needs a deck loaded before starting — still waiting on: ${noDeck.map((p) => p.name).join(", ")}.`);
      return;
    }
    // Pregame dice roll decides turn order — everyone rolls a d20, highest goes first, ties
    // broken randomly, and the log shows every roll so it's not just a silent shuffle.
    const rolls = Object.keys(lobby.players).map((sid) => ({ sid, roll: randInt(20) + 1, tiebreak: Math.random() }));
    rolls.sort((a, b) => b.roll - a.roll || b.tiebreak - a.tiebreak);
    rolls.forEach((r) => pushLog(lobby, `${lobby.players[r.sid].name} rolled a ${r.roll} for turn order`));
    lobby.turn.order = rolls.map((r) => r.sid);
    lobby.turn.activeIndex = 0;
    // Starts at Untap (the real first phase of turn 1) rather than jumping straight to Main 1 --
    // Untap's own side effect (reset land drops, untap permanents) is a manual no-op here anyway
    // since a fresh turn 1 has zero permanents and landsPlayedThisTurn is already 0 below. The
    // auto-advance through Upkeep/Draw (which is what makes the player going first actually draw
    // for turn 1 -- see advanceOnePhase's own Draw-phase comment for why that's a deliberate
    // house-rule departure from real Magic) is DELIBERATELY NOT run here -- see
    // beginTurnFlowOnceHandsReady, called from keepHand once every player has kept their opening
    // hand, so that first-turn draw can't land before the Opening Hand prompt has even been seen.
    lobby.turn.phase = "Untap";
    lobby.turn.turnNumber = 1;
    lobby.turn.started = true;
    lobby.turn.phaseStartedAt = Date.now();
    lobby.combat = { step: "none", attackers: {}, blocks: {}, defendersPending: [] };
    lobby.stack = [];
    lobby.priority = { holderId: null, lastActorId: null };
    for (const pid in lobby.players) {
      lobby.players[pid].mana = EMPTY_MANA();
      lobby.players[pid].landsPlayedThisTurn = 0;
    }
    pushLog(lobby, `${lobby.players[lobby.turn.order[0]].name} goes first! Turn order: ${lobby.turn.order.map((id) => (lobby.players[id] ? lobby.players[id].name : "?")).join(" → ")}`);
    broadcastTurn(lobby);
    broadcastCombat(lobby);
    broadcastPlayers(lobby);
  });

  socket.on("nextPhase", () => {
    const lobby = currentLobby(); if (!lobby) return;
    if (!lobby.turn.started) return;
    const activeId = lobby.turn.order[lobby.turn.activeIndex];
    if (activeId !== socket.id) return;
    if (lobby.stack.length > 0) return; // can't advance the turn with something pending on the stack
    if (lobby.turn.pendingDiscard) return; // can't advance past End Step until the discard is resolved
    if (lobby.turn.phase === "End Step") {
      const handCount = Object.values(lobby.cards).filter((c) => c.owner === activeId && c.zoneType === "hand").length;
      if (handCount > 7 && !hasNoMaxHandSize(lobby, activeId)) {
        lobby.turn.pendingDiscard = { playerId: activeId, count: handCount - 7, advanceAfter: true };
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
    const advanceAfter = pd.advanceAfter;
    const discardedCards = ids.map((id) => lobby.cards[id]);
    discardedCards.forEach((card) => sendToGraveyardInternal(lobby, card));
    pushLog(lobby, `${p.name} discarded ${ids.length} card(s)${advanceAfter ? " to hand size" : ""}`);
    // Archfiend of Ifnir-style "whenever you discard a card" -- fired once per card (a multi-card
    // discard, e.g. hand-size cleanup or Mind Rot, is really N separate discard events), covers both
    // this hand-size/pendingDiscard path and any spell/ability-driven discard (they all route
    // through the same targetPlayerDiscards -> pendingDiscard -> resolveDiscard pipeline).
    discardedCards.forEach((card) => fireGlobalTrigger(lobby, "youDiscard", socket.id, card));
    // Connive's own "if you discarded a NONLAND card this way, put a +1/+1 counter on this
    // creature" -- the one piece EFFECTS.connive itself couldn't resolve (it returns long before
    // the player has actually picked a card), so it's tagged onto pendingDiscard and checked here,
    // against what was REALLY discarded, not assumed. sourceCardId may no longer be on the
    // battlefield by now (the connived creature could have died in response) -- a missing lookup is
    // a silent no-op, same as every other "source left before this resolved" case in this file.
    if (pd.connive) {
      const discardedNonland = discardedCards.some((card) => !(card.type || "").toLowerCase().includes("land"));
      if (discardedNonland) {
        const source = lobby.cards[pd.connive.sourceCardId];
        if (source) {
          const bonus = bonusCountersFor(lobby, source.owner);
          const mult = counterMultiplierFor(lobby, source.owner);
          source.counters = (source.counters || 0) + (1 + bonus) * mult;
          broadcastCard(lobby, source);
        }
      }
    }
    lobby.turn.pendingDiscard = null;
    // Real pre-existing bug, caught while building connive (Wave 64): a MID-TURN discard
    // (advanceAfter false -- Mind Rot, Faithless Looting, connive, ...) never told clients
    // pendingDiscard had cleared, since advancePhase's own broadcastTurn only runs for the
    // End-Step-hand-size case below. Every client's discard prompt stayed stuck open (using stale
    // cached turn state) until some UNRELATED broadcastTurn happened to fire later. Broadcasting
    // here unconditionally fixes both paths; advancePhase's own broadcastTurn just redundantly
    // re-sends the (by-then-further-advanced) turn state right after, which is harmless.
    broadcastTurn(lobby);
    // Only the End Step hand-size cleanup (nextPhase's own check, flagged via advanceAfter) should
    // actually move the turn forward once resolved -- a mid-turn discard from a spell effect
    // (Faithless Looting's own "discard two cards," Mind Rot targeting an opponent, etc.) has
    // nothing to do with advancing the turn and must not silently skip straight to the next phase.
    if (advanceAfter) advancePhase(lobby);
  });

  // ---- stack / priority ----

  socket.on("passPriority", () => {
    const lobby = currentLobby(); if (!lobby) return;
    if (lobby.stack.length === 0 || lobby.priority.holderId !== socket.id) return;
    const next = nextInOrder(lobby.turn.order, socket.id);
    if (!next) return; // shouldn't happen with a non-empty stack and a non-empty turn order
    if (next === lobby.priority.lastActorId) {
      resolveStackTop(lobby);
    } else {
      lobby.priority.holderId = next;
      broadcastStack(lobby);
    }
  });

  // Manual "this got countered" tool -- there's no card-text automation anywhere in this app, so
  // a counterspell's effect is represented the same way every other spell effect already is:
  // whoever cast/resolved it (via the normal stack, elsewhere) just applies the outcome directly.
  // Open to anyone, same spirit as targeting ("anyone can Target anything") -- not gated on
  // priority, since by the time you're representing "it got countered" the actual counterspell
  // has already been cast and resolved through the normal flow.
  // Optional `handCardId`: representing the counterspell WITH a real card from your hand -- its
  // mana cost is actually charged (checked BEFORE anything is removed, so an unaffordable pick
  // rejects cleanly and leaves the stack untouched) and the card itself goes to the graveyard,
  // same as any spell that's been cast and resolved. Omitting it keeps the original free/no-card
  // behavior (representing an effect this app has no automation for at all).
  socket.on("counterStackItem", ({ targetId, handCardId } = {}) => {
    const lobby = currentLobby(); if (!lobby) return;
    const p = lobby.players[socket.id];
    if (!p) return;
    let handCard = null;
    if (handCardId) {
      handCard = lobby.cards[handCardId];
      if (!handCard || handCard.owner !== socket.id || handCard.zoneType !== "hand") {
        socket.emit("actionError", "Choose a card from your own hand to pay its cost, or counter for free.");
        return;
      }
      const remaining = canAffordAndPay(p.mana, parseManaCost(handCard.manaCost), 0);
      if (!remaining) { socket.emit("actionError", `Not enough mana to cast ${handCard.name || "that card"}.`); return; }
      p.mana = remaining;
    }
    const card = removeStackItem(lobby, targetId);
    if (!card) return;
    const owner = lobby.players[card.owner];
    const ownerLabel = owner ? `${owner.name}'s ` : "";
    if (handCard) {
      delete lobby.cards[handCard.id];
      io.to(lobby.id).emit("cardRemove", handCard.id);
      p.graveyard.push(toEntry(handCard));
      pushLog(lobby, `${p.name} countered ${ownerLabel}${card.name || "spell"} by casting ${handCard.name || "a card"}`);
    } else {
      pushLog(lobby, `${p.name} countered ${ownerLabel}${card.name || "spell"}`);
    }
    if (lobby.stack.length === 0) {
      lobby.priority.holderId = null;
      lobby.priority.lastActorId = null;
    }
    broadcastPlayers(lobby);
    broadcastStack(lobby);
    socket.emit("counterStackItemResolved");
  });

  // ---- combat ----

  socket.on("declareAttackers", (assignments) => {
    const lobby = currentLobby(); if (!lobby) return;
    if (!lobby.turn.started || lobby.turn.order[lobby.turn.activeIndex] !== socket.id) return;
    if (lobby.stack.length > 0) return; // can't move combat forward with something pending
    if (lobby.combat.step !== "declareAttackers") return;
    // Orim's Chant, kicked -- "creatures can't attack this turn," table-wide.
    if (lobby.creaturesCantAttack && Object.keys(assignments || {}).length > 0) {
      socket.emit("actionError", "Creatures can't attack this turn.");
      return;
    }
    // Kardur, Doomscourge -- "until your next turn, creatures your opponents control attack each
    // combat if able and attack a player other than you if able." Enforced the same way every
    // other restriction in this engine is: reject the WHOLE declaration (nothing tapped yet) if it
    // violates the rule, rather than silently forcing an attack choice for the player -- they still
    // choose WHO to attack, they just can't decline to attack at all, or aim at Kardur's own
    // controller when a different defender is available.
    const activeKardurControllers = (lobby.kardurForcedAttackControllers || []).filter((id) => id !== socket.id && lobby.players[id]);
    if (activeKardurControllers.length) {
      const eligibleIds = Object.values(lobby.cards).filter((c) => {
        if (c.owner !== socket.id || c.zoneType !== "creature" || c.tapped) return false;
        const hasHaste = effectiveKeywords(lobby, c).some((k) => (k || "").toLowerCase() === "haste");
        return !(c.controllerSince === lobby.turn.turnNumber && !hasHaste);
      }).map((c) => c.id);
      const submittedIds = Object.keys(assignments || {});
      const missing = eligibleIds.filter((id) => !submittedIds.includes(id));
      if (missing.length) {
        const names = missing.map((id) => (lobby.cards[id] && lobby.cards[id].name) || "A creature").join(", ");
        socket.emit("actionError", `${names} must attack this combat (Kardur, Doomscourge).`);
        return;
      }
      for (const kardurControllerId of activeKardurControllers) {
        const otherDefenders = Object.keys(lobby.players).filter((pid) => pid !== socket.id && pid !== kardurControllerId);
        if (otherDefenders.length === 0) continue; // no OTHER legal defender exists -- attacking Kardur's controller is fine
        const attacksKardurController = Object.values(assignments || {}).includes(kardurControllerId);
        if (attacksKardurController) {
          socket.emit("actionError", `Your creatures must attack a player other than ${(lobby.players[kardurControllerId] || {}).name || "Kardur's controller"} this combat, if able (Kardur, Doomscourge).`);
          return;
        }
      }
    }
    // First pass: which submitted assignments are even legal attackers at all (unchanged checks),
    // without mutating/tapping anything yet -- the attack-tax total right after needs the FULL
    // legal set to compute correctly, and an unaffordable tax should reject the whole declaration
    // cleanly rather than leaving some creatures tapped and others not.
    const candidateAttackers = {};
    for (const [cardId, defenderId] of Object.entries(assignments || {})) {
      const card = lobby.cards[cardId];
      if (!card || card.owner !== socket.id || card.zoneType !== "creature" || card.tapped) continue;
      const hasHaste = effectiveKeywords(lobby, card).some((k) => (k || "").toLowerCase() === "haste");
      if (card.controllerSince === lobby.turn.turnNumber && !hasHaste) continue; // summoning sick
      if (!lobby.players[defenderId] || defenderId === socket.id) continue;
      candidateAttackers[cardId] = defenderId;
    }
    // Master of Cruelties and its functional cousins -- "This creature can only attack alone."
    // Rejects the WHOLE declaration (nothing tapped/paid yet at this point) rather than silently
    // dropping either the restricted creature or its co-attackers, so the player gets a clear
    // reason and can resubmit rather than being surprised by a partial attack.
    const attackAloneId = Object.keys(candidateAttackers).find((id) => ATTACK_ALONE_CARDS.includes(archiveKey(lobby.cards[id].name)));
    if (attackAloneId && Object.keys(candidateAttackers).length > 1) {
      socket.emit("actionError", `${lobby.cards[attackAloneId].name} can only attack alone.`);
      return;
    }
    // Attack-tax effects (Propaganda and its functional cousins) -- a real static cost to declare
    // an attacker against a player who controls one, owed once per attacking creature per effect.
    const p = lobby.players[socket.id];
    let totalTax = 0;
    for (const defenderId of Object.values(candidateAttackers)) {
      for (const id in lobby.cards) {
        const c = lobby.cards[id];
        if (c.owner === defenderId && c.zoneType !== "hand" && c.zoneType !== "stack") {
          totalTax += ATTACK_TAX_EFFECTS[archiveKey(c.name)] || 0;
        }
      }
    }
    if (totalTax > 0) {
      const paid = canAffordAndPay(p.mana, parseManaCost(`{${totalTax}}`), 0);
      if (!paid) { socket.emit("actionError", `Not enough mana to pay the attack tax (need {${totalTax}} total for these attackers).`); return; }
      p.mana = paid;
      broadcastPlayers(lobby);
      pushLog(lobby, `${p.name} paid {${totalTax}} in attack taxes`);
    }
    const validAttackers = {};
    const defendersSet = new Set();
    for (const [cardId, defenderId] of Object.entries(candidateAttackers)) {
      const card = lobby.cards[cardId];
      validAttackers[cardId] = defenderId;
      defendersSet.add(defenderId);
      // Vigilance (CR 702.21b): attacking doesn't cause this creature to tap. A real, previously
      // unenforced keyword -- effectiveKeywords was already the right shared check (equipment/
      // aura/anthem-granted Vigilance all included for free), it just was never consulted here.
      const hasVigilance = effectiveKeywords(lobby, card).some((k) => (k || "").toLowerCase() === "vigilance");
      if (!hasVigilance) card.tapped = true;
      broadcastCard(lobby, card);
    }
    lobby.combat.attackers = validAttackers;
    lobby.combat.blocks = {};
    // Raid (Searslicer Goblin and its functional cousins) -- "if you attacked this turn," checked at
    // the player's own end step, well after lobby.combat.attackers has already been reset by the
    // Combat -> Main 2 phase transition, so it needs its own persistent flag rather than reading
    // combat state directly.
    if (Object.keys(validAttackers).length > 0) p.attackedThisTurn = true;
    // Shared Animosity / Battle Cry / Goblin Piledriver-style pumps -- all three need every
    // attacker known at once (each one's bonus depends on every OTHER attacker), so they're
    // computed once right here rather than as a per-creature trigger like
    // fireAttackTriggers/fireGlobalAttackTypeTriggers just below.
    applySharedAnimosity(lobby, Object.keys(validAttackers));
    applyBattleCry(lobby, Object.keys(validAttackers));
    applySelfAttackTypeCountPump(lobby, Object.keys(validAttackers));
    applyExalted(lobby, Object.keys(validAttackers), socket.id);
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
    Object.keys(validAttackers).forEach((cardId) => {
      const card = lobby.cards[cardId];
      if (card) { fireAttackTriggers(lobby, card); fireGlobalAttackTypeTriggers(lobby, card); }
    });
    // If any attack trigger actually fired, it's now either sitting on the stack (handled by
    // resolveStackTop's own combat.step check once the stack drains) or -- for a target-requiring
    // one -- queued waiting on its controller to pick a target first. Either way damage has to
    // wait instead of firing immediately here, bypassing the priority window/target choice entirely.
    if (lobby.combat.step === "damage" && lobby.stack.length === 0 && lobby.pendingTargetChoices.length === 0) resolveCombatDamage(lobby);
  });

  // lobby.combat.blocks[attackerId] is an ARRAY of blocker ids (possibly empty), not a single
  // id|null -- real double-blocking (and Menace's requirement of it) needs more than one blocker
  // per attacker to even be representable. `assignments` is {attackerId: [blockerId, ...]}; a
  // bare string is still tolerated (wrapped into a 1-element array) so an older client payload
  // shape doesn't hard-fail.
  socket.on("declareBlockers", (assignments) => {
    const lobby = currentLobby(); if (!lobby) return;
    if (lobby.stack.length > 0) return; // can't move combat forward with something pending
    if (lobby.combat.step !== "declareBlockers") return;
    if (!lobby.combat.defendersPending.includes(socket.id)) return;
    const usedBlockers = new Set();
    Object.values(lobby.combat.blocks).forEach((arr) => (arr || []).forEach((id) => usedBlockers.add(id)));
    for (const [attackerId, rawBlockerIds] of Object.entries(assignments || {})) {
      if (lobby.combat.attackers[attackerId] !== socket.id) continue;
      const attackerCard = lobby.cards[attackerId];
      const atkKw = attackerCard ? effectiveKeywords(lobby, attackerCard).map((k) => (k || "").toLowerCase()) : [];
      // Rogue's Passage / Escape Tunnel-style "target creature can't be blocked this turn" --
      // Unblockable is granted the same way any other temporary keyword is (grantKeywordToTarget),
      // just checked here as a hard block-eligibility gate rather than a combat-math modifier. Force
      // an explicit empty block list (not just skipping this attacker) so downstream damage
      // resolution sees the same "unblocked" shape a normal empty declaration would produce.
      if (atkKw.includes("unblockable")) { lobby.combat.blocks[attackerId] = []; continue; }
      const list = Array.isArray(rawBlockerIds) ? rawBlockerIds : (rawBlockerIds ? [rawBlockerIds] : []);
      const validBlockers = [];
      for (const blockerId of list) {
        if (!blockerId || usedBlockers.has(blockerId) || validBlockers.includes(blockerId)) continue;
        const blockerCard = lobby.cards[blockerId];
        if (!blockerCard || blockerCard.owner !== socket.id || blockerCard.zoneType !== "creature" || blockerCard.tapped) continue;
        // CR 509.1b: a creature without flying or reach can't block a flying attacker. Checked via
        // effectiveKeywords (not the printed card.keywords) so a Reach/Flying grant from an aura,
        // equipment, or anthem correctly makes an otherwise-grounded creature a legal blocker too.
        const blkKw = effectiveKeywords(lobby, blockerCard).map((k) => (k || "").toLowerCase());
        if (atkKw.includes("flying") && !blkKw.includes("flying") && !blkKw.includes("reach")) continue;
        // Protection's "can't be blocked by [quality]" facet -- the attacker has protection, so a
        // blocker matching one of its protected qualities is illegal, symmetric to the targeting
        // check in resolveChosenTarget (same toggle, same parsedProtectionQualities parsing).
        if (attackerCard && sourceMatchesProtection(attackerCard, blockerCard)) continue;
        // Serra's Emissary-style player-level protection: the attacker's controller has protection
        // from the blocker's card type, so this blocker is illegal for the same reason.
        if (attackerCard && cardTypeProtectionBlocks(lobby, attackerCard.owner, blockerCard)) continue;
        validBlockers.push(blockerId);
      }
      // CR 509.1c: Menace requires two or more blockers or none at all -- a single-blocker
      // declaration against it is simply illegal. Rather than reject the whole action with an
      // error round-trip, it silently drops to "no block", matching this handler's existing
      // silent-skip-invalid-entries style for every other illegal case above.
      const finalBlockers = (atkKw.includes("menace") && validBlockers.length === 1) ? [] : validBlockers;
      finalBlockers.forEach((id) => usedBlockers.add(id));
      lobby.combat.blocks[attackerId] = finalBlockers;
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

  // Live cursor position -- purely ephemeral, never stored in lobby state (no reconnect/persistence
  // need for a mouse position). x/y are percentages of the sender's own #playmat element, clamped
  // here so a malicious/buggy client can't push a wildly out-of-range value that breaks the
  // receiving client's layout math. boardOwner is whichever player's board tab the sender currently
  // has open -- every receiving client only renders this cursor while ITS OWN activeBoardOwner
  // matches, so a cursor never appears to be pointing at a board tab the sender isn't even looking
  // at (relayed to everyone in the lobby; the visibility filtering all happens client-side).
  socket.on("cursorMove", ({ x, y, boardOwner }) => {
    const lobby = currentLobby(); if (!lobby || !lobby.players[socket.id]) return;
    const cx = Math.max(0, Math.min(100, Number(x) || 0));
    const cy = Math.max(0, Math.min(100, Number(y) || 0));
    socket.to(lobby.id).emit("cursorMoved", { playerId: socket.id, x: cx, y: cy, boardOwner: String(boardOwner || "") });
  });

  // Draws attention to a spot on the board -- middle-click anywhere on the table, including on top
  // of a card (see the matching `mousedown` listener; right-click stays free for each card's own
  // context menu). Rate-limited via a token bucket (PING_BUCKET_MAX tokens, refilling one per
  // PING_REFILL_MS) rather than a flat per-second cooldown, so a player can burst up to
  // PING_BUCKET_MAX pings back-to-back and only then has to wait for tokens to regenerate -- keeps
  // this from being spammed into an actual flashing nuisance while still allowing quick bursts.
  // Unlike cursorMove this DOES include the sender in the broadcast (so pinging gives you your own
  // visual confirmation it went out) and DOES log it, since a ping is a deliberate, occasional
  // attention-getter rather than continuous passive telemetry.
  const PING_BUCKET_MAX = 10, PING_REFILL_MS = 1000;
  socket.on("ping", ({ x, y, boardOwner }) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p) return;
    if (!lobby.pingBucket) lobby.pingBucket = {};
    const now = Date.now();
    let bucket = lobby.pingBucket[socket.id];
    if (!bucket) bucket = lobby.pingBucket[socket.id] = { tokens: PING_BUCKET_MAX, lastRefill: now };
    const refillCount = Math.floor((now - bucket.lastRefill) / PING_REFILL_MS);
    if (refillCount > 0) {
      bucket.tokens = Math.min(PING_BUCKET_MAX, bucket.tokens + refillCount);
      bucket.lastRefill += refillCount * PING_REFILL_MS;
    }
    if (bucket.tokens < 1) return;
    bucket.tokens -= 1;
    const cx = Math.max(0, Math.min(100, Number(x) || 0));
    const cy = Math.max(0, Math.min(100, Number(y) || 0));
    const color = p.cursorColor || p.color || "#f0e6c8";
    io.to(lobby.id).emit("pinged", { playerId: socket.id, name: p.name, x: cx, y: cy, boardOwner: String(boardOwner || ""), color });
    pushLog(lobby, `${p.name} pinged the board`);
  });

  // Cursor color is enforced unique PER LOBBY (unlike the plain nametag `color` above, which has no
  // such guarantee) -- rejects a pick that's already in use by someone else currently seated here,
  // rather than silently letting two cursors look identical. null clears back to the default
  // (falls back to the player's own `color` client-side).
  socket.on("setCursorColor", (color) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p) return;
    if (color === null) { p.cursorColor = null; broadcastPlayers(lobby); return; }
    if (!CURSOR_COLORS.includes(color)) return;
    const taken = Object.entries(lobby.players).some(([id, other]) => id !== socket.id && other.cursorColor === color);
    if (taken) { socket.emit("actionError", "Someone else at this table already has that cursor color."); return; }
    p.cursorColor = color;
    broadcastPlayers(lobby);
  });

  // A custom cursor image (static or animated GIF) instead of the plain dot -- the actual on-screen
  // size cap is enforced client-side via CSS (a huge source image must never be able to cover the
  // board), this only validates the URL itself the same way every other image field in this app does.
  socket.on("setCursorIcon", (data) => {
    const lobby = currentLobby(); const p = lobby && lobby.players[socket.id];
    if (!p) return;
    // Accepts either a bare URL string (legacy shape) or {url, scale, x, y} for cropped icons.
    const { url, scale, x, y } = typeof data === "string" ? { url: data } : (data || {});
    const clean = url ? sanitizeImgUrl(url) : null;
    p.cursorIcon = clean;
    p.cursorIconFit = clean ? sanitizeImgFit({ scale, x, y }) : null;
    broadcastPlayers(lobby);
  });

  // See setUndo's own comment for the full scope/reasoning -- this just runs whatever revert
  // closure is currently pending for the calling player, if any, and if it hasn't gone stale.
  socket.on("undo", () => {
    const lobby = currentLobby(); if (!lobby || !lobby.lastAction) return;
    const entry = lobby.lastAction[socket.id];
    if (!entry) return;
    const expired = Date.now() - entry.ts > UNDO_TTL_MS || entry.turnNumber !== lobby.turn.turnNumber || entry.phase !== lobby.turn.phase;
    delete lobby.lastAction[socket.id];
    const sock = io.sockets.sockets.get(socket.id);
    if (sock) sock.emit("undoAvailable", null);
    if (expired) { socket.emit("actionError", "That's no longer available to undo."); return; }
    entry.revert();
    const p = lobby.players[socket.id];
    pushLog(lobby, `${p ? p.name : "Someone"} undid: ${entry.label}`);
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
      p.life = 40; p.cmdr = 0; p.cmdrDamage = {}; p.eliminated = false; p.poison = 0;
      p.commanders.forEach((c) => { if (c) { c.tax = 0; c.battlefieldId = null; } });
      p.mulligans = 0;
      p.handKept = false;
      p.openingHandDrawn = false;
      p.mana = EMPTY_MANA();
      p.landsPlayedThisTurn = 0;
      p.landDropBonus = 0;
    }
    lobby.gameState.log = [];
    lobby.turn = { started: false, order: [], activeIndex: 0, phase: "Main 1", turnNumber: 1, pendingDiscard: null, phaseStartedAt: null, extraCombatsPending: 0 };
    lobby.combat = { step: "none", attackers: {}, blocks: {}, defendersPending: [] };
    lobby.stack = [];
    lobby.priority = { holderId: null, lastActorId: null };
    io.to(lobby.id).emit("cleared");
    broadcastPlayers(lobby);
    broadcastTargets(lobby);
    broadcastTurn(lobby);
    broadcastCombat(lobby);
    broadcastStack(lobby);
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
    p.graceMs = RECONNECT_GRACE_MS;
    broadcastPlayers(lobby); // lets others see a "disconnected" indicator while the seat is held open
    scheduleGraceRemoval(lobby, socket.id, RECONNECT_GRACE_MS);
  });
});

http.listen(8087, () => { console.log("Commander Engine Listening on 8087"); });
