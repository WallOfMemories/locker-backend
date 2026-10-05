const { db } = require("../config/firebase");

const SNAPWALL_SETTINGS_ID = "snapwall";

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

  const settings = {
    spacePrice: 2,
    expansionThreshold: 80,
    expansionBatchSize: 50,
  };

  await settingsRef.set(settings);

  return {
    created: true,
    settings: {
      id: SNAPWALL_SETTINGS_ID,
      ...settings,
    },
  };
}

module.exports = {
  getSnapWallSettings,
  createDefaultSnapWallSettings,
};