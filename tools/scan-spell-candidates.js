// Dev tool, not part of the running app. Scans data/oracle-catalog.json (see fetch-oracle-catalog.js)
// for instants/sorceries whose ENTIRE resolution (not just one line, unlike a permanent's trigger --
// casting a spell is one atomic event) matches a small set of simple, unambiguous shapes: destroy/
// exile/bounce/tap target creature, draw cards, gain/lose life, damage to a creature/player/any
// target, counter target spell, target player discards. Tolerant of reminder-text parentheticals and
// up to two chained simple clauses, and of common "or planeswalker" / "or battle" target-type
// suffixes (this app's targeting is fully trust-based, so it doesn't need to distinguish those at
// the code level -- broadening the *pattern match* to accept the wording doesn't change what
// EFFECTS.damageTarget/destroyTarget etc. actually validate).
//
// Usage: node tools/scan-spell-candidates.js            (prints counts + a sample)
//        node tools/scan-spell-candidates.js --emit      (also writes generated-spells.js)

const fs = require("fs");
const path = require("path");

const CATALOG_FILE = path.join(__dirname, "..", "data", "oracle-catalog.json");
const cards = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
const spells = cards.filter((c) => /\b(Instant|Sorcery)\b/.test(c.type_line || ""));

const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
function parseAmount(s) {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return NUM_WORDS[(s || "").toLowerCase()] || null;
}
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function selfText(card) { return (card.oracle_text || "").trim().replace(new RegExp(esc(card.name), "g"), "~"); }
function stripReminders(t) { return t.replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim(); }
function jsKey(name) { return JSON.stringify(name.toLowerCase().trim()); }

const AMT = "(\\d+|a|an|one|two|three|four|five|six)";

