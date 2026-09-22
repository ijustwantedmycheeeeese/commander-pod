// Wave 64 -- Redirect Lightning, Misdirection, Untimely Malfunction, Fire Covenant.
// Engine bits in server.js: additionalCost.lifeOrGeneric ("pay 5 life or {2}", attemptPlay), additionalCost.minX, card._payXLife,
// spell.allowDupTargets (a repeating target chain that may pick the same target again, capped at X picks), blockerCard._cantBlockTurn,
// and queueRedirectNewTargetChoice takes params.sourceName for its prompt label.

// Redirect Lightning -- "As an additional cost, pay 5 life or pay {2}. Change the target of target spell or ability with a single target."
// (Reuses Deflecting Swat's redirect; the "single target" restriction and the legality of the new target are not re-validated.)
SPELL_ABILITIES["redirect lightning"] = {
  label: "Redirect Lightning — change the target of target spell or ability",
  additionalCost: { lifeOrGeneric: { life: 5, generic: 2 } },
  requiresTarget: true, targetKind: "spell", effects: [{ type: "queueRedirectNewTargetChoice", sourceName: "Redirect Lightning" }]
};

// Misdirection -- "You may exile a blue card from your hand rather than pay this spell's mana cost. Change the target of target spell with a single target."
SPELL_ABILITIES["misdirection"] = {
  label: "Misdirection — change the target of target spell",
  requiresTarget: true, targetKind: "spell", effects: [{ type: "queueRedirectNewTargetChoice", sourceName: "Misdirection" }]
};
ALT_COSTS["misdirection"] = { kind: "exileColoredCardFromHand", colorFilter: "U", lifeCost: 0, label: "Misdirection — exile a blue card from your hand rather than pay its mana cost" };

// Untimely Malfunction -- modal: destroy target artifact / change the target of target spell or ability / one or two target creatures can't block this turn.
SPELL_ABILITIES["untimely malfunction"] = {
  label: "Untimely Malfunction — choose one",
  modes: [
    { label: "Untimely Malfunction — destroy target artifact", requiresTarget: true, targetKind: "artifact", effects: [{ type: "destroyTarget" }] },
    { label: "Untimely Malfunction — change the target of target spell or ability", requiresTarget: true, targetKind: "spell", effects: [{ type: "queueRedirectNewTargetChoice", sourceName: "Untimely Malfunction" }] },
    { label: "Untimely Malfunction — one or two target creatures can't block this turn", requiresTarget: true, targetKind: "creature",
      extraTargets: [{ targetKind: "creature", optional: true, label: "Untimely Malfunction — a second creature that can't block, or press Done" }],
      effects: [{ type: "targetsCantBlockThisTurn" }] }
  ]
};

EFFECTS.targetsCantBlockThisTurn = function (lobby, ctx, params) {
  const ids = (params.chosenTargetIds || [params.chosenTargetId]).filter((t) => t != null);
  ids.forEach((id) => {
    const c = lobby.cards[id];
    if (!c || c.zoneType !== "creature") return;
    c._cantBlockTurn = lobby.turn.turnNumber;
    pushLog(lobby, `${c.name} can't block this turn`);
  });
};

// Fire Covenant -- "As an additional cost, pay X life. Fire Covenant deals X damage divided as you choose among any number of target creatures."
// Every pick in the chain is one point of the X life paid (a creature may be picked several times); the chain ends by itself after X picks.
SPELL_ABILITIES["fire covenant"] = {
  label: "Fire Covenant — pay X life, X damage divided among target creatures (each click = 1 damage)",
  additionalCost: { payXLife: true, minX: 1 },
  requiresTarget: true, targetKind: "creature", repeat: true, allowDupTargets: true,
  repeatLabel: "Fire Covenant — click a creature for each point of damage (repeat), or press Done",
  effects: [{ type: "dividedDamageByPicks" }]
};

EFFECTS.dividedDamageByPicks = function (lobby, ctx, params) {
  const ids = (params.chosenTargetIds || [params.chosenTargetId]).filter((t) => t != null);
  const tally = {};
  ids.forEach((id) => { tally[id] = (tally[id] || 0) + 1; });
  Object.keys(tally).forEach((id) => EFFECTS.damageTarget(lobby, ctx, { amount: tally[id], chosenTargetId: id }));
};
