# cards/ — per-batch card automation modules

New card automation goes in small files here (one per batch, e.g. `w54_mana_and_lands.js`) instead of the big tables in `server.js`.
Every `cards/*.js` file is evaluated at startup INSIDE server.js's scope (direct `eval`), so it sees every table and helper (`drawN`, `changeControl`,
`spawnBattlefieldCard`, `queueTargetChoice`, `queueOptionalPayment`, `queueDelayedTrigger`, `pushLog`, `EFFECTS`, ...). A module is plain JS, not `require`-style:

```js
SPELL_ABILITIES["some spell"] = { label: "Some Spell — ...", effects: [{ type: "myEffect" }], requiresTarget: true, targetKind: "creature" };
CARD_ABILITIES["some creature"] = [{ trigger: "etb", requiresTarget: false, label: "...", effects: [{ type: "drawCards", amount: 1 }] }];
ACTIVATED_ABILITIES["some rock"] = [{ cost: { tap: true }, manaAbility: true, label: "...", effects: [{ type: "addFixedMana", colors: ["C", "C"] }] }];
EFFECTS.myEffect = function (lobby, ctx, params) { /* ctx.controllerId, ctx.sourceCard, params.chosenTargetId ... */ };
```

Rules: keys are lowercase card names (front face for `A // B` cards); a key or effect name that already exists (in server.js or another module) is a
STARTUP ERROR, never a silent override; a syntax error in a module also stops the server, so run `node --check` on it and the lab regression before merging.
Tables covered: CARD_ABILITIES, ACTIVATED_ABILITIES, SPELL_ABILITIES, CHANNEL_ABILITIES, ALT_COSTS, EFFECTS.
`GENERIC_SENTENCE_PATTERNS.push(/^regex$/)` marks a sentence as generically automated for the coverage scoring (also mirror it in index.html's classifier).
