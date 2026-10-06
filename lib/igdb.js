// IGDB (igdb.com) read-only client — sources ground-truth "top games" lists
// (real critic/user ratings, real platform/genre/release-date data) for the
// `gry` category's seed generation, instead of asking Gemini to recall or
// search for a ranking from memory the way scripts/generate-seeds.js does
// for telefony/telewizory. IGDB runs on the Twitch API: a Client ID +
// Client Secret (a Twitch developer app) exchange for a short-lived app
// access token via client-credentials OAuth.

const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const API_BASE = "https://api.igdb.com/v4";

// Free tier: 4 requests/second. A small fixed delay between calls keeps
// this comfortably under that without needing a token-bucket.
export const IGDB_CALL_DELAY_MS = 300;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let cachedToken = null; // { token, expiresAt }

async function getToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  const clientId = process.env.IGDB_CLIENT_ID;
  const clientSecret = process.env.IGDB_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("IGDB_CLIENT_ID / IGDB_CLIENT_SECRET is not set");

  const url = `${TOKEN_URL}?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) throw new Error(`IGDB token request failed: ${res.status} ${await res.text()}`);
  const data = await res.json();

  cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

async function igdbQuery(endpoint, body) {
  const clientId = process.env.IGDB_CLIENT_ID;
  const token = await getToken();

  const res = await fetch(`${API_BASE}/${endpoint}`, {
    method: "POST",
    headers: {
      "Client-ID": clientId,
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/plain",
    },
    body,
  });

  if (!res.ok) throw new Error(`IGDB ${endpoint} query failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Our 5 wizard platform buckets -> IGDB platform ids, covering the hardware
// generations that fall inside the last ~10 years for each. Stable,
// well-known IGDB ids — re-verify against https://api.igdb.com/v4/platforms
// if coverage ever looks off (e.g. a future "Switch 2" id isn't included
// here yet).
export const PLATFORM_IGDB_IDS = {
  PC: [6], // PC (Microsoft Windows)
  PlayStation: [48, 167], // PlayStation 4, PlayStation 5
  Xbox: [49, 169], // Xbox One, Xbox Series X|S
  Nintendo: [41, 130], // Wii U, Switch
  Mobilne: [34, 39], // Android, iOS
};

function yearRangeUnix(year) {
  const start = Math.floor(Date.UTC(year, 0, 1) / 1000);
  const end = Math.floor(Date.UTC(year + 1, 0, 1) / 1000);
  return { start, end };
}

// Fetches the top `limit` games for one (platform bucket, year) cell,
// ranked by IGDB's combined critic+user rating — real signal instead of
// asking an LLM to recall or search for "the best games of <year>".
// `category = (0,8,9)` keeps main games, remakes and remasters, and drops
// DLC/expansions/mods/episodes (best-effort — IGDB's less common category
// values aren't filtered out explicitly, but none rank high enough on
// total_rating_count to matter in practice).
export async function fetchTopGames(platformBucket, year, limit = 100) {
  const platformIds = PLATFORM_IGDB_IDS[platformBucket];
  if (!platformIds) throw new Error(`Unknown platform bucket: ${platformBucket}`);
  const { start, end } = yearRangeUnix(year);

  const query = `
    fields name, platforms.name, genres.name, themes.name, game_modes.name, total_rating;
    where platforms = (${platformIds.join(",")})
      & first_release_date >= ${start} & first_release_date < ${end}
      & total_rating != null & total_rating_count >= 5
      & category = (0,8,9);
    sort total_rating desc;
    limit ${limit};
  `;

  const rows = await igdbQuery("games", query);
  return rows.map((row) => ({
    name: row.name,
    platforms: (row.platforms ?? []).map((p) => p.name),
    genres: (row.genres ?? []).map((g) => g.name),
    themes: (row.themes ?? []).map((t) => t.name),
    gameModes: (row.game_modes ?? []).map((m) => m.name),
    releaseYear: year,
    totalRating: row.total_rating,
  }));
}
