import { getPool } from "../lib/db.js";
import { evaluatePerspektywaBatch, PERSPEKTYWA_BATCH_SIZE, geminiCallDelayMs, sleep, isQuotaError } from "../lib/gemini.js";

// One-off migration: tags every already-published "gry" product that
// predates the "perspektywa" spec field (added after the catalog already
// had ~920 games) — see lib/matching.js's sharesPerspective and
// wizardMatchGry.js's hard filter, both of which need this field to exist
// to actually restrict anything. Going forward, new games get it from the
// normal evaluation prompt (lib/gemini.js's CATEGORY_SPEC_HINTS.gry) and
// scripts/build.js's validateGrySpecs already rejects a response missing
// it — this script only exists to catch up the pre-existing backlog, and
// has nothing left to do once that backlog is cleared.

const GRY_PERSPEKTYWA = new Set(["FPP", "TPP", "izometryczna", "platformowka_2d", "inna"]);

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

// Mirrors build.js's evaluateGroupAdaptively, simplified: the perspektywa
// payload is tiny (two short strings per item) so truncation is far less
// likely than the full evaluation prompt, but the same self-correcting
// split-and-retry still costs nothing to keep for the rare bad response.
async function evaluateGroupAdaptively(group) {
  const results = new Map();
  if (group.length === 0) return results;

  let evaluations = [];
  try {
    evaluations = await evaluatePerspektywaBatch(group.map((item) => ({ productName: item.name, gatunki: item.specs?.gatunki })));
  } catch (err) {
    if (isQuotaError(err)) throw err;
    console.warn(`backfill: batch of ${group.length} failed (${err.message}), splitting and retrying`);
    evaluations = [];
  }

  const byName = new Map(
    Array.isArray(evaluations) ? evaluations.filter((e) => e && typeof e === "object").map((e) => [e.name, e]) : []
  );

  const missing = [];
  for (const item of group) {
    const evaluation = byName.get(item.name);
    if (evaluation && GRY_PERSPEKTYWA.has(evaluation.perspektywa)) results.set(item.name, evaluation.perspektywa);
    else missing.push(item);
  }

  if (missing.length === 0) return results;
  if (group.length === 1) return results; // give up on this one, left for next run

  const mid = Math.max(1, Math.ceil(missing.length / 2));
  await sleep(geminiCallDelayMs());
  const firstHalf = await evaluateGroupAdaptively(missing.slice(0, mid));
  for (const [name, perspektywa] of firstHalf) results.set(name, perspektywa);
  if (missing.length > mid) {
    await sleep(geminiCallDelayMs());
    const secondHalf = await evaluateGroupAdaptively(missing.slice(mid));
    for (const [name, perspektywa] of secondHalf) results.set(name, perspektywa);
  }
  return results;
}

async function run() {
  const pool = getPool();
  try {
    const { rows } = await pool.query(
      `SELECT id, name, specs FROM products
       WHERE status = 'published' AND category_id = (SELECT id FROM categories WHERE slug = 'gry')
         AND NOT (specs ? 'perspektywa')
       ORDER BY id`
    );
    console.log(`backfill: ${rows.length} gry products missing specs.perspektywa`);
    if (rows.length === 0) return;

    let tagged = 0;
    let quotaExhausted = false;

    for (const group of chunk(rows, PERSPEKTYWA_BATCH_SIZE)) {
      let results;
      try {
        results = await evaluateGroupAdaptively(group);
      } catch (err) {
        console.error(`backfill: Gemini daily quota exhausted, stopping early: ${err.message}`);
        quotaExhausted = true;
        break;
      }

      for (const item of group) {
        const perspektywa = results.get(item.name);
        if (!perspektywa) {
          console.warn(`backfill: no perspektywa for "${item.name}", leaving for next run`);
          continue;
        }
        await pool.query(`UPDATE products SET specs = specs || jsonb_build_object('perspektywa', $2::text) WHERE id = $1`, [
          item.id,
          perspektywa,
        ]);
        tagged++;
      }

      console.log(`backfill: tagged ${tagged}/${rows.length} so far`);
      await sleep(geminiCallDelayMs());
    }

    console.log(`backfill: done — tagged ${tagged}/${rows.length}${quotaExhausted ? " (stopped early, quota exhausted — re-run tomorrow for the rest)" : ""}`);
  } finally {
    await pool.end();
  }
}

run().catch((err) => {
  console.error("backfill: fatal error", err);
  process.exit(1);
});
