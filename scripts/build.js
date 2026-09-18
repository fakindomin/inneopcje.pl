import { getPool } from "../lib/db.js";
import { ensureSchema, isBotEnabled, pickCurrentCategory, startRun, finishRun, logSkippedRun } from "../lib/schema.js";
import { evaluateProduct, GEMINI_CALL_DELAY_MS, sleep, isQuotaError, minAllowedReleaseYear } from "../lib/gemini.js";
import { normalizeName, slugify, uniqueSlug } from "../lib/slugify.js";
import { computeAlternatives } from "../lib/matching.js";
import { normalizeBrand } from "../lib/brands.js";
import { generateSeeds } from "./generate-seeds.js";

// Confirmed on aistudio.google.com/rate-limit for this project:
// gemini-3.5-flash-lite free tier = 500 RPD, 15 RPM. 450 leaves the same
// ~10% margin odbaitujto uses for the same model/tier.
const BATCH_SIZE = 450;
const SCORE_MIN = 1;
const SCORE_MAX = 10;
const VALID_BRAND_RECOGNITION = new Set(["mainstream", "niche"]);
const VALID_PRICE_TIER = new Set(["budzetowy", "sredni", "premium"]);
const VALID_CONFIDENCE = new Set(["wysoka", "niska"]);

// One cron firing keeps looping through categories — refilling and
// processing batches — until it genuinely runs out of runway: the daily
// Gemini quota, a full lap through every category with nothing new to add,
// or the job's own time budget. This is what makes "use the whole day's
// quota" automatic instead of needing someone to keep re-triggering it.
const JOB_TIME_BUDGET_MS = 38 * 60 * 1000; // leave ~2 min under timeout-minutes: 40
const MAX_LOOP_ITERATIONS = 200; // absolute safety net, independent of the above

