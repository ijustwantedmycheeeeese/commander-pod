// Wave 60 -- Neriv, Heart of the Storm; Hexing Squelcher; Shielded by Faith; Siren Stormtamer; Bladegriff Prototype.
// Engine bits in server.js: targetKind "stackTargetingController" (+ index.html mirror), bakeEntering on anyCreatureEtb abilities,
// and the line-anchored "Spells you control can't be countered" text scan in isProtectedFromCountering.

// Neriv: the doubling already runs in damageMultiplierFor (player-directed damage only); only the coverage classifier was missing.
// Hexing Squelcher: Ward is a cosmetic badge in this engine (see the existing "ward—pay 2 life" no-op), so the granted-Ward line is a no-op match too.
GENERIC_SENTENCE_PATTERNS.push(
  /^if a creature you control that entered this turn would deal damage, it deals twice that much damage instead\.?$/,
  /^spells you control can'?t be countered\.?$/,
  /^ward\s*[\u2014-]+\s*pay 2 life\.?$/,
  /^other creatures you control have "ward\s*[—-]+\s*pay 2 life\.?"\.?$/
);

// "{U}, Sacrifice this creature: Counter target spell or ability that targets you or a creature you control."
ACTIVATED_ABILITIES["siren stormtamer"] = [{
  cost: { mana: "{U}", sacrifice: true }, requiresTarget: true, targetKind: "stackTargetingController",
  label: "Siren Stormtamer — counter target spell or ability that targets you or a creature you control",
  effects: [{ type: "counterTargetSpell" }]
}];

// "Whenever a creature enters, you may attach this Aura to that creature."
CARD_ABILITIES["shielded by faith"] = [{
  trigger: "anyCreatureEtb", bakeEntering: true, requiresTarget: false,
  label: "Shielded by Faith — you may attach this Aura to the creature that entered",
  effects: [{ type: "offerAttachAuraToEntering" }]
}];

EFFECTS.offerAttachAuraToEntering = function (lobby, ctx, params) {
  const aura = ctx.sourceCard && lobby.cards[ctx.sourceCard.id];
  const target = lobby.cards[params.enteringCardId];
  if (!aura || !target || target.zoneType !== "creature" || aura.attachedTo === target.id) return;
  queueOptionalPayment(lobby, {
    playerId: ctx.controllerId, controllerId: ctx.controllerId, sourceCard: ctx.sourceCard,
    label: `${aura.name} — attach it to ${target.name || "the creature that entered"}?`,
    costLabel: "Attach", cost: {},
    acceptedEffects: [{ type: "attachAuraToCard", targetCardId: target.id }]
  });
};

EFFECTS.attachAuraToCard = function (lobby, ctx, params) {
  const aura = ctx.sourceCard && lobby.cards[ctx.sourceCard.id];
  const target = lobby.cards[params.targetCardId];
  if (!aura || !target || target.zoneType !== "creature") return;
  aura.attachedTo = target.id;
  broadcastCard(lobby, aura);
  broadcastPlayers(lobby);
  pushLog(lobby, `${aura.name} attaches to ${target.name || "a creature"}`);
};

// "Whenever this creature deals combat damage to a player, destroy target nonland permanent of that player's choice that one of your opponents controls."
// The DAMAGED player picks (their own permanents are legal: they are one of the controller's opponents). Hexproof/protection on the pick is not checked
// (the nonlandPermanentNotControlledBy kind is shared with Council's Judgment votes).
CARD_ABILITIES["bladegriff prototype"] = [{
  trigger: "combatDamageToPlayer", requiresTarget: false,
  label: "Bladegriff Prototype — the damaged player chooses a nonland permanent an opponent of its controller controls; destroy it",
  effects: [{ type: "damagedPlayerChoosesDestroy" }]
}];

EFFECTS.damagedPlayerChoosesDestroy = function (lobby, ctx, params) {
  const chooserId = params.dealtToPlayerId;
  const chooser = lobby.players[chooserId];
  if (!chooser || chooser.eliminated) return;
  const hasLegal = Object.values(lobby.cards).some((c) => c.owner !== ctx.controllerId && (c.zoneType === "creature" || c.zoneType === "artifact"));
  if (!hasLegal) return;
  queueTargetChoice(lobby, {
    controllerId: chooserId, sourceCard: ctx.sourceCard, notControlledBy: ctx.controllerId,
    label: "Bladegriff Prototype — choose a nonland permanent you or another opponent of its controller controls; it is destroyed",
    targetKind: "nonlandPermanentNotControlledBy", effects: [{ type: "destroyTarget" }]
  });
};
