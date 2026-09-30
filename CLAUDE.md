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
- **Version:** bump `APP_VERSION` and `APP_VERSION_DATE` in `public/index.html` on every change that is deployed (shown at the bottom of "עוד"), and add a line below. Tell the user the new version number so they can confirm the phone loaded it.

## History of changes
- 2026-09-27: delete a set saved by mistake — tap a saved ✓ to undo it, or 🗑 in History → "כל הסטים". Rolls back "last time" and recomputes the PR.
- 2026-09-27: repo became the full deployable project (public/, src/worker.js, wrangler.jsonc) and was connected to Cloudflare Workers Builds — every push to main deploys.
- 2026-09-27: fix lost sets on "סיום" — the phone reloads the app mid-workout and empties the form, so only the last exercise was saved (22.9, 24.9, 27.9). Now: ✓ sets are restored into the form after a reload (`restoreTodaySets`), "סיום" fills empty sets from today's set-log and merges into a session already saved today, and on startup `repairSessionsFromSetLog` fills past sessions from set-log and merges same-date sessions (only adds data).
- 2026-09-27: "דוח מאמן" (עוד → דוח מאמן — שדרוגים): prioritized upgrades from the user's data — reps outside the target range, stalls and >7% drops (needs 3 sessions per exercise), weekly sets and frequency per major muscle, consistency, deload week, protein and body-weight rate, suspicious data (reps > 40, missing weight). Logic in `buildCoachReport`; read-only, writes nothing.
- 2026-09-28: keep long-term history — `HISTORY_MAX` 200 workouts per plan day (was 12), `SET_LOG_MAX` 600 (was 300), `BODYWEIGHT_MAX` 1000 (was 60). ~1.2 KB per workout, ~2 MB total.
- 2026-09-28 · v1.6: progress chart shows the whole history of an exercise (finished workouts + ✓ sets, across plan days) with a from→to summary; long charts thin out dates and value labels. Version number added.
- 2026-09-28 · v1.7: the workout that opens is decided from the data (latest activity per plan day): stay on a workout only while today's session there is in progress, otherwise the next in line. A deleted test set or a finished workout no longer keeps the app on the wrong day. `rotation-last` is only a fallback when nothing is recorded.
- 2026-09-28 · v1.8: weigh-in window redesigned — text field that accepts a comma (Android keyboards typed "67,4" into a number field, which came back empty so nothing saved), −/+ 0.1 stepper prefilled with the last weight, today/yesterday, range check, hero with 7-day average and weekly change, chart with 7-day average line, change vs previous weigh-in in the list. Same `bodyweight-log` format, now kept sorted by date.
- 2026-09-28 · v1.9: weigh-in field selects its prefilled value on tap (typing used to append, e.g. "6767.8", which is invalid) and scrolls above the keyboard.
- 2026-09-28 · v1.10: weigh-in uses an in-app numeric keypad (tap the number); the phone's system keyboard did not open in that sheet on the user's Android. Field is readonly; first key replaces the prefilled weight.
- 2026-09-28 · v1.11: weigh-in row is a fixed grid (52px · 1fr · 52px); the value is plain text (`#bwValue`) with a hidden `#bwInput`. On the user's phone the field inside the row collapsed to a tiny box, so typed numbers were invisible — that was the real cause of "can't type" in v1.8–1.10.
- 2026-09-28 · v1.12: (1) typo guard — ✓ asks to confirm a set with reps > 40, reps ≥ 2×last+4, or weight ≥ 1.6×last+2.5 / ≤ 0.4×last (`suspiciousSet`); (2) ✓ on an empty field takes the grey placeholder (last time / suggested weight) — "נשמר כמו בפעם הקודמת"; (3) rest timer starts from the exercise target ("מנוחה 2 עד 3 דק׳" → 2:30, `restSecondsFor`). Also: `last` ("last time") is rebuilt on startup from history + set-log (`buildLastFromData`) — a leftover test set (3×5) had polluted it; deleting a set from "כל הסטים" also clears it from a finished workout of that date, so records recompute correctly.
- 2026-09-28 · v1.13: (2) weekly automatic cloud backup — worker endpoints `GET/POST /api/backups`, `GET /api/backups/:id` store gzip+base64 snapshots in D1 table `backups` (created lazily, newest 12 kept, separate from `kv` sync); the app backs up 4 s after start when `auto-backup-last` is ≥ 7 days old; "גיבוי וייבוא" lists backups with restore (restore first makes a safety backup). (5) warm-up ramp chip "🔥 חימום" for exercises with rep range starting ≤ 8 and working weight ≥ 10 kg: 40%×10, 60%×6, 80%×3 (`warmupPlan`, display only). (6) summary sheet after "סיום": minutes, sets, volume vs previous session, new PRs, improved exercises, next-time weight increases (`showWorkoutSummary`).
- 2026-09-29 · v1.14: in edit mode the card header wraps (`.card-head` flex-wrap, name `min-width:0`). With a long exercise name on a narrow phone the 5 buttons overflowed off the card's left edge, so 🗑 (remove exercise) and ⌄ were unreachable.
- 2026-09-30 · v1.15: (1) "דוח מאמן" always shows weekly working sets per muscle as bars with 10/20 marks (`volumeSectionHtml`, uses `computeWeeklyVolume`). (2) lower-weight suggestion: `nextWeightSuggestion` returns `kind:'down'` when most sets at the top weight were 2+ reps under the range — ~10% lighter, rounded down to an existing dumbbell pair or 2.5 kg (`lighterWeight`); not for bodyweight moves (`isBodyweightExercise`), which get "with assistance" advice in the report. Shown as an orange chip "הבא" on the card, as the weight placeholder (so ✓ on an empty field saves it), in the summary after "סיום" and next to each exercise in "חזרות מתחת לטווח". Also fixed: `listHtml` was used before its declaration, so the report crashed whenever the fatigue card ("סימני עייפות מצטברת") fired.
- 2026-09-30 · v1.16: calorie coach in "יומן תזונה" (`#calCoach`, `computeCalorieCoach`/`renderCalorieCoach`). Last 14 full days (today excluded; days < 1000 kcal skipped as partly logged, needs 5) + least-squares weight slope over the same window (≥3 weigh-ins spanning ≥7 days). Maintenance ≈ intake − rate×7700/7; target gain 0.25 kg/wk; change capped ±300, min step 100, rounded to 50; inside 0.17–0.33 kg/wk → "keep". Button sets `nutrition-goal.calories` (other goal fields kept). Shows what is missing until there is enough data.
- 2026-09-30 · v1.17: adding an exercise in edit mode could fail on the phone ("didn't let me save"). Now `addPendingExercise` runs from "+ הוסף" (pointerdown/mousedown preventDefault keeps the field focused, so the keyboard closing no longer shifts the page under the tap), from Enter in the name/target field, and from "סיום עריכה" when a name is still typed. Note: renaming (✏️) still uses `prompt()`.
- Worker testing: `node --experimental-sqlite` with a small D1 shim over `node:sqlite` runs `src/worker.js` locally; Playwright can route `/api/**` to it to test the real `storage.js` end to end.
