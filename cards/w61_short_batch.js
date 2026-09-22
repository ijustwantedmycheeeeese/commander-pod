// Wave 61 -- Fountainport; The Mindskinner; Hashaton, Scarab's Fist; Arcbond; Nesting Grounds.
// Engine bits in server.js: cost.autoSacrificeToken (activateAbility), reduceDamageForVictim's 4th arg (The Mindskinner's prevention +
// mill), ability.bakeEventCard (fireGlobalTrigger) and the card._arcbondTurn hook in fireCreatureDamagedTrigger.

// The Mindskinner: "can't be blocked" names the card itself (effectiveKeywords reads it as Unblockable); the damage replacement lives in reduceDamageForVictim (player-directed damage only).
GENERIC_SENTENCE_PATTERNS.push(
  /^the mindskinner can'?t be blocked\.?$/,
  /^if a source you control would deal damage to an opponent, prevent that damage and each opponent mills that many cards\.?$/
);

// Fountainport: "{T}: Add {C}." stays the plain-tap shortcut; the other three abilities are ordinary activated abilities.
ACTIVATED_ABILITIES["fountainport"] = [
  { cost: { mana: "{2}", tap: true, autoSacrificeToken: true }, requiresTarget: false,
    label: "Fountainport — {2}, {T}, sacrifice a token: draw a card", effects: [{ type: "drawCards", amount: 1 }] },
  { cost: { mana: "{3}", tap: true, life: 1 }, requiresTarget: false,
    label: "Fountainport — {3}, {T}, pay 1 life: create a 1/1 blue Fish creature token",
    effects: [{ type: "createToken", name: "Fish", tokenType: "Token Creature — Fish", power: "1", toughness: "1", colors: ["U"] }] },
  { cost: { mana: "{4}", tap: true }, requiresTarget: false,
    label: "Fountainport — {4}, {T}: create a Treasure token",
    effects: [{ type: "createToken", name: "Treasure", tokenType: "Token Artifact — Treasure", amount: 1 }] }
];

// Hashaton: "Whenever you discard a creature card, you may pay {2}{U}. If you do, create a tapped token that's a copy of that card, except it's a 4/4
// black Zombie." The discarded card's data is baked in by bakeEventCard. The token keeps the copy's card types and abilities; its creature subtypes
// become Zombie. Like the other token-copy effects here, the copy's own ETB does not fire.
CARD_ABILITIES["hashaton, scarab's fist"] = [{
  trigger: "youDiscard", typeFilter: "creature", bakeEventCard: true, requiresTarget: false,
  label: "Hashaton — you may pay {2}{U}: create a tapped 4/4 black Zombie token copy of the discarded creature card",
  effects: [{ type: "hashatonOffer" }]
}];

EFFECTS.hashatonOffer = function (lobby, ctx, params) {
  const snap = params.eventCardSnapshot;
  if (!snap) return;
  queueOptionalPayment(lobby, {
    playerId: ctx.controllerId, controllerId: ctx.controllerId, sourceCard: ctx.sourceCard,
    label: `Hashaton — pay {2}{U} to create a tapped 4/4 black Zombie token copy of ${snap.name || "the discarded card"}?`,
    costLabel: "{2}{U}", cost: { mana: "{2}{U}" },
    acceptedEffects: [{ type: "createZombieTokenCopy", eventCardSnapshot: snap }]
  });
};

EFFECTS.createZombieTokenCopy = function (lobby, ctx, params) {
  const snap = params.eventCardSnapshot;
  if (!snap) return;
  const data = { ...snap };
  const parts = (data.type || "Creature").replace(/\blegendary\s+/i, "").split("—");
  data.type = `Token ${parts[0].trim()} — Zombie`;
  data.colors = ["B"];
  data.power = "4";
  data.toughness = "4";
  data.owner = ctx.controllerId;
  data.zoneType = classifyType(data.type);
  const token = spawnBattlefieldCard(lobby, data);
  if (token) { token.tapped = true; broadcastCard(lobby, token); }
  const p = lobby.players[ctx.controllerId];
  pushLog(lobby, `${p ? p.name : "Someone"} creates a tapped 4/4 black Zombie token copy of ${snap.name || "a creature"} (Hashaton)`);
  broadcastPlayers(lobby);
};

