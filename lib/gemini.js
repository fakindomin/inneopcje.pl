import { GoogleGenAI } from "@google/genai";
import { ALLOWED_BRANDS } from "./brands.js";

// gemini-3.6-flash's free tier is capped at 20 requests/DAY (confirmed live —
// see QuotaExceededError below). gemini-3.5-flash-lite gets a much more
// generous free daily quota (500/day, per a sibling project's own comment
// citing the same account type) for a task — structured JSON extraction
// with a self-reported confidence field, not open-ended reasoning — that
// doesn't need the full model's extra capability.
const MODEL = "gemini-3.5-flash-lite";

// Multiple of the user's own Gemini API keys (separate free-tier projects,
// same Google account) can be configured to multiply total daily/per-minute
// throughput — each key gets its own 500/day quota and 15 RPM cap. Checked
// in order, any gap in the numbering is fine (e.g. only _1 and _3 set).
const KEY_ENV_NAMES = [
  "GEMINI_API_KEY",
  "GEMINI_API_KEY_2",
  "GEMINI_API_KEY_3",
  "GEMINI_API_KEY_4",
  "GEMINI_API_KEY_5",
  "GEMINI_API_KEY_6",
];

let clients = null; // [{ envName, client }], lazily built from whichever KEY_ENV_NAMES are set
function getClients() {
  if (!clients) {
    clients = KEY_ENV_NAMES.filter((envName) => process.env[envName]).map((envName) => ({
      envName,
      client: new GoogleGenAI({ apiKey: process.env[envName] }),
    }));
    if (clients.length === 0) throw new Error("No GEMINI_API_KEY* is set");
  }
  return clients;
}

// Free tier is rate-limited to 15 requests/minute PER KEY; stay comfortably
// under it. Splitting calls round-robin across N configured keys means each
// individual key is only hit every Nth call, so the safe per-key spacing
// (4200ms at N=1) can be divided by N while every key still sees the same
// effective pacing — this is what actually lets more keys multiply
// throughput, not just daily quota.
export function geminiCallDelayMs() {
  return Math.ceil(4200 / getClients().length);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Gemini occasionally returns transient errors (model overloaded, rate limit)
// that go away on their own — retry those with backoff instead of failing
// the whole run over a blip. Anything else (bad request, model not found,
// auth) is rethrown immediately.
const RETRYABLE_CODES = new Set([429, 500, 503]);

// The free tier caps gemini-3.6-flash at 20 requests/DAY (confirmed from a
// live RESOURCE_EXHAUSTED response — GenerateRequestsPerDayPerProjectPerModel
// FreeTier quotaValue=20). That's a daily quota, not a rate limit: retrying
// within the same day can never succeed, so treat it as fatal-for-today
// instead of feeding it through the transient-error retry loop (which used
// to burn the whole 15-minute job timeout retrying a hopeless request once
// per remaining queue item).
export class QuotaExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

export function isQuotaError(err) {
  return err instanceof QuotaExceededError;
}

function isResourceExhausted(err) {
  return typeof err?.message === "string" && /RESOURCE_EXHAUSTED/i.test(err.message);
}

function extractErrorCode(err) {
  if (typeof err?.status === "number") return err.status;
  const match = typeof err?.message === "string" ? err.message.match(/"code"\s*:\s*(\d+)/) : null;
  return match ? Number(match[1]) : null;
}

async function withRetry(fn, { retries = 3, baseDelayMs = 5000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isResourceExhausted(err)) throw new QuotaExceededError(err.message);
      const retryable = RETRYABLE_CODES.has(extractErrorCode(err));
      if (!retryable || attempt >= retries) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      console.warn(`gemini: transient error, retrying in ${delay}ms (attempt ${attempt + 1}/${retries}): ${err.message}`);
      await sleep(delay);
    }
  }
}

// Keys that have hit RESOURCE_EXHAUSTED (daily quota) during this process —
// skipped for the rest of this run rather than retried (a day's quota
// doesn't come back until tomorrow). Reset naturally on the next run (fresh
// process each time build.js is invoked).
let rotationIndex = 0;
const exhaustedEnvNames = new Set();

