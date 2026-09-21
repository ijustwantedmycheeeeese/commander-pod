// Wave 59 -- mana audit fixes (lab-mana.js): multi-mana {T} abilities that fell back to the plain 1-mana tap, and
// lands whose Scryfall producedMana lists every colour although the plain {T} ability only adds {C} / {G}.
// A manaAbility entry disqualifies the card from the free-tap shortcut in the "tap" handler, so each card's whole
// mana ability is modeled here (Nykthos' missing {T}: Add {C} half is added directly in server.js next to its other entry).

ACTIVATED_ABILITIES["mana vault"] = [{ cost: { tap: true }, manaAbility: true, label: "Mana Vault — Add {C}{C}{C}", effects: [{ type: "addFixedMana", colors: ["C", "C", "C"] }] }];
ACTIVATED_ABILITIES["mana crypt"] = [{ cost: { tap: true }, manaAbility: true, label: "Mana Crypt — Add {C}{C}", effects: [{ type: "addFixedMana", colors: ["C", "C"] }] }];
ACTIVATED_ABILITIES["city of traitors"] = [{ cost: { tap: true }, manaAbility: true, label: "City of Traitors — Add {C}{C}", effects: [{ type: "addFixedMana", colors: ["C", "C"] }] }];
ACTIVATED_ABILITIES["ancient tomb"] = [{ cost: { tap: true }, manaAbility: true, label: "Ancient Tomb — Add {C}{C}, this land deals 2 damage to you", effects: [{ type: "addFixedMana", colors: ["C", "C"] }, { type: "landDamagesController", amount: 2 }] }];

ACTIVATED_ABILITIES["chromatic orrery"] = [
  { cost: { tap: true }, manaAbility: true, label: "Chromatic Orrery — Add {C}{C}{C}{C}{C}", effects: [{ type: "addFixedMana", colors: ["C", "C", "C", "C", "C"] }] },
  { cost: { mana: "{5}", tap: true }, requiresTarget: false, label: "Chromatic Orrery — {5},{T}: draw a card for each color among permanents you control", effects: [{ type: "drawForColorsAmongPermanents" }] }
];

ACTIVATED_ABILITIES["gilded lotus"] = [{ cost: { tap: true }, manaAbility: true, label: "Gilded Lotus — Add three mana of any one color", effects: [{ type: "chooseManaAnyColor", amount: 3, sourceName: "Gilded Lotus" }] }];
ACTIVATED_ABILITIES["lotus field"] = [{ cost: { tap: true }, manaAbility: true, label: "Lotus Field — Add three mana of any one color", effects: [{ type: "chooseManaAnyColor", amount: 3, sourceName: "Lotus Field" }] }];

// The World Tree: "{T}: Add {G}." (the six-lands grant and the God search are separate abilities, not modeled here).
ACTIVATED_ABILITIES["the world tree"] = [{ cost: { tap: true }, manaAbility: true, label: "The World Tree — Add {G}", effects: [{ type: "addFixedMana", colors: ["G"] }] }];
// Three Tree City: "{T}: Add {C}." (the {2},{T} creature-count half needs a chosen creature type and is not modeled).
ACTIVATED_ABILITIES["three tree city"] = [{ cost: { tap: true }, manaAbility: true, label: "Three Tree City — Add {C}", effects: [{ type: "addFixedMana", colors: ["C"] }] }];
// Gemstone Caverns: "{T}: Add {C}." (the opening-hand luck counter and its any-color upgrade are not modeled: no named-counter storage.)
ACTIVATED_ABILITIES["gemstone caverns"] = [{ cost: { tap: true }, manaAbility: true, label: "Gemstone Caverns — Add {C}", effects: [{ type: "addFixedMana", colors: ["C"] }] }];

EFFECTS.drawForColorsAmongPermanents = function (lobby, ctx, params) {
  const n = colorsAmongPermanentsFor(lobby, ctx.controllerId);
  if (n > 0) drawN(lobby, ctx.controllerId, n);
};

// "This land deals N damage to you." as part of a mana ability: the fast path never re-broadcasts after the effects, so broadcast + check for elimination here.
EFFECTS.landDamagesController = function (lobby, ctx, params) {
  const src = ctx.sourceCard && ctx.sourceCard.id;
  applyLifeLoss(lobby, ctx.controllerId, params.amount || 0, src);
  checkEliminations(lobby);
  broadcastPlayers(lobby);
};
