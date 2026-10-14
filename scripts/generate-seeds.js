import { getPool } from "../lib/db.js";
import { generateSeedNames } from "../lib/gemini.js";
import { normalizeName } from "../lib/slugify.js";
import { fetchTopGames, PLATFORM_IGDB_IDS, IGDB_CALL_DELAY_MS, sleep as igdbSleep } from "../lib/igdb.js";

const GRY_PLATFORMS = Object.keys(PLATFORM_IGDB_IDS); // PC, PlayStation, Xbox, Nintendo, Mobilne
const GRY_YEARS_BACK = 10;
const GRY_PAGE_SIZE = 100;
// Safety cap, not an expected steady-state - IGDB's own result count per
// (platform, year) bucket is what actually ends the loop (a page shorter
// than GRY_PAGE_SIZE means that bucket is exhausted). Without SOME cap, one
// unusually deep bucket (e.g. "PC, this year") could burn the entire run's
// time budget on IGDB pagination instead of leaving room for Gemini to
// evaluate anything.
const GRY_MAX_PAGES_PER_BUCKET = 20;

// Newest year first - lastNYears(10)[0] is the current year.
function lastNYears(n) {
  const currentYear = new Date().getFullYear();
  return Array.from({ length: n }, (_, i) => currentYear - i);
}

// `gry` sources candidate names from IGDB's real ratings (see lib/igdb.js)
// instead of asking Gemini to recall or search a ranking from memory. Each
// candidate's IGDB facts (platforms/genres/themes/game_modes/rating) are
// stored alongside it in seed_queue.source_facts, fed back into the Gemini
// evaluation prompt as grounding (see lib/gemini.js).
//
// Deliberately year-outer, platform-inner, newest year first: every
// platform's share for one year gets queued (and given that year as
// `priority`) before moving to an older year. build.js's fetchQueueBatch
// already orders by `priority DESC, created_at ASC`, so this is what makes
// processing fill every platform with recent titles first - breadth before
// depth - instead of exhausting one platform's entire 10-year history before
// a second platform gets anything.
//
// Pages each (year, platform) bucket GRY_PAGE_SIZE games at a time instead
// of only ever asking for the first page - IGDB's `sort total_rating desc`
// is stable between calls, so a single fixed-size fetch returns the exact
// same top N every run, and once those are all queued (done/failed/pending
// - seed_queue is checked regardless of status) the whole sweep would
// permanently dedupe to zero new names despite IGDB holding far more
// (confirmed live: a user-reported "nothing more to add" turned out to be
// this, not an actually-exhausted catalog). Stops paging a bucket once a
// page comes back shorter than GRY_PAGE_SIZE (IGDB's own signal that
// bucket's filtered results are exhausted) or GRY_MAX_PAGES_PER_BUCKET is
// hit (safety cap, not an expected steady-state - see its own comment).
async function generateGrySeeds(pool, deadline) {
  const [{ rows: existingProducts }, { rows: queued }] = await Promise.all([
    pool.query(
      `SELECT normalized_name FROM products p JOIN categories c ON c.id = p.category_id WHERE c.slug = 'gry'`
    ),
    pool.query(`SELECT product_name FROM seed_queue WHERE category = 'gry'`),
  ]);
  const known = new Set([
    ...existingProducts.map((r) => r.normalized_name),
    ...queued.map((r) => normalizeName(r.product_name)),
  ]);

  let totalQueued = 0;
  outer: for (const year of lastNYears(GRY_YEARS_BACK)) {
    for (const platform of GRY_PLATFORMS) {
      // Same reasoning as scripts/build.js's processBatch deadline check -
      // up to 20 pages x 50 (platform, year) buckets is a lot of IGDB round
      // trips, and this runs inside the same job's time budget as the
      // actual Gemini evaluation that follows it. Bailing out here (instead
      // of running the full sweep to completion no matter how long it
      // takes) leaves that budget intact for processBatch, and the sweep
      // picks up wherever it left off next time the queue runs dry anyway.
      if (deadline && Date.now() > deadline) {
        console.log(`generate-seeds(gry): approaching the job's time budget, stopping the IGDB sweep early`);
        break outer;
      }
      for (let page = 0; page < GRY_MAX_PAGES_PER_BUCKET; page++) {
        let games;
        try {
          games = await fetchTopGames(platform, year, GRY_PAGE_SIZE, page * GRY_PAGE_SIZE);
        } catch (err) {
          console.error(`generate-seeds(gry): IGDB fetch failed for ${platform}/${year} (page ${page}): ${err.message}`);
          break;
        }
        await igdbSleep(IGDB_CALL_DELAY_MS);

        const rows = [];
        for (const game of games) {
          const normalized = normalizeName(game.name);
          if (!normalized || known.has(normalized)) continue;
          known.add(normalized);
          rows.push([game.name.trim(), JSON.stringify(game), year]);
        }
        if (rows.length > 0) {
          const values = rows.map((_, i) => `('gry', $${i * 3 + 1}, $${i * 3 + 2}::jsonb, $${i * 3 + 3})`).join(", ");
          const params = rows.flat();
          await pool.query(
            `INSERT INTO seed_queue (category, product_name, source_facts, priority) VALUES ${values}
             ON CONFLICT (category, product_name) DO NOTHING`,
            params
          );
          totalQueued += rows.length;
        }

        // Shorter than a full page means IGDB has nothing further for this
        // bucket - no point requesting another page of a list that's already
        // exhausted, even if every name on THIS page happened to be known.
        if (games.length < GRY_PAGE_SIZE) break;
      }
    }
  }

  console.log(
    `generate-seeds(gry): queued ${totalQueued} new names from IGDB across ${GRY_PLATFORMS.length} platforms x ${GRY_YEARS_BACK} years (newest year first, priority = release year, up to ${GRY_MAX_PAGES_PER_BUCKET} pages/bucket)`
  );
  return totalQueued;
}