// Runs `buildRequest(client)` against one configured key, rotating to the
// next un-exhausted key on RESOURCE_EXHAUSTED instead of failing the whole
// call — only once every configured key is exhausted does this throw
// QuotaExceededError (the signal build.js treats as "stop, nothing left for
// today").
async function callWithKeyRotation(buildRequest) {
  for (;;) {
    const usable = getClients().filter((c) => !exhaustedEnvNames.has(c.envName));
    if (usable.length === 0) {
      throw new QuotaExceededError("all configured GEMINI_API_KEY* are exhausted for today");
    }

    const current = usable[rotationIndex % usable.length];
    rotationIndex++;

    try {
      return await withRetry(() => buildRequest(current.client));
    } catch (err) {
      if (isQuotaError(err)) {
        console.warn(
          `gemini: ${current.envName} hit its daily quota, rotating it out for the rest of this run (${usable.length - 1} key(s) left)`
        );
        exhaustedEnvNames.add(current.envName);
        continue;
      }
      throw err;
    }
  }
}

// How many years back from the current year count as "in scope" for a
// category, keyed by category slug. telefony/telewizory models churn fast
// and only the current generation matters commercially; gry's catalog
// needs real depth (ankieta/wizard coverage), so it gets a 10-year window
// instead of the 3-year one that fits phones/TVs. Computed at call time so
// this doesn't need a code change every January.
const CATEGORY_YEARS_BACK = { gry: 9 };
const DEFAULT_YEARS_BACK = 2;

export function minAllowedReleaseYear(category) {
  const yearsBack = CATEGORY_YEARS_BACK[category] ?? DEFAULT_YEARS_BACK;
  return new Date().getFullYear() - yearsBack;
}

const CATEGORY_SPEC_HINTS = {
  telefony:
    'Dla telefonu pole "specs" powinno zawierać m.in.: screen_size_inches (number), ' +
    "chipset (string), ram_gb (number), camera_main_mp (number), battery_mah (number).",
  telewizory:
    'Dla telewizora pole "specs" powinno zawierać m.in.: screen_size_inches (number), ' +
    "panel_type (string, np. OLED/QLED/LED), resolution (string, np. 4K/8K), " +
    "refresh_rate_hz (number), hdmi_2_1_ports (number).",
  // Shape and exact enum values must match inneopcje-admin's
  // lib/wizardTreeGry.js (the ankieta's question options) and
  // lib/matching.js ("Inaczej"'s produkcja/klimat contrast logic) 1:1 —
  // a value outside these lists just never matches any wizard filter,
  // silently degrading coverage instead of erroring loudly.
  gry:
    'Dla gry pole "specs" MUSI zawierać DOKŁADNIE te pola, z wartościami WYŁĄCZNIE z podanych list (nie wymyślaj innych wartości):\n' +
    '- platformy: string[], niepusta, podzbiór {"PC","Xbox","PlayStation","Nintendo","Mobilne"} ("Mobilne" = Android/iOS)\n' +
    '- tryb: dokładnie jedno z "solo" | "multiplayer" | "oba"\n' +
    '- gatunki: string[], niepusta, podzbiór {"RPG","Akcja","Strzelanka","Strategia","Sportowa","Przygodowa","Horror"}\n' +
    '- produkcja: dokładnie jedno z "AAA" | "AA" | "indie" (budżet/skala produkcji)\n' +
    '- dlugosc: dokładnie jedno z "krotka" (do 10h) | "srednia" (10-30h) | "dluga" (30h+)\n' +
    "- fabula_score: number, 1-5 (jak istotna/dopracowana jest fabuła)\n" +
    "- grafika_score: number, 1-5 (jakość oprawy wizualnej)\n" +
    "- release_month: number, 1-12 (miesiąc premiery)\n" +
    "- wybor_trudnosci: boolean (czy gra oferuje wybór poziomu trudności)\n" +
    '- klimat: dokładnie jedno z "mroczny" | "lekki"\n' +
    '- open_world: dokładnie jedno z "otwarty" | "liniowy"\n' +
    'Pole "price_pln_approx" (wymagane u wszystkich kategorii) to przybliżona aktualna cena w PLN.',
};

