import { GoogleGenAI } from "@google/genai";
import { ALLOWED_BRANDS } from "./brands.js";

// gemini-3.6-flash's free tier is capped at 20 requests/DAY (confirmed live —
// see QuotaExceededError below). gemini-3.5-flash-lite gets a much more
// generous free daily quota (500/day, per a sibling project's own comment
// citing the same account type) for a task — structured JSON extraction
// with a self-reported confidence field, not open-ended reasoning — that
// doesn't need the full model's extra capability.
const MODEL = "gemini-3.5-flash-lite";

// Free tier is rate-limited to 15 requests/minute; stay comfortably under it.
export const GEMINI_CALL_DELAY_MS = 4200;

let client;
function getClient() {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    client = new GoogleGenAI({ apiKey });
  }
  return client;
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

// Rolling 3-year window (current year and the two before it) — computed at
// call time so this doesn't need a code change every January.
export function minAllowedReleaseYear() {
  return new Date().getFullYear() - 2;
}

const CATEGORY_SPEC_HINTS = {
  telefony:
    'Dla telefonu pole "specs" powinno zawierać m.in.: screen_size_inches (number), ' +
    "chipset (string), ram_gb (number), camera_main_mp (number), battery_mah (number).",
  telewizory:
    'Dla telewizora pole "specs" powinno zawierać m.in.: screen_size_inches (number), ' +
    "panel_type (string, np. OLED/QLED/LED), resolution (string, np. 4K/8K), " +
    "refresh_rate_hz (number), hdmi_2_1_ports (number).",
};

function buildEvaluationPrompt(category, productName) {
  const specHint = CATEGORY_SPEC_HINTS[category] ?? "";
  const brands = ALLOWED_BRANDS[category];
  const brandHint = brands
    ? `\nPole "brand" MUSI być jedną z dokładnie tych wartości (dopasuj pisownię 1:1): ${brands.join(", ")}. Jeśli "${productName}" nie pochodzi od żadnej z tych marek, ustaw "confidence": "niska".\n`
    : "";
  const minYear = minAllowedReleaseYear();

  return `Oceń produkt "${productName}" (kategoria: ${category}) pod kątem stosunku ceny do jakości, z perspektywy polskiego rynku i cen w PLN.

Zwróć WYŁĄCZNIE poprawny JSON (bez markdown, bez komentarzy) o dokładnie takim kształcie:
{
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

Interesują nas WYŁĄCZNIE modele wprowadzone na rynek od ${minYear} roku wzwyż — starsze generacje są poza zakresem tej bazy. Jeśli "${productName}" jest starszy niż ${minYear} rok, i tak podaj poprawny "release_year", ale ustaw "confidence": "niska".

Jeśli nie znasz tego produktu wystarczająco dobrze, żeby podać rzetelne dane (istnieje ryzyko pomyłki modelu, konfuzji z innym produktem, lub to nie jest realny/wydany produkt), ustaw "confidence": "niska" i NIE zgaduj szczegółów — w takim wypadku pola liczbowe i specs mogą być przybliżone, ale nie wymyślaj nieistniejących cech.`;
}

export async function evaluateProduct(category, productName) {
  const ai = getClient();
  const response = await withRetry(() =>
    ai.models.generateContent({
      model: MODEL,
      contents: buildEvaluationPrompt(category, productName),
      config: {
        responseMimeType: "application/json",
        temperature: 0.4,
      },
    })
  );

  return JSON.parse(response.text);
}

function buildSeedPrompt(category) {
  const label = category === "telewizory" ? "telewizorów" : "telefonów";
  const brands = ALLOWED_BRANDS[category];
  const brandRule = brands
    ? `Wybieraj WYŁĄCZNIE spośród tych marek: ${brands.join(", ")}. Nie proponuj żadnej innej marki, nawet jeśli jest realna — ma to być pula ograniczona do modeli faktycznie dostępnych w normalnej sprzedaży detalicznej w Polsce (RTV Euro AGD, Media Expert, x-kom, Media Markt, sklepy operatorów), nie import z AliExpress ani marki bez dystrybucji w Polsce.`
    : "Uwzględnij mix znanych i mniej znanych producentów.";

  const minYear = minAllowedReleaseYear();

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
  const ai = getClient();
  const response = await withRetry(() =>
    ai.models.generateContent({
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
