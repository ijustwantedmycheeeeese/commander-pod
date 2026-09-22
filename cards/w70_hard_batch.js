// Wave 70 -- Psychic Frog, Tavern Brawler, Red Sun's Twilight.

// Psychic Frog -- "Whenever this creature deals combat damage to a player or planeswalker, draw a
// card." (the planeswalker half is a disclosed narrowing: this engine's combatDamageToPlayer trigger
// only ever fires for player damage, same simplification every other "...or planeswalker" card here
// already accepts). "Discard a card: Put a +1/+1 counter on this creature." (autoDiscardFilter's plain
// "card" shape, Cryptbreaker precedent). "Exile three cards from your graveyard: This creature gains
// flying until end of turn." -- a genuinely new cost (no existing "exile N from your own graveyard"
// activation cost), added as cost.autoExileGraveyardCount in server.js's activateAbility handler,
// mirroring autoDiscardCount's own auto-pick-first-N shape but sourced from the graveyard array.
CARD_ABILITIES["psychic frog"] = [
  { trigger: "combatDamageToPlayer", requiresTarget: false, label: "Psychic Frog — draw a card", effects: [{ type: "drawCards", amount: 1, target: "controller" }] }
];
ACTIVATED_ABILITIES["psychic frog"] = [
  { cost: { autoDiscardFilter: "card" }, requiresTarget: false, label: "Psychic Frog — Discard a card: put a +1/+1 counter on this creature", effects: [{ type: "addCountersToSelf", amount: 1 }] },
  { cost: { autoExileGraveyardCount: 3 }, requiresTarget: false, label: "Psychic Frog — Exile three cards from your graveyard: this creature gains flying until end of turn", effects: [{ type: "grantKeywordToSelf", keyword: "Flying" }] }
];

// Tavern Brawler -- "Commander creatures you own have 'At the beginning of your upkeep, exile the top
// card of your library. This creature gets +X/+0 until end of turn, where X is that card's mana
// value. You may play that card this turn.'" A Background (Folk Hero's own precedent this wave):
// rather than a real per-creature ability grant, the Background itself exiles ONE card at its
// controller's upkeep (a disclosed simplification when more than one commander creature is out --
// real Magic would have each grantee trigger and exile its own separate card) and applies that single
// card's mana value as a +X/+0 buff to every commander creature the controller currently has on the
// battlefield. "You may play that card this turn" reuses impulseExileTopToHand's own
// exile-into-hand-flagged-with-turn mechanism (Dark-Dweller Oracle precedent) rather than the plain
// helper, since the exiled card's cmc is needed for the buff.
CARD_ABILITIES["tavern brawler"] = [
  { trigger: "upkeep", requiresTarget: false, label: "Tavern Brawler — Commander creatures you own: at the beginning of your upkeep, exile the top card of your library; they get +X/+0 until end of turn where X is that card's mana value, and you may play that card this turn", effects: [{ type: "tavernBrawlerUpkeep" }] }
];
EFFECTS.tavernBrawlerUpkeep = function (lobby, ctx, params) {
  const p = lobby.players[ctx.controllerId];
  if (!p || !p.library.length) return;
  const commanders = Object.values(lobby.cards).filter((c) => c.owner === ctx.controllerId && c.isCommander && c.zoneType === "creature");
  if (!commanders.length) return;
  const entry = p.library.shift();
  const c = spawnBattlefieldCard(lobby, { ...entry, owner: ctx.controllerId, faceDown: false, zoneType: "hand" });
  c._impulseTurn = lobby.turn.turnNumber;
  broadcastCard(lobby, c);
  const mv = c.cmc || 0;
  commanders.forEach((cmd) => grantTemporaryPT(lobby, cmd, mv, 0));
  pushLog(lobby, `${p.name} exiles ${c.name || "a card"} off the top of their library (Tavern Brawler): commander creatures get +${mv}/+0 until end of turn`);
  broadcastPlayers(lobby);
};

// Red Sun's Twilight -- "Destroy up to X target artifacts. If X is 5 or more, for each artifact
// destroyed this way, create a token that's a copy of it. Those tokens gain haste. Exile them at the
// beginning of the next end step." "Up to X" reuses Fire Covenant's own repeat/allowEmpty target
// chain, but capped by the spell's real cast-time X (server.js's new capAtCastX flag /
// _castXValue) instead of Fire Covenant's payXLife, since these targets are distinct (no
// allowDupTargets). Each destroyed artifact is snapshotted into a token BEFORE it's actually
// destroyed (own bespoke copy, not createTokenCopyOfTargetCreature, so the newly spawned token's id
// is in hand to queue its own delayed exile -- the shared helper never returns what it creates), same
// delayed-exile-at-end-step shape as Whip of Erebos's reanimateWithHasteExileAtEndStep.
SPELL_ABILITIES["red sun's twilight"] = {
  label: "Red Sun's Twilight — destroy up to X target artifacts; if X is 5 or more, create hasty token copies of them, exiled at the next end step",
  requiresTarget: true, targetKind: "artifact", repeat: true, allowEmpty: true, capAtCastX: true,
  repeatLabel: "Red Sun's Twilight — another artifact to destroy, or press Done",
  effects: [{ type: "redSunsTwilightDestroy" }]
};
EFFECTS.redSunsTwilightDestroy = function (lobby, ctx, params) {
  const ids = (params.chosenTargetIds || [params.chosenTargetId]).filter((t) => t != null);
  const x = params.xAmount || 0;
  ids.forEach((id) => {
    const c = lobby.cards[id];
    if (!c) return;
    if (x >= 5) {
      const token = spawnBattlefieldCard(lobby, {
        name: c.name, type: c.type, manaCost: c.manaCost, cmc: c.cmc, colors: c.colors, colorIdentity: c.colorIdentity,
        text: c.text, img: c.img, producedMana: c.producedMana, keywords: [...new Set([...(c.keywords || []), "Haste"])],
        owner: ctx.controllerId, zoneType: "artifact"
      });
      queueDelayedTrigger(lobby, {
        firesAtPhase: "End Step", controllerId: ctx.controllerId, sourceCard: token,
        label: `${token.name || "A token"} — exile (Red Sun's Twilight)`, effects: [{ type: "exileChosenCardById", targetCardId: token.id }]
      });
    }
    EFFECTS.destroyTarget(lobby, ctx, { chosenTargetId: id });
  });
};
