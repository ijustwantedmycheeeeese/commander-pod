// Wave 65 -- Reverberate, Agatha of the Vile Cauldron, Sweet-Gum Recluse, Counterbalance, Tato Farmer.
// Engine bits in server.js: card._isSpellCopy (a spell copy just ceases to exist in sendToGraveyardInternal/exileCardInternal),
// activatedAbilityCostReductionFor (Agatha clause), fireTrigger forwards `repeat` for "any number of target" triggers,
// targetKinds creatureEnteredThisTurn / milledLandInGraveyard (server + index.html), entry._milledTurn stamped by millLibraryCards,
// and CARD_ABILITIES `bakeCastSpell` (fireCastWatchTriggers bakes the cast spell's stack id into each effect as spellId).

// Reverberate -- "Copy target instant or sorcery spell. You may choose new targets for the copy."
SPELL_ABILITIES["reverberate"] = {
  label: "Reverberate — copy target instant or sorcery spell",
  requiresTarget: true, targetKind: "instantOrSorcerySpell", effects: [{ type: "copyTargetSpell" }]
};
EFFECTS.copyTargetSpell = function (lobby, ctx, params) {
  const orig = lobby.stack.find((s) => s.id === params.chosenTargetId);
  if (!orig || orig.kind === "ability" || !isInstantOrSorcery(orig.type)) return; // the spell left the stack: fizzles
  const p = lobby.players[ctx.controllerId];
  const copy = {
    ...orig, id: newId(), owner: ctx.controllerId, ownerColor: p ? p.color : orig.ownerColor,
    isCommander: false, originalOwner: null, _flashback: false, _isSpellCopy: true, zoneType: "stack",
    _resolvedSpellEffects: orig._resolvedSpellEffects ? JSON.parse(JSON.stringify(orig._resolvedSpellEffects)) : undefined
  };
  lobby.cards[copy.id] = copy;
  lobby.stack.push(copy); // a copy is not cast: no cast triggers, it just lands on top and resolves first
  broadcastCard(lobby, copy);
  broadcastStack(lobby);
  pushLog(lobby, `${p ? p.name : "Someone"} copied ${orig.name || "a spell"}`);
  if (copy._resolvedSpellEffects && copy._resolvedSpellEffects.some((e) => e.chosenTargetId)) {
    queueTargetChoice(lobby, {
      controllerId: ctx.controllerId, sourceCard: ctx.sourceCard, label: `Reverberate — choose a new target for the copy of ${orig.name || "the spell"} (or skip to keep the target)`,
      targetKind: "any", optional: true, allowEmpty: true, effects: [{ type: "redirectSpellCopyTarget", stackItemId: copy.id }]
    });
  }
};
EFFECTS.redirectSpellCopyTarget = function (lobby, ctx, params) {
  if (!params.chosenTargetId) return; // skipped: the copy keeps the original target
  const item = lobby.stack.find((s) => s.id === params.stackItemId);
  if (!item || !item._resolvedSpellEffects) return;
  item._resolvedSpellEffects.forEach((e) => { if (e.chosenTargetId) e.chosenTargetId = params.chosenTargetId; });
  broadcastStack(lobby);
  pushLog(lobby, "The copy's target is changed");
};

// Agatha of the Vile Cauldron -- the cost reduction lives in activatedAbilityCostReductionFor (server.js); this only
// tells the coverage scorer the two static sentences are handled.
GENERIC_SENTENCE_PATTERNS.push(/^activated abilities of creatures you control cost \{x\} less to activate, where x is [^']+'s power\.?$/);

// Sweet-Gum Recluse -- "When this creature enters, put three +1/+1 counters on each of any number of target creatures that entered this turn."
CARD_ABILITIES["sweet-gum recluse"] = [{
  trigger: "etb", requiresTarget: true, repeat: true, targetKind: "creatureEnteredThisTurn",
  label: "Sweet-Gum Recluse — put three +1/+1 counters on each of any number of target creatures that entered this turn",
  effects: [{ type: "addCountersToEachTarget", amount: 3 }]
}];
EFFECTS.addCountersToEachTarget = function (lobby, ctx, params) {
  const ids = params.chosenTargetIds || (params.chosenTargetId ? [params.chosenTargetId] : []);
  ids.filter((t) => t != null).forEach((id) => EFFECTS.addCountersToTarget(lobby, ctx, { amount: params.amount, chosenTargetId: id }));
};

// Counterbalance -- "Whenever an opponent casts a spell, you may reveal the top card of your library. If you do, counter that spell
// if it has the same mana value as the revealed card." (The "may" is always taken: revealing costs nothing but information.)
CARD_ABILITIES["counterbalance"] = [{
  trigger: "opponentCastsSpellTrig", bakeCastSpell: true, requiresTarget: false,
  label: "Counterbalance — reveal the top card of your library; counter that spell if it has the same mana value",
  effects: [{ type: "counterbalanceReveal" }]
}];
EFFECTS.counterbalanceReveal = function (lobby, ctx, params) {
  const p = lobby.players[ctx.controllerId];
  const top = p && (p.library || [])[0];
  if (!top) return;
  const spell = lobby.stack.find((s) => s.id === params.spellId);
  pushLog(lobby, `${p.name} reveals ${top.name || "a card"} (mana value ${top.cmc || 0}) with Counterbalance`);
  if (!spell || spell.kind === "ability") return;
  if ((top.cmc || 0) === (spell.cmc || 0)) EFFECTS.counterTargetSpell(lobby, ctx, { chosenTargetId: spell.id });
};

// Tato Farmer -- "{T}: Put target land card in a graveyard that was milled this turn onto the battlefield under your control tapped."
ACTIVATED_ABILITIES["tato farmer"] = [{
  cost: { tap: true }, requiresTarget: true, targetKind: "milledLandInGraveyard",
  label: "Tato Farmer — {T}: put target land card in a graveyard that was milled this turn onto the battlefield under your control tapped",
  effects: [{ type: "reanimateFromGraveyardTapped" }]
}];
EFFECTS.reanimateFromGraveyardTapped = function (lobby, ctx, params) {
  const found = findAndRemoveGraveyardEntry(lobby, params.chosenTargetId);
  if (!found) return;
  const card = spawnBattlefieldCard(lobby, { ...found.entry, owner: ctx.controllerId, zoneType: classifyType(found.entry.type) });
  card.tapped = true;
  broadcastCard(lobby, card);
  broadcastPlayers(lobby);
  fireEtbTriggers(lobby, card);
};

// Agatha's own second ability -- "{4}{R}{G}: Other creatures you control get +1/+1 and gain trample and haste until end of turn."
ACTIVATED_ABILITIES["agatha of the vile cauldron"] = [{
  cost: { mana: "{4}{R}{G}" }, requiresTarget: false,
  label: "Agatha — {4}{R}{G}: other creatures you control get +1/+1 and gain trample and haste until end of turn",
  effects: [{ type: "grantTemporaryPTAndKeywordsToOtherCreatures", power: 1, toughness: 1, keywords: ["Trample", "Haste"] }]
}];
EFFECTS.grantTemporaryPTAndKeywordsToOtherCreatures = function (lobby, ctx, params) {
  Object.values(lobby.cards).forEach((c) => {
    if (c.owner !== ctx.controllerId || c.zoneType !== "creature" || (ctx.sourceCard && c.id === ctx.sourceCard.id)) return;
    if (params.power || params.toughness) grantTemporaryPT(lobby, c, params.power || 0, params.toughness || 0);
    (params.keywords || []).forEach((k) => grantTemporaryKeyword(lobby, c, k));
  });
};
