// The rename from SnapWall to The Locker must not lose the saved settings.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// A tiny in-memory stand-in for Firestore.
const store = new Map();
const db = {
  collection: (c) => ({
    doc: (id) => ({
      id,
      get: async () => ({
        exists: store.has(`${c}/${id}`),
        id,
        data: () => store.get(`${c}/${id}`),
      }),
      set: async (value) => void store.set(`${c}/${id}`, value),
    }),
  }),
};

const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = {
  id: firebasePath,
  filename: firebasePath,
  loaded: true,
  exports: { db },
};

const service = require(path.join("..", "src", "services", "settingsService"));

test("old settings/snapwall values are copied to settings/thelocker", async () => {
  store.clear();
  store.set("settings/snapwall", { spacePrice: 99, autoExpand: true });

  const settings = await service.getTheLockerSettings();

  assert.equal(settings.spacePrice, 99);
  assert.equal(settings.autoExpand, true);
  assert.equal(store.get("settings/thelocker").spacePrice, 99);
  assert.ok(store.has("settings/snapwall"), "old document is kept as a backup");
});

test("admin edits after the move go to the new document", async () => {
  await service.updateTheLockerSettings({ spacePrice: 150 });

  assert.equal(store.get("settings/thelocker").spacePrice, 150);
  assert.equal(store.get("settings/snapwall").spacePrice, 99);
});

test("no settings anywhere: nothing is invented", async () => {
  store.clear();

  assert.equal(await service.getTheLockerSettings(), null);
});