// Arcbond: "Choose target creature. Whenever that creature is dealt damage this turn, it deals that much damage to each other creature and each
// player." Marks the creature; fireCreatureDamagedTrigger (server.js) queues arcbondBurst for every damage event this turn.
SPELL_ABILITIES["arcbond"] = {
  label: "Arcbond — the chosen creature deals damage to each other creature and each player whenever it is dealt damage this turn",
  effects: [{ type: "arcbondMark" }], requiresTarget: true, targetKind: "creature"
};

EFFECTS.arcbondMark = function (lobby, ctx, params) {
  const card = lobby.cards[params.chosenTargetId];
  if (!card || card.zoneType !== "creature") return;
  card._arcbondTurn = lobby.turn.turnNumber;
  pushLog(lobby, `${card.name || "A creature"} is marked by Arcbond until end of turn`);
};

EFFECTS.arcbondBurst = function (lobby, ctx, params) {
  const source = lobby.cards[params.sourceCardId] || ctx.sourceCard;
  const amount = params.amount || 0;
  if (!source || amount <= 0) return;
  const dmgCtx = { controllerId: source.owner, sourceCard: source };
  Object.values(lobby.cards)
    .filter((c) => c.zoneType === "creature" && c.id !== source.id)
    .map((c) => c.id)
    .forEach((id) => { if (lobby.cards[id]) EFFECTS.damageTarget(lobby, dmgCtx, { amount, chosenTargetId: id }); });
  Object.keys(lobby.players).forEach((pid) => {
    const pl = lobby.players[pid];
    if (pl && !pl.eliminated) EFFECTS.damageTarget(lobby, dmgCtx, { amount, chosenTargetId: pid });
  });
  checkEliminations(lobby);
  broadcastPlayers(lobby);
};

// Nesting Grounds: "{1}, {T}: Move a counter from target permanent you control onto a second target permanent. Activate only as a sorcery."
// Counters are one signed scalar per card in this engine (+N = +1/+1 or loyalty, -N = -1/-1), so the moved counter is the first target's own kind.
// Targets are limited to creatures and artifacts (the "ownPermanent" / "permanent" target kinds); sorcery timing comes from the condition (Strength Bobblehead's shape).
ACTIVATED_ABILITIES["nesting grounds"] = [{
  cost: { mana: "{1}", tap: true }, requiresTarget: true, targetKind: "ownPermanent",
  condition: (card, lobby) => lobby.turn.order[lobby.turn.activeIndex] === card.owner && (lobby.turn.phase === "Main 1" || lobby.turn.phase === "Main 2") && lobby.stack.length === 0,
  conditionError: "Activate only as a sorcery.",
  label: "Nesting Grounds — {1}, {T}: move a counter from target permanent you control onto a second target permanent (sorcery speed)",
  effects: [{ type: "nestingGroundsChooseSecond" }]
}];

EFFECTS.nestingGroundsChooseSecond = function (lobby, ctx, params) {
  const from = lobby.cards[params.chosenTargetId];
  if (!from || !from.counters) return;
  queueTargetChoice(lobby, {
    controllerId: ctx.controllerId, sourceCard: ctx.sourceCard,
    label: "Nesting Grounds — choose the second target permanent (it receives the counter)", targetKind: "permanent",
    effects: [{ type: "nestingGroundsMove", fromCardId: from.id }]
  });
};

EFFECTS.nestingGroundsMove = function (lobby, ctx, params) {
  const from = lobby.cards[params.fromCardId];
  const to = lobby.cards[params.chosenTargetId];
  if (!from || !to || from.id === to.id || !from.counters) return;
  const sign = from.counters > 0 ? 1 : -1;
  from.counters -= sign;
  to.counters = (to.counters || 0) + sign;
  broadcastCard(lobby, from);
  broadcastCard(lobby, to);
  pushLog(lobby, `Nesting Grounds moves a ${sign > 0 ? "+1/+1" : "-1/-1"} counter from ${from.name || "a permanent"} to ${to.name || "a permanent"}`);
};
