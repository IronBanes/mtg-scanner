# MTG Scanner

A phone web app for scanning, pricing and tracking Magic: The Gathering cards.
Runs in Safari on iPhone — tap **Share → Add to Home Screen** to install it like an app.

## Features
- **Single scan** (tap to scan one card) and **Multi scan** (auto-scan: show cards one after another, each is added when recognized)
- **Just scan** mode — see the name and price without saving anything; scans land in *Recent scans* and can be added to a list later
- Scan straight into your **Collection** or any **Deck**
- **Exact printing**: reads the set code + collector number on 2015+ cards to pick the right version/price
- Foil toggle, quantities, Main/Sideboard/Commander/Maybe boards
- **Search** any card (plain names or full Scryfall syntax), pick a printing, add it anywhere
- Collection and deck **totals** (deck view also shows what you don't own yet and its cost)
- **Export CSV** (for ChatGPT/Claude/spreadsheets), **Copy for Untap** (plain deck list), **Import** pasted lists or CSV
- Backup/restore to a single JSON file

## Notes
- Card data and prices come from the free [Scryfall API](https://scryfall.com/docs/api) (USD, TCGplayer market).
- Card text recognition runs on the phone with Tesseract.js. Modern card frames (2003+) work well;
  old 1993–2002 frames often don't — use **Type** for those.
- Your data is stored on the phone only. Export a backup occasionally.

## Run locally
Any static file server works, e.g. `npx http-server -p 8765`. The camera needs HTTPS (or localhost).

## Releasing
The service worker caches each release as one unit. On every deploy, bump `VERSION` in `sw.js`
**and** the matching `?v=` on `style.css` / `app.js` in `index.html`. Phones download the whole new
release in the background and show a "new version — Reload" notice when it's ready.
