// Wave 68 -- For the Common Good, Professional Face-Breaker, Blasphemous Edict.
// Engine bits in server.js (found half-built at session start, finished here): targetKind "ownToken"
// (resolveChosenTarget + index.html mirror), grantTemporaryKeywordUntilNextTurn + its Untap-step
// cleanup sweep, ALT_COSTS kind "manaIfCreatureCount", fireGlobalCombatDamageToPlayerTrigger's new
// ability.oncePerTurn collapse. Added this session: parseManaCost/canAffordAndPay now support a real
// double-{X}{X} mana cost (cost.xCount, previously always charged only ONE X's worth of generic mana
// -- a latent bug that also affected Pest Infestation, wave 12), createTokenCopyOfTargetCreature now
// falls back to params.xAmount when no fixed count is given, EFFECTS.tokensGainIndestructibleUntilNextTurn
// + gainLifeForTokenCount (For the Common Good's own second/third clauses), EFFECTS.eachPlayerSacrificesUpTo
// (Blasphemous Edict).

// For the Common Good -- "Create X tokens that are copies of target token you control. Then tokens you
// control gain indestructible until your next turn. You gain 1 life for each token you control."
// Sequential effects sharing executeSpellEffectsNow's one synchronous forEach, so the life total and
// the indestructible grant both see the COPIES already on the battlefield.
SPELL_ABILITIES["for the common good"] = {
  label: "For the Common Good — create X token copies of target token you control, then your tokens gain indestructible until your next turn and you gain 1 life per token you control",
  requiresTarget: true, targetKind: "ownToken",
  effects: [
    { type: "createTokenCopyOfTargetCreature" },
    { type: "tokensGainIndestructibleUntilNextTurn" },
    { type: "gainLifeForTokenCount" }
  ]
};

// Professional Face-Breaker -- Menace is a plain intrinsic keyword (no table entry needed, same as
// every other vanilla keyword line). "Whenever one or more creatures you control deal combat damage to
// a player, create a Treasure token" collapses via ability.oncePerTurn (server.js). The Treasure-sac
// ability reuses cost.autoSacrificeArtifactFilter (Throne of Geth's own "Sacrifice an artifact"
// precedent, narrowed to the "treasure" type-line substring) and wave 46's impulseExileTopToHand.
CARD_ABILITIES["professional face-breaker"] = [{
  trigger: "anyCreatureCombatDamageToPlayer", oncePerTurn: true, requiresTarget: false,
  label: "Professional Face-Breaker — create a Treasure token",
  effects: [{ type: "createToken", name: "Treasure", tokenType: "Token Artifact — Treasure", img: "https://cards.scryfall.io/normal/front/6/8/68894c85-fb43-4c9a-9de3-2fa1c9c31543.jpg", amount: 1 }]
}];
ACTIVATED_ABILITIES["professional face-breaker"] = [{
  cost: { autoSacrificeArtifactFilter: "treasure" }, requiresTarget: false,
  label: "Professional Face-Breaker — Sacrifice a Treasure: exile the top card of your library, you may play it this turn",
  effects: [{ type: "impulseExileTopToHand", amount: 1 }]
}];

// Blasphemous Edict -- "You may pay {B} rather than pay this spell's mana cost if there are thirteen
// or more creatures on the battlefield. Each player sacrifices thirteen creatures of their choice."
ALT_COSTS["blasphemous edict"] = { kind: "manaIfCreatureCount", minCreatures: 13, mana: "{B}", label: "Blasphemous Edict — cast for {B} if there are 13+ creatures on the battlefield" };
SPELL_ABILITIES["blasphemous edict"] = {
  label: "Blasphemous Edict — each player sacrifices thirteen creatures of their choice",
  effects: [{ type: "eachPlayerSacrificesUpTo", amount: 13 }]
};
