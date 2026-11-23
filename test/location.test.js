const test = require("node:test");
const assert = require("node:assert/strict");

const { sanitizeLocation } = require("../src/utils/location");

// A Snap's location can only be a country.

test("no location is fine", () => {
  assert.deepEqual(sanitizeLocation(undefined), { ok: true, value: null });
  assert.deepEqual(sanitizeLocation(null), { ok: true, value: null });
});

test("a country is accepted and saved under its proper name, with no coordinates or address", () => {
  const result = sanitizeLocation({
    id: "in",
    name: "whatever the browser sent",
    address: "12 Some Street",
    lat: 17.4,
    lng: 78.4,
  });

  assert.deepEqual(result, {
    ok: true,
    value: { name: "India", address: "", lat: null, lng: null, placeId: "IN" },
  });
});

test("a country can be matched by its exact name too", () => {
  assert.equal(sanitizeLocation({ name: "japan" }).value.name, "Japan");
});

test("cities, streets and free text are refused", () => {
  assert.equal(sanitizeLocation({ id: "123456", name: "Charminar, Hyderabad", lat: 17.36, lng: 78.47 }).ok, false);
  assert.equal(sanitizeLocation({ name: "Hyderabad" }).ok, false);
  assert.equal(sanitizeLocation({ name: "" }).ok, false);
  assert.equal(sanitizeLocation({}).ok, false);
  assert.equal(sanitizeLocation("India").ok, false);
});