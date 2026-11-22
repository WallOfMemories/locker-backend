const { getStorage } = require("firebase-admin/storage");

const { db, firebaseApp } = require("../config/firebase");

// ------------------------------------------------------------
// NEW: removes Snap photos that were uploaded but never became a Snap.
//
// How they appear: the browser uploads the photo straight to Storage (after
// payment). If the person then closes the tab, or the Snap fails to save,
// the file stays in snaps/<uid>/ with nothing pointing at it. Storage rules
// also let any signed-in user upload there, so this job is what stops
// abandoned (or abusive) uploads from piling up and costing money.
//
// Safe by design:
//  - only looks inside "snaps/"
//  - only touches files OLDER than ORPHAN_MIN_AGE_HOURS (default 48), so a
//    person who is mid-way through posting is never affected
//  - a file is deleted only if NO Snap document uses it as its storagePath
//  - resumes where the last run stopped (cursor saved in Firestore), so the
//    whole bucket gets checked over a few days even if it is large
//  - dryRun=true only reports what it WOULD delete
// ------------------------------------------------------------

const CURSOR_DOC = ["settings", "orphanUploadCleanup"];
const PAGE_SIZE = 200; // files looked at per run
const CHECK_PARALLEL = 10; // Firestore lookups at the same time
const TIME_BUDGET_MS = 22000; // the Vercel function limit is 30 s

async function snapUsesFile(storagePath) {
  const snapshot = await db
    .collection("snaps")
    .where("storagePath", "==", storagePath)
    .limit(1)
    .get();

  return !snapshot.empty;
}

async function cleanupOrphanUploads({ dryRun = false } = {}) {
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;

  if (!bucketName) {
    return { skipped: "FIREBASE_STORAGE_BUCKET is not set" };
  }

  const minAgeHours = Number(process.env.ORPHAN_MIN_AGE_HOURS) || 48;
  const cutoff = Date.now() - minAgeHours * 60 * 60 * 1000;
  const startedAt = Date.now();

  const bucket = getStorage(firebaseApp).bucket(bucketName);
  const cursorRef = db.collection(CURSOR_DOC[0]).doc(CURSOR_DOC[1]);
  const cursorDoc = await cursorRef.get();
  const pageToken = cursorDoc.exists ? cursorDoc.data().pageToken || undefined : undefined;

  const [files, nextQuery] = await bucket.getFiles({
    prefix: "snaps/",
    maxResults: PAGE_SIZE,
    autoPaginate: false,
    ...(pageToken ? { pageToken } : {}),
  });

  const result = { checked: 0, tooNew: 0, inUse: 0, orphans: 0, deleted: 0, dryRun };

  for (let i = 0; i < files.length; i += CHECK_PARALLEL) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      // Out of time: leave the cursor where it was; the rest is picked up
      // on the next run (already-checked files are simply re-checked).
      result.stoppedEarly = true;
      break;
    }

    const chunk = files.slice(i, i + CHECK_PARALLEL);

    await Promise.all(
      chunk.map(async (file) => {
        result.checked += 1;

        const created = new Date(file.metadata?.timeCreated || 0).getTime();

        // Too new (or no date): never touch it.
        if (!created || created > cutoff) {
          result.tooNew += 1;
          return;
        }

        if (await snapUsesFile(file.name)) {
          result.inUse += 1;
          return;
        }

        result.orphans += 1;

        if (dryRun) return;

        try {
          await file.delete({ ignoreNotFound: true });
          result.deleted += 1;
        } catch (error) {
          console.error("Could not delete orphan upload:", file.name, error.message);
        }
      })
    );
  }

  // Remember where to continue; start over once the end is reached.
  if (!dryRun && !result.stoppedEarly) {
    await cursorRef.set(
      { pageToken: nextQuery?.pageToken || "", updatedAt: new Date() },
      { merge: true }
    );
  }

  return result;
}

module.exports = { cleanupOrphanUploads };