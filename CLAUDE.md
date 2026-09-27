# יומן אימונים (Workout app)

This repo is the source of the user's workout log — the "אימונים" icon (lime dumbbell) on their Android home screen.
When the user talks about "יומן אימונים", "האפליקציה של האימונים", sets, exercises, PRs or nutrition — this is the app.

- **Live URL:** https://workout-app.plants-app.workers.dev/ (Cloudflare Worker `workout-app`, same Cloudflare account as `plants-app`)
- **Main file:** `index.html` — single-page app, Hebrew, RTL, dark theme (accent `#d7ff3f`)
- **Other files served by the worker:** `/storage.js` (defines `window.storage`), `/foods.js`, `/sw.js`, `/manifest.webmanifest`, icons.
  Until they are added to this repo, the only copies are on Cloudflare — do not deploy anything that would remove them.

## Data model (never rename these storage keys — they hold the user's real history)
All persistence goes through `window.storage.get/set/list(key, false)`, values are JSON strings.
- `day-data:<dayKey>` → `{ history:[{date, exercises:{exId:{sets:[{reps,weight,warmup}], note}}}], last:{exId:rec}, prs:{exId:{weight,reps,e1rm,date}} }`
- `set-log:<dayKey>` → newest-first array of individually saved sets `{date,time,exerciseId,exerciseName,setIndex,reps,weight,warmup}` (max 300)
- `day-overrides`, `rotation-last`, `bodyweight-log`, `nutrition-goal`, `my-foods`, `nut-recent`, `nut-meals`, `deload-start`
- Weights are stored in kg; `kgToDisplayUnit` / `displayUnitToKg` convert for display. PRs compare by estimated 1RM (`est1RM`, `prEst`).

## Working on it
- Test in Playwright with a stub `storage.js` that keeps `window.storage` in memory, plus an empty `foods.js`, served over `python3 -m http.server`.
- Check at phone width (390px). UI text is Hebrew.
- Deploy: the user uploads `index.html` in the Cloudflare dashboard (Workers & Pages → workout-app). After deploying, the service worker may serve the old copy until the app is fully closed and reopened.

## History of changes
- 2026-09-27: delete a set saved by mistake — tap a saved ✓ to undo it, or 🗑 in History → "כל הסטים". Rolls back "last time" and recomputes the PR.
