// Wave 62 -- Massacre, Return of the Wildspeaker, Kaya's Ghostform, Dryad of the Ilysian Grove.
// Engine bits in server.js: checkGhostformReturn (called from fireDeathTriggers + exileCardInternal) and controlsChromaticLantern also
// matching Dryad (every land you control taps for any colour through the Chromatic Lantern branch of the tap handler).

GENERIC_SENTENCE_PATTERNS.push(
  /^when enchanted permanent dies or is put into exile, return that card to the battlefield under your control\.?$/,
  /^lands you control are every basic land type in addition to their other types\.?$/,
  /^enchant creature or planeswalker you control$/
);

// "If an opponent controls a Plains and you control a Swamp, you may cast this spell without paying its mana cost. All creatures get -2/-2 until end of turn."
ALT_COSTS["massacre"] = { kind: "freeIfLandTypes", ownLand: "swamp", opponentLand: "plains", label: "Massacre — cast for free if an opponent controls a Plains and you control a Swamp" };
SPELL_ABILITIES["massacre"] = { label: "Massacre — all creatures get -2/-2 until end of turn", effects: [{ type: "allCreaturesGetFixedMinus", amount: 2 }] };

// "Choose one — Draw cards equal to the greatest power among non-Human creatures you control. / Non-Human creatures you control get +3/+3 until end of turn."
SPELL_ABILITIES["return of the wildspeaker"] = { label: "Return of the Wildspeaker — choose one", modes: [
  { label: "Return of the Wildspeaker — draw cards equal to the greatest power among your non-Human creatures", requiresTarget: false, effects: [{ type: "drawGreatestPowerNonHuman" }] },
  { label: "Return of the Wildspeaker — your non-Human creatures get +3/+3 until end of turn", requiresTarget: false, effects: [{ type: "pumpNonHumanCreatures", amount: 3 }] }
] };

const isNonHumanCreature = (c, ownerId) => c.owner === ownerId && c.zoneType === "creature" && !/\bhuman\b/i.test(c.type || "");

EFFECTS.allCreaturesGetFixedMinus = function (lobby, ctx, params) {
  const x = params.amount || 0;
  if (!x) return;
  Object.values(lobby.cards).filter((c) => c.zoneType === "creature").forEach((c) => grantTemporaryPT(lobby, c, -x, -x));
  const p = lobby.players[ctx.controllerId];
  pushLog(lobby, `${p ? p.name : "Someone"}: all creatures get -${x}/-${x} until end of turn`);
  broadcastPlayers(lobby); // state-based check: toughness 0 or less dies now
};

EFFECTS.drawGreatestPowerNonHuman = function (lobby, ctx) {
  const greatest = Object.values(lobby.cards).filter((c) => isNonHumanCreature(c, ctx.controllerId)).reduce((max, c) => {
    const power = Math.max(0, parsePT(c.power) + (c.counters || 0) + attachedBonusFor(lobby, c).powerBonus + staticBonusFor(lobby, c).powerBonus);
    return Math.max(max, power);
  }, 0);
  drawN(lobby, ctx.controllerId, greatest);
};

EFFECTS.pumpNonHumanCreatures = function (lobby, ctx, params) {
  const amt = params.amount || 0;
  Object.values(lobby.cards).filter((c) => isNonHumanCreature(c, ctx.controllerId)).forEach((c) => grantTemporaryPT(lobby, c, amt, amt));
  broadcastPlayers(lobby);
};

// Kaya's Ghostform -- the trigger is queued by checkGhostformReturn (server.js); by the time it resolves the card sits in its owner's graveyard (dies) or exile.
EFFECTS.ghostformReturn = function (lobby, ctx, params) {
  const owner = lobby.players[params.ownerId];
  if (!owner) return;
  let entry = null;
  for (const zone of ["graveyard", "exile"]) {
    const idx = (owner[zone] || []).findIndex((e) => e.id === params.entryId);
    if (idx !== -1) { [entry] = owner[zone].splice(idx, 1); break; }
  }
  if (!entry) return;
  const card = spawnBattlefieldCard(lobby, { ...entry, owner: ctx.controllerId, zoneType: classifyType(entry.type) });
  broadcastPlayers(lobby);
  pushLog(lobby, `${entry.name || "A card"} returns to the battlefield (Kaya's Ghostform)`);
  fireEtbTriggers(lobby, card);
};