// Refills seed_queue with new candidate product names for `category`.
// Dedupes against products already in the DB and rows already queued.
export async function generateSeeds(pool, category, deadline) {
  if (category === "gry") return generateGrySeeds(pool, deadline);

  const names = await generateSeedNames(category);

  const [{ rows: existingProducts }, { rows: queued }] = await Promise.all([
    pool.query(`SELECT normalized_name FROM products p JOIN categories c ON c.id = p.category_id WHERE c.slug = $1`, [
      category,
    ]),
    pool.query(`SELECT product_name FROM seed_queue WHERE category = $1`, [category]),
  ]);

  const known = new Set([
    ...existingProducts.map((r) => r.normalized_name),
    ...queued.map((r) => normalizeName(r.product_name)),
  ]);

  const fresh = [];
  for (const name of names) {
    const normalized = normalizeName(name);
    if (!normalized || known.has(normalized)) continue;
    known.add(normalized);
    fresh.push(name.trim());
  }

  if (fresh.length === 0) {
    console.log(`generate-seeds: no new ${category} names to queue`);
    return 0;
  }

  const values = fresh.map((_, i) => `($1, $${i + 2})`).join(", ");
  await pool.query(
    `INSERT INTO seed_queue (category, product_name) VALUES ${values} ON CONFLICT (category, product_name) DO NOTHING`,
    [category, ...fresh]
  );

  console.log(`generate-seeds: queued ${fresh.length} new ${category} names`);
  return fresh.length;
}

// Allow running standalone: node scripts/generate-seeds.js telefony
if (import.meta.url === `file://${process.argv[1]}`) {
  const category = process.argv[2];
  if (!category) {
    console.error("Usage: node scripts/generate-seeds.js <telefony|telewizory>");
    process.exit(1);
  }
  const pool = getPool();
  try {
    await generateSeeds(pool, category);
  } finally {
    await pool.end();
  }
}
