// Wave 66 -- Mindbreak Trap, Inkshield, Energy Field, Fraying Sanity, Isshin, Two Heavens as One.
// Engine bits in server.js: reduceDamageForVictim(..., isCombat) (Energy Field prevention, Inkshield via player.inkshieldActive),
// noteGraveyardEntry (called at every graveyard insertion: player.gyEntriesThisTurn + Energy Field sacrifice), fireFrayingSanityMills
// (End Step), attackTriggerCopies (Isshin: attack-caused triggers fire twice), ALT_COSTS kind freeIfOpponentCastSpells.

// Mindbreak Trap -- "Exile any number of target spells." (A repeating target chain: click each spell, then Done; zero targets is allowed.)
SPELL_ABILITIES["mindbreak trap"] = {
  label: "Mindbreak Trap — exile any number of target spells",
  requiresTarget: true, targetKind: "spell", repeat: true, allowEmpty: true,
  repeatLabel: "Mindbreak Trap — another spell to exile, or press Done",
  effects: [{ type: "exileTargetSpells" }]
};
ALT_COSTS["mindbreak trap"] = { kind: "freeIfOpponentCastSpells", minSpells: 3, label: "Mindbreak Trap — pay {0} if an opponent cast three or more spells this turn" };
EFFECTS.exileTargetSpells = function (lobby, ctx, params) {
  const ids = (params.chosenTargetIds || [params.chosenTargetId]).filter((t) => t != null);
  const caster = lobby.players[ctx.controllerId];
  new Set(ids).forEach((id) => {
    if (ctx.sourceCard && id === ctx.sourceCard.id) return;
    const idx = lobby.stack.findIndex((s) => s.id === id && s.kind !== "ability");
    if (idx === -1) return; // the spell left the stack: that target fizzles
    const item = lobby.stack.splice(idx, 1)[0];
    exileCardInternal(lobby, item); // exiled, not countered: "can't be countered" does not save it
    pushLog(lobby, `${caster ? caster.name : "Someone"} exiled ${item.name || "a spell"} (Mindbreak Trap)`);
  });
  broadcastStack(lobby);
};

// Inkshield -- "Prevent all combat damage that would be dealt to you this turn. For each 1 damage prevented this way, create a 2/1 white and
// black Inkling creature token with flying."
SPELL_ABILITIES["inkshield"] = {
  label: "Inkshield — prevent all combat damage dealt to you this turn; an Inkling per damage prevented",
  requiresTarget: false, effects: [{ type: "inkshieldActivate" }]
};
EFFECTS.inkshieldActivate = function (lobby, ctx) {
  const p = lobby.players[ctx.controllerId];
  if (!p) return;
  p.inkshieldActive = true;
  broadcastPlayers(lobby);
};

// Energy Field -- both halves live in server.js (reduceDamageForVictim / noteGraveyardEntry); these mark the sentences as handled.
GENERIC_SENTENCE_PATTERNS.push(/^prevent all damage that would be dealt to you by sources you don['’]t control\.?$/);
GENERIC_SENTENCE_PATTERNS.push(/^when a card is put into your graveyard from anywhere, sacrifice this enchantment\.?$/);

// Fraying Sanity -- "Enchant player": the ETB picks the player (an Aura is not attached in this engine), the mill is fireFrayingSanityMills.
CARD_ABILITIES["fraying sanity"] = [{
  trigger: "etb", requiresTarget: true, targetKind: "player",
  label: "Fraying Sanity — enchant target player",
  effects: [{ type: "enchantPlayerWithSelf" }]
}];
EFFECTS.enchantPlayerWithSelf = function (lobby, ctx, params) {
  const card = ctx.sourceCard && lobby.cards[ctx.sourceCard.id];
  if (!card || !lobby.players[params.chosenTargetId]) return;
  card._enchantedPlayerId = params.chosenTargetId;
  pushLog(lobby, `${card.name} enchants ${lobby.players[params.chosenTargetId].name}`);
  broadcastCard(lobby, card);
};
GENERIC_SENTENCE_PATTERNS.push(/^enchant player$/);
GENERIC_SENTENCE_PATTERNS.push(/^at the beginning of each end step, enchanted player mills x cards, where x is the number of cards put into their graveyard from anywhere this turn\.?$/);

// Isshin, Two Heavens as One -- the doubling is attackTriggerCopies (server.js).
GENERIC_SENTENCE_PATTERNS.push(/^if a creature attacking causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time\.?$/);
