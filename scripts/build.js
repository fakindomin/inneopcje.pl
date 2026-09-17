import { getPool } from "../lib/db.js";
import { ensureSchema, pickCurrentCategory } from "../lib/schema.js";
import { evaluateProduct, GEMINI_CALL_DELAY_MS, sleep } from "../lib/gemini.js";
import { normalizeName, slugify, uniqueSlug } from "../lib/slugify.js";
import { computeAlternatives } from "../lib/matching.js";
import { generateSeeds } from "./generate-seeds.js";

const BATCH_SIZE = 25;
const SCORE_MIN = 1;
const SCORE_MAX = 10;
const VALID_BRAND_RECOGNITION = new Set(["mainstream", "niche"]);
const VALID_PRICE_TIER = new Set(["budzetowy", "sredni", "premium"]);
const VALID_CONFIDENCE = new Set(["wysoka", "niska"]);

function validateEvaluation(data) {
  if (!data || typeof data !== "object") return "response is not an object";
  if (typeof data.verdict !== "string" || !data.verdict.trim()) return "missing verdict";
  const score = Number(data.score);
  if (!Number.isFinite(score) || score < SCORE_MIN || score > SCORE_MAX) return "score out of range";
  if (typeof data.summary !== "string" || !data.summary.trim()) return "missing summary";
  if (!Array.isArray(data.pros) || data.pros.length === 0) return "missing pros";
  if (!Array.isArray(data.cons) || data.cons.length === 0) return "missing cons";
  if (!data.specs || typeof data.specs !== "object") return "missing specs";
  if (typeof data.specs.price_pln_approx !== "string" || !data.specs.price_pln_approx.trim()) {
    return "missing specs.price_pln_approx";
  }
  if (typeof data.brand !== "string" || !data.brand.trim()) return "missing brand";
  if (!VALID_BRAND_RECOGNITION.has(data.brand_recognition)) return "invalid brand_recognition";
  if (!VALID_PRICE_TIER.has(data.price_tier)) return "invalid price_tier";
  if (!VALID_CONFIDENCE.has(data.confidence)) return "invalid confidence";
  return null;
}

async function fetchQueueBatch(pool, category) {
  const { rows } = await pool.query(
    `SELECT id, product_name FROM seed_queue
     WHERE category = $1 AND status = 'pending'
     ORDER BY priority DESC, created_at ASC
     LIMIT $2`,
    [category, BATCH_SIZE]
  );
  return rows;
}

async function insertProduct(pool, categoryId, name, evaluation, status) {
  const normalizedName = normalizeName(name);
  const slug = await uniqueSlug(pool, slugify(name));
  const score = Number(evaluation.score).toFixed(1);

  const { rows } = await pool.query(
    `INSERT INTO products
       (category_id, name, slug, normalized_name, brand, brand_recognition, verdict, score,
        summary, pros, cons, specs, price_tier, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14)
     RETURNING id, slug, name, brand, brand_recognition, score, price_tier, specs`,
    [
      categoryId,
      name,
      slug,
      normalizedName,
      evaluation.brand,
      evaluation.brand_recognition,
      evaluation.verdict,
      score,
      evaluation.summary,
      JSON.stringify(evaluation.pros),
      JSON.stringify(evaluation.cons),
      JSON.stringify(evaluation.specs),
      evaluation.price_tier,
      status,
    ]
  );
  return rows[0];
}

async function linkAlternatives(pool, categoryId, product) {
  const { rows: candidates } = await pool.query(
    `SELECT id, slug, name, brand, brand_recognition, score, price_tier, specs
     FROM products WHERE category_id = $1 AND status = 'published' AND id <> $2`,
    [categoryId, product.id]
  );

  const alternatives = computeAlternatives(product, candidates);
  for (const alt of alternatives) {
    await pool.query(
      `INSERT INTO product_alternatives (product_id, alternative_product_id, comparison_angle, reason)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (product_id, alternative_product_id, comparison_angle) DO NOTHING`,
      [product.id, alt.alternativeId, alt.angle, alt.reason]
    );
  }
  return alternatives.length;
}

async function run() {
  const pool = getPool();
  const stats = { published: 0, draft: 0, failed: 0 };

  try {
    await ensureSchema(pool);
    const category = await pickCurrentCategory(pool);
    console.log(`build: run scoped to category "${category}"`);

    const { rows: categoryRows } = await pool.query(`SELECT id FROM categories WHERE slug = $1`, [category]);
    const categoryId = categoryRows[0]?.id;
    if (!categoryId) throw new Error(`category "${category}" not found`);

    let queue = await fetchQueueBatch(pool, category);
    if (queue.length === 0) {
      await generateSeeds(pool, category);
      await sleep(GEMINI_CALL_DELAY_MS);
      queue = await fetchQueueBatch(pool, category);
    }

    if (queue.length === 0) {
      console.log("build: nothing to do (queue still empty after refill)");
      return;
    }

    for (const item of queue) {
      try {
        const evaluation = await evaluateProduct(category, item.product_name);
        const error = validateEvaluation(evaluation);
        if (error) throw new Error(`invalid Gemini response: ${error}`);

        const status = evaluation.confidence === "wysoka" ? "published" : "draft";
        const product = await insertProduct(pool, categoryId, item.product_name, evaluation, status);

        let linked = 0;
        if (status === "published") {
          linked = await linkAlternatives(pool, categoryId, product);
        }

        await pool.query(`UPDATE seed_queue SET status = 'done' WHERE id = $1`, [item.id]);
        stats[status]++;
        console.log(`build: ${status} "${item.product_name}" -> ${product.slug} (${linked} alternatives linked)`);
      } catch (err) {
        await pool.query(`UPDATE seed_queue SET status = 'failed' WHERE id = $1`, [item.id]);
        stats.failed++;
        console.error(`build: failed "${item.product_name}": ${err.message}`);
      }

      await sleep(GEMINI_CALL_DELAY_MS);
    }

    console.log(`build: done — published=${stats.published} draft=${stats.draft} failed=${stats.failed}`);
  } finally {
    await pool.end();
  }
}

run().catch((err) => {
  console.error("build: fatal error", err);
  process.exit(1);
});
