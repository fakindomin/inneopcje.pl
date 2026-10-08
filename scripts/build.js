import { getPool } from "../lib/db.js";
import { ensureSchema, isBotEnabled, pickCurrentCategory, startRun, finishRun, logSkippedRun } from "../lib/schema.js";
import {
  evaluateProductsBatch,
  BATCH_EVAL_SIZE,
  geminiCallDelayMs,
  perKeyCallIntervalMs,
  keyCount,
  sleep,
  isQuotaError,
  minAllowedReleaseYear,
} from "../lib/gemini.js";
import { normalizeName, slugify, uniqueSlug } from "../lib/slugify.js";
import { computeAlternatives } from "../lib/matching.js";
import { normalizeBrand } from "../lib/brands.js";
import { generateSeeds } from "./generate-seeds.js";

// Confirmed on aistudio.google.com/rate-limit for this project:
// gemini-3.5-flash-lite free tier = 500 RPD, 15 RPM PER KEY (see
// lib/gemini.js's key rotation — multiple GEMINI_API_KEY* multiply both
// caps). 450 leaves a ~10% margin under one key's own daily cap; it's just
// a per-fetch LIMIT, so build.js's outer loop re-fetches more batches in
// the same run regardless of how many keys are configured.
const BATCH_SIZE = 450;
const SCORE_MIN = 1;
const SCORE_MAX = 10;
const VALID_BRAND_RECOGNITION = new Set(["mainstream", "niche"]);
const VALID_PRICE_TIER = new Set(["budzetowy", "sredni", "premium"]);
const VALID_CONFIDENCE = new Set(["wysoka", "niska"]);

// Must match inneopcje-admin's lib/wizardTreeGry.js question options and
// lib/matching.js's produkcja/klimat contrast logic exactly — see the
// rationale in lib/gemini.js's CATEGORY_SPEC_HINTS.gry.
const GRY_PLATFORMY = new Set(["PC", "Xbox", "PlayStation", "Nintendo", "Mobilne"]);
const GRY_TRYB = new Set(["solo", "multiplayer", "oba"]);
const GRY_GATUNKI = new Set(["RPG", "Akcja", "Strzelanka", "Strategia", "Sportowa", "Przygodowa", "Horror"]);
const GRY_PRODUKCJA = new Set(["AAA", "AA", "indie"]);
const GRY_DLUGOSC = new Set(["krotka", "srednia", "dluga"]);
const GRY_KLIMAT = new Set(["mroczny", "lekki"]);
const GRY_OPEN_WORLD = new Set(["otwarty", "liniowy"]);
const GRY_PERSPEKTYWA = new Set(["FPP", "TPP", "izometryczna", "platformowka_2d", "inna"]);

