// Wave 58 -- Hyena Umbra (umbra armor), Notion Thief (draw replacement), Breena, the Demagogue (attack trigger, attacker draws).
// New engine bits in server.js: tryUmbraArmor (called wherever a creature would be destroyed), the Notion Thief replacement inside drawN,
// and the "playerAttacksOpponent" trigger dispatch in the declareAttackers handler (attackerId/defenderId baked into the effects).

// "Enchant creature. Enchanted creature gets +1/+1 and has first strike. Umbra armor" (the bonus is the generic aura handling).
GENERIC_SENTENCE_PATTERNS.push(/^umbra armor(?: \(.*\))?\.?$/);

// "If an opponent would draw a card except the first one they draw in each of their draw steps, instead that player skips that draw and you draw a card."
GENERIC_SENTENCE_PATTERNS.push(/^if an opponent would draw a card except the first one they draw in each of their draw steps, instead that player skips that draw and you draw a card\.?$/);

// "Whenever a player attacks one of your opponents, if that opponent has more life than another of your opponents, that attacking player
// draws a card and you put two +1/+1 counters on a creature you control."
CARD_ABILITIES["breena, the demagogue"] = [{
  trigger: "playerAttacksOpponent", requiresTarget: false,
  label: "Breena, the Demagogue — the attacking player draws a card and you put two +1/+1 counters on a creature you control",
  condition: (source, lobby, ev) => {
    const def = lobby.players[ev.defenderId];
    if (!def) return false;
    return Object.keys(lobby.players).some((id) => id !== source.owner && id !== ev.defenderId && !lobby.players[id].eliminated && lobby.players[id].life < def.life);
  },
  effects: [{ type: "breenaDrawAndCounters" }]
}];

EFFECTS.breenaDrawAndCounters = function (lobby, ctx, params) {
  const drawer = lobby.players[params.attackerId];
  if (drawer && !drawer.eliminated) {
    drawN(lobby, params.attackerId, 1);
    pushLog(lobby, `Breena, the Demagogue -- ${drawer.name} draws a card`);
  }
  const hasCreature = Object.values(lobby.cards).some((c) => c.owner === ctx.controllerId && c.zoneType === "creature");
  if (hasCreature) {
    queueTargetChoice(lobby, {
      controllerId: ctx.controllerId, sourceCard: ctx.sourceCard,
      label: "Breena, the Demagogue — put two +1/+1 counters on a creature you control", targetKind: "ownCreature",
      effects: [{ type: "addCountersToTarget", amount: 2 }]
    });
  }
  broadcastPlayers(lobby);
};
