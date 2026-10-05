// ------------------------------------------------------------
// Place search for the Create Snap "Add location" picker
// (Instagram-style: search a place, or use current location).
//
// CHANGED: results were poor because Nominatim is a *geocoder* (it wants
// full words, has no search-as-you-type and ignores where the user is).
// Search now tries providers in this order and uses the first one that
// returns places:
//
//   1. Google Places  — best business / cafe / shop coverage
//                       (only if GOOGLE_PLACES_API_KEY is set in .env)
//   2. Photon         — free, built for search-as-you-type, understands
//                       partial words ("char" -> Charminar) and ranks
//                       places NEAR THE USER first
//   3. Nominatim      — last-resort fallback
//
// Every provider is mapped to the same { id, name, address, lat, lng }
// shape, so the rest of the app doesn't care which one answered.
// ------------------------------------------------------------

const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY || "";

const PHOTON_URL = process.env.PHOTON_URL || "https://photon.komoot.io";

const NOMINATIM_URL =
  process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org";

const USER_AGENT =
  process.env.NOMINATIM_USER_AGENT ||
  "SnapWall/1.0 (set NOMINATIM_USER_AGENT in .env)";

// Optional: where to rank results when the browser doesn't send the
// user's position (e.g. set to your main city so local places win).
const DEFAULT_BIAS =
  Number.isFinite(Number(process.env.DEFAULT_BIAS_LAT)) &&
  Number.isFinite(Number(process.env.DEFAULT_BIAS_LNG)) &&
  process.env.DEFAULT_BIAS_LAT !== undefined &&
  process.env.DEFAULT_BIAS_LAT !== ""
    ? {
        lat: Number(process.env.DEFAULT_BIAS_LAT),
        lng: Number(process.env.DEFAULT_BIAS_LNG),
      }
    : null;

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;
const NOMINATIM_GAP_MS = 1100; // Nominatim: max 1 request / second
const TIMEOUT_MS = 8000;

// ---------------- cache ----------------
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);

  if (!hit) return undefined;

  if (hit.expires < Date.now()) {
    cache.delete(key);
    return undefined;
  }

  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) {
    cache.delete(cache.keys().next().value); // drop the oldest
  }

  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

// ---------------- http ----------------
async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en",
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Location provider responded ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// Nominatim only: one request at a time, >= 1.1s apart.
let nominatimQueue = Promise.resolve();

function nominatimThrottled(task) {
  const run = nominatimQueue.then(task);

  nominatimQueue = run
    .catch(() => {})
    .then(() => new Promise((r) => setTimeout(r, NOMINATIM_GAP_MS)));

  return run;
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

function validCoords(place) {
  return Number.isFinite(place.lat) && Number.isFinite(place.lng);
}

// ---------------- Google Places (Text Search, new API) ----------------
async function googleSearch(q, bias) {
  const body = {
    textQuery: q,
    maxResultCount: 8,
    languageCode: "en",
  };

  if (bias) {
    body.locationBias = {
      circle: {
        center: { latitude: bias.lat, longitude: bias.lng },
        radius: 30000, // 30 km
      },
    };
  }

  const data = await request(
    "https://places.googleapis.com/v1/places:searchText",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_KEY,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.location",
      },
      body: JSON.stringify(body),
    }
  );

  return (data.places || []).map((place) => ({
    id: `g${place.id}`,
    name: place.displayName?.text || "Unknown place",
    address: place.formattedAddress || "",
    lat: Number(place.location?.latitude),
    lng: Number(place.location?.longitude),
  }));
}

// ---------------- Photon (OpenStreetMap, search-as-you-type) ----------------
function mapPhoton(feature) {
  const p = feature.properties || {};
  const [lng, lat] = feature.geometry?.coordinates || [];

  const street = [p.housenumber, p.street].filter(Boolean).join(" ");

  const name = p.name || street || p.district || p.city || "Unknown place";

  const address = unique([
    street !== name ? street : "",
    p.district !== name ? p.district : "",
    p.city !== name ? p.city : "",
    p.state !== name ? p.state : "",
    p.country,
  ]).join(", ");

  return {
    id: `p${p.osm_type || ""}${p.osm_id}`,
    name,
    address,
    lat: Number(lat),
    lng: Number(lng),
  };
}

