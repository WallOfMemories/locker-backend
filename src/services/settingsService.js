const { db } = require("../config/firebase");

const THELOCKER_SETTINGS_ID = "thelocker";

// The app used to be called SnapWall and kept its settings in settings/snapwall.
// If the new document does not exist yet but the old one does, the old values
// (space price, wall growth...) are copied across the first time they are read.
// Nothing is deleted: the old document is left as a backup.
const LEGACY_SETTINGS_ID = "snapwall";

async function loadSettingsRef() {
  const ref = db.collection("settings").doc(THELOCKER_SETTINGS_ID);
  const snapshot = await ref.get();

  if (snapshot.exists) return { ref, snapshot };

  const legacy = await db.collection("settings").doc(LEGACY_SETTINGS_ID).get();

  if (!legacy.exists) return { ref, snapshot };

  await ref.set(legacy.data());

  return { ref, snapshot: await ref.get() };
}

// CHANGED: added `autoExpand` (off by default). The wall only grows by
// itself once an admin switches it on from the Wall Size page.
const DEFAULT_SETTINGS = {
  // CHANGED: ₹2 -> ₹10. Only used the FIRST time the settings are created;
  // an existing settings/thelocker document keeps its saved spacePrice.
  spacePrice: 10,
  expansionThreshold: 80,
  expansionBatchSize: 50,
  autoExpand: false,
};

async function getTheLockerSettings() {
  const { snapshot: doc } = await loadSettingsRef();

  if (!doc.exists) {
    return null;
  }

  return {
    id: doc.id,
    ...doc.data(),
  };
}

async function createDefaultTheLockerSettings() {
  const { ref: settingsRef, snapshot: existing } = await loadSettingsRef();

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
      id: THELOCKER_SETTINGS_ID,
      ...DEFAULT_SETTINGS,
    },
  };
}

// NEW: admin edits. `updates` must already be validated (see
// adminController). Only the fields passed in are changed.
async function updateTheLockerSettings(updates) {
  const { ref: settingsRef, snapshot: existing } = await loadSettingsRef();

  const merged = {
    ...(existing.exists ? existing.data() : DEFAULT_SETTINGS),
    ...updates,
  };

  await settingsRef.set(merged);

  return {
    id: THELOCKER_SETTINGS_ID,
    ...merged,
  };
}

module.exports = {
  getTheLockerSettings,
  createDefaultTheLockerSettings,
  updateTheLockerSettings,
};