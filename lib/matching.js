// Alternative-matching engine — see the memory note on this audit for the
// full rationale. Core rules:
//   - Price isn't a meaningful axis for media (games/books/films/music) the
//     way it was for phones, so there's no price-based slot anymore. The
//     three slots are "Podobne" (wyzsza_jakosc - similar/slightly higher
//     score), "A może..." (inny_nastroj - same kind of thing, opposite
//     mood/climate) and "Inaczej" (niszowa_marka - production-scale or
//     brand-recognition contrast). None of them claim to be objectively
//     "better" or "cheaper" - that framing fit phones, not media.
//   - `score` is a price-to-quality-ratio rating (a cheap phone can score
//     well purely for being good value), NOT an absolute quality rating —
//     so "Podobne" prefers the candidate to be in the same price_tier as
//     base, reaching one tier up (or, failing that, one tier down — see
//     below) only when nothing in base's own tier out-scores it. Without
//     that preference, a budget phone with a great value score could get
//     labeled "better" than a flagship it isn't actually better than;
//     without the one-tier cap, it could jump straight from budzetowy to
//     premium in one hop, which is exactly the kind of false claim this
//     engine exists to avoid. "Inaczej" similarly prefers the SAME tier when
//     it falls back to the brand-recognition path (see below), since that
//     path's reason text explicitly claims "porównywalny poziom jakości"
//     (comparable quality) — that's only true within one segment.
//   - Both "Podobne" and "Inaczej" prefer a different brand, but fall back
//     to the same brand rather than leaving a slot empty — a missing slot
//     is only acceptable when no honest candidate exists at all.
//   - "Inaczej" always points to the *opposite* brand-recognition tier from
//     the base (mainstream -> niche, niche -> mainstream) — "different" is
//     relative to the base, not "more obscure than the base."
//   - Every relaxation level has its own reason text that matches what's
//     actually true; we never claim a slot is "better" when it was only
//     filled by loosening the brand constraint.
//   - "Podobne" also falls back one tier *below* base when nothing in
//     base's own tier or the tier above out-scores it — otherwise a tier
//     with a low score ceiling (e.g. a capped premium segment) can leave
//     the slot permanently empty even though a genuinely higher-scoring
//     title exists one segment down.
//   - "A może..." picks a candidate with the OPPOSITE `specs.klimat` from
//     base (mroczny <-> lekki) that otherwise resembles it as closely as
//     possible (same tryb, similar dlugosc, overlapping gatunki) - the
//     point is "the same kind of thing, just a different mood", e.g.
//     suggesting something lighter instead of a horror game. Only applies
//     to product lines that carry a `klimat` spec; the slot is simply left
//     empty for lines that don't (no legacy price-based fallback).
//   - When a product line tracks a `produkcja` spec (AAA/AA/indie), "Inaczej"
//     prefers a genuine production-scale contrast (AAA <-> indie) over a
//     same-tier/closest-score pick — same tier + closest score tends to
//     surface something that barely differs from base, which defeats the
//     point of "Inaczej". The same-tier "porównywalny poziom jakości" path
//     stays as the fallback for product lines without that spec.
const TIER_ORDER = { budzetowy: 1, sredni: 2, premium: 3 };
const PRODUCTION_SCALE_ORDER = { indie: 1, AA: 2, AAA: 3 };
const DLUGOSC_ORDER = { krotka: 1, srednia: 2, dluga: 3 };

// What "Podobne" actually points to when it claims a candidate is on par
// with (or edges out) base - citing the raw `score` alone doesn't say WHY,
// and `score` is a price-to-quality ratio anyway, not a quality measure on
// its own. Each dimension here is a genuine quality axis; the one where the
// candidate has the biggest lead over base becomes the stated reason.
const QUALITY_DIMENSIONS = [
  { get: (specs) => Number(specs?.grafika_score) || null, label: "lepszą oprawą graficzną" },
  { get: (specs) => Number(specs?.fabula_score) || null, label: "bardziej dopracowaną fabułą" },
  { get: (specs) => DLUGOSC_ORDER[specs?.dlugosc] ?? null, label: "dłuższą rozgrywką" },
];

// Finds which concrete attribute actually favors `candidate` over `base`,
// picking the biggest lead when more than one does. Returns null when none
// of these dimensions happen to favor the candidate (score can differ for
// reasons outside this list) - buildBetterReason falls back to a generic
// reason in that case.
function pickWinningDimension(base, candidate) {
  let winner = null;
  for (const dimension of QUALITY_DIMENSIONS) {
    const baseValue = dimension.get(base.specs);
    const candidateValue = dimension.get(candidate.specs);
    if (baseValue == null || candidateValue == null) continue;
    const lead = candidateValue - baseValue;
    if (lead > 0 && (!winner || lead > winner.lead)) winner = { label: dimension.label, lead };
  }
  return winner;
}

function isSameTier(base, candidate) {
  const baseTier = TIER_ORDER[base.price_tier] ?? null;
  const candTier = TIER_ORDER[candidate.price_tier] ?? null;
  if (baseTier == null || candTier == null) return true;
  return candTier === baseTier;
}

