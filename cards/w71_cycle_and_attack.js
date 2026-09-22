// Wave 71 -- Gempalm Incinerator, Mariposa Military Base, Jolene, the Plunder Queen.

// Gempalm Incinerator -- "Cycling {1}{R}." / "When you cycle this card, you may have it deal X
// damage to target creature, where X is the number of Goblins on the battlefield." Cycling itself
// needs no table entry (cyclingCostFromText is generic). The trigger half is a genuinely new
// dispatch: server.js's cycleCard handler now consults getAutomatedAbilities(card.name, "cycle")
// (a fresh trigger type, first user) and bakes in the live Goblin count across the WHOLE
// battlefield (any owner), matching the real card's global wording.
CARD_ABILITIES["gempalm incinerator"] = [
  { trigger: "cycle", requiresTarget: true, optional: true, targetKind: "creature",
    label: "Gempalm Incinerator — you may have it deal damage to target creature equal to Goblins on the battlefield",
    effects: [{ type: "damageTarget" }] }
];

// Mariposa Military Base -- "You may have this land enter tapped. If you do, you get two rad
// counters." (a real oracle "enter tapped", not "enters tapped" -- entersTapped()'s own text scan
// already treats that phrasing as untapped-by-default, same disclosed skip-the-optional-bonus
// precedent as "you may reveal"/"unless you" elsewhere, so this ETB choice needs no code change;
// the 2 rad counters are simply never granted here). "{T}: Add {C}." (plain mana ability). "{5},
// {T}: Draw a card. This ability costs {1} less to activate for each rad counter you have." -- a
// genuinely new self-scoped cost reduction (cost.reduceByOwnRadCounters, server.js's
// activateAbility handler), distinct from activatedAbilityCostReductionFor's creature-only scope.
// Two {T} abilities on one card need BOTH given explicit table entries (Nykthos precedent) -- a
// lone mana entry would otherwise disqualify the plain-tap shortcut for the OTHER ability.
ACTIVATED_ABILITIES["mariposa military base"] = [
  { cost: { tap: true }, manaAbility: true, label: "Mariposa Military Base — Add {C}", effects: [{ type: "addFixedMana", colors: ["C"] }] },
  { cost: { mana: "{5}", tap: true, reduceByOwnRadCounters: true }, requiresTarget: false,
    label: "Mariposa Military Base — {5}, {T}: draw a card (costs {1} less per rad counter you have)",
    effects: [{ type: "drawCards", amount: 1, target: "controller" }] }
];

// Jolene, the Plunder Queen -- "Whenever a player attacks one or more of your opponents, that
// attacking player creates a Treasure token." Rides the existing playerAttacksOpponent dispatch
// (Breena, the Demagogue's wave-58 precedent: attackerId/defenderId baked into effects), but the
// new createTreasureTokenForAttacker effect hands the token to the ATTACKER (params.attackerId),
// not to Jolene's own controller -- the opposite direction from every prior playerAttacksOpponent
// card. "If you would create one or more Treasure tokens, instead create those tokens plus an
// additional Treasure token." -- see createTreasureToken's own comment in server.js (additive +1,
// scoped to Jolene's OWN controller's token creation only, so it does not double-dip on the
// tokens her first ability hands to an attacker). "Sacrifice five Treasures: Put five +1/+1
// counters on Jolene." -- a fixed-count Treasure sacrifice (not Chatterfang's variable X), so it
// reuses autoSacrificeArtifactFilter with the new cost.autoSacrificeCount (server.js) rather than
// a wholly new cost shape.
CARD_ABILITIES["jolene, the plunder queen"] = [
  { trigger: "playerAttacksOpponent", requiresTarget: false, label: "Jolene, the Plunder Queen — that attacking player creates a Treasure token",
    effects: [{ type: "createTreasureTokenForAttacker" }] }
];
ACTIVATED_ABILITIES["jolene, the plunder queen"] = [
  { cost: { autoSacrificeArtifactFilter: "treasure", autoSacrificeCount: 5 }, requiresTarget: false,
    label: "Jolene, the Plunder Queen — Sacrifice five Treasures: put five +1/+1 counters on Jolene",
    effects: [{ type: "addCountersToSelf", amount: 5 }] }
];
