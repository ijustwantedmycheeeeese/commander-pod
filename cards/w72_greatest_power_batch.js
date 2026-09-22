// Wave 72 -- Mondrak Glory Dominus, Saw in Half, Shadowgrange Archfiend, Ellie, Brick Master.
// Engine bits in server.js: tokenMultiplierFor now also matches Mondrak's own "twice that many"
// phrasing (a second alternation, no "it creates" verb like Anointed Procession's wording).
// cost.autoSacrificeArtifactOrCreatureCount is a genuine OR-filter extension over
// autoSacrificeArtifactFilter (zoneType "artifact" OR "creature", excluding the activating
// permanent itself) -- deferred at the end of wave 71 as exactly this gap.
// createTokenCopyOfTargetCreature now takes params.sourceOverride (a captured field snapshot,
// for when the source card is already gone from lobby.cards) and params.halvePowerToughness
// (Saw in Half). New EFFECTS: destroyTargetCreateHalvedCopiesForController (Saw in Half),
// eachOpponentSacrificesGreatestPowerGainLife (Shadowgrange Archfiend), createAttackingTokenForAttacker
// (Ellie, Brick Master -- benefits whoever attacked, not Ellie's own controller, same delegation
// shape as Jolene's own createTreasureTokenForAttacker). A new GENERIC_SENTENCE_PATTERNS entry
// covers "Partner" reminder text generically (a deckbuilding-only rule this engine has never
// enforced for any commander -- see the wave-independent comment near fireCommanderDamageTrigger --
// so there's no gameplay behavior to automate, only coverage to acknowledge).

// Mondrak, Glory Dominus -- "If one or more tokens would be created under your control, twice
// that many of those tokens are created instead." (tokenMultiplierFor, static, no table entry).
// "{1}{W/P}{W/P}, Sacrifice two other artifacts and/or creatures: Put an indestructible counter on
// Mondrak." {W/P} simplifies to a plain {W} cost, same disclosed narrowing as Spellskite/Norn's
// Annex's own {*/P} handling elsewhere in this file. grantKeywordToSelf's existing params.permanent
// already grants a keyword for good (Ferocious Tigorilla's own precedent) -- indestructible via a
// counter and indestructible via the keyword are functionally identical in this engine (no code
// path ever distinguishes "how" a permanent became indestructible), so no new counter-tracking
// primitive is needed.
ACTIVATED_ABILITIES["mondrak, glory dominus"] = [{
  cost: { mana: "{1}{W}{W}", autoSacrificeArtifactOrCreatureCount: 2 },
  requiresTarget: false,
  label: "Mondrak, Glory Dominus — {1}{W}{W}, Sacrifice two other artifacts and/or creatures: put an indestructible counter on Mondrak",
  effects: [{ type: "grantKeywordToSelf", keyword: "Indestructible", permanent: true }]
}];

// Saw in Half -- "Destroy target creature. If that creature dies this way, its controller creates
// two tokens that are copies of that creature, except their power is half that creature's power
// and their toughness is half that creature's toughness. Round up each time."
SPELL_ABILITIES["saw in half"] = {
  label: "Saw in Half — destroy target creature; if it dies this way, its controller creates two half-power/toughness token copies of it",
  requiresTarget: true, targetKind: "creature",
  effects: [{ type: "destroyTargetCreateHalvedCopiesForController" }]
};

// Shadowgrange Archfiend -- "When this creature enters, each opponent sacrifices a creature with
// the greatest power among creatures they control. You gain life equal to the greatest power among
// creatures sacrificed this way." Madness ({2}{B}, pay 8 life discard-cast) isn't modeled anywhere
// in this engine -- only this ETB is automated.
CARD_ABILITIES["shadowgrange archfiend"] = [{
  trigger: "etb", requiresTarget: false,
  label: "Shadowgrange Archfiend — each opponent sacrifices their greatest-power creature, you gain life equal to the total power sacrificed",
  effects: [{ type: "eachOpponentSacrificesGreatestPowerGainLife" }]
}];

// Ellie, Brick Master -- "Distract the Horde — Whenever a player attacks one of your opponents,
// that attacking player creates a tapped 1/1 black Fungus Zombie creature token named Cordyceps
// Infected that's attacking that opponent." "Partner—Survivors" is deckbuilding-only reminder text
// (GENERIC_SENTENCE_PATTERNS below).
CARD_ABILITIES["ellie, brick master"] = [{
  trigger: "playerAttacksOpponent", requiresTarget: false,
  label: "Ellie, Brick Master — that attacking player creates a tapped 1/1 black Fungus Zombie token attacking that opponent",
  effects: [{ type: "createAttackingTokenForAttacker", name: "Cordyceps Infected", tokenType: "Token Creature — Fungus Zombie", power: "1", toughness: "1", colors: ["B"], img: "" }]
}];
GENERIC_SENTENCE_PATTERNS.push(/^partner.*\(you can have two commanders/);
