// Wave 57 -- Timetwister, Nighthawk Scavenger, Copy Artifact (+ Power Fist / The Reaver Cleaver: already worked at runtime through
// checkEquipmentCombatDamageCounters/Treasure in server.js, only their coverage classification was missing).
// New engine bit (server.js + index.html): Nighthawk Scavenger's dynamic power in staticBonusFor.

// "Each player shuffles their hand and graveyard into their library, then draws seven cards. (Then put Timetwister into its owner's graveyard.)"
SPELL_ABILITIES["timetwister"] = { label: "Timetwister — each player shuffles hand and graveyard into their library, then draws seven", effects: [{ type: "timetwisterEffect", amount: 7 }] };

// "Nighthawk Scavenger's power is equal to 1 plus the number of card types among cards in your opponents' graveyards." (dynamic power: staticBonusFor)
GENERIC_SENTENCE_PATTERNS.push(/^nighthawk scavenger's power is equal to 1 plus the number of card types among cards in your opponents' graveyards\.?$/);

// Power Fist / The Reaver Cleaver: the quoted combat-damage grants are already run by checkEquipmentCombatDamageCounters/Treasure (server.js);
// these patterns only mark the sentences as automated for the coverage scoring.
GENERIC_SENTENCE_PATTERNS.push(
  /^equipped creature has trample and "whenever this creature deals combat damage to a player, put that many \+1\/\+1 counters on it\."?$/,
  /^equipped creature gets \+1\/\+1 and has trample and "whenever this creature deals combat damage to a player or planeswalker, create that many treasure tokens\."?$/
);

// "You may have this enchantment enter as a copy of any artifact on the battlefield, except it's an enchantment in addition to its other types."
CARD_ABILITIES["copy artifact"] = [{ trigger: "etb", requiresTarget: true, targetKind: "typeList", typeFilter: ["artifact"], label: "Copy Artifact — you may have this enter as a copy of any artifact, except it's also an enchantment", effects: [{ type: "becomeCopyPermanent", addType: "Enchantment" }] }];

EFFECTS.timetwisterEffect = function (lobby, ctx, params) {
  for (const pid in lobby.players) {
    const p = lobby.players[pid];
    (p.graveyard || []).forEach((e) => p.library.push(e));
    p.graveyard = [];
    Object.values(lobby.cards).filter((c) => c.owner === pid && c.zoneType === "hand").forEach((c) => {
      p.library.push(toEntry(c));
      delete lobby.cards[c.id];
      if (lobby.targets[c.id]) delete lobby.targets[c.id];
      io.to(lobby.id).emit("cardRemove", c.id);
    });
    shuffle(p.library);
  }
  broadcastTargets(lobby);
  for (const pid in lobby.players) drawN(lobby, pid, params.amount || 7);
  broadcastPlayers(lobby);
};