// Each: [regex, targetKind|null, builder(match) -> {effects, requiresTarget}]
const CLAUSE_PATTERNS = [
  [new RegExp(`^draw ${AMT} cards?\\.?$`, "i"), null, (m) => ({ effects: [{ type: "drawCards", amount: parseAmount(m[1]) }] })],
  [new RegExp(`^you gain ${AMT} life\\.?$`, "i"), null, (m) => ({ effects: [{ type: "gainLife", target: "controller", amount: parseAmount(m[1]) }] })],
  [new RegExp(`^target player loses ${AMT} life\\.?$`, "i"), "player", (m) => ({ effects: [{ type: "loseLife" }], amount: parseAmount(m[1]) })],
  [/^destroy target creature(?: or planeswalker| or battle)?\.?$/i, "creature", () => ({ effects: [{ type: "destroyTarget" }] })],
  [/^exile target creature(?: or planeswalker| or battle)?\.?$/i, "creature", () => ({ effects: [{ type: "exileTarget" }] })],
  [/^return target creature to its owner's hand\.?$/i, "creature", () => ({ effects: [{ type: "bounceTargetToHand" }] })],
  [/^tap target creature\.?$/i, "creature", () => ({ effects: [{ type: "tapTarget" }] })],
  [/^counter target spell\.?$/i, "spell", () => ({ effects: [{ type: "counterTargetSpell" }] })],
  [new RegExp(`^target player discards? ${AMT} cards?\\.?$`, "i"), "player", (m) => ({ effects: [{ type: "targetPlayerDiscards" }], amount: parseAmount(m[1]) })],
  [/^~ deals (\d+) damage to target creature\.?$/i, "creature", (m) => ({ effects: [{ type: "damageTarget" }], amount: parseInt(m[1], 10) })],
  [/^~ deals (\d+) damage to any target\.?$/i, "any", (m) => ({ effects: [{ type: "damageTarget" }], amount: parseInt(m[1], 10) })],
  [/^~ deals (\d+) damage to target player(?: or planeswalker)?\.?$/i, "player", (m) => ({ effects: [{ type: "damageTarget" }], amount: parseInt(m[1], 10) })],
  [/^~ deals (\d+) damage to target creature or planeswalker\.?$/i, "any", (m) => ({ effects: [{ type: "damageTarget" }], amount: parseInt(m[1], 10) })]
];

function matchOne(sentence) {
  for (const [re, kind, build] of CLAUSE_PATTERNS) {
    const m = sentence.match(re);
    if (m) {
      const built = build(m);
      if (built.amount !== undefined) built.effects[0].amount = built.amount;
      if (built.effects[0].type === "damageTarget" || built.effects[0].type === "targetPlayerDiscards") built.effects[0].chosenTargetId = undefined; // placeholder marker, stripped before emit
      return { kind, effects: built.effects };
    }
  }
  return null;
}

const matches = [];
for (const c of spells) {
  const raw = stripReminders(selfText(c));
  if (!raw) continue;
  const sentences = raw.split(/(?<=\.)\s+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length > 2) continue;
  const parsed = sentences.map(matchOne);
  if (parsed.some((p) => !p)) continue;
  // A spell can only ever need ONE target (this vocabulary doesn't model multi-target spells) --
  // reject anything where more than one clause independently wants a target.
  const targetKinds = parsed.filter((p) => p.kind).map((p) => p.kind);
  if (targetKinds.length > 1) continue;
  const targetKind = targetKinds[0] || null;
  const effects = parsed.flatMap((p) => p.effects);
  effects.forEach((e) => delete e.chosenTargetId);
  matches.push({ card: c, targetKind, effects });
}

console.log(`Spell candidates: ${matches.length} / ${spells.length} instants+sorceries = ${(100 * matches.length / spells.length).toFixed(1)}%`);
const byKind = {};
matches.forEach((m) => { const k = m.targetKind || "(no target)"; byKind[k] = (byKind[k] || 0) + 1; });
console.log("By target kind:", byKind);
console.log("\nSample of 15:");
matches.slice(0, 15).forEach((m) => console.log(`  ${m.card.name} [${m.targetKind || "no target"}]: ${JSON.stringify(m.effects)}`));

const EXISTING_SPELL_KEYS = new Set(); // populate from server.js's SPELL_ABILITIES keys once seeded, same pattern as scan-trigger-candidates.js

function summarizeEffects(effects) {
  return effects.map((e) => {
    if (e.type === "drawCards") return e.amount === 1 ? "draw a card" : `draw ${e.amount} cards`;
    if (e.type === "gainLife") return `gain ${e.amount} life`;
    if (e.type === "loseLife") return "target player loses life";
    if (e.type === "destroyTarget") return "destroy target creature";
    if (e.type === "exileTarget") return "exile target creature";
    if (e.type === "bounceTargetToHand") return "bounce target creature";
    if (e.type === "tapTarget") return "tap target creature";
    if (e.type === "counterTargetSpell") return "counter target spell";
    if (e.type === "targetPlayerDiscards") return `target player discards ${e.amount}`;
    if (e.type === "damageTarget") return `deal ${e.amount} damage`;
    return e.type;
  }).join(", ");
}

if (process.argv.includes("--emit")) {
  const lines = [];
  lines.push("// AUTO-GENERATED candidates from tools/scan-spell-candidates.js -- review before merging into SPELL_ABILITIES.");
  lines.push("const GENERATED_SPELL_ABILITIES = {");
  let n = 0;
  for (const m of matches) {
    const key = m.card.name.toLowerCase().trim();
    if (EXISTING_SPELL_KEYS.has(key)) continue;
    const entry = { label: `${m.card.name} — ${summarizeEffects(m.effects)}`, effects: m.effects };
    if (m.targetKind) { entry.requiresTarget = true; entry.targetKind = m.targetKind; }
    lines.push(`  ${jsKey(m.card.name)}: ${JSON.stringify(entry)},`);
    n++;
  }
  lines.push("};");
  lines.push("module.exports = { GENERATED_SPELL_ABILITIES };");
  fs.writeFileSync(path.join(__dirname, "generated-spells.js"), lines.join("\n"));
  console.log(`\nWrote tools/generated-spells.js: ${n} entries.`);
}
