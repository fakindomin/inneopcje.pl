import { getPool } from "../lib/db.js";
import { generateSeedNames } from "../lib/gemini.js";
import { normalizeName } from "../lib/slugify.js";
import { fetchTopGames, PLATFORM_IGDB_IDS, IGDB_CALL_DELAY_MS, sleep as igdbSleep } from "../lib/igdb.js";

const GRY_PLATFORMS = Object.keys(PLATFORM_IGDB_IDS); // PC, PlayStation, Xbox, Nintendo, Mobilne
const GRY_YEARS_BACK = 10;

// Newest year first - lastNYears(10)[0] is the current year.
function lastNYears(n) {
  const currentYear = new Date().getFullYear();
  return Array.from({ length: n }, (_, i) => currentYear - i);
}

// `gry` sources candidate names from IGDB's real ratings (top 100 per
// platform per year, see lib/igdb.js) instead of asking Gemini to recall or
// search a ranking from memory. Sweeps every (year, platform) cell once per
// call; re-running later mostly dedupes to nothing new until IGDB's own
// rankings shift. Each candidate's IGDB facts (platforms/genres/themes/
// game_modes/rating) are stored alongside it in seed_queue.source_facts, fed
// back into the Gemini evaluation prompt as grounding (see lib/gemini.js).
//
// Deliberately year-outer, platform-inner, newest year first: every
// platform's top 100 for one year gets queued (and given that year as
// `priority`) before moving to an older year. build.js's fetchQueueBatch
// already orders by `priority DESC, created_at ASC`, so this is what makes
// processing fill every platform with recent titles first - breadth before
// depth - instead of exhausting one platform's entire 10-year history before
// a second platform gets anything.
async function generateGrySeeds(pool) {
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
  for (const year of lastNYears(GRY_YEARS_BACK)) {
    for (const platform of GRY_PLATFORMS) {
      let games;
      try {
        games = await fetchTopGames(platform, year, 100);
      } catch (err) {
        console.error(`generate-seeds(gry): IGDB fetch failed for ${platform}/${year}: ${err.message}`);
        continue;
      }
      await igdbSleep(IGDB_CALL_DELAY_MS);

      const rows = [];
      for (const game of games) {
        const normalized = normalizeName(game.name);
        if (!normalized || known.has(normalized)) continue;
        known.add(normalized);
        rows.push([game.name.trim(), JSON.stringify(game), year]);
      }
      if (rows.length === 0) continue;

      const values = rows.map((_, i) => `('gry', $${i * 3 + 1}, $${i * 3 + 2}::jsonb, $${i * 3 + 3})`).join(", ");
      const params = rows.flat();
      await pool.query(
        `INSERT INTO seed_queue (category, product_name, source_facts, priority) VALUES ${values}
         ON CONFLICT (category, product_name) DO NOTHING`,
        params
      );
      totalQueued += rows.length;
    }
  }

  console.log(
    `generate-seeds(gry): queued ${totalQueued} new names from IGDB across ${GRY_PLATFORMS.length} platforms x ${GRY_YEARS_BACK} years (newest year first, priority = release year)`
  );
  return totalQueued;
}

// Refills seed_queue with new candidate product names for `category`.
// Dedupes against products already in the DB and rows already queued.
export async function generateSeeds(pool, category) {
  if (category === "gry") return generateGrySeeds(pool);

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
