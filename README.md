# innaopcja-bot

Automated product-database builder for [innaopcja.pl](https://innaopcja.pl). Runs on a
GitHub Actions schedule, uses Gemini to research products, and writes directly into the
**same Neon Postgres database** as the live site (`products`, `product_alternatives`,
`categories` — the schema owned by the `innaopcja.pl` repo).

This repo is separate from the site on purpose: it needs a public GitHub repo for a
reliable Actions cron on a personal account, and it has no reason to touch the Next.js
app or its deploy pipeline.

## How it works

One cron firing (`scripts/build.js`) doesn't stop after one category or one small
batch — it keeps looping, spending as much of the day's Gemini quota as it can:

0. Checks `bot_state` (key `enabled`) — if it's `'false'`, the whole run is a no-op: it
   logs a `skipped` row in `bot_runs` and exits. This is how the "Stop"/"Start" toggle in
   the innaopcja.pl admin panel (`/admin`) controls the bot without needing GitHub
   Actions API access — the schedule keeps firing, but does nothing while paused.
1. Otherwise, it loops. Each pass through the loop:
   - Picks the next category — round-robins over every top-level row in `categories`
     (state kept in `bot_state`, key `last_category`), so a category added later via the
     admin panel joins the rotation automatically, no code change needed.
   - Pulls up to `BATCH_SIZE` (450) `pending` rows from `seed_queue` for that category.
     If empty, asks Gemini for 40 new candidate names first (`scripts/generate-seeds.js`,
     deduped against existing products and queue rows), then re-checks.
   - Queued names are evaluated `BATCH_EVAL_SIZE` (20) at a time, one Gemini
     (`gemini-3.5-flash-lite`, JSON mode) call per batch instead of per name — the free
     tier's binding constraint is requests/day (and RPM), not context window, so this
     multiplies effective daily throughput by ~20x per key on top of whatever multiple
     `GEMINI_API_KEY_2`/etc. already provide (see "Multiple Gemini keys" below). Each
     title in a batch is still scored and validated independently (verdict, score,
     summary, pros/cons, specs — always includes `specs.price_pln_approx`, brand, brand
     recognition, price tier, and a `confidence` flag) and matched back to its
     `seed_queue` row by the title it echoes — one bad/unmatched title in a batch only
     fails that one row, not the rest. Published when `confidence` is `wysoka`, `draft`
     otherwise — low-confidence or malformed responses never overwrite existing data.
   - For newly `published` products, computes up to 3 "Inna Opcja" alternatives
     (`tansza` / `wyzsza_jakosc` / `niszowa_marka`) against other published products in
     the same category — see `lib/matching.js`. A slot is left empty rather than filled
     with a bad match.
   - Logs one `bot_runs` row for that category's pass (published/draft/failed counts).
2. The loop itself stops when: Gemini reports the daily quota is exhausted
   (`RESOURCE_EXHAUSTED`), a full lap through every category adds nothing new (e.g.
   Gemini keeps suggesting names that already exist), the job's own time budget runs out
   (38 min, under the 40-minute workflow timeout), or an absolute safety cap (200 loop
   iterations) is hit.
3. Waits a pace-dependent delay between individual Gemini calls throughout (free
   tier RPM cap, ~4.2s at one key, less with more — see "Multiple Gemini keys" below).

`bot_runs` (one row per category pass, not per cron firing) is what the admin panel reads
to show "did it run today," recent history, and live status — without calling the GitHub
Actions API.

Everything is idempotent: `lib/schema.js` creates `seed_queue`, `bot_state`, and
`bot_runs` with `CREATE TABLE IF NOT EXISTS` on every run, so there's no separate
migration step to remember to run. It no longer auto-creates a `telewizory`
category — it used to, which actively undid deleting that category on every run
once the site pivoted away from it; categories are the site's call now, not this
bot's.

## Setup

1. Push this repo to GitHub as **public** (required for reliable free scheduled Actions
   on a personal account).
2. In *Settings → Secrets and variables → Actions*, add:
   - `GEMINI_API_KEY` (and optionally `GEMINI_API_KEY_2`/`_3`/`_4`/…, see "Multiple
     Gemini keys" below) — a Gemini API key (Google AI Studio).
   - `NEON_DATABASE_URL` — the **same** Neon connection string the `innaopcja.pl` site
     uses (its `DATABASE_URL` in `.env.local`). Using the same value is intentional:
     this bot writes into the live site's database.
   - `IGDB_CLIENT_ID` / `IGDB_CLIENT_SECRET` — a free Twitch developer app
     (dev.twitch.tv/console/apps; requires 2FA on the Twitch account). Only used by
     the `gry` category's seed generation (see below) — telefony/telewizory don't
     need it.
3. The workflow runs weekly (Monday 03:00 UTC), or on demand via *Actions → Build
   product database → Run workflow*. New phone/TV models don't appear often enough to
   justify more - product prices instead refresh live, per view, in the
   `innaopcja.pl` site itself (see that repo's `app/api/phone/[slug]/price`).

For local testing, copy `.env.example` to `.env`, fill in both values, then:

```bash
npm install
node --env-file=.env scripts/build.js
```

## The `gry` category: IGDB-sourced seeding

Unlike telefony/telewizory (seeded by asking Gemini to recall/search a name list),
`gry`'s candidates come from [IGDB](https://igdb.com) — real critic+user ratings,
real platform/genre/release-date data, queried directly instead of trusting an LLM's
memory of "best games of \<year\>". `scripts/generate-seeds.js`'s `generateGrySeeds`
sweeps every (year × platform bucket) cell — the last 10 years × 5 buckets
(`lib/igdb.js`'s `PLATFORM_IGDB_IDS`) — asking IGDB for the top 100 by rating each
time, and stores each candidate's IGDB facts (platforms/genres/themes/game_modes/
rating) in `seed_queue.source_facts` (JSONB).

Deliberately **newest year first, every platform before going a year older**: each
candidate's `seed_queue.priority` is set to its release year, and `build.js`'s
`fetchQueueBatch` already orders by `priority DESC, created_at ASC` — so processing
naturally fills every platform with recent titles first (breadth), only working
backward into older years (depth) once the recent ones are done, instead of
exhausting one platform's entire 10-year history before a second platform gets
anything.

`gry` also gets its own 10-year release-window (`minAllowedReleaseYear`), vs. the
3-year window that fits fast-churning phones/TVs — see `CATEGORY_YEARS_BACK` in
`lib/gemini.js`.

When `build.js` evaluates a queued `gry` candidate, it hands those stored IGDB facts
to Gemini as grounding context (`buildFactsBlock`) instead of asking it to invent
platforms/genres/release year from scratch — Gemini's job narrows to translating
them into the wizard's fixed enums (`specs.platformy`/`tryb`/`gatunki`/`klimat`/
`open_world`/etc. — see `CATEGORY_SPEC_HINTS.gry`) and filling in what IGDB doesn't
have (PLN price, verdict/summary/pros/cons, produkcja AAA/AA/indie, dlugosc,
fabula_score/grafika_score). `build.js`'s `validateGrySpecs` rejects a response whose
specs fall outside those enums — a bad value there wouldn't error, it'd just silently
never match any ankieta/wizard filter.

Re-running the seed sweep (whenever `gry`'s queue empties) mostly dedupes to nothing
new until IGDB's own rankings shift — the heavy lifting happens once, on the first
backfill, not every week.

## Multiple Gemini keys

Set `GEMINI_API_KEY_2`, `_3`, `_4`, … (up to `_6`, see `KEY_ENV_NAMES` in
`lib/gemini.js`) alongside `GEMINI_API_KEY` to multiply throughput — each is a
separate free-tier key/project (same Google account, different projects is the normal
way to get more than one; don't create throwaway Google accounts just to farm more
free quota, that's the part that'd actually cross into ToS-abuse territory).

Every Gemini call round-robins across whichever keys are configured
(`callWithKeyRotation`). This multiplies both caps for the same reason: with N keys,
each individual key is only hit every Nth call, so `geminiCallDelayMs()` divides the
safe single-key pacing (4200ms) by N — same per-key RPM headroom, N× the total
throughput — while the combined daily quota becomes N × 500/day. A key that hits
`RESOURCE_EXHAUSTED` gets rotated out for the rest of that run (not retried — a daily
quota doesn't come back until tomorrow); the whole run only stops with
`QuotaExceededError` once every configured key is exhausted.

## Known limitations / follow-ups

- Alternative matching only computes **outgoing** slots for the product just inserted.
  It doesn't retroactively revisit older products' slots even if a newer, better-fitting
  candidate shows up later — that'd need a periodic re-matching pass.
- `draft` products (low Gemini confidence) are never surfaced by the site
  (`status = 'published'` is required everywhere) and are never used as alternative
  candidates. They just sit in the database for manual review/promotion.
- `PLATFORM_IGDB_IDS` (`lib/igdb.js`) is a hand-maintained list of IGDB platform ids
  per wizard bucket — it doesn't yet include newer hardware released after this was
  written (e.g. a future "Switch 2"). Re-check against
  `https://api.igdb.com/v4/platforms` if `gry` coverage for a bucket looks thin.
  (The platform ids themselves were confirmed live and are correct - see the
  `category` note below for a sibling filter that wasn't.)
- `fetchTopGames` doesn't filter IGDB's `category` field (DLC/bundle/edition entries
  can slip into results alongside real games) — a prior version tried
  `category = (0,8,9)` to keep only main games/remakes/remasters, but live testing
  showed that filter was simply wrong (it zeroed out every result for every
  platform/year, including unambiguous main games) and was removed rather than
  guessed at again. `total_rating_count >= 5` already excludes the lowest-signal
  noise; a rare DLC/bundle entry that ranks highly just gets evaluated by Gemini
  like any other candidate.
