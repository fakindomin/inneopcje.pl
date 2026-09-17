// Idempotent — safe to run on every invocation. This repo doesn't ship a
// separate migration runner: it just makes sure the pieces it needs exist
// on top of the schema already applied by the innaopcja.pl website repo
// (categories, products, product_alternatives).
export async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seed_queue (
      id SERIAL PRIMARY KEY,
      category TEXT NOT NULL,
      product_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (category, product_name)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // One row per invocation of scripts/build.js — lets the admin panel show
  // whether the bot ran today and what it did, without needing any access
  // to the GitHub Actions API.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_runs (
      id SERIAL PRIMARY KEY,
      category TEXT,
      status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed', 'skipped')),
      published_count INTEGER NOT NULL DEFAULT 0,
      draft_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ
    );
  `);

  await pool.query(
    `INSERT INTO categories (name, slug, parent_id) VALUES ('Telewizory', 'telewizory', NULL)
     ON CONFLICT (slug) DO NOTHING`
  );
}

// Paused from the admin panel (innaopcja.pl/admin) by flipping bot_state's
// 'enabled' key to 'false'. Unset counts as enabled, so existing databases
// aren't paused by default.
export async function isBotEnabled(pool) {
  const { rows } = await pool.query(`SELECT value FROM bot_state WHERE key = 'enabled'`);
  return rows[0]?.value !== "false";
}

// Round-robins over every top-level category found in `categories`, so a
// category added later (e.g. via the admin panel) is picked up automatically
// without a code change here.
export async function pickCurrentCategory(pool) {
  const { rows: categoryRows } = await pool.query(
    `SELECT slug FROM categories WHERE parent_id IS NULL ORDER BY id`
  );
  const slugs = categoryRows.map((r) => r.slug);
  if (slugs.length === 0) throw new Error("no categories found");

  const { rows } = await pool.query(`SELECT value FROM bot_state WHERE key = 'last_category'`);
  const last = rows[0]?.value;
  const lastIndex = slugs.indexOf(last);
  const current = slugs[(lastIndex + 1) % slugs.length];

  await pool.query(
    `INSERT INTO bot_state (key, value) VALUES ('last_category', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [current]
  );

  return current;
}

export async function startRun(pool, category) {
  const { rows } = await pool.query(
    `INSERT INTO bot_runs (category, status) VALUES ($1, 'running') RETURNING id`,
    [category]
  );
  return rows[0].id;
}

export async function finishRun(pool, runId, { status, published = 0, draft = 0, failed = 0 }) {
  await pool.query(
    `UPDATE bot_runs
     SET status = $2, published_count = $3, draft_count = $4, failed_count = $5, finished_at = now()
     WHERE id = $1`,
    [runId, status, published, draft, failed]
  );
}

export async function logSkippedRun(pool) {
  await pool.query(`INSERT INTO bot_runs (category, status, finished_at) VALUES (NULL, 'skipped', now())`);
}
