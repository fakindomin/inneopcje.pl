import { getPool } from "../lib/db.js";
import { generateSeedNames } from "../lib/gemini.js";
import { normalizeName } from "../lib/slugify.js";

// Refills seed_queue with new candidate product names for `category`.
// Dedupes against products already in the DB and rows already queued.
export async function generateSeeds(pool, category) {
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
