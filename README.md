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
   - For each queued name, asks Gemini (`gemini-3.5-flash-lite`, JSON mode) to evaluate
     it: verdict, score, summary, pros/cons, specs (always includes
     `specs.price_pln_approx`), brand, brand recognition, price tier, and a `confidence`
     flag. Published when `confidence` is `wysoka`, `draft` otherwise — low-confidence or
     malformed responses never overwrite existing data.
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
3. Waits ~4.2s between individual Gemini calls throughout (free tier RPM cap).

`bot_runs` (one row per category pass, not per cron firing) is what the admin panel reads
to show "did it run today," recent history, and live status — without calling the GitHub
Actions API.

Everything is idempotent: `lib/schema.js` creates `seed_queue`, `bot_state`, and
`bot_runs` with `CREATE TABLE IF NOT EXISTS` on every run, and makes sure the
`telewizory` category exists, so there's no separate migration step to remember to run.

## Setup

1. Push this repo to GitHub as **public** (required for reliable free scheduled Actions
   on a personal account).
2. In *Settings → Secrets and variables → Actions*, add:
   - `GEMINI_API_KEY` — a Gemini API key (Google AI Studio).
   - `NEON_DATABASE_URL` — the **same** Neon connection string the `innaopcja.pl` site
     uses (its `DATABASE_URL` in `.env.local`). Using the same value is intentional:
     this bot writes into the live site's database.
3. The workflow runs every hour, or on demand via *Actions → Build product database →
   Run workflow*. Most hourly ticks on a day whose quota is already used up exit in
   seconds — only the tick that lands after the daily reset does real work.

For local testing, copy `.env.example` to `.env`, fill in both values, then:

```bash
npm install
node --env-file=.env scripts/build.js
```

## Known limitations / follow-ups

- Alternative matching only computes **outgoing** slots for the product just inserted.
  It doesn't retroactively revisit older products' slots even if a newer, better-fitting
  candidate shows up later — that'd need a periodic re-matching pass.
- `draft` products (low Gemini confidence) are never surfaced by the site
  (`status = 'published'` is required everywhere) and are never used as alternative
  candidates. They just sit in the database for manual review/promotion.
