import { GoogleGenAI } from "@google/genai";

const MODEL = "gemini-3.6-flash";

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
  "confidence": "wysoka" | "niska"
}

${specHint}

Jeśli nie znasz tego produktu wystarczająco dobrze, żeby podać rzetelne dane (istnieje ryzyko pomyłki modelu, konfuzji z innym produktem, lub to nie jest realny/wydany produkt), ustaw "confidence": "niska" i NIE zgaduj szczegółów — w takim wypadku pola liczbowe i specs mogą być przybliżone, ale nie wymyślaj nieistniejących cech.`;
}

export async function evaluateProduct(category, productName) {
  const ai = getClient();
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: buildEvaluationPrompt(category, productName),
    config: {
      responseMimeType: "application/json",
      temperature: 0.4,
    },
  });

  return JSON.parse(response.text);
}

function buildSeedPrompt(category) {
  const label = category === "telewizory" ? "telewizorów" : "telefonów";
  return `Wygeneruj listę 40 popularnych i zróżnicowanych ${label} dostępnych obecnie w Polsce.
Uwzględnij mix znanych i mniej znanych producentów oraz różne segmenty cenowe (budżetowy, średni, premium).
Każda pozycja to pełna, jednoznaczna nazwa modelu (marka + model), bez duplikatów.

Zwróć WYŁĄCZNIE poprawny JSON w postaci: { "products": string[] }`;
}

export async function generateSeedNames(category) {
  const ai = getClient();
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: buildSeedPrompt(category),
    config: {
      responseMimeType: "application/json",
      temperature: 0.9,
    },
  });

  const parsed = JSON.parse(response.text);
  if (!Array.isArray(parsed.products)) {
    throw new Error("generate-seeds: unexpected Gemini response shape");
  }
  return parsed.products.filter((name) => typeof name === "string" && name.trim().length > 0);
}