// Checks the gry-specific specs shape the wizard/matching engine depend on
// — a value outside these enums would never error, just silently never
// match any wizard filter, so this is validated as strictly as the generic
// fields above rather than left to Gemini's prompt instructions alone.
function validateGrySpecs(specs) {
  if (!Array.isArray(specs.platformy) || specs.platformy.length === 0 || !specs.platformy.every((p) => GRY_PLATFORMY.has(p))) {
    return "invalid specs.platformy";
  }
  if (!GRY_TRYB.has(specs.tryb)) return "invalid specs.tryb";
  if (!Array.isArray(specs.gatunki) || specs.gatunki.length === 0 || !specs.gatunki.every((g) => GRY_GATUNKI.has(g))) {
    return "invalid specs.gatunki";
  }
  if (!GRY_PRODUKCJA.has(specs.produkcja)) return "invalid specs.produkcja";
  if (!GRY_DLUGOSC.has(specs.dlugosc)) return "invalid specs.dlugosc";
  if (!GRY_KLIMAT.has(specs.klimat)) return "invalid specs.klimat";
  if (!GRY_OPEN_WORLD.has(specs.open_world)) return "invalid specs.open_world";
  if (!GRY_PERSPEKTYWA.has(specs.perspektywa)) return "invalid specs.perspektywa";
  const fabula = Number(specs.fabula_score);
  if (!Number.isInteger(fabula) || fabula < 1 || fabula > 5) return "invalid specs.fabula_score";
  const grafika = Number(specs.grafika_score);
  if (!Number.isInteger(grafika) || grafika < 1 || grafika > 5) return "invalid specs.grafika_score";
  const month = Number(specs.release_month);
  if (!Number.isInteger(month) || month < 1 || month > 12) return "invalid specs.release_month";
  if (typeof specs.wybor_trudnosci !== "boolean") return "invalid specs.wybor_trudnosci";
  return null;
}

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
  if (category === "gry") {
    const grySpecsError = validateGrySpecs(data.specs);
    if (grySpecsError) return grySpecsError;
  }
  if (typeof data.brand !== "string" || !data.brand.trim()) return "missing brand";
  const canonicalBrand = normalizeBrand(category, data.brand);
  if (!canonicalBrand) return `brand "${data.brand}" is outside the allowed list for "${category}"`;
  data.brand = canonicalBrand;
  if (!VALID_BRAND_RECOGNITION.has(data.brand_recognition)) return "invalid brand_recognition";
  if (!VALID_PRICE_TIER.has(data.price_tier)) return "invalid price_tier";
  const releaseYear = Number(data.release_year);
  const minYear = minAllowedReleaseYear(category);
  if (!Number.isFinite(releaseYear)) return "missing release_year";
  if (releaseYear < minYear) return `release_year ${releaseYear} is older than the allowed window (${minYear}+)`;
  if (releaseYear > new Date().getFullYear() + 1) return `release_year ${releaseYear} is implausibly far in the future`;
  if (!VALID_CONFIDENCE.has(data.confidence)) return "invalid confidence";
  return null;
}