// Picks the closest higher-scoring candidate, preferring base's own price
// tier and only reaching one tier higher when nothing there out-scores it
// — score alone isn't enough (it's a value-for-money rating, so a cheaper
// tier can out-score a pricier one on value without being "better"), and
// an uncapped tier search could jump straight from budzetowy to premium.
function pickHigherScore(base, pool) {
  const baseScore = Number(base.score);
  const baseTier = TIER_ORDER[base.price_tier] ?? null;

  const higherScoring = (tierPredicate) =>
    pool.filter((c) => tierPredicate(TIER_ORDER[c.price_tier] ?? null) && Number(c.score) > baseScore);

  const bestOf = (matches) => {
    if (matches.length === 0) return null;
    matches.sort((a, b) => Number(a.score) - Number(b.score));
    return matches[0];
  };

  if (baseTier == null) {
    // Tier unknown for base - fall back to the old, tier-agnostic search
    // rather than refusing to match at all.
    return bestOf(higherScoring(() => true));
  }

  const sameTier = bestOf(higherScoring((t) => t === baseTier));
  if (sameTier) return sameTier;

  const oneUp = bestOf(higherScoring((t) => t === baseTier + 1));
  if (oneUp) return oneUp;

  return bestOf(higherScoring((t) => t === baseTier - 1));
}

function productionScale(product) {
  return PRODUCTION_SCALE_ORDER[product.specs?.produkcja] ?? null;
}

// Picks the candidate whose production scale contrasts most with base
// (AAA <-> indie), falling back to the next-most-contrasting scale when the
// first is empty. Only applies to product lines that carry a `produkcja`
// spec (currently: gry).
function pickProductionContrast(base, pool) {
  const baseScale = productionScale(base);
  if (baseScale == null) return null;
  const byContrast = [1, 2, 3]
    .filter((scale) => scale !== baseScale)
    .sort((a, b) => Math.abs(b - baseScale) - Math.abs(a - baseScale));
  for (const scale of byContrast) {
    const pick = pickClosestScore(base, pool.filter((c) => productionScale(c) === scale));
    if (pick) return pick;
  }
  return null;
}

function pickClosestScore(base, pool) {
  if (pool.length === 0) return null;
  const baseScore = Number(base.score);
  return [...pool].sort(
    (a, b) => Math.abs(Number(a.score) - baseScore) - Math.abs(Number(b.score) - baseScore)
  )[0];
}

function moodClimate(product) {
  return product.specs?.klimat ?? null;
}

// How much `candidate` has in common with `base` beyond mood - keeps the
// "A może..." pick close to base on everything else (mode, length,
// overlapping genres), so it reads as "the same kind of thing, just a
// different mood" rather than an arbitrary pick that happens to differ
// in climate.
function sharedAttributesScore(base, candidate) {
  let shared = 0;
  if (base.specs?.tryb && candidate.specs?.tryb === base.specs.tryb) shared += 1;
  if (base.specs?.dlugosc && candidate.specs?.dlugosc === base.specs.dlugosc) shared += 1;
  const baseGenres = new Set(base.specs?.gatunki ?? []);
  shared += (candidate.specs?.gatunki ?? []).filter((g) => baseGenres.has(g)).length;
  return shared;
}

// Whether `candidate` shares at least one gatunek with base - a hard filter
// for every slot (not just a tiebreak), since suggesting a different genre
// entirely (e.g. a fighting game as "Podobne" to an RPG) isn't an honest
// alternative no matter how close the score or production scale is. Lines
// without a `gatunki` spec don't restrict by it.
function sharesGenre(base, candidate) {
  const baseGenres = base.specs?.gatunki;
  if (!Array.isArray(baseGenres) || baseGenres.length === 0) return true;
  const candidateGenres = candidate.specs?.gatunki ?? [];
  return candidateGenres.some((g) => baseGenres.includes(g));
}

// Whether `candidate` has the same `perspektywa` (FPP/TPP/izometryczna/
// platformowka_2d/inna) as base - a hard filter alongside sharesGenre, for
// the same reason: suggesting e.g. a top-down strategy as "Podobne" to an
// FPP shooter isn't an honest alternative, the way they actually play is
// too different. Missing the field on either side (not yet backfilled)
// doesn't restrict - treated as matching any perspective.
function sharesPerspective(base, candidate) {
  const basePerspective = base.specs?.perspektywa;
  if (!basePerspective) return true;
  const candidatePerspective = candidate.specs?.perspektywa;
  if (!candidatePerspective) return true;
  return candidatePerspective === basePerspective;
}

// Whether `candidate` is actually playable on at least one of base's
// platforms - a mood-contrast suggestion the user can't run on their own
// platform isn't a usable alternative at all, so this is a hard filter,
// not just a scoring tiebreak. Lines without a `platformy` spec don't
// restrict by it.
function sharesPlatform(base, candidate) {
  const basePlatforms = base.specs?.platformy;
  if (!Array.isArray(basePlatforms) || basePlatforms.length === 0) return true;
  const candidatePlatforms = candidate.specs?.platformy ?? [];
  return candidatePlatforms.some((p) => basePlatforms.includes(p));
}

