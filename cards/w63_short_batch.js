// Wave 63 -- Horizon of Progress, Empowered Autogenerator, Nezahal Primal Tide, Veil of Summer, Wishclaw Talisman.
// Engine bits in server.js: cost.autoDiscardCount (discard N cards), cost.removeNamedCounter / cost.ownTurnOnly (card.namedCounters),
// pendingDiscard.tapped (land put onto the battlefield tapped), excludeTypeFilter in fireCastWatchTriggers, player._castColors
// (colours cast this turn), player._uncounterableTurn (isProtectedFromCountering) and player._hexproofColors (cardTypeProtectionBlocks).

// Horizon of Progress -- the mana half offers the colours (or {C}) of the OTHER lands you control (its own ability is ignored, CR 106.7 loop rule).
ACTIVATED_ABILITIES["horizon of progress"] = [
  { cost: { tap: true, life: 1 }, manaAbility: true, label: "Horizon of Progress — {T}, Pay 1 life: Add one mana of any type that a land you control could produce", effects: [{ type: "chooseManaFromOwnLandTypes", sourceName: "Horizon of Progress" }] },
  { cost: { mana: "{3}", tap: true }, requiresTarget: false, label: "Horizon of Progress — {3},{T}: you may put a land card from your hand onto the battlefield tapped", effects: [{ type: "putLandFromHandOntoBattlefieldOptional", tapped: true }] },
  { cost: { mana: "{1}", tap: true, sacrifice: true }, requiresTarget: false, label: "Horizon of Progress — {1},{T}, sacrifice this land: draw a card", effects: [{ type: "drawCards", amount: 1 }] }
];

// Empowered Autogenerator -- "{T}: Put a charge counter on this artifact. Add X mana of any one color, where X is the number of charge counters on this artifact."
ACTIVATED_ABILITIES["empowered autogenerator"] = [
  { cost: { tap: true }, manaAbility: true, label: "Empowered Autogenerator — put a charge counter on it, add X mana of any one color", effects: [{ type: "chargeCounterAnyColorMana" }] }
];

EFFECTS.chargeCounterAnyColorMana = function (lobby, ctx, params) {
  const card = ctx.sourceCard && lobby.cards[ctx.sourceCard.id];
  if (!card) return;
  card.namedCounters = card.namedCounters || {};
  card.namedCounters.charge = (card.namedCounters.charge || 0) + 1;
  broadcastCard(lobby, card);
  const p = lobby.players[ctx.controllerId];
  pushLog(lobby, `${p ? p.name : "Someone"}: ${card.name} now has ${card.namedCounters.charge} charge counter${card.namedCounters.charge === 1 ? "" : "s"}`);
  EFFECTS.chooseManaAnyColor(lobby, ctx, { amount: card.namedCounters.charge, sourceName: card.name });
};

// Nezahal, Primal Tide -- "Whenever an opponent casts a noncreature spell, draw a card." / "Discard three cards: Exile Nezahal. Return it to the
// battlefield tapped under its owner's control at the beginning of the next end step."
CARD_ABILITIES["nezahal, primal tide"] = [
  { trigger: "opponentCastsSpellTrig", excludeTypeFilter: ["creature"], requiresTarget: false, label: "Nezahal, Primal Tide — an opponent cast a noncreature spell: draw a card", effects: [{ type: "drawCards", amount: 1 }] }
];
ACTIVATED_ABILITIES["nezahal, primal tide"] = [
  { cost: { autoDiscardFilter: "card", autoDiscardCount: 3 }, requiresTarget: false, label: "Nezahal, Primal Tide — discard three cards: exile it, return it tapped at the beginning of the next end step", effects: [{ type: "exileSelfReturnTappedAtEndStep" }] }
];

EFFECTS.exileSelfReturnTappedAtEndStep = function (lobby, ctx, params) {
  const card = ctx.sourceCard && lobby.cards[ctx.sourceCard.id];
  if (!card) return;
  const ownerId = card.originalOwner || card.owner;
  const owner = lobby.players[ownerId];
  if (!owner) return;
  const entry = toEntry(card);
  exileCardInternal(lobby, card);
  const at = owner.exile.findIndex((e) => e.id === entry.id);
  if (at === -1) return; // a commander went back to the command zone instead of exile
  broadcastPlayers(lobby);
  queueDelayedTrigger(lobby, {
    firesAtPhase: "End Step", controllerId: ctx.controllerId, sourceCard: ctx.sourceCard,
    label: `${entry.name} — return it to the battlefield tapped`,
    effects: [{ type: "returnExiledEntryTapped", entryId: entry.id, ownerId }]
  });
};