function buildFactsBlock(facts) {
  if (!facts) return "";
  const rating = facts.totalRating != null ? Math.round(facts.totalRating) : null;
  return `
Potwierdzone fakty o tym tytule (źródło: IGDB) — wykorzystaj je zamiast zgadywać/szukać w pamięci, przełóż na wymagany kształt "specs" powyżej (np. gatunki IGDB -> najbliższa znaczeniowo z dozwolonej listy, tematy pomagają ocenić "klimat", tryby gry pomagają ocenić "tryb"):
- Platformy (IGDB): ${facts.platforms?.join(", ") || "brak danych"}
- Gatunki (IGDB): ${facts.genres?.join(", ") || "brak danych"}
- Tematy (IGDB): ${facts.themes?.join(", ") || "brak danych"}
- Tryby gry (IGDB): ${facts.gameModes?.join(", ") || "brak danych"}
- Rok premiery: ${facts.releaseYear}
- Ocena łączna (IGDB, skala 0-100, krytycy+użytkownicy): ${rating ?? "brak danych"}
`;
}

// One request evaluates up to BATCH_EVAL_SIZE candidates at once instead of
// one request per candidate — the free tier's binding constraint is
// requests/day (and RPM), not the (very large) context window, so batching
// turns "500 requests/day" into "500 x BATCH_EVAL_SIZE evaluations/day" per
// key. Each candidate is still scored independently; a bad/unknown one just
// gets "confidence": "niska" for that one entry, same as the single-item
// prompt, and build.js validates each returned item on its own, so one
// malformed entry doesn't invalidate the rest of the batch.
export const BATCH_EVAL_SIZE = 20;

function buildBatchEvaluationPrompt(category, items) {
  const specHint = CATEGORY_SPEC_HINTS[category] ?? "";
  const brands = ALLOWED_BRANDS[category];
  const brandHint = brands
    ? `\nPole "brand" MUSI być jedną z dokładnie tych wartości (dopasuj pisownię 1:1): ${brands.join(", ")}. Jeśli dany tytuł nie pochodzi od żadnej z tych marek, ustaw dla NIEGO "confidence": "niska".\n`
    : "";
  const minYear = minAllowedReleaseYear(category);

  const itemsBlock = items
    .map((item, i) => {
      const factsBlock = buildFactsBlock(item.facts);
      return `### Tytuł ${i + 1}: "${item.productName}"${factsBlock}`;
    })
    .join("\n\n");

  return `Oceń KAŻDY z poniższych ${items.length} produktów (kategoria: ${category}) pod kątem stosunku ceny do jakości, z perspektywy polskiego rynku i cen w PLN. Każdy tytuł oceniasz NIEZALEŻNIE od pozostałych — błąd/niepewność co do jednego nie wpływa na ocenę innych.

${itemsBlock}

Zwróć WYŁĄCZNIE poprawny JSON (bez markdown, bez komentarzy): tablicę o DOKŁADNIE ${items.length} elementach, po jednym na każdy tytuł powyżej, w tej samej kolejności, każdy o dokładnie takim kształcie:
{
  "name": string (DOKŁADNIE taka sama nazwa jak w nagłówku "Tytuł N" powyżej, bez żadnych zmian — służy do dopasowania wyniku z powrotem do tytułu),
  "verdict": string (krótkie, jednozdaniowe podsumowanie werdyktu),
  "score": number (1-10, jedno miejsce po przecinku),
  "summary": string (2-3 zdania uzasadnienia),
  "pros": string[] (2-4 pozycje),
  "cons": string[] (2-4 pozycje),
  "specs": object (klucz-wartość ze specyfikacją techniczną, ZAWSZE zawiera "price_pln_approx" jako string z przybliżoną ceną lub zakresem cen w PLN, np. "2500-2800"),
  "brand": string (nazwa producenta),
  "brand_recognition": "mainstream" | "niche" (czy marka jest szeroko rozpoznawalna w Polsce),
  "price_tier": "budzetowy" | "sredni" | "premium",
  "release_year": number (rok premiery/wprowadzenia tego konkretnego modelu na rynek),
  "confidence": "wysoka" | "niska"
}
${brandHint}
${specHint}

Interesują nas WYŁĄCZNIE modele wprowadzone na rynek od ${minYear} roku wzwyż — starsze generacje są poza zakresem tej bazy. Jeśli dany tytuł jest starszy niż ${minYear} rok, i tak podaj poprawny "release_year" dla NIEGO, ale ustaw dla NIEGO "confidence": "niska".

Jeśli nie znasz któregoś produktu wystarczająco dobrze, żeby podać rzetelne dane (ryzyko pomyłki modelu, konfuzji z innym produktem, lub to nie jest realny/wydany produkt), ustaw dla NIEGO "confidence": "niska" i NIE zgaduj szczegółów dla NIEGO — pozostałe tytuły w tej samej odpowiedzi oceń normalnie.`;
}

