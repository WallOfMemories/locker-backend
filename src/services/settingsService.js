const { db } = require("../config/firebase");

const SNAPWALL_SETTINGS_ID = "snapwall";

// CHANGED: added `autoExpand` (off by default). The wall only grows by
// itself once an admin switches it on from the Wall Size page.
const DEFAULT_SETTINGS = {
  spacePrice: 2,
  expansionThreshold: 80,
  expansionBatchSize: 50,
  autoExpand: false,
};

async function getSnapWallSettings() {
  const doc = await db
    .collection("settings")
    .doc(SNAPWALL_SETTINGS_ID)
    .get();

  if (!doc.exists) {
    return null;
  }

  return {
    id: doc.id,
    ...doc.data(),
  };
}

async function createDefaultSnapWallSettings() {
  const settingsRef = db
    .collection("settings")
    .doc(SNAPWALL_SETTINGS_ID);

  const existing = await settingsRef.get();

  if (existing.exists) {
    return {
      created: false,
      settings: {
        id: existing.id,
        ...existing.data(),
      },
    };
  }

  await settingsRef.set(DEFAULT_SETTINGS);

  return {
    created: true,
    settings: {
      id: SNAPWALL_SETTINGS_ID,
      ...DEFAULT_SETTINGS,
    },
  };
}

// NEW: admin edits. `updates` must already be validated (see
// adminController). Only the fields passed in are changed.
async function updateSnapWallSettings(updates) {
  const settingsRef = db
    .collection("settings")
    .doc(SNAPWALL_SETTINGS_ID);

  const existing = await settingsRef.get();

  const merged = {
    ...(existing.exists ? existing.data() : DEFAULT_SETTINGS),
    ...updates,
  };

  await settingsRef.set(merged);

  return {
    id: SNAPWALL_SETTINGS_ID,
    ...merged,
  };
}

module.exports = {
  getSnapWallSettings,
  createDefaultSnapWallSettings,
  updateSnapWallSettings,
};