// Mutates data.brand to the canonical allowlisted spelling on success (fixes
// Vivo/vivo-style casing duplicates) — that's why this isn't a pure function.
function validateEvaluation(data, category) {
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
  const canonicalBrand = normalizeBrand(category, data.brand);
  if (!canonicalBrand) return `brand "${data.brand}" is outside the allowed list for "${category}"`;
  data.brand = canonicalBrand;
  if (!VALID_BRAND_RECOGNITION.has(data.brand_recognition)) return "invalid brand_recognition";
  if (!VALID_PRICE_TIER.has(data.price_tier)) return "invalid price_tier";
  const releaseYear = Number(data.release_year);
  const minYear = minAllowedReleaseYear();
  if (!Number.isFinite(releaseYear)) return "missing release_year";
  if (releaseYear < minYear) return `release_year ${releaseYear} is older than the allowed window (${minYear}+)`;
  if (releaseYear > new Date().getFullYear() + 1) return `release_year ${releaseYear} is implausibly far in the future`;
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

// Evaluates every item in `queue`, inserting/linking as it goes. Stops
// immediately (leaving the rest of `queue` untouched, still 'pending') if
// Gemini reports the daily quota is exhausted.
async function processBatch(pool, category, categoryId, queue) {
  const stats = { published: 0, draft: 0, failed: 0 };
  let lastItemError = null;
  let quotaExhausted = false;

  for (const item of queue) {
    try {
      const evaluation = await evaluateProduct(category, item.product_name);
      const error = validateEvaluation(evaluation, category);
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
      if (isQuotaError(err)) {
        console.error(`build: Gemini daily quota exhausted, stopping batch early: ${err.message}`);
        quotaExhausted = true;
        break;
      }

      await pool.query(`UPDATE seed_queue SET status = 'failed', last_error = $2 WHERE id = $1`, [
        item.id,
        err.message,
      ]);
      stats.failed++;
      lastItemError = err.message;
      console.error(`build: failed "${item.product_name}": ${err.message}`);
    }

    await sleep(GEMINI_CALL_DELAY_MS);
  }

  return { stats, quotaExhausted, lastItemError };
}

// One category's worth of work for this pass: refill the queue if empty,
// process whatever's there, log a bot_runs row. Returns whether it actually
// did anything (so the outer loop can tell "nothing left anywhere" apart
// from "just this category was empty") and whether quota ran out.
async function runOneCategoryCycle(pool) {
  const category = await pickCurrentCategory(pool);
  const { rows: categoryRows } = await pool.query(`SELECT id FROM categories WHERE slug = $1`, [category]);
  const categoryId = categoryRows[0]?.id;
  if (!categoryId) {
    console.error(`build: category "${category}" not found, skipping`);
    return { didWork: false, quotaExhausted: false };
  }

  const runId = await startRun(pool, category);
  console.log(`build: cycle scoped to category "${category}" (run ${runId})`);

  let queue = await fetchQueueBatch(pool, category);
  if (queue.length === 0) {
    try {
      await generateSeeds(pool, category);
    } catch (err) {
      if (isQuotaError(err)) {
        await finishRun(pool, runId, { status: "failed", note: err.message });
        return { didWork: false, quotaExhausted: true };
      }
      console.error(`build: generate-seeds failed, will retry next cycle: ${err.message}`);
      await finishRun(pool, runId, { status: "failed", note: err.message });
      return { didWork: false, quotaExhausted: false };
    }
    await sleep(GEMINI_CALL_DELAY_MS);
    queue = await fetchQueueBatch(pool, category);
  }

  if (queue.length === 0) {
    console.log(`build: nothing to do for "${category}" (queue still empty after refill)`);
    await finishRun(pool, runId, { status: "success" });
    return { didWork: false, quotaExhausted: false };
  }

  const { stats, quotaExhausted, lastItemError } = await processBatch(pool, category, categoryId, queue);

  console.log(`build: "${category}" done — published=${stats.published} draft=${stats.draft} failed=${stats.failed}`);
  await finishRun(pool, runId, {
    status: quotaExhausted ? "failed" : "success",
    ...stats,
    note: quotaExhausted
      ? "Gemini: wyczerpany dzienny limit (RESOURCE_EXHAUSTED) — przerwano cykl wcześniej, reszta kolejki zostaje w 'pending'"
      : stats.failed > 0
      ? `ostatni błąd pozycji: ${lastItemError}`
      : null,
  });

  return { didWork: true, quotaExhausted };
}

async function run() {
  const pool = getPool();

  try {
    await ensureSchema(pool);

    if (!(await isBotEnabled(pool))) {
      console.log("build: bot is disabled in bot_state (paused from the admin panel) — skipping");
      await logSkippedRun(pool);
      return;
    }

    const { rows: categoryRows } = await pool.query(`SELECT slug FROM categories WHERE parent_id IS NULL`);
    const categoryCount = Math.max(categoryRows.length, 1);

    const jobStart = Date.now();
    let consecutiveEmptyCycles = 0;
    let iterations = 0;

    while (true) {
      iterations++;
      if (iterations > MAX_LOOP_ITERATIONS) {
        console.log("build: hit the absolute iteration safety cap, stopping");
        break;
      }
      if (Date.now() - jobStart > JOB_TIME_BUDGET_MS) {
        console.log("build: approaching the job's time budget, stopping cleanly");
        break;
      }
      if (consecutiveEmptyCycles >= categoryCount) {
        console.log("build: full lap through every category with nothing new to do — stopping for now");
        break;
      }

      const { didWork, quotaExhausted } = await runOneCategoryCycle(pool);

      if (quotaExhausted) {
        console.log("build: stopping — Gemini daily quota exhausted");
        break;
      }

      consecutiveEmptyCycles = didWork ? 0 : consecutiveEmptyCycles + 1;
    }
  } finally {
    await pool.end();
  }
}

run().catch((err) => {
  console.error("build: fatal error", err);
  process.exit(1);
});