async function fetchQueueBatch(pool, category) {
  const { rows } = await pool.query(
    `SELECT id, product_name, source_facts FROM seed_queue
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

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

// Evaluates `group` via one evaluateProductsBatch call, then recursively
// halves and retries whatever didn't come back cleanly - either the whole
// call failed (bad/non-array JSON, a truncated response) or it returned a
// valid array missing some names - down to individual items if needed.
// There's no "right" BATCH_EVAL_SIZE to hardcode: how many full records
// (verdict/summary/pros/cons/specs each) fit before a response gets cut off
// depends on how verbose each one turns out, which varies per batch. This
// makes the actual safe size self-discover per call instead of guessing a
// constant that either wastes headroom (too small) or routinely truncates
// (too large, as BATCH_EVAL_SIZE=20 did in practice). Returns
// Map<product_name, { evaluation } | { error }>. A QuotaExceededError
// propagates immediately instead of being treated as "this group failed" -
// splitting and retrying against an exhausted key can't possibly help.
async function evaluateGroupAdaptively(category, group) {
  const results = new Map();
  if (group.length === 0) return results;

  let evaluations = [];
  try {
    evaluations = await evaluateProductsBatch(
      category,
      group.map((item) => ({ productName: item.product_name, facts: item.source_facts }))
    );
  } catch (err) {
    if (isQuotaError(err)) throw err;
    console.warn(`build: batch of ${group.length} failed (${err.message}), splitting and retrying`);
    evaluations = []; // treated as "every item in this group came back missing" below
  }

  const byName = new Map(
    Array.isArray(evaluations) ? evaluations.filter((e) => e && typeof e === "object").map((e) => [e.name, e]) : []
  );

  const missing = [];
  for (const item of group) {
    const evaluation = byName.get(item.product_name);
    if (evaluation) results.set(item.product_name, { evaluation });
    else missing.push(item);
  }

  if (missing.length === 0) return results;

  // Already at the smallest possible group and it still came back missing
  // - nowhere left to split to, this is a genuine permanent failure.
  if (group.length === 1) {
    results.set(missing[0].product_name, { error: "not present in batch response (even alone)" });
    return results;
  }

  // Split whatever's still missing and retry - even a single straggler
  // from an otherwise-successful larger group gets one more solo attempt
  // instead of being given up on immediately, since a lone miss might
  // just be a fluke that a fresh, lower-pressure retry clears.
  const mid = Math.max(1, Math.ceil(missing.length / 2));
  await sleep(geminiCallDelayMs());
  const firstHalf = await evaluateGroupAdaptively(category, missing.slice(0, mid));
  for (const [name, result] of firstHalf) results.set(name, result);
  if (missing.length > mid) {
    await sleep(geminiCallDelayMs());
    const secondHalf = await evaluateGroupAdaptively(category, missing.slice(mid));
    for (const [name, result] of secondHalf) results.set(name, result);
  }
  return results;
}

// One group's worth of DB writes (insert/link/seed_queue update), shared by
// both a successfully-evaluated group and nothing else - a group whose
// Gemini call itself rejected (quota exhausted) never reaches this, its
// items are left untouched ('pending') for a future run instead.
async function writeGroupResults(pool, category, categoryId, group, results, stats, onItemError) {
  for (const item of group) {
    try {
      const result = results.get(item.product_name);
      if (!result) throw new Error("not present in batch response");
      if (result.error) throw new Error(result.error);
      const evaluation = result.evaluation;

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
      await pool.query(`UPDATE seed_queue SET status = 'failed', last_error = $2 WHERE id = $1`, [item.id, err.message]);
      stats.failed++;
      onItemError(err.message);
      console.error(`build: failed "${item.product_name}": ${err.message}`);
    }
  }
}

// Evaluates every item in `queue`, inserting/linking as it goes,
// BATCH_EVAL_SIZE candidates per Gemini call instead of one call per
// candidate (see lib/gemini.js's evaluateProductsBatch — the free tier's
// binding constraint is requests/day and requests/minute, not context
// window, so this multiplies effective throughput). Groups of BATCH_EVAL_SIZE
// are further run `keyCount()` AT A TIME, one concurrent call per configured
// GEMINI_API_KEY* — a single batch call is model-latency-bound (several
// seconds of actual generation, not just the rate-limit gap), so with
// multiple independent keys the real lever is parallelism, not a bigger
// per-call batch. evaluateGroupAdaptively handles a group that doesn't come
// back cleanly by splitting and retrying smaller pieces internally, so a
// single bad/truncated response doesn't cost its whole group - it only ever
// rejects this call with QuotaExceededError, meaning every configured key
// was exhausted by the time it ran (see callWithKeyRotation). That group's
// items are left untouched (still 'pending') for a future run; whatever
// else in the same round succeeded is kept.
async function processBatch(pool, category, categoryId, queue) {
  const stats = { published: 0, draft: 0, failed: 0 };
  let lastItemError = null;
  let quotaExhausted = false;

  const concurrency = Math.max(1, keyCount());
  const groups = chunk(queue, BATCH_EVAL_SIZE);

  for (let i = 0; i < groups.length && !quotaExhausted; i += concurrency) {
    const round = groups.slice(i, i + concurrency);
    const settled = await Promise.allSettled(round.map((group) => evaluateGroupAdaptively(category, group)));

    for (let g = 0; g < round.length; g++) {
      const outcome = settled[g];
      if (outcome.status === "rejected") {
        console.error(
          `build: Gemini daily quota exhausted, leaving ${round[g].length} items pending: ${outcome.reason.message}`
        );
        quotaExhausted = true;
        continue;
      }
      await writeGroupResults(pool, category, categoryId, round[g], outcome.value, stats, (msg) => {
        lastItemError = msg;
      });
    }

    if (!quotaExhausted && i + concurrency < groups.length) await sleep(perKeyCallIntervalMs());
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
    await sleep(geminiCallDelayMs());
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
