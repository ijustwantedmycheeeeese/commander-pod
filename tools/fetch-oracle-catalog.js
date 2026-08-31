// Dev tool, not part of the running app. Fetches Scryfall's "Oracle Cards" bulk data (one record
// per unique card, deduplicated by Oracle ID), trims it down to the fields useful for cataloging
// automatable triggers/activated abilities, filters to Commander-legal cards, and writes the result
// to data/oracle-catalog.json (gitignored -- regenerate anytime with `node tools/fetch-oracle-catalog.js`,
// data refreshes on Scryfall's end roughly every 12 hours).
//
// Usage: node tools/fetch-oracle-catalog.js

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const KEEP_FIELDS = ["name", "mana_cost", "cmc", "type_line", "oracle_text", "power", "toughness", "colors", "color_identity", "keywords"];
const OUT_DIR = path.join(__dirname, "..", "data");
const OUT_FILE = path.join(OUT_DIR, "oracle-catalog.json");

async function main() {
  console.log("Fetching bulk-data listing...");
  const listRes = await fetch("https://api.scryfall.com/bulk-data", { headers: { "User-Agent": "Archon-tools/1.0", "Accept": "application/json" } });
  const listing = await listRes.json();
  const entry = listing.data.find((d) => d.type === "oracle_cards");
  if (!entry) throw new Error("oracle_cards entry not found in bulk-data listing");
  console.log(`Downloading ${entry.name} (${(entry.compressed_size / 1024 / 1024).toFixed(1)} MB compressed)...`);

  const fileRes = await fetch(entry.download_uri || entry.jsonl_download_uri, { headers: { "User-Agent": "Archon-tools/1.0" } });
  const buf = Buffer.from(await fileRes.arrayBuffer());
  const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
  const raw = isGzip ? zlib.gunzipSync(buf) : buf;
  const text = raw.toString("utf8");

  // Bulk-data has shipped as either a JSON array or JSONL (one object per line) at different times --
  // handle both so this script doesn't silently break if Scryfall's format changes again.
  let cards;
  const trimmedText = text.trim();
  if (trimmedText.startsWith("[")) {
    cards = JSON.parse(trimmedText);
  } else {
    cards = trimmedText.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  console.log(`Parsed ${cards.length} unique cards.`);

  const legal = cards.filter((c) => c.legalities && c.legalities.commander === "legal");
  console.log(`${legal.length} are Commander-legal.`);

  const trimmed = legal.map((c) => {
    const out = {};
    KEEP_FIELDS.forEach((k) => { if (c[k] !== undefined) out[k] = c[k]; });
    return out;
  });

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(trimmed));
  const sizeMb = (fs.statSync(OUT_FILE).size / 1024 / 1024).toFixed(1);
  console.log(`Wrote ${trimmed.length} cards to ${OUT_FILE} (${sizeMb} MB).`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
