// Wave 55 -- 8 short-text cards (removal, mana, combat trick, drawback draw, attack-declared trigger).
// New engine bits: targetKind "untappedCreature" (server.js + index.html) and the "anyAttackDeclared" trigger
// (server.js, fired once per attack declaration by ANY player, see the declareAttackers handler).

// "Destroy target nonland permanent. Its controller creates a 1/1 white Human creature token."
SPELL_ABILITIES["stroke of midnight"] = { label: "Stroke of Midnight — destroy target nonland permanent, its controller creates a 1/1 Human", effects: [{ type: "destroyTargetCreateTokenForController", tokenName: "Human", tokenType: "Token Creature — Human", power: "1", toughness: "1", colors: ["W"] }], requiresTarget: true, targetKind: "typeList", typeFilter: ["creature", "artifact", "enchantment", "planeswalker", "battle"] };

// "Tap target untapped creature. That creature deals damage equal to its power to its controller."
SPELL_ABILITIES["backlash"] = { label: "Backlash — tap target untapped creature; it deals damage equal to its power to its controller", effects: [{ type: "backlashTarget" }], requiresTarget: true, targetKind: "untappedCreature" };

// "Add {B}{B}{B}. Threshold -- add {B}{B}{B}{B}{B} instead if there are seven or more cards in your graveyard."
SPELL_ABILITIES["cabal ritual"] = { label: "Cabal Ritual — add {B}{B}{B} ({B}{B}{B}{B}{B} with threshold)", effects: [{ type: "addFixedManaThreshold", colors: ["B", "B", "B"], thresholdColors: ["B", "B", "B", "B", "B"], threshold: 7 }] };

// "If you control a commander, you may cast this spell without paying its mana cost. Exile target creature."
ALT_COSTS["deadly rollick"] = { kind: "commanderFree", label: "Deadly Rollick — cast for free if you control a commander" };
SPELL_ABILITIES["deadly rollick"] = { label: "Deadly Rollick — exile target creature", effects: [{ type: "exileTarget" }], requiresTarget: true, targetKind: "creature" };

// "Metalcraft -- {T}: Add one mana of any color. Activate only if you control three or more artifacts."
ACTIVATED_ABILITIES["mox opal"] = [{ cost: { tap: true }, manaAbility: true, condition: (card, lobby) => Object.values(lobby.cards).filter((c) => c.owner === card.owner && c.zoneType !== "hand" && c.zoneType !== "stack" && (c.type || "").toLowerCase().includes("artifact")).length >= 3, conditionError: "Metalcraft: you need to control three or more artifacts.", label: "Mox Opal — Add one mana of any color (metalcraft)", effects: [{ type: "chooseManaAnyColor", sourceName: "Mox Opal" }] }];

// Front face of "Legion Leadership // Legion Stronghold": "Until end of turn, double target creature's power and it gains first strike."
SPELL_ABILITIES["legion leadership"] = { label: "Legion Leadership — double target creature's power and it gains first strike until end of turn", effects: [{ type: "doubleTargetPowerAndKeyword", keyword: "First strike" }], requiresTarget: true, targetKind: "creature" };

// "Flying. Whenever this creature is dealt damage, you and target opponent each draw a card."
CARD_ABILITIES["flumph"] = [{ trigger: "damagedSelf", requiresTarget: true, targetKind: "opponent", label: "Flumph — you and target opponent each draw a card", effects: [{ type: "drawCards", amount: 1, target: "controller" }, { type: "drawCards", amount: 1 }] }];

// "Whenever one or more creatures attack, you may have target attacking creature gain double strike until end of turn."
CARD_ABILITIES["duelist's heritage"] = [{ trigger: "anyAttackDeclared", requiresTarget: true, targetKind: "attackingCreature", label: "Duelist's Heritage — target attacking creature gains double strike until end of turn", effects: [{ type: "grantTemporaryKeywordToTarget", keyword: "Double strike" }] }];

EFFECTS.backlashTarget = function (lobby, ctx, params) {
  const card = lobby.cards[params.chosenTargetId];
  if (!card) return;
  card.tapped = true;
  broadcastCard(lobby, card);
  const power = Math.max(0, parsePT(card.power) + (card.counters || 0) + attachedBonusFor(lobby, card).powerBonus + staticBonusFor(lobby, card).powerBonus);
  if (power <= 0) return;
  // The creature is the damage source and its controller the recipient, so the spell caster's own damage multipliers don't apply.
  EFFECTS.damageTarget(lobby, { controllerId: card.owner, sourceCard: card }, { amount: power, chosenTargetId: card.owner });
};

EFFECTS.addFixedManaThreshold = function (lobby, ctx, params) {
  const p = lobby.players[ctx.controllerId];
  if (!p) return;
  const colors = (p.graveyard || []).length >= (params.threshold || 7) ? params.thresholdColors : params.colors;
  EFFECTS.addFixedMana(lobby, ctx, { colors });
};

EFFECTS.doubleTargetPowerAndKeyword = function (lobby, ctx, params) {
  const card = lobby.cards[params.chosenTargetId];
  if (!card) return;
  const power = Math.max(0, parsePT(card.power) + (card.counters || 0) + attachedBonusFor(lobby, card).powerBonus + staticBonusFor(lobby, card).powerBonus);
  if (power) grantTemporaryPT(lobby, card, power, 0);
  if (params.keyword) grantTemporaryKeyword(lobby, card, params.keyword);
};
