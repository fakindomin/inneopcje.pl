// Mirrors innaopcja.pl's lib/normalize.js so normalized_name stays comparable
// across both repos (trigram search, dedup checks).
export function normalizeName(input) {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9+\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function slugify(input) {
  return normalizeName(input).replace(/\s+/g, "-").replace(/-+/g, "-");
}

export async function uniqueSlug(pool, baseSlug) {
  const { rows } = await pool.query(
    `SELECT slug FROM products WHERE slug = $1 OR slug LIKE $1 || '-%'`,
    [baseSlug]
  );
  if (rows.length === 0) return baseSlug;

  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(baseSlug)) return baseSlug;

  let n = 2;
  while (taken.has(`${baseSlug}-${n}`)) n++;
  return `${baseSlug}-${n}`;
}