// Evaluates up to BATCH_EVAL_SIZE candidates in one Gemini call. `items` is
// `[{ productName, facts }]`; returns the parsed JSON array as-is (one
// object per item, matched back to its `product_name` by build.js via the
// `name` field) — validation per item happens in build.js, not here.
export async function evaluateProductsBatch(category, items) {
  const response = await callWithKeyRotation((client) =>
    client.models.generateContent({
      model: MODEL,
      contents: buildBatchEvaluationPrompt(category, items),
      config: {
        responseMimeType: "application/json",
        temperature: 0.4,
      },
    })
  );

  const parsed = JSON.parse(response.text);
  if (!Array.isArray(parsed)) throw new Error("batch evaluation response is not a JSON array");
  return parsed;
}

function buildSeedPrompt(category) {
  const label = category === "telewizory" ? "telewizorów" : "telefonów";
  const brands = ALLOWED_BRANDS[category];
  const brandRule = brands
    ? `Wybieraj WYŁĄCZNIE spośród tych marek: ${brands.join(", ")}. Nie proponuj żadnej innej marki, nawet jeśli jest realna — ma to być pula ograniczona do modeli faktycznie dostępnych w normalnej sprzedaży detalicznej w Polsce (RTV Euro AGD, Media Expert, x-kom, Media Markt, sklepy operatorów), nie import z AliExpress ani marki bez dystrybucji w Polsce.`
    : "Uwzględnij mix znanych i mniej znanych producentów.";

  const minYear = minAllowedReleaseYear(category);

  return `Wyszukaj w internecie i wygeneruj listę 40 aktualnie sprzedawanych ${label}, dostępnych obecnie w normalnej sprzedaży detalicznej w Polsce.
${brandRule}
TWARDY WYMÓG: wyłącznie modele wprowadzone na rynek w roku ${minYear} lub później (ostatnie 3 lata). Nie proponuj starszych generacji, nawet jeśli nadal są w sprzedaży — nie interesują nas. Zweryfikuj rok premiery przez wyszukiwarkę, nie zgaduj z pamięci.
Uwzględnij różne segmenty cenowe (budżetowy, średni, premium) w ramach dozwolonych marek.
Każda pozycja to pełna, jednoznaczna nazwa modelu (marka + model), bez duplikatów.

Zwróć WYŁĄCZNIE listę nazw modeli, dokładnie jedna nazwa na linię, bez numeracji, bez wypunktowania, bez żadnego innego tekstu przed ani po liście.`;
}

// Uses Google Search grounding so the model checks what's actually on sale
// right now instead of relying only on its training data (which has a
// knowledge cutoff and was defaulting to years-old model numbers — e.g.
// Samsung OLED TVs stuck on the 2023 "S90C" generation). Grounding + forced
// JSON output don't reliably combine in one call, so this asks for a plain
// newline list instead of JSON.
export async function generateSeedNames(category) {
  const response = await callWithKeyRotation((client) =>
    client.models.generateContent({
      model: MODEL,
      contents: buildSeedPrompt(category),
      config: {
        tools: [{ googleSearch: {} }],
        temperature: 0.9,
      },
    })
  );

  const text = response.text ?? "";
  return text
    .split("\n")
    .map((line) => line.replace(/^[\s\-*•\d.)]+/, "").trim())
    .filter((name) => name.length > 0 && name.length < 100);
}
