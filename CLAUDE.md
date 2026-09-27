# יומן אימונים (Workout app)

This repo is the source of the user's workout log — the "אימונים" icon (lime dumbbell) on their Android home screen.
When the user talks about "יומן אימונים", "האפליקציה של האימונים", sets, exercises, PRs or nutrition — this is the app.

- **Live URL:** https://workout-app.plants-app.workers.dev/ (Cloudflare Worker `workout-app`, same Cloudflare account as `plants-app`)
## Layout
- `public/` — static files served as-is (Workers static assets). **Every file here is part of the live app; a deploy replaces the whole set, so never delete one.**
  - `index.html` — the single-page app, Hebrew, RTL, dark theme (accent `#d7ff3f`)
  - `storage.js` (defines `window.storage`), `foods.js`, `sw.js` (network-first cache), `manifest.webmanifest`, `icons/`
- `src/worker.js` — handles `/api/*` only: password login (secret `APP_PASSWORD`, set in the dashboard) and a key/value sync API on D1.
- `wrangler.jsonc` — worker name, assets folder, D1 binding `DB` → database `workout`.

## Where the data lives
`storage.js` is local-first: every write goes to the browser's localStorage and is pushed in the background to D1 (`/api/kv`); on load the newer copy per key wins.
So the data is on the phone **and** in D1 table `kv` (key, value, updated). A device that is not logged in shows only its own local data.
Still remind the user to back up (in-app export) before any change that touches storage keys.

## Data model (never rename these storage keys — they hold the user's real history)
All persistence goes through `window.storage.get/set/list(key, false)`, values are JSON strings.
- `day-data:<dayKey>` → `{ history:[{date, exercises:{exId:{sets:[{reps,weight,warmup}], note}}}], last:{exId:rec}, prs:{exId:{weight,reps,e1rm,date}} }`
- `set-log:<dayKey>` → newest-first array of individually saved sets `{date,time,exerciseId,exerciseName,setIndex,reps,weight,warmup}` (max 300)
- `day-overrides`, `rotation-last`, `bodyweight-log`, `nutrition-goal`, `my-foods`, `nut-recent`, `nut-meals`, `deload-start`
- Weights are stored in kg; `kgToDisplayUnit` / `displayUnitToKg` convert for display. PRs compare by estimated 1RM (`est1RM`, `prEst`).

## Working on it
- Test in Playwright with a stub `storage.js` that keeps `window.storage` in memory (note: the real `get` throws when a key is missing), served over `python3 -m http.server` from a copy of `public/`.
- Check at phone width (390px). UI text is Hebrew.
- Deploy: push to `main`. Cloudflare Workers Builds (connected to this repo) runs `npx wrangler deploy`. Do **not** use "Edit code" → Deploy in the dashboard — it knows only the worker, not the assets.
- The service worker is network-first, so a new version shows on the next load with signal.

## History of changes
- 2026-09-27: delete a set saved by mistake — tap a saved ✓ to undo it, or 🗑 in History → "כל הסטים". Rolls back "last time" and recomputes the PR.
- 2026-09-27: repo became the full deployable project (public/, src/worker.js, wrangler.jsonc) and was connected to Cloudflare Workers Builds — every push to main deploys.
- 2026-09-27: fix lost sets on "סיום" — the phone reloads the app mid-workout and empties the form, so only the last exercise was saved (22.9, 24.9, 27.9). Now: ✓ sets are restored into the form after a reload (`restoreTodaySets`), "סיום" fills empty sets from today's set-log and merges into a session already saved today, and on startup `repairSessionsFromSetLog` fills past sessions from set-log and merges same-date sessions (only adds data).
- 2026-09-27: "דוח מאמן" (עוד → דוח מאמן — שדרוגים): prioritized upgrades from the user's data — reps outside the target range, stalls and >7% drops (needs 3 sessions per exercise), weekly sets and frequency per major muscle, consistency, deload week, protein and body-weight rate, suspicious data (reps > 40, missing weight). Logic in `buildCoachReport`; read-only, writes nothing.
