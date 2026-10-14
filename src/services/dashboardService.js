const { db } = require("../config/firebase");
const { getSnapWallSettings } = require("./settingsService");
const { listExpansions } = require("./wallService");
const { listForAdmin } = require("./paymentService");

const DAY_MS = 24 * 60 * 60 * 1000;

async function countOf(query) {
  const snapshot = await query.count().get();

  return snapshot.data().count;
}

// Everything the admin Dashboard shows, in one round trip.
async function getDashboard() {
  const since7Days = new Date(Date.now() - 7 * DAY_MS);

  const [
    totalSpaces,
    occupiedSpaces,
    totalUsers,
    totalSnaps,
    hiddenSnaps,
    lockedCapsules,
    newSnaps7Days,
    pendingReports,
    payments,
    expansions,
    settings,
  ] = await Promise.all([
    countOf(db.collection("spaces")),
    countOf(db.collection("spaces").where("status", "==", "occupied")),
    countOf(db.collection("users")),
    countOf(db.collection("snaps")),
    countOf(db.collection("snaps").where("status", "==", "hidden")),
    countOf(db.collection("snaps").where("status", "==", "locked")),
    countOf(db.collection("snaps").where("createdAt", ">=", since7Days)),
    db.collection("reports").where("status", "==", "pending").select("snapId").get(),
    listForAdmin(5),
    listExpansions(),
    getSnapWallSettings(),
  ]);

  const snapsWithReports = new Set(
    pendingReports.docs.map((doc) => doc.data().snapId)
  );

  return {
    wall: {
      total: totalSpaces,
      occupied: occupiedSpaces,
      available: totalSpaces - occupiedSpaces,
      occupancyPercent: totalSpaces
        ? Math.round((occupiedSpaces / totalSpaces) * 1000) / 10
        : 0,
      autoExpand: settings?.autoExpand === true,
      expansionThreshold: settings?.expansionThreshold ?? 80,
      lastExpansion: expansions[0] || null,
    },
    users: { total: totalUsers },
    snaps: {
      total: totalSnaps,
      hidden: hiddenSnaps,
      lockedCapsules,
      newLast7Days: newSnaps7Days,
    },
    reports: {
      pendingReports: pendingReports.size,
      pendingSnaps: snapsWithReports.size,
    },
    payments: {
      summary: payments.summary,
      recent: payments.items,
    },
  };
}

module.exports = { getDashboard };