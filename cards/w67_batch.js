// Wave 67 -- Malakir Rebirth // Malakir Mire, Thousand-Year Storm, Strong the Brutish Thespian,
// Nuka-Nuke Launcher, Cosmic Spider-Man.
// Engine bits in server.js: checkDeathReturnTapped (fireDeathTriggers; card._deathReturnTappedTurn,
// Malakir Rebirth), fireGlobalTrigger's new bakeStormCopy branch (bakes spellId + the PRE-increment
// _instSorcCastThisTurn count into effects, Thousand-Year Storm), castSpell's own
// _instSorcCastThisTurn increment + _nukaNukeUntilTurnNumber check (Nuka-Nuke Launcher, checked on
// EVERY cast by any player -- a delayed effect belongs to the player, not to the permanent that
// armed it), and fireAttackTriggers' enchantedCreatureAttacks loop now bakes attackerDefenderId too.

// Malakir Rebirth // Malakir Mire -- "Choose target creature. You lose 2 life. Until end of turn,
// that creature gains 'When this creature dies, return it to the battlefield tapped under its
// owner's control.'" Malakir Mire (the land back face) is a plain "enters tapped unless you
// control two or more other lands. {T}: Add {B}." -- both halves already handled generically
// (conditionalEntersTappedCount + the plain-tap producedMana shortcut), no table entry needed.
// Both keys defined identically, same "front name alone AND the full 'a // b' name" precedent as
// Bala Ged Recovery // Bala Ged Sanctuary.
const malakirRebirthAbility = {
  label: "Malakir Rebirth — target creature gains \"when this dies, return it to the battlefield tapped under its owner's control\" this turn; you lose 2 life",
  requiresTarget: true, targetKind: "creature",
  effects: [{ type: "casterLosesLife", amount: 2 }, { type: "markDeathReturnTapped" }]
};
SPELL_ABILITIES["malakir rebirth"] = malakirRebirthAbility;
SPELL_ABILITIES["malakir rebirth // malakir mire"] = malakirRebirthAbility;
// EFFECTS.loseLife reads chosenTargetId FIRST when present (added for Archon of Cruelty's real
// "target opponent loses life"), which would collide here -- the spell's single creature target
// gets baked onto EVERY effect in this array, so a plain {type:"loseLife", target:"controller"}
// would wrongly try to reduce the TARGET CREATURE's (nonexistent) life instead of the caster's.
// This ignores chosenTargetId entirely and always hits ctx.controllerId, same applyLifeLoss guts
// (lifeLocked, Deflecting Palm redirect, etc.) loseLife itself uses.
EFFECTS.casterLosesLife = function (lobby, ctx, params) {
  const sourceCardId = ctx.sourceCard && ctx.sourceCard.id;
  if (applyLifeLoss(lobby, ctx.controllerId, params.amount || 0, sourceCardId)) {
    io.to(lobby.id).emit("spellDamage", { targetId: ctx.controllerId, amount: params.amount || 0, sourceCardId });
  }
};
EFFECTS.markDeathReturnTapped = function (lobby, ctx, params) {
  const c = lobby.cards[params.chosenTargetId];
  if (!c) return;
  c._deathReturnTappedTurn = lobby.turn.turnNumber;
  broadcastCard(lobby, c);
  pushLog(lobby, `${c.name || "The creature"} gains "when this dies, return it tapped under its owner's control" this turn (Malakir Rebirth)`);
};
// The actual return -- checkDeathReturnTapped (server.js) queues this once the marked creature
// really dies; the card sits in its owner's graveyard by the time it resolves (findAndRemoveGraveyardEntry
// scans every player's graveyard, same as Tato Farmer's reanimateFromGraveyardTapped).
EFFECTS.deathReturnTapped = function (lobby, ctx, params) {
  const found = findAndRemoveGraveyardEntry(lobby, params.entryId);
  if (!found) return;
  const card = spawnBattlefieldCard(lobby, { ...found.entry, owner: found.ownerId, zoneType: classifyType(found.entry.type) });
  card.tapped = true;
  broadcastCard(lobby, card);
  broadcastPlayers(lobby);
  pushLog(lobby, `${found.entry.name || "A creature"} returns to the battlefield tapped (Malakir Rebirth)`);
  fireEtbTriggers(lobby, card);
};

