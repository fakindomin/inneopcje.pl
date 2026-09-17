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

  await pool.query(
    `INSERT INTO categories (name, slug, parent_id) VALUES ('Telewizory', 'telewizory', NULL)
     ON CONFLICT (slug) DO NOTHING`
  );
}

const RUN_CATEGORIES = ["telefony", "telewizory"];

export async function pickCurrentCategory(pool) {
  const { rows } = await pool.query(`SELECT value FROM bot_state WHERE key = 'last_category'`);
  const last = rows[0]?.value;
  const current = last === RUN_CATEGORIES[0] ? RUN_CATEGORIES[1] : RUN_CATEGORIES[0];

  await pool.query(
    `INSERT INTO bot_state (key, value) VALUES ('last_category', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [current]
  );

  return current;
}
