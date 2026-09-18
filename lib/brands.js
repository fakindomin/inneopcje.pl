// Brands the bot is allowed to research, scoped to what's actually sold
// through normal Polish retail (RTV Euro AGD, Media Expert, x-kom, Media
// Markt, carrier stores) — not AliExpress-only imports or brands with no
// real PL distribution. Enforced both in the seed-generation prompt (to
// steer Gemini) and in build.js's validation (so the prompt alone isn't
// the only thing stopping an off-list brand from getting published).
//
// A category with no entry here runs unrestricted — new categories added
// via the admin panel won't silently break, they just won't be scoped
// until someone adds a list for them.
export const ALLOWED_BRANDS = {
  telefony: [
    "Samsung",
    "Apple",
    "Xiaomi",
    "Redmi",
    "POCO",
    "OnePlus",
    "Google",
    "Honor",
    "Motorola",
    "Oppo",
    "realme",
    "Nothing",
    "Sony",
    "Huawei",
    "Asus",
    "TCL",
    "ZTE",
    "CAT",
    "HAMMER",
  ],
  telewizory: [
    "Samsung",
    "LG",
    "Sony",
    "Philips",
    "TCL",
    "Hisense",
    "Panasonic",
    "Sharp",
    "Toshiba",
    "JVC",
    "Xiaomi",
    "Kruger&Matz",
    "Manta",
    "Grundig",
    "Blaupunkt",
    "Thomson",
    "Finlux",
    "Hyundai",
    "Medion",
    "AOC",
    "BenQ",
    "Hitachi",
  ],
};

// Case-insensitively matches `rawBrand` against the category's allowlist and
// returns the canonical spelling (fixes the Vivo/vivo, Asus/ASUS-style
// duplicates), or null if it's not on the list. Categories without a list
// pass through unchanged.
export function normalizeBrand(category, rawBrand) {
  const list = ALLOWED_BRANDS[category];
  if (!list) return (rawBrand || "").trim() || null;

  const trimmed = (rawBrand || "").trim();
  if (!trimmed) return null;
  return list.find((b) => b.toLowerCase() === trimmed.toLowerCase()) ?? null;
}