EFFECTS.returnExiledEntryTapped = function (lobby, ctx, params) {
  const owner = lobby.players[params.ownerId];
  if (!owner) return;
  const idx = owner.exile.findIndex((e) => e.id === params.entryId);
  if (idx === -1) return;
  const [entry] = owner.exile.splice(idx, 1);
  const newCard = spawnBattlefieldCard(lobby, { ...entry, owner: params.ownerId, zoneType: classifyType(entry.type), faceDown: false });
  newCard.tapped = true;
  broadcastCard(lobby, newCard);
  broadcastPlayers(lobby);
  pushLog(lobby, `${entry.name || "A card"} returns to the battlefield tapped`);
  fireEtbTriggers(lobby, newCard);
};

// Veil of Summer -- "Draw a card if an opponent has cast a blue or black spell this turn. Spells you control can't be countered this turn. You and
// permanents you control gain hexproof from blue and from black until end of turn."
SPELL_ABILITIES["veil of summer"] = { label: "Veil of Summer — draw if an opponent cast a blue or black spell, uncounterable spells, hexproof from blue and black", effects: [{ type: "veilOfSummer" }] };

EFFECTS.veilOfSummer = function (lobby, ctx, params) {
  const p = lobby.players[ctx.controllerId];
  if (!p) return;
  const turn = lobby.turn.turnNumber;
  const oppCastBlueBlack = Object.entries(lobby.players).some(([id, o]) => id !== ctx.controllerId && o._castColors && o._castColors.turn === turn && o._castColors.colors.some((col) => col === "U" || col === "B"));
  if (oppCastBlueBlack) drawN(lobby, ctx.controllerId, 1);
  p._uncounterableTurn = turn;
  p._hexproofColors = { turn, colors: ["U", "B"] };
  pushLog(lobby, `${p.name}: spells can't be countered and hexproof from blue and black until end of turn (Veil of Summer)`);
  broadcastPlayers(lobby);
};

// Wishclaw Talisman -- "This artifact enters with three wish counters on it. {1}, {T}, Remove a wish counter from this artifact: Search your
// library for a card, put it into your hand, then shuffle. An opponent gains control of this artifact. Activate only during your turn."
CARD_ABILITIES["wishclaw talisman"] = [
  { trigger: "etb", requiresTarget: false, label: "Wishclaw Talisman — enters with three wish counters", effects: [{ type: "enterWithNamedCounters", name: "wish", amount: 3 }] }
];
ACTIVATED_ABILITIES["wishclaw talisman"] = [
  { cost: { mana: "{1}", tap: true, removeNamedCounter: "wish", ownTurnOnly: true }, requiresTarget: false, label: "Wishclaw Talisman — remove a wish counter: search for a card, then an opponent gains control of it", effects: [{ type: "tutorToHand" }, { type: "giveSourceToNextOpponent" }] }
];

EFFECTS.enterWithNamedCounters = function (lobby, ctx, params) {
  const card = ctx.sourceCard && lobby.cards[ctx.sourceCard.id];
  if (!card) return;
  card.namedCounters = card.namedCounters || {};
  card.namedCounters[params.name] = (card.namedCounters[params.name] || 0) + (params.amount || 1);
  broadcastCard(lobby, card);
};

// "An opponent gains control": the opponent next in turn order (in a 2-player game the only one).
EFFECTS.giveSourceToNextOpponent = function (lobby, ctx, params) {
  const card = ctx.sourceCard && lobby.cards[ctx.sourceCard.id];
  if (!card) return;
  const order = lobby.turn.order || Object.keys(lobby.players);
  const start = order.indexOf(ctx.controllerId);
  for (let i = 1; i < order.length; i++) {
    const id = order[(start + i) % order.length];
    const opp = lobby.players[id];
    if (opp && !opp.eliminated && id !== ctx.controllerId) {
      changeControl(lobby, card, id);
      pushLog(lobby, `${opp.name} gains control of ${card.name}`);
      broadcastPlayers(lobby);
      return;
    }
  }
};

EFFECTS.chooseManaFromOwnLandTypes = function (lobby, ctx, params) {
  const p = lobby.players[ctx.controllerId];
  if (!p) return;
  const colors = new Set();
  for (const id in lobby.cards) {
    const c = lobby.cards[id];
    if (c.owner !== ctx.controllerId || c.zoneType !== "mana" || (ctx.sourceCard && c.id === ctx.sourceCard.id)) continue;
    const basic = basicLandColor(c.type);
    if (basic) colors.add(basic);
    if (Array.isArray(c.producedMana)) c.producedMana.forEach((col) => { if (["W", "U", "B", "R", "G", "C"].includes(col)) colors.add(col); });
  }
  if (!colors.size) { pushLog(lobby, `${p.name}: no land they control could produce mana (${params.sourceName || "mana source"})`); return; }
  EFFECTS.chooseManaFromColors(lobby, ctx, { colors: Array.from(colors), sourceName: params.sourceName });
};
