const { findCountry } = require("./countries");

// Validates the optional location picked on the Create Snap page.
// CHANGED: a location can now only be a COUNTRY. The country is looked up in
// our own list (by code, else by exact name) and saved under its proper name,
// so nothing else — a street, a city, free text — can be stored.
// -> { ok: true, value: null | {...} } | { ok: false }
function sanitizeLocation(raw) {
  if (raw === undefined || raw === null) {
    return { ok: true, value: null };
  }

  if (typeof raw !== "object") return { ok: false };

  const country = findCountry(raw.id ?? raw.placeId, raw.name);

  if (!country) return { ok: false };

  return {
    ok: true,
    value: {
      name: country.name,
      address: "",
      lat: null,
      lng: null,
      placeId: country.code,
    },
  };
}

module.exports = { sanitizeLocation };