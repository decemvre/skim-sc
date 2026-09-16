# SkiM SC

A mobile-friendly public reference for Korean StarCraft: Brood War / Remastered.

**Live site:** https://decemvre.github.io/skim-sc/

Includes selected star-university rosters, player IDs and races, major and recurring competitions, SOOP and English viewing links, and the public SkiM SC Calendar subscription button.

## Updating the guide

- Edit `docs/index.html` to update content and links.
- Edit `docs/style.css` to change the appearance.
- Recheck current information against the sources in `SOURCES.md`.
- Update the visible verification date only after checking the corresponding facts.
- Push to `main`; GitHub Pages publishes the `/docs` folder automatically.

This is plain static HTML and CSS. No installation, build process, browser scripts, analytics, external fonts, or account keys are required. `.nojekyll` keeps the static files unchanged.

## Local preview

From the repository root, run `python3 -m http.server 4173 --directory docs` and open http://localhost:4173/.

## Editorial policy

Use player IDs, not Korean real names. Team cards show selected current members and coaches, not full or guaranteed match lineups. Current roster evidence comes from dated Korean community records; official organizer notices take priority for schedules. Do not infer current affiliations from an old match, player biography, or previous season.

Only the user-supplied public calendar identifier and public esports information belong in this repository. Do not add private conversations, account data, credentials, or unrelated calendar details.

This guide is maintained manually; it does not automatically refresh its content or the separate calendar. It is an independent fan project, not affiliated with Blizzard Entertainment or SOOP.
