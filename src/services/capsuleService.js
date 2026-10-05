const { db } = require("../config/firebase");
const { FieldValue } = require("firebase-admin/firestore");

// ------------------------------------------------------------
// Time-lock ("locker") helpers.
//
// A Time Capsule snap is stored with:
//   status: "locked"
//   unlockAt: Timestamp          (kept forever, shown in the UI)
//   pendingUnlockAt: Timestamp   (only exists while locked — it is what the
//                                 scheduler queries; deleted on publish)
//
// When unlockAt passes, the snap becomes public automatically:
//   1. isSnapLocked() already treats it as public the moment the time is
//      up, so nothing leaks late or early even between scheduler runs.
//   2. publishDueCapsules() flips status -> "published" every minute so
//      the rest of the app (liked / saved / published queries) sees it.
// ------------------------------------------------------------

const SCHEDULER_INTERVAL_MS = 60 * 1000;
const BATCH_SIZE = 400; // Firestore batches allow 500 writes

// Firestore Timestamp | Date | ISO string | {_seconds} -> Date | null
function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value._seconds === "number") {
    return new Date(value._seconds * 1000);
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toISO(value) {
  const date = toDate(value);

  return date ? date.toISOString() : null;
}

// True while a snap must stay hidden from everyone but its owner.
// A locked snap with a missing date fails closed (stays locked).
function isSnapLocked(snap, now = new Date()) {
  if (!snap || snap.status !== "locked") return false;

  const unlockAt = toDate(snap.unlockAt);

  return !unlockAt || unlockAt > now;
}

async function publishDueCapsules() {
  const now = new Date();
  let published = 0;

  // Single-field range query: no composite index needed, and it only
  // ever reads capsules that are actually due.
  for (;;) {
    const snapshot = await db
      .collection("snaps")
      .where("pendingUnlockAt", "<=", now)
      .limit(BATCH_SIZE)
      .get();

    if (snapshot.empty) break;

    const batch = db.batch();

    snapshot.docs.forEach((doc) => {
      // Hidden by an admin while still sealed: keep it hidden, but make sure
      // "unhide" restores it as published instead of locking it again.
      if (doc.data().status === "hidden") {
        batch.update(doc.ref, {
          hiddenPrevStatus: "published",
          publishedAt: now,
          pendingUnlockAt: FieldValue.delete(),
        });

        return;
      }

      batch.update(doc.ref, {
        status: "published",
        publishedAt: now,
        pendingUnlockAt: FieldValue.delete(),
      });
    });

    await batch.commit();

    published += snapshot.size;

    if (snapshot.size < BATCH_SIZE) break;
  }

  if (published > 0) {
    console.log(`Time Capsules unlocked: ${published}`);
  }

  return published;
}

function startCapsuleScheduler() {
  async function run() {
    try {
      await publishDueCapsules();
    } catch (error) {
      console.error("Capsule scheduler error:", error);
    }
  }

  run(); // catch up straight away after a restart

  const timer = setInterval(run, SCHEDULER_INTERVAL_MS);

  return timer;
}

module.exports = {
  toDate,
  toISO,
  isSnapLocked,
  publishDueCapsules,
  startCapsuleScheduler,
};