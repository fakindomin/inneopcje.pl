// One-off diagnostic for the "IGDB returns 0 games for every platform/year
// cell" issue - not part of the normal pipeline. Prints real IGDB platform
// ids (to cross-check lib/igdb.js's hand-written PLATFORM_IGDB_IDS) and a
// few probe queries with filters progressively added back, to isolate
// whether the platform id, the year window, or the rating/category filter
// is what's killing the result set.
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const API_BASE = "https://api.igdb.com/v4";

async function getToken() {
  const clientId = process.env.IGDB_CLIENT_ID;
  const clientSecret = process.env.IGDB_CLIENT_SECRET;
  const url = `${TOKEN_URL}?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`;
  const res = await fetch(url, { method: "POST" });
  const text = await res.text();
  console.log(`token request: status=${res.status} body=${text.slice(0, 300)}`);
  if (!res.ok) throw new Error("token request failed");
  return JSON.parse(text).access_token;
}

async function query(label, endpoint, body, token) {
  const res = await fetch(`${API_BASE}/${endpoint}`, {
    method: "POST",
    headers: {
      "Client-ID": process.env.IGDB_CLIENT_ID,
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/plain",
    },
    body,
  });
  const text = await res.text();
  console.log(`\n--- ${label} (status ${res.status}) ---`);
  console.log(`query: ${body.trim()}`);
  console.log(`response (first 2000 chars): ${text.slice(0, 2000)}`);
  return text;
}

const token = await getToken();

await query(
  "platform ids lookup",
  "platforms",
  `fields id,name,abbreviation; where name = "PC (Microsoft Windows)" | name = "PlayStation 5" | name = "PlayStation 4" | name = "Xbox Series X|S" | name = "Xbox One" | name = "Nintendo Switch" | name = "Wii U" | name = "Android" | name = "iOS"; limit 20;`,
  token
);

const start2023 = Math.floor(Date.UTC(2023, 0, 1) / 1000);
const end2023 = Math.floor(Date.UTC(2024, 0, 1) / 1000);

await query(
  "PC(id=6) + 2023, NO rating/category filter",
  "games",
  `fields name,total_rating,total_rating_count,category; where platforms = (6) & first_release_date >= ${start2023} & first_release_date < ${end2023}; sort total_rating desc; limit 10;`,
  token
);

await query(
  "PC(id=6) + 2023, WITH total_rating != null only",
  "games",
  `fields name,total_rating,total_rating_count,category; where platforms = (6) & first_release_date >= ${start2023} & first_release_date < ${end2023} & total_rating != null; sort total_rating desc; limit 10;`,
  token
);

await query(
  "PC(id=6) + 2023, WITH rating_count>=5 only (no category filter)",
  "games",
  `fields name,total_rating,total_rating_count,category; where platforms = (6) & first_release_date >= ${start2023} & first_release_date < ${end2023} & total_rating != null & total_rating_count >= 5; sort total_rating desc; limit 10;`,
  token
);

await query(
  "PC(id=6) + 2023, WITH full current filter (rating_count>=5 & category 0/8/9)",
  "games",
  `fields name,total_rating,total_rating_count,category; where platforms = (6) & first_release_date >= ${start2023} & first_release_date < ${end2023} & total_rating != null & total_rating_count >= 5 & category = (0,8,9); sort total_rating desc; limit 10;`,
  token
);
