# innaopcja-bot

Automated product-database builder for [innaopcja.pl](https://innaopcja.pl). Runs on a
GitHub Actions schedule, uses Gemini to research products, and writes directly into the
**same Neon Postgres database** as the live site (`products`, `product_alternatives`,
`categories` — the schema owned by the `innaopcja.pl` repo).

This repo is separate from the site on purpose: it needs a public GitHub repo for a
reliable Actions cron on a personal account, and it has no reason to touch the Next.js
app or its deploy pipeline.

## How it works

Each run (`scripts/build.js`):

0. Checks `bot_state` (key `enabled`) — if it's `'false'`, the run is a no-op: it logs a
   `skipped` row in `bot_runs` and exits. This is how the "Stop"/"Start" toggle in the
   innaopcja.pl admin panel (`/admin`) controls the bot without needing GitHub Actions
   API access — the schedule keeps firing, but does nothing while paused.
1. Picks the category for this run — round-robins over every top-level row in
   `categories` (state kept in the `bot_state` table, key `last_category`), so a category
   added later via the admin panel is picked up automatically, no code change needed.
2. Pulls up to 25 `pending` rows from `seed_queue` for that category. If the queue is
   empty, it asks Gemini for 40 new candidate product names first
   (`scripts/generate-seeds.js`), deduped against existing products and queue rows.
3. For each queued product name, asks Gemini (`gemini-3.5-flash-lite`, JSON mode) to
   evaluate it: verdict, score, summary, pros/cons, specs (always includes
   `specs.price_pln_approx`), brand, brand recognition, price tier, and a `confidence`
   flag.
4. Inserts the product as `published` when `confidence` is `wysoka`, or `draft`
   otherwise. Low-confidence/malformed responses never overwrite existing data — the
   row is just marked `failed` in the queue and skipped.
5. For newly `published` products, computes up to 3 "Inna Opcja" alternatives
   (`tansza` / `wyzsza_jakosc` / `niszowa_marka`) against other published products in
   the same category, using price (`specs.price_pln_approx`) and `price_tier`/`score` as
   fallback. A slot is left empty rather than filled with a bad match — see
   `lib/matching.js`.
6. Waits ~4.2s between Gemini calls (free tier is capped at 15 requests/minute).

Every invocation also writes one row to `bot_runs` (category, status, published/draft/
failed counts, started/finished timestamps) — this is what the admin panel reads to show
"did it run today" and recent history, without calling the GitHub Actions API.

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
3. The workflow runs daily at 06:00 UTC, or on demand via *Actions → Build product
   database → Run workflow*.

For local testing, copy `.env.example` to `.env`, fill in both values, then:

```bash
npm install
node --env-file=.env scripts/build.js
```

## Known limitations / follow-ups

- **`telewizory` has no page on the site yet.** The website currently only serves
  `/telefon/[slug]`, and search always redirects there regardless of category. TV
  products this bot publishes will exist in the database and be findable via search,
  but need a `/telewizor/[slug]` route (or a category-aware route) on the site side to
  be presented correctly.
- Alternative matching only computes **outgoing** slots for the product just inserted.
  It doesn't retroactively revisit older products' slots even if a newer, better-fitting
  candidate shows up later — that'd need a periodic re-matching pass.
- `draft` products (low Gemini confidence) are never surfaced by the site
  (`status = 'published'` is required everywhere) and are never used as alternative
  candidates. They just sit in the database for manual review/promotion.
