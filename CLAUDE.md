# MTG Scanner

Vanilla-JS phone web app (PWA, no build step) for scanning, pricing and tracking Magic cards and decks.
Served by GitHub Pages from `main`: https://ironbanes.github.io/mtg-scanner/ (installed on iPhone via Safari).

## Checks
- `npm test` (node --test). Tests run the app in a vm sandbox: `tests/harness.cjs`
  (`app({ insights: true, all, route })`). Add new tests in that style.
- Browser check: the `mtg-scanner` launch config serves on port 8765 (8766 if busy). Check at phone width.

## Rules
- **Release:** bump `VERSION` in `sw.js` and every `?v=` in `index.html` to the same number together
  (a test enforces this).
- **Saved data is sacred:** never ship a change that could overwrite or drop saved user data. If the saved
  shape changes, bump `SCHEMA` in `app.js` and add a step to `MIGRATIONS`.
- `app.js` uses CRLF line endings (git autocrlf). Keep them.
- Any third-party API must be callable from the browser at `https://ironbanes.github.io` (check CORS first).
- Commit as IronBanes:
  `git -c user.name=IronBanes -c user.email=IronBanes@users.noreply.github.com commit ...`

## Workflow
Draft → Review fixes → Checks+PR → Address review, one commit per pass. The user merges; never merge.
Say in the PR who drafted it (Claude or Zoo Code).

CodeRabbit: automatic reviews are off, so comment `@coderabbitai review` on the PR. It's often
rate-limited, and it may push commits to the branch: review anything it pushes.
