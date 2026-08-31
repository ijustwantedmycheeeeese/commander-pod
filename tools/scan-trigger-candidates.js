// Dev tool, not part of the running app. Scans data/oracle-catalog.json (see fetch-oracle-catalog.js)
// for a fixed set of simple, unambiguous trigger/activated-ability phrasings -- the same shapes
// already hand-modeled in server.js's CARD_ABILITIES/ACTIVATED_ABILITIES -- and emits ready-to-review
// JS object literals for each confident match. Anything that doesn't match one of these exact
// patterns is left alone; this is a candidate generator for human review, not an auto-committer.
//
// Usage: node tools/scan-trigger-candidates.js            (prints counts + a sample of each pattern)
//        node tools/scan-trigger-candidates.js --emit      (also writes generated-abilities.js)

const fs = require("fs");
const path = require("path");

const CATALOG_FILE = path.join(__dirname, "..", "data", "oracle-catalog.json");
const cards = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));

const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
function parseAmount(s) {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return NUM_WORDS[(s || "").toLowerCase()] || null;
}
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function selfText(card) {
  return (card.oracle_text || "").replace(new RegExp(esc(card.name), "g"), "~");
}
function jsKey(name) { return JSON.stringify(name.toLowerCase().trim()); }

// Matches the hand-authored label convention already used in server.js: "Card Name — short effect
// summary" (e.g. "Elvish Visionary — draw a card"), rather than a bare card name.
function summarizeEffects(effects) {
  return effects.map((e) => {
    if (e.type === "drawCards") return e.amount === 1 ? "draw a card" : `draw ${e.amount} cards`;
    if (e.type === "gainLife") return `gain ${e.amount} life`;
    if (e.type === "loseLife") return `each opponent loses ${e.amount} life`;
    if (e.type === "addCountersToSelf") return "+1/+1 counter";
    if (e.type === "destroyTarget") return "destroy target creature";
    if (e.type === "exileTarget") return "exile target creature";
    if (e.type === "bounceTargetToHand") return "bounce target creature";
    if (e.type === "tapTarget") return "tap target creature";
    return e.type;
  }).join(", ");
}
function makeLabel(name, effects) { return `${name} — ${summarizeEffects(effects)}`; }

const AMT = "(\\d+|a|an|one|two|three|four|five|six)";

// Each entry: [regex (matched against a single normalized line), builder(match) -> effects[] or null]
const EFFECT_TAIL_PATTERNS = [
  [new RegExp(`^draw ${AMT} cards?\\.$`, "i"), (m) => [{ type: "drawCards", amount: parseAmount(m[1]) }]],
  [new RegExp(`^you gain ${AMT} life\\.$`, "i"), (m) => [{ type: "gainLife", target: "controller", amount: parseAmount(m[1]) }]],
  [/^destroy target creature\.$/i, () => ({ requiresTarget: true, effects: [{ type: "destroyTarget" }] })],
  [/^exile target creature\.$/i, () => ({ requiresTarget: true, effects: [{ type: "exileTarget" }] })],
  [/^return target creature to its owner's hand\.$/i, () => ({ requiresTarget: true, effects: [{ type: "bounceTargetToHand" }] })],
  [/^tap target creature\.$/i, () => ({ requiresTarget: true, effects: [{ type: "tapTarget" }] })],
  [/^put a \+1\/\+1 counter on (?:this creature|~)\.$/i, () => [{ type: "addCountersToSelf", amount: 1 }]]
];
function matchEffectTail(line) {
  for (const [re, build] of EFFECT_TAIL_PATTERNS) {
    const m = line.match(re);
    if (m) {
      const built = build(m);
      return Array.isArray(built) ? { requiresTarget: false, effects: built } : built;
    }
  }
  return null;
}

const results = { etb: [], death: [], attack: [], deathYouControl: [], selfGainsLife: [], youCastSpell: [], activated: [] };

for (const card of cards) {
  if (!card.oracle_text) continue;
  const text = selfText(card);
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    let m;

    if ((m = line.match(/^When ~ enters(?: the battlefield)?,\s*(.+)$/i))) {
      const eff = matchEffectTail(m[1]);
      if (eff) results.etb.push({ card, ...eff, rawLine: line });
    } else if ((m = line.match(/^When ~ dies,\s*(.+)$/i))) {
      const eff = matchEffectTail(m[1]);
      if (eff) results.death.push({ card, ...eff, rawLine: line });
    } else if ((m = line.match(/^Whenever ~ attacks,\s*(.+)$/i))) {
      const eff = matchEffectTail(m[1]);
      if (eff) results.attack.push({ card, ...eff, rawLine: line });
    } else if ((m = line.match(/^Whenever (?:this creature|~) or another creature you control dies,\s*each opponent loses (\d+|a|an|one|two|three) life and you gain (\d+|a|an|one|two|three) life\.$/i))) {
      results.deathYouControl.push({ card, effects: [{ type: "loseLife", target: "eachOpponent", amount: parseAmount(m[1]) }, { type: "gainLife", target: "controller", amount: parseAmount(m[2]) }], rawLine: line });
    } else if ((m = line.match(/^Whenever you gain life,\s*put a \+1\/\+1 counter on (?:this creature|~)\.$/i))) {
      results.selfGainsLife.push({ card, effects: [{ type: "addCountersToSelf", amount: 1 }], rawLine: line });
    } else if ((m = line.match(/^Whenever you cast a spell,\s*you gain (\d+|a|an|one|two|three) life\.$/i))) {
      results.youCastSpell.push({ card, effects: [{ type: "gainLife", target: "controller", amount: parseAmount(m[1]) }], rawLine: line });
    } else if ((m = line.match(/^(.+?):\s*(.+)$/))) {
      // Activated ability shape: "Cost[, Cost...]: Effect."
      const costPart = m[1].trim();
      const effectPart = m[2].trim();
      const costTokens = costPart.split(",").map((t) => t.trim());
      const cost = {};
      let costOk = true;
      for (const tok of costTokens) {
        if (/^\{T\}$/.test(tok)) cost.tap = true;
        else if (/^Sacrifice (this creature|~)$/i.test(tok)) cost.sacrifice = true;
        else if (/^(\{[WUBRGC0-9X]+\})+$/.test(tok)) cost.mana = (cost.mana || "") + tok;
        else { costOk = false; break; }
      }
      if (costOk && (cost.tap || cost.sacrifice || cost.mana)) {
        const eff = matchEffectTail(effectPart);
        if (eff && !eff.requiresTarget) {
          results.activated.push({ card, cost, effects: eff.effects, rawLine: line });
        }
      }
    }
  }
}

