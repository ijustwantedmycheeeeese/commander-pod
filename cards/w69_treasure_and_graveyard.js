// Wave 69 -- Smaug the Magnificent, Rotwidow Pack, Folk Hero.
// (Daring Fiendbonder was attempted and deferred -- see STATE.md: its "exile this card from your
// graveyard" activation needs a real new subsystem, not a quick reuse of Nyx Weaver's own cost.exile,
// which turned out to be dead/unreachable code -- see the deferred note for the full finding.)

// Smaug the Magnificent -- "Whenever Smaug attacks, he deals damage equal to the number of Treasures
// you control to any target." / "At the beginning of your upkeep, create a Treasure token."
// The upkeep half is a plain createTreasureToken trigger (Goldspan Dragon/Redcap Thief precedent);
// the attack half needs a real Treasure COUNT, which the shared amountSource:"count" baking (Dragon
// Tempest/Scarab God) can't give us -- that path only ever counts zoneType:"creature" permanents, and
// Treasures are artifacts. A small bespoke effect instead, same "count matching permanents, then hand
// off to damageTarget" shape.
CARD_ABILITIES["smaug the magnificent"] = [
  { trigger: "attack", requiresTarget: true, targetKind: "any", label: "Smaug the Magnificent — deals damage equal to the number of Treasures you control to any target", effects: [{ type: "smaugTreasureDamage" }] },
  { trigger: "upkeep", requiresTarget: false, label: "Smaug the Magnificent — create a Treasure token", effects: [{ type: "createTreasureToken" }] }
];
EFFECTS.smaugTreasureDamage = function (lobby, ctx, params) {
  const amount = Object.values(lobby.cards).filter((c) => c.owner === ctx.controllerId && c.zoneType !== "hand" && c.zoneType !== "stack" && /treasure/i.test(c.type || "")).length;
  EFFECTS.damageTarget(lobby, ctx, { ...params, amount });
};

// Rotwidow Pack -- "{3}{B}{G}, Exile a creature card from your graveyard: Create a 1/2 green Spider
// creature token with reach, then each opponent loses 1 life for each Spider you control." Unlike a
// self-exile-from-graveyard ability (Daring Fiendbonder, deferred), Rotwidow Pack stays ON THE
// BATTLEFIELD and exiles a CHOSEN creature card from its controller's graveyard as part of the cost --
// the existing targetKind "ownGraveyardCreature" (Tortured Existence, Reya Dawnbringer) already IS that
// picker; the ability just exiles the chosen entry instead of returning/reanimating it, via the same
// findAndRemoveGraveyardEntry primitive every other graveyard-consuming effect here already uses.
ACTIVATED_ABILITIES["rotwidow pack"] = [{
  cost: { mana: "{3}{B}{G}" }, requiresTarget: true, targetKind: "ownGraveyardCreature",
  label: "Rotwidow Pack — {3}{B}{G}, Exile a creature card from your graveyard: create a 1/2 green Spider creature token with reach, then each opponent loses 1 life for each Spider you control",
  effects: [{ type: "rotwidowPackSpiderDrain" }]
}];
EFFECTS.rotwidowPackSpiderDrain = function (lobby, ctx, params) {
  const found = findAndRemoveGraveyardEntry(lobby, params.chosenTargetId);
  if (found) {
    const owner = lobby.players[found.ownerId];
    if (owner) { owner.exile = [...(owner.exile || []), found.entry]; broadcastPlayers(lobby); }
  }
  EFFECTS.createToken(lobby, ctx, { name: "Spider", tokenType: "Token Creature — Spider", power: "1", toughness: "2", colors: ["G"], keywords: ["Reach"] });
  const spiderCount = Object.values(lobby.cards).filter((c) => c.owner === ctx.controllerId && c.zoneType === "creature" && (c.type || "").toLowerCase().includes("spider")).length;
  EFFECTS.loseLife(lobby, ctx, { target: "eachOpponent", amount: spiderCount });
};

// Folk Hero -- "Commander creatures you own have 'Whenever you cast a spell that shares a creature
// type with this creature, draw a card. This ability triggers only once each turn.'" A Background (a
// non-creature enchantment permanent), not a creature itself -- rather than building a real
// ability-granting mechanism, the Background reacts directly to its OWN controller's casts (bakeEventCard,
// same as Hashaton) and compares the cast spell's subtypes against whichever of the controller's OWN
// commander creatures are actually on the battlefield right now, landing on the same outcome the
// granted wording describes without ever needing a real per-creature ability grant. A noncreature
// spell has no subtypes and correctly never matches.
// NOTE: server.js declares TWO functions named creatureSubtypesOf (one at ~line 8550 taking a card,
// a second "Coat of Arms" one at ~line 9266 taking a raw type-line string) -- the second silently
// shadows the first for every caller table-wide, including the existing Shared Animosity code that
// calls it with a card object (a real, pre-existing bug: Shared Animosity's own creature-type-overlap
// check is currently broken the same way this would have been). Flagged in STATE.md as a fix for a
// future session (rename the second one, verify Shared Animosity's regression); a fresh, unambiguously
// named local helper here sidesteps the collision entirely rather than relying on either shadowed name.
function fhCreatureSubtypes(cardLike) {
  const m = ((cardLike && cardLike.type) || "").match(/creature\s*[—-]\s*(.+)$/i);
  if (!m) return [];
  return m[1].split(/\s+/).map((s) => s.toLowerCase());
}
CARD_ABILITIES["folk hero"] = [
  { trigger: "youCastSpell", requiresTarget: false, bakeEventCard: true, label: "Folk Hero — Commander creatures you own: whenever you cast a spell that shares a creature type with this creature, draw a card (once each turn)", effects: [{ type: "folkHeroSharedTypeDraw" }] }
];
EFFECTS.folkHeroSharedTypeDraw = function (lobby, ctx, params) {
  const bg = ctx.sourceCard && lobby.cards[ctx.sourceCard.id];
  if (!bg || bg._folkHeroDrawTurn === lobby.turn.turnNumber) return;
  const spellTypes = fhCreatureSubtypes(params.eventCardSnapshot);
  if (!spellTypes.length) return;
  const commanders = Object.values(lobby.cards).filter((c) => c.owner === ctx.controllerId && c.isCommander && c.zoneType === "creature");
  if (!commanders.some((cmd) => fhCreatureSubtypes(cmd).some((t) => spellTypes.includes(t)))) return;
  bg._folkHeroDrawTurn = lobby.turn.turnNumber;
  EFFECTS.drawCards(lobby, ctx, { amount: 1, target: "controller" });
};