async function photonSearch(q, bias) {
  const params = new URLSearchParams({ q, limit: "8", lang: "en" });

  if (bias) {
    params.set("lat", String(bias.lat));
    params.set("lon", String(bias.lng));
    params.set("location_bias_scale", "0.4"); // nearby places rank higher
  }

  const data = await request(`${PHOTON_URL}/api/?${params}`);

  return (data.features || []).map(mapPhoton);
}

async function photonReverse(lat, lng) {
  const data = await request(
    `${PHOTON_URL}/reverse?lat=${lat}&lon=${lng}&lang=en&limit=1`
  );

  const feature = data.features?.[0];

  return feature ? { ...mapPhoton(feature), lat, lng } : null;
}

// ---------------- Nominatim (fallback) ----------------
function mapNominatim(item) {
  const parts = String(item.display_name || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  const addr = item.address || {};

  const name =
    item.name ||
    [addr.house_number, addr.road].filter(Boolean).join(" ") ||
    addr.suburb ||
    addr.city ||
    addr.town ||
    addr.village ||
    parts[0] ||
    "Unknown place";

  const address =
    parts[0] === name ? parts.slice(1).join(", ") : parts.join(", ");

  return {
    id: `n${item.osm_type || "place"}${item.osm_id || item.place_id}`,
    name,
    address,
    lat: Number(item.lat),
    lng: Number(item.lon),
  };
}

async function nominatimSearch(q, bias) {
  let path = `/search?format=jsonv2&addressdetails=1&limit=8&q=${encodeURIComponent(
    q
  )}`;

  if (bias) {
    // soft preference (bounded=0): ~±1° box around the user
    const d = 1;

    path += `&viewbox=${bias.lng - d},${bias.lat + d},${bias.lng + d},${
      bias.lat - d
    }`;
  }

  const data = await nominatimThrottled(() =>
    request(`${NOMINATIM_URL}${path}`)
  );

  return (Array.isArray(data) ? data : []).map(mapNominatim);
}

async function nominatimReverse(lat, lng) {
  const data = await nominatimThrottled(() =>
    request(
      `${NOMINATIM_URL}/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=${lat}&lon=${lng}`
    )
  );

  if (!data || data.error) return null;

  return { ...mapNominatim(data), lat, lng };
}

// ---------------- public API ----------------
async function searchPlaces(rawQuery, rawBias) {
  const q = String(rawQuery || "").trim().slice(0, 100);

  if (q.length < 2) return [];

  const bias =
    rawBias &&
    Number.isFinite(rawBias.lat) &&
    Number.isFinite(rawBias.lng)
      ? rawBias
      : DEFAULT_BIAS;

  // ~11 km buckets so people in the same area share cached results
  const key = `s:${q.toLowerCase()}:${
    bias ? `${bias.lat.toFixed(1)},${bias.lng.toFixed(1)}` : "-"
  }`;

  const cached = cacheGet(key);

  if (cached) return cached;

  const providers = [
    GOOGLE_KEY && googleSearch,
    photonSearch,
    nominatimSearch,
  ].filter(Boolean);

  let places = [];
  let lastError = null;

  for (const provider of providers) {
    try {
      places = (await provider(q, bias)).filter(validCoords);

      if (places.length > 0) break;
    } catch (error) {
      lastError = error;
      console.warn(`Location provider "${provider.name}" failed:`, error.message);
    }
  }

  // Every provider failed (vs. "found nothing") -> let the caller say so.
  if (places.length === 0 && lastError) throw lastError;

  // drop duplicates (same name + address)
  const seen = new Set();

  places = places.filter((place) => {
    const id = `${place.name}|${place.address}`.toLowerCase();

    if (seen.has(id)) return false;

    seen.add(id);

    return true;
  });

  cacheSet(key, places);

  return places;
}

async function reversePlace(lat, lng) {
  const key = `r:${lat.toFixed(4)},${lng.toFixed(4)}`;
  const cached = cacheGet(key);

  if (cached !== undefined) return cached;

  let place = null;

  for (const provider of [photonReverse, nominatimReverse]) {
    try {
      place = await provider(lat, lng);

      if (place) break;
    } catch (error) {
      console.warn(`Reverse provider "${provider.name}" failed:`, error.message);
    }
  }

  cacheSet(key, place);

  return place;
}

module.exports = { searchPlaces, reversePlace };