// Picks a candidate with the OPPOSITE climate/mood from base (mroczny <->
// lekki) that otherwise resembles it as closely as possible. Only applies
// to product lines that carry a `klimat` spec (currently: gry).
function pickMoodContrast(base, pool) {
  const baseMood = moodClimate(base);
  if (baseMood == null) return null;
  const opposite = pool.filter((c) => {
    const mood = moodClimate(c);
    return mood != null && mood !== baseMood && sharesPlatform(base, c);
  });
  if (opposite.length === 0) return null;
  const baseScore = Number(base.score);
  return [...opposite].sort((a, b) => {
    const sharedDiff = sharedAttributesScore(base, b) - sharedAttributesScore(base, a);
    if (sharedDiff !== 0) return sharedDiff;
    return Math.abs(Number(a.score) - baseScore) - Math.abs(Number(b.score) - baseScore);
  })[0];
}

function buildBetterReason(base, candidate, sameBrand) {
  const brandNote = sameBrand ? ", ta sama marka" : "";
  const dimension = pickWinningDimension(base, candidate);
  if (dimension) {
    return `Podobny tytuł, ale z ${dimension.label} (ocena ${candidate.score})${brandNote}`;
  }
  return sameBrand
    ? `Podobny poziom jakości, ta sama marka (ocena ${candidate.score})`
    : `Podobny poziom jakości (ocena ${candidate.score})`;
}

function buildMoodReason(candidate) {
  const moodLabel = candidate.specs.klimat === "lekki" ? "lżejszy, pogodniejszy klimat" : "mroczniejszy klimat";
  return `Podobny tytuł, ale ${moodLabel}`;
}

function buildProductionReason(base, candidate, sameBrand) {
  const studioNote = sameBrand ? "" : ` (${candidate.brand})`;
  return `Inna skala produkcji${studioNote}: ${candidate.specs.produkcja} zamiast ${base.specs.produkcja}`;
}

// Computes up to 3 outgoing alternative slots for `base` from `candidates`
// (already-published products in the same category, excluding base itself).
// Fills every slot it honestly can — same brand is an acceptable fallback,
// a fabricated claim is not.
export function computeAlternatives(base, candidates) {
  const results = [];
  const used = new Set();
  const available = () =>
    candidates.filter((c) => c.id !== base.id && !used.has(c.id) && sharesGenre(base, c) && sharesPerspective(base, c));
  const otherBrand = () => available().filter((c) => c.brand !== base.brand);

  let mood = pickMoodContrast(base, otherBrand());
  if (!mood) {
    mood = pickMoodContrast(base, available());
  }
  if (mood) {
    results.push({ angle: "inny_nastroj", alternativeId: mood.id, reason: buildMoodReason(mood) });
    used.add(mood.id);
  }

  let better = pickHigherScore(base, otherBrand());
  let betterSameBrand = false;
  if (!better) {
    better = pickHigherScore(base, available());
    betterSameBrand = true;
  }
  if (better) {
    results.push({
      angle: "wyzsza_jakosc",
      alternativeId: better.id,
      reason: buildBetterReason(base, better, betterSameBrand),
    });
    used.add(better.id);
  }

  let different = null;
  let reason = null;

  // Prefer a genuine production-scale contrast (AAA <-> indie) when the
  // category tracks it — a same-tier, closest-score pick tends to surface
  // something that barely differs from base, which defeats the point of
  // "Inaczej".
  if (productionScale(base) != null) {
    different = pickProductionContrast(base, otherBrand());
    let sameBrand = false;
    if (!different) {
      different = pickProductionContrast(base, available());
      sameBrand = true;
    }
    if (different) reason = buildProductionReason(base, different, sameBrand);
  }

  if (!different) {
    const wantRecognition = base.brand_recognition === "mainstream" ? "niche" : "mainstream";
    different = pickClosestScore(
      base,
      available().filter((c) => c.brand_recognition === wantRecognition && isSameTier(base, c))
    );
    reason = different
      ? wantRecognition === "niche"
        ? `Mniej znana w Polsce marka (${different.brand}), porównywalny poziom jakości`
        : `Bardziej rozpoznawalna marka (${different.brand}), porównywalny poziom jakości`
      : null;
    if (!different) {
      // Category only has one brand-recognition tier at this price point —
      // neutral fallback instead of pretending a recognition contrast that
      // doesn't exist. Still same-tier only: "porównywalny poziom jakości"
      // isn't true across price segments.
      different = pickClosestScore(base, otherBrand().filter((c) => isSameTier(base, c)));
      reason = different ? `Inna marka (${different.brand}), porównywalny poziom jakości` : null;
    }
  }
  if (different) {
    results.push({ angle: "niszowa_marka", alternativeId: different.id, reason });
  }

  return results;
}