// Thousand-Year Storm -- "Whenever you cast an instant or sorcery spell, copy it for each other
// instant and sorcery spell you've cast before it this turn. You may choose new targets for the copies."
CARD_ABILITIES["thousand-year storm"] = [{
  trigger: "youCastSpell", spellTypeFilter: ["instant", "sorcery"], bakeStormCopy: true, requiresTarget: false,
  label: "Thousand-Year Storm — copy the spell for each other instant or sorcery spell you've cast before it this turn",
  effects: [{ type: "copySpellForStorm" }]
}];
EFFECTS.copySpellForStorm = function (lobby, ctx, params) {
  for (let i = (params.stormCopies || 0); i > 0; i--) EFFECTS.copyTargetSpell(lobby, ctx, { chosenTargetId: params.spellId });
};

// Strong, the Brutish Thespian -- Ward {2} is already generically covered (Ward == Hexproof
// simplification, targetIsUntargetableBy). Only Enrage needs a table entry (fireCreatureDamagedTrigger's
// own "damagedSelf" dispatch, same shape as Body of Knowledge). The "you gain life rather than lose
// life from radiation" replacement effect has nothing to invert -- this engine has no radiation
// life-loss mechanic at all (rad counters are a tracked player scalar with no rules consequence
// modeled, a disclosed gap documented at EFFECTS.giveRadCounters) -- so it's marked covered as a
// harmless no-op, same "no table entry needed" precedent as the Ward—Pay 2 life skip.
CARD_ABILITIES["strong, the brutish thespian"] = [{
  trigger: "damagedSelf", requiresTarget: false,
  label: "Strong, the Brutish Thespian — Enrage: you get three rad counters and put three +1/+1 counters on Strong",
  effects: [{ type: "giveRadCounters", amount: 3 }, { type: "addCountersToSelf", amount: 3 }]
}];
GENERIC_SENTENCE_PATTERNS.push(/^you gain life rather than lose life from radiation\.?$/);

// Cosmic Spider-Man -- "At the beginning of combat on your turn, other Spiders you control gain
// flying, first strike, trample, lifelink, and haste until end of turn." beginningOfCombat already
// scans only the active player's own permanents (server.js), so no "on your turn" check is needed here.
CARD_ABILITIES["cosmic spider-man"] = [{
  trigger: "beginningOfCombat", requiresTarget: false,
  label: "Cosmic Spider-Man — other Spiders you control gain flying, first strike, trample, lifelink, and haste until end of turn",
  effects: [{ type: "grantTemporaryKeywordsToOtherTypeCreatures", typeFilter: "spider", keywords: ["Flying", "First strike", "Trample", "Lifelink", "Haste"] }]
}];
EFFECTS.grantTemporaryKeywordsToOtherTypeCreatures = function (lobby, ctx, params) {
  Object.values(lobby.cards).forEach((c) => {
    if (c.owner !== ctx.controllerId || c.zoneType !== "creature") return;
    if (ctx.sourceCard && c.id === ctx.sourceCard.id) return; // "other" Spiders
    if (!(c.type || "").toLowerCase().includes(params.typeFilter)) return;
    (params.keywords || []).forEach((k) => grantTemporaryKeyword(lobby, c, k));
  });
};

// Nuka-Nuke Launcher -- "Whenever equipped creature attacks, until the end of defending player's
// next turn, that player gets two rad counters whenever they cast a spell." The actual rad-counter
// grant on cast lives in castSpell (server.js), checked against EVERY player's own
// _nukaNukeUntilTurnNumber on every cast -- this only arms it.
CARD_ABILITIES["nuka-nuke launcher"] = [{
  trigger: "enchantedCreatureAttacks", requiresTarget: false,
  label: "Nuka-Nuke Launcher — until the end of defending player's next turn, that player gets two rad counters whenever they cast a spell",
  effects: [{ type: "armNukaNukeDefender" }]
}];
EFFECTS.armNukaNukeDefender = function (lobby, ctx, params) {
  const defenderId = params.attackerDefenderId;
  const defender = defenderId && lobby.players[defenderId];
  if (!defender) return;
  const order = lobby.turn.order || [];
  const idx = order.indexOf(defenderId);
  if (idx === -1) return;
  // Steps around the (possibly reordered-by-extra-turns) turn order from right now to the
  // defender's own next turn; turn.turnNumber increments by exactly 1 per step (see the
  // turn.turnNumber++ site in advanceOnePhase), so this stays correct even with extra turns queued.
  const steps = ((idx - lobby.turn.activeIndex) + order.length) % order.length || order.length;
  const untilTurn = lobby.turn.turnNumber + steps;
  defender._nukaNukeUntilTurnNumber = Math.max(defender._nukaNukeUntilTurnNumber || 0, untilTurn);
  pushLog(lobby, `${defender.name} will get two rad counters whenever they cast a spell, until the end of their next turn (Nuka-Nuke Launcher)`);
};
