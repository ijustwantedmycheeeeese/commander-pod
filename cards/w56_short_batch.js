// Wave 56 -- 6 cards: Sheoldred (draw triggers), Loran (ETB destroy + shared draw), Yahenni's Expertise (sweep + free cast),
// Mana Drain (counter + delayed mana), Sink into Stupor (bounce a spell OR nonland permanent), Steal Enchantment (control-change Aura).
// New engine bits: targetKind "opponentSpellOrNonlandPermanent" (server.js resolveChosenTarget + index.html), and the Aura
// control regex in checkControlDurations now also covers "you control enchanted enchantment/artifact/land".

// "Deathtouch. Whenever you draw a card, you gain 2 life. Whenever an opponent draws a card, they lose 2 life."
CARD_ABILITIES["sheoldred, the apocalypse"] = [
  { trigger: "youDrawCard", requiresTarget: false, label: "Sheoldred, the Apocalypse — you gain 2 life", effects: [{ type: "gainLife", target: "controller", amount: 2 }] },
  { trigger: "opponentDrawsCard", dynamicTargetOwner: true, requiresTarget: false, label: "Sheoldred, the Apocalypse — that opponent loses 2 life", effects: [{ type: "loseLife", amount: 2 }] }
];

// "When Loran enters, destroy up to one target artifact or enchantment. / {T}: You and target opponent each draw a card."
CARD_ABILITIES["loran of the third path"] = [{ trigger: "etb", requiresTarget: true, targetKind: "typeList", typeFilter: ["artifact", "enchantment"], label: "Loran of the Third Path — destroy up to one target artifact or enchantment", effects: [{ type: "destroyTarget" }] }];
ACTIVATED_ABILITIES["loran of the third path"] = [{ cost: { tap: true }, requiresTarget: true, targetKind: "opponent", label: "Loran of the Third Path — {T}: you and target opponent each draw a card", effects: [{ type: "drawCards", amount: 1, target: "controller" }, { type: "drawCards", amount: 1 }] }];

// "All creatures get -3/-3 until end of turn. You may cast a spell with mana value 3 or less from your hand without paying its mana cost."
SPELL_ABILITIES["yahenni's expertise"] = { label: "Yahenni's Expertise — all creatures get -3/-3 until end of turn, you may cast a spell (MV 3 or less) from hand free", effects: [{ type: "allCreaturesGetMinusN", amount: 3 }, { type: "queueFreeCastFromHand", maxCmc: 3 }] };

// "Counter target spell. At the beginning of your next main phase, add an amount of {C} equal to that spell's mana value."
SPELL_ABILITIES["mana drain"] = { label: "Mana Drain — counter target spell, add {C} equal to its mana value at the start of your next main phase", effects: [{ type: "counterTargetSpellDelayedMana" }], requiresTarget: true, targetKind: "spell" };

// Front face of "Sink into Stupor // Soporific Springs": "Return target spell or nonland permanent an opponent controls to its owner's hand."
SPELL_ABILITIES["sink into stupor"] = { label: "Sink into Stupor — return target spell or nonland permanent an opponent controls to its owner's hand", effects: [{ type: "bounceSpellOrNonlandPermanent" }], requiresTarget: true, targetKind: "opponentSpellOrNonlandPermanent" };

// "Enchant enchantment. You control enchanted enchantment." (the control link itself is checkControlDurations in server.js)
GENERIC_SENTENCE_PATTERNS.push(/^enchant enchantment$/, /^you control enchanted enchantment\.?$/);

EFFECTS.allCreaturesGetMinusN = function (lobby, ctx, params) {
  const n = params.amount || 0;
  if (!n) return;
  Object.values(lobby.cards).filter((c) => c.zoneType === "creature").forEach((c) => grantTemporaryPT(lobby, c, -n, -n));
  const p = lobby.players[ctx.controllerId];
  pushLog(lobby, `${p ? p.name : "Someone"} -- all creatures get -${n}/-${n} until end of turn`);
  broadcastPlayers(lobby); // state-based toughness check runs in broadcastPlayers
};

EFFECTS.counterTargetSpellDelayedMana = function (lobby, ctx, params) {
  const item = lobby.stack.find((s) => s.id === params.chosenTargetId);
  if (!item) return;
  const cmc = item.kind === "ability" ? 0 : (item.cmc || 0);
  EFFECTS.counterTargetSpell(lobby, ctx, params);
  if (lobby.stack.some((s) => s.id === params.chosenTargetId)) return; // "can't be countered": no mana
  if (!cmc) return;
  // "Your next main phase": on your own turn before/at precombat main that is Main 2 (or Main 1 if still earlier); otherwise your next turn's Main 1.
  const turn = lobby.turn;
  const ownTurn = turn.order[turn.activeIndex] === ctx.controllerId;
  let phase = "Main 1";
  if (ownTurn && (turn.phase === "Main 1" || turn.phase === "Combat")) phase = "Main 2";
  else if (ownTurn && (turn.phase === "Untap" || turn.phase === "Upkeep" || turn.phase === "Draw")) phase = "Main 1";
  queueDelayedTrigger(lobby, {
    firesAtPhase: phase, controllerId: ctx.controllerId, sourceCard: ctx.sourceCard, ownTurnOnly: true,
    label: `Mana Drain — add ${cmc} colorless mana`,
    effects: [{ type: "addFixedMana", colors: Array.from({ length: cmc }, () => "C") }]
  });
};

EFFECTS.bounceSpellOrNonlandPermanent = function (lobby, ctx, params) {
  const id = params.chosenTargetId;
  const idx = lobby.stack.findIndex((s) => s.id === id);
  if (idx !== -1) {
    const item = lobby.stack.splice(idx, 1)[0];
    if (item.kind === "ability") return;
    bounceCardToHandInternal(lobby, item);
    broadcastStack(lobby);
    return;
  }
  const card = lobby.cards[id];
  if (card && (card.zoneType === "creature" || card.zoneType === "artifact")) bounceCardToHandInternal(lobby, card);
};
