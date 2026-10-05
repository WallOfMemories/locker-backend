const {
  searchPlaces,
  reversePlace,
} = require("../services/locationService");

// GET /api/locations/search?q=char[&lat=17.38&lng=78.48]
async function search(req, res) {
  const q = String(req.query.q || "").trim();

  if (q.length < 2) {
    return res.status(200).json({ success: true, places: [] });
  }

  // Optional: where the user is, so nearby places rank first.
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);

  const bias =
    req.query.lat !== undefined &&
    req.query.lng !== undefined &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
      ? { lat, lng }
      : null;

  try {
    const places = await searchPlaces(q, bias);

    return res.status(200).json({ success: true, places });
  } catch (error) {
    console.error("Location search error:", error);

    return res.status(502).json({
      success: false,
      message: "Location search is unavailable right now.",
    });
  }
}

// GET /api/locations/reverse?lat=17.36&lng=78.47
async function reverse(req, res) {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  ) {
    return res.status(400).json({
      success: false,
      message: "Valid lat and lng are required.",
    });
  }

  try {
    const place = await reversePlace(lat, lng);

    return res.status(200).json({ success: true, place });
  } catch (error) {
    console.error("Reverse location error:", error);

    return res.status(502).json({
      success: false,
      message: "Could not look up that location.",
    });
  }
}

module.exports = { search, reverse };