// Wave 54 -- 8 short-text cards (2 fixed-mana lands, counters, removal, draw, tutor).
// All reuse existing effect primitives; no new engine capability needed.

ACTIVATED_ABILITIES["desolate mire"] = [{ cost: { mana: "{1}", tap: true }, manaAbility: true, label: "Desolate Mire — Add {W}{B}", effects: [{ type: "addFixedMana", colors: ["W", "B"] }] }];
ACTIVATED_ABILITIES["sunscorched divide"] = [{ cost: { mana: "{1}", tap: true }, manaAbility: true, label: "Sunscorched Divide — Add {R}{W}", effects: [{ type: "addFixedMana", colors: ["R", "W"] }] }];

SPELL_ABILITIES["dispel"] = { label: "Dispel — counter target instant spell", effects: [{ type: "counterTargetSpellIf", typeIncludes: ["instant"] }], requiresTarget: true, targetKind: "spell" };
SPELL_ABILITIES["miscast"] = { label: "Miscast — counter target instant or sorcery spell unless its controller pays {3}", effects: [{ type: "counterTargetSpellUnlessPay", payAmount: 3 }], requiresTarget: true, targetKind: "instantOrSorcerySpell" };

// Front face only, per cards/README.md (MDFC keys are the front face). The land back
// face (Fell Mire) is a plain tapland, already covered generically.
SPELL_ABILITIES["fell the profane"] = { label: "Fell the Profane — destroy target creature or planeswalker", effects: [{ type: "destroyTarget" }], requiresTarget: true, targetKind: "typeList", typeFilter: ["creature", "planeswalker"] };

// "You and target opponent each draw three cards." -- drawCards' own established fallback
// (no explicit target + chosenTargetId present -> resolves to the chosen target, see Kenrith's
// "target player draws a card") handles the opponent half; the controller half is explicit.
SPELL_ABILITIES["secret rendezvous"] = { label: "Secret Rendezvous — you and target opponent each draw three cards", effects: [{ type: "drawCards", amount: 3, target: "controller" }, { type: "drawCards", amount: 3 }], requiresTarget: true, targetKind: "opponent" };

SPELL_ABILITIES["borne upon a wind"] = { label: "Borne Upon a Wind — you may cast spells this turn as though they had flash, draw a card", effects: [{ type: "grantFlashUntilEndOfTurn" }, { type: "drawCards", amount: 1, target: "controller" }] };

// Vampiric Tutor's own exact shape.
SPELL_ABILITIES["imperial seal"] = { label: "Imperial Seal — search your library for a card, put it on top, lose 2 life", effects: [{ type: "tutorToHand", toTopOfLibrary: true, lifeLoss: 2 }] };
