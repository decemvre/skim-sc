# Skim Bot

Keeps SkiM SC current and tells the group chat what is on: today's Korean Brood War matches
and news, in English, with players under their IDs and nicknames - never their real names.
Runs on Silviu's machine; posts through the Friendzy WhatsApp bridge (send-only).

- `node bot/matches.mjs` - SOOP's official schedule -> `bot/data/matches.json`; names matched
  against Liquipedia once and kept in `bot/data/names.json` (edit it by hand to correct one).
- `node --test bot/test/*.test.mjs` - the tests.

No dependencies beyond Node 24 and Google Chrome (to read SOOP's schedule page).
