const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
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
  if (users[forUsername] && users[forUsername].avatar === oldUrl) return; // still the account avatar
  // The same account could have this same URL set as the ACTIVE mat on a different table (e.g.
  // applied a saved mat on two tables, then changed it on one) -- don't delete out from under it.
  for (const id in lobbies) {
    for (const sid in lobbies[id].players) {
      const p = lobbies[id].players[sid];
      if (p.username === forUsername && p.boardMat === oldUrl) return;
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
const CARD_ARCHIVE_FILE = DATA_DIR + "/card_archive.json";
let users = loadJSON(USERS_FILE, {});
let decks = loadJSON(DECKS_FILE, {});
let mats = loadJSON(MATS_FILE, {}); // username -> { matName: url } -- account-wide, unlike the per-table active boardMat
let cardArchive = loadJSON(CARD_ARCHIVE_FILE, {}); // lowercase card name -> full extracted card data
function saveUsers() { saveJSON(USERS_FILE, users); }
function saveDecks() { saveJSON(DECKS_FILE, decks); }
function saveMats() { saveJSON(MATS_FILE, mats); }
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
// "ab_" prefix keeps a triggered-ability stack instance's id visually distinct from a real card id
// and guarantees it can never collide with one.
function newAbilityId() { return "ab_" + Date.now() + "_" + randInt(100000); }
function newLobbyId() { return crypto.randomBytes(4).toString("hex"); }

const PHASES = ["Untap", "Upkeep", "Draw", "Main 1", "Combat", "Main 2", "End Step"];
// Manually grantable keywords (auras, equipment, anthems, etc. -- none of which are automated in
// this app) -- a curated list matching Scryfall's own keyword naming so a granted keyword looks
// identical to one a card was natively printed with. Haste already plugs straight into the
// existing summoning-sickness check in declareAttackers with zero extra code.
const KNOWN_KEYWORDS = ["Flying", "Haste", "Indestructible", "Deathtouch", "Lifelink", "Trample", "Vigilance", "Menace", "Reach", "First strike", "Double strike", "Hexproof", "Ward", "Defender", "Flash", "Protection"];
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
    effects: [{ type: "createToken", amount: 4, name: "Insect", type: "Token Creature — Insect", power: "1", toughness: "1", colors: ["G"], keywords: ["Flying", "Deathtouch"] }]
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
  "aerith gainsborough": [{ trigger: "selfGainsLife", label: "Aerith Gainsborough — +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }]
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
  "archivist": [{ cost: { tap: true }, label: "Archivist — {T}: Draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "alchemist's apprentice": [{ cost: { sacrifice: true }, label: "Alchemist's Apprentice — Sacrifice: Draw a card", effects: [{ type: "drawCards", amount: 1 }] }],
  "carnivorous moss-beast": [{ cost: { mana: "{5}{G}{G}" }, label: "Carnivorous Moss-Beast — {5}{G}{G}: +1/+1 counter", effects: [{ type: "addCountersToSelf", amount: 1 }] }],
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
  "ice cream kitty": [{ cost: { mana: "{2}", tap: true, sacrifice: true }, label: "Ice Cream Kitty — gain 3 life", effects: [{ type: "gainLife", target: "controller", amount: 3 }] }]
};
function getActivatedAbilities(cardName) {
  return ACTIVATED_ABILITIES[archiveKey(cardName)] || [];
}

// What a cast instant/sorcery spell actually DOES, for the narrow set of real cards authored here --
// one entry per card (unlike CARD_ABILITIES/ACTIVATED_ABILITIES, a spell only ever resolves once,
// so there's no array of multiple abilities to pick from). Targets, when present, are chosen at
// RESOLUTION time (once the spell reaches the top of the stack) rather than at cast time like real
// Magic -- a deliberate simplification matching how every other target-requiring effect in this app
// already works (see queueTargetChoice's own comment), and arguably more forgiving than the real
// rule besides (nothing here can "fizzle" for a target that became illegal mid-stack the way real
// Magic can). targetKind is one of "creature" (existing zoneType-based matching), "player", "any"
// (creature, player, or planeswalker), or "spell" (anything currently on the stack, for counters).
const SPELL_ABILITIES = {
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
  "weave fate": { label: "Weave Fate — draw 2 cards", effects: [{ type: "drawCards", amount: 2 }] }
};
function getSpellAbility(cardName) {
  return SPELL_ABILITIES[archiveKey(cardName)] || null;
}
// Union of every card name with SOME automation -- a trigger, an activated ability, or a spell
// effect. Sent once at auth time (see authOk) so the client can compute "how much of this deck is
// automated" locally and instantly as a deck is built/imported, without a round trip per change.
function getAllAutomatedCardNames() {
  return [...new Set([...Object.keys(CARD_ABILITIES), ...Object.keys(ACTIVATED_ABILITIES), ...Object.keys(SPELL_ABILITIES)])];
}
function isCardAutomated(cardName) {
  const key = archiveKey(cardName);
  return !!(CARD_ABILITIES[key] || ACTIVATED_ABILITIES[key] || SPELL_ABILITIES[key]);
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
  eachPlayerDrawsCards(lobby, ctx, params) {
    Object.keys(lobby.players).forEach((id) => drawN(lobby, id, params.amount || 1));
  },
  gainLife(lobby, ctx, params) {
    effectTargets(lobby, ctx.controllerId, params.target).forEach((id) => applyLifeGain(lobby, id, params.amount || 0));
  },
  loseLife(lobby, ctx, params) {
    effectTargets(lobby, ctx.controllerId, params.target).forEach((id) => {
      const p = lobby.players[id]; if (p) p.life -= params.amount || 0;
    });
  },
  damageEachOpponent(lobby, ctx, params) {
    effectTargets(lobby, ctx.controllerId, "eachOpponent").forEach((id) => {
      const p = lobby.players[id]; if (p) p.life -= params.amount || 0;
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
  createToken(lobby, ctx, params) {
    const n = params.amount || 1;
    for (let i = 0; i < n; i++) {
      spawnBattlefieldCard(lobby, {
        name: params.name || "Token", type: params.type || "Token Creature", img: params.img || "",
        power: params.power, toughness: params.toughness, colors: params.colors || [],
        keywords: params.keywords || [], owner: ctx.controllerId, zoneType: classifyType(params.type || "Token Creature")
      });
    }
  },
  // Only meaningful for an ETB trigger -- by the time a death trigger resolves, the source card is
  // already gone. No-ops safely rather than modeling "last known information."
  addCountersToSelf(lobby, ctx, params) {
    const card = ctx.sourceCard && lobby.cards[ctx.sourceCard.id];
    if (card) { card.counters = (card.counters || 0) + (params.amount || 1); broadcastCard(lobby, card); }
  },
  // The four targeted effects -- params.chosenTargetId is baked in by chooseTargetFor before this
  // ever runs (see queueTargetChoice), so resolveStackTop/passPriority need no knowledge of
  // targeting at all. If the target already left play before this resolved (a legal response
  // removed it, etc.), these all just no-op -- matches a real Magic spell/ability fizzling for
  // lack of a legal target, not fully modeled but close enough.
  destroyTarget(lobby, ctx, params) {
    const card = lobby.cards[params.chosenTargetId];
    if (!card) return;
    fireDeathTriggers(lobby, card);
    sendToGraveyardInternal(lobby, card);
  },
  exileTarget(lobby, ctx, params) {
    const card = lobby.cards[params.chosenTargetId];
    if (card) exileCardInternal(lobby, card);
  },
  bounceTargetToHand(lobby, ctx, params) {
    const card = lobby.cards[params.chosenTargetId];
    if (card) bounceCardToHandInternal(lobby, card);
  },
  tapTarget(lobby, ctx, params) {
    const card = lobby.cards[params.chosenTargetId];
    if (card) { card.tapped = true; broadcastCard(lobby, card); }
  },
  // For "any target"/"creature" spells that deal damage. chosenTargetId can resolve to either a
  // player or a creature -- check players first since a player id never collides with a card id.
  // Sub-lethal damage to a creature has no persistent effect: this app never marks/tracks damage
  // between separate actions (combat damage is likewise computed fresh and instantaneous each time,
  // never stored on the card), so there's nothing to represent short of destroying it outright.
  damageTarget(lobby, ctx, params) {
    const amount = params.amount || 0;
    const p = lobby.players[params.chosenTargetId];
    if (p) { p.life -= amount; return; }
    const card = lobby.cards[params.chosenTargetId];
    if (!card) return;
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
    const item = removeStackItem(lobby, params.chosenTargetId);
    if (!item) return;
    const owner = lobby.players[item.owner];
    const caster = lobby.players[ctx.controllerId];
    if (owner) pushLog(lobby, `${caster ? caster.name : "Someone"} countered ${owner.name}'s ${item.name || "spell"}`);
  },
  // Reuses the exact same pendingDiscard mechanism as the existing "discard down to 7 cards" hand-
  // size check (resolveDiscard) -- it was already fully generic (any player, any count, any time),
  // just previously only ever set from the End Step overflow check. A second discard becoming due
  // before this one resolves would overwrite it (single slot, not a queue) -- accepted as a rare-
  // edge-case limitation, matching this app's existing no-queueing-of-that-particular-state precedent.
  targetPlayerDiscards(lobby, ctx, params) {
    const p = lobby.players[params.chosenTargetId];
    if (!p) return;
    const handCount = Object.values(lobby.cards).filter((c) => c.owner === params.chosenTargetId && c.zoneType === "hand").length;
    const count = Math.min(params.amount || 1, handCount);
    if (count <= 0) return;
    lobby.turn.pendingDiscard = { playerId: params.chosenTargetId, count };
    broadcastTurn(lobby);
    pushLog(lobby, `${p.name} must discard ${count} card${count === 1 ? "" : "s"}`);
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
    cards: {},        // battlefield/hand cards, keyed by id
    players: {},      // socket.id -> player state
    targets: {},      // cardId -> [playerId, ...]
    gameState: { log: [] },
    chatLog: [],
    spectators: {}, // socket.id -> { username, name } -- watch-only, never touches lobby.players
    voiceParticipants: new Set(),
    turn: { started: false, order: [], activeIndex: 0, phase: "Main 1", turnNumber: 1, pendingDiscard: null, phaseStartedAt: null },
    combat: { step: "none", attackers: {}, blocks: {}, defendersPending: [] },
    stack: [], // cast spells awaiting resolution, top = last element
    priority: { holderId: null, lastActorId: null }, // only meaningful while stack.length > 0
    // A target-requiring triggered ability queues here INSTEAD OF going on the stack until its
    // controller picks a legal target -- see queueTargetChoice. Only the front entry is actively
    // prompted; a second one firing before the first is resolved just waits its turn.
    pendingTargetChoices: []
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
    if (!l.turn) l.turn = { started: false, order: [], activeIndex: 0, phase: "Main 1", turnNumber: 1, pendingDiscard: null, phaseStartedAt: null };
    if (l.turn.pendingDiscard === undefined) l.turn.pendingDiscard = null;
    if (l.turn.phaseStartedAt === undefined) l.turn.phaseStartedAt = null;
    if (!l.stack) l.stack = [];
    if (!l.priority) l.priority = { holderId: null, lastActorId: null };
    if (!l.pendingTargetChoices) l.pendingTargetChoices = [];
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

  for (const id in lobby.cards) {
    if (lobby.cards[id].owner === oldId) lobby.cards[id].owner = newId;
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
  for (const id in lobby.cards) maskedCards[id] = maskCard(lobby.cards[id], socketId);
  // If this reconnecting player is the one a pending trigger is actually waiting on, they need to
  // know -- the chooseTarget prompt only fires once, at the moment the trigger first queued, so a
  // fresh connection (a real reload, not just this socket) would otherwise never see it.
  const myPendingChoice = lobby.pendingTargetChoices.find((c, i) => i === 0 && c.controllerId === socketId);
  return {
    lobbyId: lobby.id,
    lobbyName: lobby.name,
    cards: maskedCards,
    gameState: lobby.gameState,
    players: playersView(lobby, socketId),
    targets: lobby.targets,
    turn: lobby.turn,
    combat: lobby.combat,
    stack: lobby.stack.map((c) => maskCard(c, socketId)),
    priority: lobby.priority,
    pendingTargetChoice: myPendingChoice ? { id: myPendingChoice.id, label: myPendingChoice.label, sourceImg: myPendingChoice.sourceCard.img } : null,
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

// Resolution-time distinction (type line only, not casting speed -- a Flash *creature* is still
// a permanent when it resolves). Instants/sorceries have no permanent form, so on resolution they
// go to the graveyard instead of the battlefield; their actual effect is manually adjudicated by
// the players, same as every other unautomated effect in this app.
function isInstantOrSorcery(type) {
  const t = (type || "").toLowerCase();
  return t.includes("instant") || t.includes("sorcery");
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

// Exotic Orchard / Reflecting Pool-style sources derive their color from OTHER permanents on the
// battlefield rather than having a fixed set of their own -- detected via oracle text since
// there's no structured field for it. Deliberately narrow to the opponent-facing wording so a
// card like Reflecting Pool ("...a land YOU control...") doesn't get treated the same way.
function dependsOnOpponentLands(card) {
  const text = (card.text || "").toLowerCase();
  return text.includes("opponent controls could produce") || text.includes("opponent controls can produce");
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
// A card's keywords plus whatever any attached equipment/aura grants -- the one thing that
// matters for gameplay (Haste-gated summoning sickness, and anything else that reads keywords).
function effectiveKeywords(lobby, card) {
  const bonus = attachedBonusFor(lobby, card);
  if (!bonus.keywords.length) return card.keywords || [];
  return [...new Set([...(card.keywords || []), ...bonus.keywords])];
}

// Parses a permanent's own oracle text for the single most common untyped anthem/lord pattern --
// "Other creatures you control get +X/+Y". Deliberately not attempting color/creature-type-restricted
// anthems ("Elves you control get...", "Angels you control get..."), which stay manual via the
// existing Manage Keywords tool -- same narrowing precedent as equipEffectsFromText above.
function anthemEffectsFromText(text) {
  const t = text || "";
  let powerBonus = 0, toughnessBonus = 0;
  const m = t.match(/other creatures you control get ([+-]\d+)\/([+-]\d+)/i);
  if (m) { powerBonus = parseInt(m[1], 10) || 0; toughnessBonus = parseInt(m[2], 10) || 0; }
  return { powerBonus, toughnessBonus };
}
// Live-computed like attachedBonusFor -- scans every OTHER permanent the same controller controls
// (source can be a creature "lord", artifact, or enchantment; classifyType buckets all three under
// zoneType "artifact" except creatures, so this only excludes hand/stack, not by type) for an anthem
// on its own text. "Other" is enforced structurally by skipping card.id, not by parsing the word.
function staticBonusFor(lobby, card) {
  let powerBonus = 0, toughnessBonus = 0;
  if (card.zoneType !== "creature") return { powerBonus, toughnessBonus };
  for (const id in lobby.cards) {
    if (id === card.id) continue;
    const c = lobby.cards[id];
    if (c.owner !== card.owner || c.zoneType === "hand" || c.zoneType === "stack") continue;
    const eff = anthemEffectsFromText(c.text);
    powerBonus += eff.powerBonus;
    toughnessBonus += eff.toughnessBonus;
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
  // Live-computed, never stored on the card itself -- lets the client show a real, correctly-labeled
  // "Activate: ..." context-menu entry only when one actually exists. Safe to send: nothing secret,
  // and only attached once a name is actually visible to this viewer (the face-down branch above
  // never reaches here) and the card is somewhere an ability could be activated from.
  if (card.zoneType === "hand" || card.zoneType === "stack") return card;
  const abilities = getActivatedAbilities(card.name);
  if (!abilities.length) return card;
  return { ...card, activatedAbilities: abilities.map((a, index) => ({ index, label: a.label })) };
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
      avatar: (users[p.username] && users[p.username].avatar) || null,
      life: p.life,
      cmdr: p.cmdr,
      cmdrDamage: p.cmdrDamage || {},
      eliminated: !!p.eliminated,
      poison: p.poison,
      boardMat: p.boardMat || null,
      mulligans: p.mulligans,
      handKept: p.handKept,
      openingHandDrawn: !!p.openingHandDrawn,
      mana: p.mana,
      landsPlayedThisTurn: p.landsPlayedThisTurn,
      landDropBonus: p.landDropBonus,
      commanders: p.commanders,
      graveyard: p.graveyard,
      exile: p.exile,
      libraryCount: p.library.length,
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
// only on your own turn, during a main phase, with the stack empty. Before the game is actually
// started there's no turn structure yet, so pregame setup stays unrestricted.
function checkTiming(lobby, socketId, card) {
  const text = (card.type || "").toLowerCase();
  const isInstantSpeed = text.includes("instant") || (Array.isArray(card.keywords) && card.keywords.some((k) => (k || "").toLowerCase() === "flash"));
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
  fireGlobalTrigger(lobby, "youCastSpell", casterId);
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
  if (sock) sock.emit("chooseTarget", { id: entry.id, label: entry.label, sourceImg: entry.sourceCard.img });
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
    return { ok: true };
  }
  if (targetKind === "spell") {
    if (!lobby.stack.some((s) => s.id === targetId)) return { ok: false, error: "Choose a spell or ability on the stack." };
    return { ok: true };
  }
  if (targetKind === "any") {
    if (lobby.players[targetId]) return { ok: true };
    const c = lobby.cards[targetId];
    if (c && (c.zoneType === "creature" || (c.type || "").toLowerCase().includes("planeswalker"))) return { ok: true };
    return { ok: false, error: "Choose a creature, player, or planeswalker." };
  }
  // Existing behavior: a card whose zoneType matches (default "creature").
  const c = lobby.cards[targetId];
  if (!c || c.zoneType !== targetKind) return { ok: false, error: `Choose a ${targetKind === "creature" ? "creature" : targetKind}.` };
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
// Shared by fireEtbTriggers/fireDeathTriggers/fireAttackTriggers: either queues for a target or
// pushes straight to the stack, depending on the authored ability.
function fireTrigger(lobby, card, ability) {
  if (ability.requiresTarget) {
    queueTargetChoice(lobby, { controllerId: card.owner, sourceCard: card, label: ability.label, effects: ability.effects, targetZoneType: ability.targetZoneType });
  } else {
    pushAbilityToStack(lobby, { sourceCard: card, controllerId: card.owner, label: ability.label, effects: ability.effects });
  }
}

// Fires every authored "enters the battlefield" ability for `card` (self-referential only -- see
// the CARD_ABILITIES comment). Pregame stays trigger-free, matching this file's existing
// "pregame is unrestricted" convention -- there's no meaningful turn.order/priority system yet.
function fireEtbTriggers(lobby, card) {
  if (!lobby.turn.started) return;
  getAutomatedAbilities(card.name, "etb").forEach((ability) => fireTrigger(lobby, card, ability));
}

// Fires every authored "dies" ability for `card` (self-referential only). Must be called BEFORE
// the card is actually removed from lobby.cards, so its data (owner, etc.) is still intact to
// build the ability instance from.
function fireDeathTriggers(lobby, card) {
  if (!lobby.turn.started) return;
  getAutomatedAbilities(card.name, "death").forEach((ability) => fireTrigger(lobby, card, ability));
  fireGlobalTrigger(lobby, "deathYouControl", card.owner);
}

// The non-self-referential counterpart to fireEtbTriggers/fireDeathTriggers/fireAttackTriggers,
// which only ever check the trigger's own source card. Aristocrats-style wording ("whenever a
// creature you control dies", "whenever you gain life", "whenever you cast a spell") isn't about
// the source of the event at all -- it's about every OTHER permanent belonging to whoever the event
// happened to, so this scans the whole battlefield instead of one card. `forPlayerId` is whichever
// player the event actually happened to (the dying creature's controller, the player who gained
// life, the caster) -- only THEIR permanents are scanned, matching "you"/"you control" in the
// oracle text these trigger types exist to cover.
function fireGlobalTrigger(lobby, eventType, forPlayerId) {
  if (!lobby.turn.started) return;
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.owner !== forPlayerId || c.zoneType === "hand" || c.zoneType === "stack") continue;
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
  p.life += amount;
  fireGlobalTrigger(lobby, "selfGainsLife", playerId);
}

// Fires every authored "attacks" ability for `card` (self-referential only). Called from
// declareAttackers once combat.attackers is already committed -- combat-sequencing correctness
// (the trigger resolving BEFORE damage, not after) is handled by resolveStackTop's combat.step
// check AND declareAttackers' own pendingTargetChoices check, not by anything here.
function fireAttackTriggers(lobby, card) {
  if (!lobby.turn.started) return;
  getAutomatedAbilities(card.name, "attack").forEach((ability) => fireTrigger(lobby, card, ability));
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
      const spellAbility = getSpellAbility(card.name);
      if (spellAbility && spellAbility.requiresTarget) {
        // The spell is already off the stack (popped above) but not yet resolved -- it "hovers"
        // here, resolved-but-pending, exactly like a target-requiring triggered ability does,
        // until its controller picks a target. finishStackTail below still needs to run (the stack
        // itself IS shorter now), which is why this falls through to it instead of returning early.
        queueTargetChoice(lobby, { kind: "spell", controllerId: card.owner, spellCard: card, sourceCard: card, label: spellAbility.label, effects: spellAbility.effects, targetKind: spellAbility.targetKind });
        if (owner) pushLog(lobby, `${owner.name}'s ${card.name || "spell"} is resolving -- choosing a target`);
      } else {
        if (spellAbility) executeSpellEffectsNow(lobby, card, spellAbility.effects);
        sendToGraveyardInternal(lobby, card);
        if (owner) pushLog(lobby, `${owner.name}'s ${card.name || "spell"} resolved`);
      }
    } else {
      card.zoneType = classifyType(card.type);
      card.controllerSince = lobby.turn.started ? lobby.turn.turnNumber : 0;
      if (entersTapped(card)) card.tapped = true;
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

function sendToGraveyardInternal(lobby, card) {
  delete lobby.cards[card.id];
  if (lobby.targets[card.id]) delete lobby.targets[card.id];
  io.to(lobby.id).emit("cardRemove", card.id);
  clearCommanderRef(lobby, card);
  detachDependents(lobby, card);
  // A card's owner (where it goes when it leaves play) isn't necessarily who currently controls
  // it -- a permanent stolen via takeControl still belongs to whoever it was stolen from.
  const owner = lobby.players[card.originalOwner || card.owner];
  if (owner) owner.graveyard.push(toEntry(card));
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
  if (owner) owner.exile.push(toEntry(card));
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

// Untap/Upkeep/Draw never require a decision (no triggers are automated, draw already happens on
// its own), and Combat is skipped too when the active player has no creature to attack with --
// no need to make them click through three no-op phases (or an empty combat) every single turn.
function shouldAutoAdvance(lobby) {
  const turn = lobby.turn;
  if (!turn.started || turn.order.length === 0) return false;
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

function advanceOnePhase(lobby) {
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
  turn.phaseStartedAt = Date.now(); // purely informational -- drives a passive client-side "how long has this phase been going" indicator, never used to auto-act for anyone
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

  function hasKw(card, kw) {
    return effectiveKeywords(lobby, card).some((k) => (k || "").toLowerCase() === kw);
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
    if (dealtByDeathtouch || deathtouchHit.has(card.id)) return (marked[card.id] || 0) > 0;
    return (marked[card.id] || 0) >= effPT(card).toughness;
  }
  function processDeaths() {
    for (const id in marked) {
      const card = lobby.cards[id];
      if (card && dealtLethal(card, false)) { fireDeathTriggers(lobby, card); sendToGraveyardInternal(lobby, card); }
    }
  }

  const pairs = Object.entries(combat.attackers)
    .map(([attackerId, defenderId]) => ({ attackerId, defenderId, blockerId: combat.blocks[attackerId] }))
    .filter((p) => lobby.cards[p.attackerId]);

  function dealStepDamage(isFirstStrikeStep) {
    for (const { attackerId, defenderId, blockerId } of pairs) {
      const attacker = lobby.cards[attackerId];
      if (!attacker) continue; // died in an earlier sub-step
      const atkFS = hasKw(attacker, "first strike"), atkDS = hasKw(attacker, "double strike");
      const attackerActs = isFirstStrikeStep ? (atkFS || atkDS) : (!atkFS || atkDS);
      const blocker = blockerId ? lobby.cards[blockerId] : null;

      if (blocker) {
        if (attackerActs) {
          const { power: atkPower } = effPT(attacker);
          const atkDeathtouch = hasKw(attacker, "deathtouch");
          const atkTrample = hasKw(attacker, "trample");
          if (atkPower > 0) {
            let toBlocker = atkPower, toPlayer = 0;
            if (atkTrample) {
              const need = remainingToKill(blocker, atkDeathtouch);
              toBlocker = Math.min(atkPower, need);
              toPlayer = atkPower - toBlocker;
            }
            markDamage(blocker, toBlocker, atkDeathtouch);
            if (toPlayer > 0) {
              const defender = lobby.players[defenderId];
              if (defender) {
                defender.life -= toPlayer;
                dmgEvents.push({ targetId: defenderId, amount: toPlayer });
                pushLog(lobby, `${attacker.name || "A face-down creature"} tramples ${toPlayer} over to ${defender.name}`);
              }
            }
          }
        }
        const blkFS = hasKw(blocker, "first strike"), blkDS = hasKw(blocker, "double strike");
        const blockerActs = isFirstStrikeStep ? (blkFS || blkDS) : (!blkFS || blkDS);
        if (blockerActs && lobby.cards[blocker.id]) {
          const { power: defPower } = effPT(blocker);
          markDamage(attacker, defPower, hasKw(blocker, "deathtouch"));
        }
        if (attackerActs || blockerActs) {
          const atkAfter = effPT(attacker), defAfter = effPT(blocker);
          pushLog(lobby, `${attacker.name || "A face-down creature"} (${atkAfter.power}/${atkAfter.toughness}) fights ${blocker.name || "a face-down creature"} (${defAfter.power}/${defAfter.toughness})`);
        }
      } else if (attackerActs) {
        const { power: atkPower } = effPT(attacker);
        const defender = lobby.players[defenderId];
        if (defender && atkPower > 0) {
          defender.life -= atkPower;
          if (attacker.isCommander) {
            defender.cmdr = (defender.cmdr || 0) + atkPower; // kept as the quick-glance total
            const key = commanderSlotKey(lobby, attacker);
            if (key) {
              if (!defender.cmdrDamage) defender.cmdrDamage = {};
              defender.cmdrDamage[key] = (defender.cmdrDamage[key] || 0) + atkPower;
            }
          }
          pushLog(lobby, `${attacker.name || "A face-down creature"} hits ${defender.name} for ${atkPower}`);
          dmgEvents.push({ targetId: defenderId, amount: atkPower });
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

// Known limitation: existing sessions aren't invalidated on password change -- `sessions` has no
// per-user reverse index to support that cleanly. Fine for a small trusted pod, not silently glossed over.
app.post("/api/changePassword", (req, res) => {
  const { token, currentPassword, newPassword } = req.body || {};
  const username = token && sessions[token];
  if (!username) return res.json({ success: false, error: "Not authenticated." });
  const u = users[username];
  if (!u || !verifyPassword(currentPassword || "", u.salt, u.hash)) {
    return res.json({ success: false, error: "Current password is incorrect." });
  }
  if (!newPassword || newPassword.length < 4) return res.json({ success: false, error: "New password must be at least 4 characters." });
  const salt = crypto.randomBytes(16).toString("hex");
  u.salt = salt;
  u.hash = hashPassword(newPassword, salt);
  saveUsers();
  res.json({ success: true });
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

// Board mat / avatar image uploads, an alternative to pasting a URL (both feed the exact same
// boardMat/avatar string fields -- this just fills that field in for you instead of replacing it).
const UPLOAD_MIME_EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };
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
  if (!token || !sessions[token]) return res.status(401).json({ success: false, error: "Not authenticated" });
  upload.single("file")(req, res, (err) => {
    if (err) return res.json({ success: false, error: err.code === "LIMIT_FILE_SIZE" ? "File too large (5MB max)." : "Upload failed." });
    if (!req.file) return res.json({ success: false, error: "Only PNG, JPG, or WEBP images are supported." });
    res.json({ success: true, url: "/uploads/" + req.file.filename });
  });
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
  socket.emit("authOk", {
    username, decks: Object.keys(decks[username] || {}),
    mats: mats[username] || {},
    avatar: (users[username] && users[username].avatar) || null,
    defaultName: (users[username] && users[username].defaultName) || null,
    automatedCardNames: getAllAutomatedCardNames()
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

    lobby.players[socket.id] = {
      username,
      name: (users[username] && users[username].defaultName) || username,
      color: nextColor(),
      life: 40, cmdr: 0, cmdrDamage: {}, eliminated: false, poison: 0, boardMat: null,
      library: [], graveyard: [], exile: [],
      commanders: [null, null],
      mulligans: 0, handKept: false, openingHandDrawn: false,
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

  socket.on("setName", (name) => {
    const lobby = currentLobby(); if (!lobby || !lobby.players[socket.id]) return;
    lobby.players[socket.id].name = (name || "Player").toString().slice(0, 24);
    broadcastPlayers(lobby);
  });

  socket.on("updateAccount", ({ avatar, defaultName } = {}) => {
    if (!users[username]) return;
    const oldAvatar = users[username].avatar;
    users[username].avatar = (avatar || "").toString().trim().slice(0, 500) || null;
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
    const clean = (url || "").toString().trim().slice(0, 500);
    const oldMat = lobby.players[socket.id].boardMat;
    lobby.players[socket.id].boardMat = clean || null;
    broadcastPlayers(lobby);
    if (oldMat && oldMat !== lobby.players[socket.id].boardMat) deleteUploadIfOrphaned(oldMat, username);
  });

  socket.on("statChange", ({ key, val }) => {
    const lobby = currentLobby(); if (!lobby || !lobby.players[socket.id] || !["life", "cmdr", "poison"].includes(key)) return;
    if (key === "life" && val > 0) applyLifeGain(lobby, socket.id, val);
    else lobby.players[socket.id][key] += val;
    // Manual life adjustment can trigger elimination just like combat can; the manual cmdr/poison
    // buttons only ever touch the flat aggregate/poison counters, never cmdrDamage[key] itself
    // (only resolveCombatDamage writes that), so this is really just the life <= 0 path in
    // practice for this call site -- included anyway since checkEliminations checks both.
    checkEliminations(lobby);
    broadcastPlayers(lobby);
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

  socket.on("spawnCard", (data) => {
    const lobby = currentLobby(); if (!lobby || !lobby.players[socket.id]) return;
    const card = spawnBattlefieldCard(lobby, { ...data, owner: socket.id, zoneType: classifyType(data.type) });
    const who = lobby.players[socket.id].name;
    pushLog(lobby, data.faceDown ? `${who} spawned a card face down` : `${who} spawned ${data.name}`);
    if (card.zoneType !== "hand") fireEtbTriggers(lobby, card);
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
      if (zoneType === "mana" || !lobby.turn.started) {
        // Lands aren't spells -- no stack, no priority window, resolves immediately like today.
        // Pregame (no turn structure yet, no turn.order to hold a priority round) stays
        // unrestricted the same way it always has -- everything just resolves immediately.
        card.zoneType = zoneType;
        card.faceDown = false;
        // A card sitting in hand was stamped with whatever turn it was drawn on (or 0, pregame) --
        // that's stale the moment it actually enters the battlefield, which is what summoning
        // sickness needs to key off. Same story for entersTapped: spawnBattlefieldCard already
        // applies it for cards created straight onto the battlefield, but a card played from hand
        // never goes through that function again, so it was silently skipped.
        card.controllerSince = lobby.turn.started ? lobby.turn.turnNumber : 0;
        if (entersTapped(card)) card.tapped = true;
        broadcastCard(lobby, card);
        broadcastPlayers(lobby);
        pushLog(lobby, `${p.name} played ${card.name || "a card"}`);
        fireEtbTriggers(lobby, card);
      } else {
        pushToStack(lobby, card, socket.id);
        pushLog(lobby, `${p.name} cast ${card.name || "a spell"}`);
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
    const result = attemptPlay(p, card, targetZoneType, xValue);
    if (!result.ok) { socket.emit("actionError", result.error); return; }
    if (targetZoneType === "mana" || !lobby.turn.started) {
      card.zoneType = targetZoneType;
      card.faceDown = false;
      card.controllerSince = lobby.turn.started ? lobby.turn.turnNumber : 0;
      if (entersTapped(card)) card.tapped = true;
      broadcastCard(lobby, card);
      broadcastPlayers(lobby);
      pushLog(lobby, `${p.name} played ${card.name || "a card"}`);
      fireEtbTriggers(lobby, card);
    } else {
      pushToStack(lobby, card, socket.id);
      pushLog(lobby, `${p.name} cast ${card.name || "a spell"}`);
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
    const targetZoneType = classifyType(card.type);
    if (targetZoneType === "mana" || !lobby.turn.started) {
      card.zoneType = targetZoneType;
      card.faceDown = false;
      card.controllerSince = lobby.turn.started ? lobby.turn.turnNumber : 0;
      if (entersTapped(card)) card.tapped = true;
      broadcastCard(lobby, card);
      pushLog(lobby, `${p.name} played ${card.name || "a card"} without paying its cost`);
      fireEtbTriggers(lobby, card);
    } else {
      pushToStack(lobby, card, socket.id);
      pushLog(lobby, `${p.name} cast ${card.name || "a spell"} without paying its mana cost`);
    }
  });

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
    }
    let color = options ? (options.length === 1 ? options[0] : null) : basicLandColor(card.type);
    if (!color && !options && Array.isArray(card.producedMana) && card.producedMana.length === 1) {
      color = card.producedMana[0];
    }
    if (color && ["W", "U", "B", "R", "G", "C"].includes(color)) {
      const p = lobby.players[socket.id];
      p.mana[color] = (p.mana[color] || 0) + 1;
      broadcastPlayers(lobby);
      pushLog(lobby, `${p.name} tapped ${card.name} for {${color}}`);
    } else if (options ? options.length > 1 : (Array.isArray(card.producedMana) && card.producedMana.length > 1)) {
      const finalOptions = (options || card.producedMana).filter((c) => ["W", "U", "B", "R", "G", "C"].includes(c));
      if (finalOptions.length) socket.emit("chooseMana", { cardId: card.id, cardName: card.name, options: finalOptions });
    } else if (options && options.length === 0) {
      socket.emit("actionError", `No opponent controls a land right now, so ${card.name} can't produce mana.`);
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
  });

  // Activates a player-initiated ability from ACTIVATED_ABILITIES (see its comment for scope).
  // Checks affordability of ALL costs before paying ANY of them -- no partial payment on a failed
  // check partway through. Once costs are validated, pays them, then hands off to fireTrigger --
  // the exact same requiresTarget-or-straight-to-stack branch CARD_ABILITIES entries already use,
  // so resolveStackTop needs zero changes regardless of how an item reached the stack.
  socket.on("activateAbility", ({ cardId, abilityIndex }) => {
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
    const ability = getActivatedAbilities(card.name)[abilityIndex];
    if (!ability) return;
    const cost = ability.cost || {};

    if (cost.tap) {
      if (card.tapped) { socket.emit("actionError", `${card.name} is already tapped.`); return; }
      // Summoning sickness (CR 302.6) only ever restricts CREATURES -- a plain artifact/other
      // permanent with a {T} cost is never subject to it, same as the client's own isSummoningSick
      // helper already correctly gates on zoneType. Missing this check here meant a same-turn
      // artifact's tap ability was incorrectly blocked, caught via a Campfire ({1},{T}: gain 2 life)
      // activation test.
      if (card.zoneType === "creature") {
        const hasHaste = effectiveKeywords(lobby, card).some((k) => (k || "").toLowerCase() === "haste");
        if (card.controllerSince === lobby.turn.turnNumber && !hasHaste) { socket.emit("actionError", `${card.name} has summoning sickness.`); return; }
      }
    }
    let remainingMana = null;
    if (cost.mana) {
      remainingMana = canAffordAndPay(p.mana, parseManaCost(cost.mana), 0);
      if (!remainingMana) { socket.emit("actionError", `Not enough mana to activate ${card.name}'s ability.`); return; }
    }
    // cost.sacrifice has nothing to validate -- you already own it and it's on the battlefield.

    if (cost.tap) { card.tapped = true; broadcastCard(lobby, card); }
    if (cost.mana) { p.mana = remainingMana; broadcastPlayers(lobby); }
    pushLog(lobby, `${p.name} activated: ${ability.label}`);
    if (cost.sacrifice) {
      // Paid as part of the cost, immediately -- same as real Magic (costs are paid on activation,
      // not on resolution). The card object itself stays valid for fireTrigger below even after
      // this: sendToGraveyardInternal only removes it from lobby.cards, it doesn't mutate the object.
      fireDeathTriggers(lobby, card);
      sendToGraveyardInternal(lobby, card);
    }
    fireTrigger(lobby, card, ability);
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
    const effects = entry.effects.map((e) => ({ ...e, chosenTargetId: targetId }));
    if (entry.kind === "spell") {
      // The spell itself already left the stack back in resolveStackTop -- this is the second half
      // of its resolution, deferred until now because it needed a target. Executes its effects then
      // sends it to the graveyard, exactly what resolveStackTop's instant/sorcery branch would have
      // done immediately if no target had been required.
      executeSpellEffectsNow(lobby, entry.spellCard, effects);
      sendToGraveyardInternal(lobby, entry.spellCard);
      const owner = lobby.players[entry.spellCard.owner];
      if (owner) pushLog(lobby, `${owner.name}'s ${entry.spellCard.name || "spell"} resolved`);
      finishStackTail(lobby);
    } else {
      pushAbilityToStack(lobby, { sourceCard: entry.sourceCard, controllerId: entry.controllerId, label: entry.label, effects });
    }
    socket.emit("targetChoiceResolved", id);
    if (lobby.pendingTargetChoices.length > 0) promptTargetChoice(lobby, lobby.pendingTargetChoices[0]);
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

  // ---- saved board mats (account-scoped, like decks -- distinct from the per-table active
  // boardMat on lobby.players, which is unaffected by any of this) ----

  socket.on("saveMat", ({ name, url }) => {
    name = (name || "").toString().trim().slice(0, 40);
    const clean = (url || "").toString().trim().slice(0, 500);
    if (!name || !clean) return;
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
      const wanted = parseDecklistNames(text, 99);
      if (wanted.length === 0) { socket.emit("deckPasteResult", { success: false, error: "Nothing parsed from that list." }); return; }
      const found = await resolveCardNames(wanted);
      socket.emit("deckPasteResult", { success: true, requested: wanted.length, found });
    } catch (e) {
      socket.emit("deckPasteResult", { success: false, error: "Resolve failed — check your connection and try again." });
    }
  });

  // Best-effort import from a Moxfield or Archidekt deck URL. Both are unofficial, undocumented
  // endpoints that could change or break without notice -- Archidekt's has been confirmed reachable
  // from a plain server-side fetch, but Moxfield's sits behind bot-detection that blocks non-browser
  // clients regardless of headers (confirmed via direct testing: identical requests succeed from curl
  // but are rejected for a Node fetch), so it will often fall through to the error message below.
  // Feeds the resulting card names into the exact same pipeline as resolveDeckPaste above, and reuses
  // its result event so the client needs no new handler.
  socket.on("importDeckFromUrl", async (rawUrl) => {
    const fallbackMsg = "Couldn't import from that URL — try pasting the decklist directly instead.";
    try {
      const url = new URL((rawUrl || "").trim());
      const host = url.hostname.replace(/^www\./, "").toLowerCase();
      const wanted = [];
      if (host === "archidekt.com") {
        const m = url.pathname.match(/\/decks\/(\d+)/);
        if (!m) { socket.emit("deckPasteResult", { success: false, error: fallbackMsg }); return; }
        const r = await fetch(`https://archidekt.com/api/decks/${m[1]}/`, { headers: { "User-Agent": "CommanderVTT/8.0" } });
        if (!r.ok) { socket.emit("deckPasteResult", { success: false, error: fallbackMsg }); return; }
        const data = await r.json();
        (data.cards || []).forEach((entry) => {
          const name = entry.card && entry.card.oracleCard && entry.card.oracleCard.name;
          const qty = entry.quantity || 1;
          if (name) for (let i = 0; i < qty; i++) wanted.push(name);
        });
      } else if (host === "moxfield.com") {
        const m = url.pathname.match(/\/decks\/([A-Za-z0-9_-]+)/);
        if (!m) { socket.emit("deckPasteResult", { success: false, error: fallbackMsg }); return; }
        const r = await fetch(`https://api2.moxfield.com/v3/decks/all/${m[1]}`, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36", "Accept": "application/json" }
        });
        if (!r.ok) { socket.emit("deckPasteResult", { success: false, error: fallbackMsg }); return; }
        const data = await r.json();
        const boards = data.boards || {};
        for (const boardName of ["mainboard", "commanders"]) {
          const cards = (boards[boardName] && boards[boardName].cards) || {};
          for (const key in cards) {
            const entry = cards[key];
            const name = entry.card && entry.card.name;
            const qty = entry.quantity || 1;
            if (name) for (let i = 0; i < qty; i++) wanted.push(name);
          }
        }
      } else {
        socket.emit("deckPasteResult", { success: false, error: "Only Moxfield and Archidekt deck URLs are supported — try pasting the decklist directly instead." });
        return;
      }
      if (wanted.length === 0) { socket.emit("deckPasteResult", { success: false, error: fallbackMsg }); return; }
      if (wanted.length > 99) wanted.length = 99;
      const found = await resolveCardNames(wanted);
      socket.emit("deckPasteResult", { success: true, requested: wanted.length, found });
    } catch (e) {
      socket.emit("deckPasteResult", { success: false, error: fallbackMsg });
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
    lobby.turn.phase = "Main 1";
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
    if (lobby.stack.length > 0) return; // can't advance the turn with something pending on the stack
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
  socket.on("counterStackItem", (cardId) => {
    const lobby = currentLobby(); if (!lobby) return;
    const card = removeStackItem(lobby, cardId);
    if (!card) return;
    const owner = lobby.players[card.owner];
    const who = lobby.players[socket.id] ? lobby.players[socket.id].name : "Someone";
    if (owner) pushLog(lobby, `${who} countered ${owner.name}'s ${card.name || "spell"}`);
    if (lobby.stack.length === 0) {
      lobby.priority.holderId = null;
      lobby.priority.lastActorId = null;
    }
    broadcastPlayers(lobby);
    broadcastStack(lobby);
  });

  // ---- combat ----

  socket.on("declareAttackers", (assignments) => {
    const lobby = currentLobby(); if (!lobby) return;
    if (!lobby.turn.started || lobby.turn.order[lobby.turn.activeIndex] !== socket.id) return;
    if (lobby.stack.length > 0) return; // can't move combat forward with something pending
    if (lobby.combat.step !== "declareAttackers") return;
    const validAttackers = {};
    const defendersSet = new Set();
    for (const [cardId, defenderId] of Object.entries(assignments || {})) {
      const card = lobby.cards[cardId];
      if (!card || card.owner !== socket.id || card.zoneType !== "creature" || card.tapped) continue;
      const hasHaste = effectiveKeywords(lobby, card).some((k) => (k || "").toLowerCase() === "haste");
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
    Object.keys(validAttackers).forEach((cardId) => {
      const card = lobby.cards[cardId];
      if (card) fireAttackTriggers(lobby, card);
    });
    // If any attack trigger actually fired, it's now either sitting on the stack (handled by
    // resolveStackTop's own combat.step check once the stack drains) or -- for a target-requiring
    // one -- queued waiting on its controller to pick a target first. Either way damage has to
    // wait instead of firing immediately here, bypassing the priority window/target choice entirely.
    if (lobby.combat.step === "damage" && lobby.stack.length === 0 && lobby.pendingTargetChoices.length === 0) resolveCombatDamage(lobby);
  });

  socket.on("declareBlockers", (assignments) => {
    const lobby = currentLobby(); if (!lobby) return;
    if (lobby.stack.length > 0) return; // can't move combat forward with something pending
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
    lobby.turn = { started: false, order: [], activeIndex: 0, phase: "Main 1", turnNumber: 1, pendingDiscard: null, phaseStartedAt: null };
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
