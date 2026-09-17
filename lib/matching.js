const TIER_ORDER = { budzetowy: 1, sredni: 2, premium: 3 };

export function parsePriceLow(specs) {
  const raw = specs?.price_pln_approx;
  if (typeof raw !== "string") return null;
  const match = raw.replace(/\s/g, "").match(/(\d[\d,.]*)/);
  if (!match) return null;
  const num = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(num) ? num : null;
}

function isCheaper(base, basePrice, baseTier, candidate, candidatePrice) {
  if (basePrice != null && candidatePrice != null) return candidatePrice < basePrice;
  const candidateTier = TIER_ORDER[candidate.price_tier] ?? null;
  if (baseTier != null && candidateTier != null) return candidateTier < baseTier;
  return Number(candidate.score) < Number(base.score);
}

function isPricier(base, basePrice, baseTier, candidate, candidatePrice) {
  if (basePrice != null && candidatePrice != null) return candidatePrice > basePrice;
  const candidateTier = TIER_ORDER[candidate.price_tier] ?? null;
  if (baseTier != null && candidateTier != null) return candidateTier > baseTier;
  return Number(candidate.score) > Number(base.score);
}

function buildCheaperReason(price) {
  return price != null
    ? `Wyraźnie niższa cena (ok. ${price} zł) w podobnym segmencie`
    : "Niższa cena w podobnym segmencie";
}

function buildPricierReason(price) {
  return price != null
    ? `Wyższa klasa za wyższą cenę (ok. ${price} zł)`
    : "Wyższa klasa specyfikacji za wyższą cenę";
}

// Picks up to 3 outgoing alternative slots for `base` from `candidates`
// (already-published products in the same category). Any slot without a
// good match is simply omitted — per the "don't guess" rule, a missing
// slot beats a fabricated one.
export function computeAlternatives(base, candidates) {
  const basePrice = parsePriceLow(base.specs);
  const baseTier = TIER_ORDER[base.price_tier] ?? null;
  const pool = candidates.filter((c) => c.brand !== base.brand);
  const results = [];

  const cheaper = pool
    .map((c) => ({ c, price: parsePriceLow(c.specs) }))
    .filter(({ c, price }) => isCheaper(base, basePrice, baseTier, c, price))
    .sort((a, b) => {
      if (basePrice != null) return (b.price ?? -Infinity) - (a.price ?? -Infinity);
      return (TIER_ORDER[b.c.price_tier] ?? 0) - (TIER_ORDER[a.c.price_tier] ?? 0);
    })[0];
  if (cheaper) {
    results.push({ angle: "tansza", alternativeId: cheaper.c.id, reason: buildCheaperReason(cheaper.price) });
  }

  const pricier = pool
    .map((c) => ({ c, price: parsePriceLow(c.specs) }))
    .filter(({ c, price }) => isPricier(base, basePrice, baseTier, c, price))
    .sort((a, b) => {
      if (basePrice != null) return (a.price ?? Infinity) - (b.price ?? Infinity);
      return (TIER_ORDER[a.c.price_tier] ?? 99) - (TIER_ORDER[b.c.price_tier] ?? 99);
    })[0];
  if (pricier) {
    results.push({ angle: "wyzsza_jakosc", alternativeId: pricier.c.id, reason: buildPricierReason(pricier.price) });
  }

  if (base.brand_recognition === "mainstream") {
    const niche = pool
      .filter((c) => c.brand_recognition === "niche")
      .map((c) => ({ c, diff: Math.abs(Number(c.score) - Number(base.score)) }))
      .sort((a, b) => a.diff - b.diff)[0];
    if (niche) {
      results.push({
        angle: "niszowa_marka",
        alternativeId: niche.c.id,
        reason: `Mniej znana w Polsce marka (${niche.c.brand}), porównywalny poziom jakości`,
      });
    }
  }

  return results;
}