console.log("=== Candidate counts (before dedup) ===");
Object.entries(results).forEach(([k, v]) => console.log(`  ${k}: ${v.length}`));

// A card can match more than once (rare) or the same effect could double-count across reprint
// variants -- oracle_cards is already deduplicated by Oracle ID so this is just within-card lines.
function dedupByCard(list) {
  const seen = new Set();
  return list.filter((r) => { const k = r.card.name; if (seen.has(k)) return false; seen.add(k); return true; });
}
for (const k in results) results[k] = dedupByCard(results[k]);

console.log("\n=== Candidate counts (deduped, one match per card per trigger type) ===");
Object.entries(results).forEach(([k, v]) => console.log(`  ${k}: ${v.length}`));

console.log("\n=== Sample of 5 per category (name + matched line) ===");
for (const k in results) {
  console.log(`\n-- ${k} --`);
  results[k].slice(0, 5).forEach((r) => console.log(`  ${r.card.name}: "${r.rawLine}"`));
}

// Cards already hand-modeled in server.js -- excluded so this tool never proposes a duplicate/
// conflicting entry for something already curated. Keep this list in sync with CARD_ABILITIES/
// ACTIVATED_ABILITIES's own keys in server.js.
const EXISTING_CARD_ABILITIES_KEYS = new Set([
  "elvish visionary", "mulldrifter", "kitchen finks", "hornet queen", "solemn simulacrum",
  "kokusho, the evening star", "library larcenist", "ezio, brash novice", "nekrataal",
  "ravenous chupacabra", "man-o'-war", "zulaport cutthroat", "ajani's pridemate", "contemplation"
]);
const EXISTING_ACTIVATED_ABILITIES_KEYS = new Set(["archivist", "alchemist's apprentice", "carnivorous moss-beast"]);

if (process.argv.includes("--emit")) {
  // Group by card name first -- a card can match more than one trigger-shaped line (e.g. both an
  // ETB and a selfGainsLife ability on separate lines), and CARD_ABILITIES/ACTIVATED_ABILITIES both
  // expect ONE array value per card name. Emitting the same object key twice would silently drop
  // one ability to JS's last-key-wins behavior instead of erroring, so grouping has to happen before
  // codegen, not be left to the object literal to sort out.
  const cardAbilitiesByName = new Map();
  ["etb", "death", "attack", "deathYouControl", "selfGainsLife", "youCastSpell"].forEach((trigger) => {
    results[trigger].forEach((r) => {
      const key = r.card.name.toLowerCase().trim();
      if (EXISTING_CARD_ABILITIES_KEYS.has(key)) return;
      const entry = { trigger, label: makeLabel(r.card.name, r.effects) };
      if (r.requiresTarget) entry.requiresTarget = true;
      entry.effects = r.effects;
      if (!cardAbilitiesByName.has(key)) cardAbilitiesByName.set(key, { name: r.card.name, abilities: [] });
      cardAbilitiesByName.get(key).abilities.push(entry);
    });
  });

  const activatedByName = new Map();
  results.activated.forEach((r) => {
    const key = r.card.name.toLowerCase().trim();
    if (EXISTING_ACTIVATED_ABILITIES_KEYS.has(key)) return;
    const entry = { cost: r.cost, label: makeLabel(r.card.name, r.effects), effects: r.effects };
    if (!activatedByName.has(key)) activatedByName.set(key, { name: r.card.name, abilities: [] });
    activatedByName.get(key).abilities.push(entry);
  });

  const lines = [];
  lines.push("// AUTO-GENERATED candidates from tools/scan-trigger-candidates.js -- review before merging into CARD_ABILITIES/ACTIVATED_ABILITIES.");
  lines.push("const GENERATED_CARD_ABILITIES = {");
  for (const { name, abilities } of cardAbilitiesByName.values()) {
    lines.push(`  ${jsKey(name)}: ${JSON.stringify(abilities)},`);
  }
  lines.push("};");
  lines.push("");
  lines.push("const GENERATED_ACTIVATED_ABILITIES = {");
  for (const { name, abilities } of activatedByName.values()) {
    lines.push(`  ${jsKey(name)}: ${JSON.stringify(abilities)},`);
  }
  lines.push("};");
  lines.push("");
  lines.push("module.exports = { GENERATED_CARD_ABILITIES, GENERATED_ACTIVATED_ABILITIES };");
  fs.writeFileSync(path.join(__dirname, "generated-abilities.js"), lines.join("\n"));
  console.log(`\nWrote tools/generated-abilities.js: ${cardAbilitiesByName.size} CARD_ABILITIES + ${activatedByName.size} ACTIVATED_ABILITIES (after excluding already-modeled cards).`);
}
