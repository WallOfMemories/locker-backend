const { db, firebaseApp } = require("../config/firebase");
const { FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { isSnapLocked, toISO } = require("./capsuleService");

// ------------------------------------------------------------
// Reports + moderation
//
// reports/{snapId}_{reporterUid}
//   snapId, spaceId, snapOwnerId, reportedBy, reason,
//   status: "pending" | "resolved",
//   createdAt,
//   (when resolved) action, resolvedAt, resolvedBy, snapCaption
//
// The doc id makes "one report per person per Snap" automatic.
//
// Admin actions on a Snap:
//   hide   -> snap.status = "hidden"  (space stays taken, photo disappears
//             from the wall; the owner can still see it in their profile)
//   unhide -> snap goes back to what it was before (published / locked)
//   safe   -> reports dismissed, Snap untouched
//   delete -> Snap removed, its space becomes available again
// Every action also closes ALL pending reports on that Snap.
// ------------------------------------------------------------

const REPORT_REASONS = [
  "inappropriate",
  "spam",
  "harassment",
  "copyright",
  "other",
];

const ADMIN_ACTIONS = ["hide", "unhide", "safe", "delete"];

const RESOLVED_LABEL = {
  hide: "hidden",
  safe: "safe",
  delete: "deleted",
};

const BATCH_SIZE = 400;
const HISTORY_LIMIT = 50;

class ModerationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- helpers ----------

async function getDocsById(collectionName, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const byId = {};

  for (let i = 0; i < unique.length; i += 100) {
    const refs = unique
      .slice(i, i + 100)
      .map((id) => db.collection(collectionName).doc(id));

    const docs = await db.getAll(...refs);

    docs.forEach((doc) => {
      if (doc.exists) byId[doc.id] = doc.data();
    });
  }

  return byId;
}

function ownerView(userId, users) {
  const user = users[userId] || {};

  return {
    uid: userId || "",
    username: user.username || "",
    displayName: user.displayName || "",
  };
}

function snapView(id, snap, users) {
  return {
    snapId: id,
    spaceId: snap.spaceId || "",
    imageUrl: snap.imageUrl || "",
    caption: snap.caption || "",
    type: snap.type || "post",
    status: snap.status || "",
    owner: ownerView(snap.userId, users),
    createdAt: toISO(snap.createdAt),
    hiddenAt: toISO(snap.hiddenAt),
    // Time Capsules: the admin always sees the real photo, even while the
    // capsule is still sealed for everyone else.
    sealed: isSnapLocked(snap),
    unlockAt: toISO(snap.unlockAt),
  };
}

async function resolvePendingReports(snapId, action, adminId, snap) {
  const pending = await db
    .collection("reports")
    .where("snapId", "==", snapId)
    .where("status", "==", "pending")
    .get();

  for (let i = 0; i < pending.docs.length; i += BATCH_SIZE) {
    const batch = db.batch();

    pending.docs.slice(i, i + BATCH_SIZE).forEach((doc) => {
      batch.update(doc.ref, {
        status: "resolved",
        action: RESOLVED_LABEL[action],
        resolvedAt: new Date(),
        resolvedBy: adminId,
        snapCaption: snap.caption || "",
      });
    });

    await batch.commit();
  }

  return pending.size;
}

// Best effort: removes the photo file too. Needs FIREBASE_STORAGE_BUCKET
// in the backend .env — without it the file is simply left in Storage.
async function deleteSnapFile(storagePath) {
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;

  if (!bucketName || !storagePath) return;

  try {
    await getStorage(firebaseApp)
      .bucket(bucketName)
      .file(storagePath)
      .delete({ ignoreNotFound: true });
  } catch (error) {
    console.error("Could not delete Snap image from Storage:", error);
  }
}

// ---------- user: report a Snap ----------

async function reportSnap(snapId, reporterId, rawReason) {
  const snapDoc = await db.collection("snaps").doc(snapId).get();

  if (!snapDoc.exists) {
    throw new ModerationError(404, "Snap not found");
  }

  const snap = snapDoc.data();

  if (snap.userId === reporterId) {
    throw new ModerationError(400, "You can't report your own Snap.");
  }

  if (snap.status === "hidden") {
    throw new ModerationError(
      409,
      "This Snap is already hidden by our moderators."
    );
  }

  const reason = REPORT_REASONS.includes(rawReason) ? rawReason : "other";

  try {
    // create() fails if the doc exists -> one report per person per Snap.
    await db
      .collection("reports")
      .doc(`${snapId}_${reporterId}`)
      .create({
        snapId,
        spaceId: snap.spaceId || "",
        snapOwnerId: snap.userId || "",
        reportedBy: reporterId,
        reason,
        status: "pending",
        createdAt: new Date(),
      });
  } catch (error) {
    if (error.code === 6 || /ALREADY_EXISTS/i.test(error.message || "")) {
      throw new ModerationError(409, "You have already reported this Snap.");
    }

    throw error;
  }
}

// ---------- admin: lists ----------

async function listPending() {
  const snapshot = await db
    .collection("reports")
    .where("status", "==", "pending")
    .get();

  const groups = {};

  snapshot.docs.forEach((doc) => {
    const report = doc.data();
    const group =
      groups[report.snapId] ||
      (groups[report.snapId] = {
        count: 0,
        reasons: {},
        firstAt: null,
        latestAt: null,
      });

    const at = report.createdAt?.toDate?.() || new Date(0);

    group.count += 1;
    group.reasons[report.reason] = (group.reasons[report.reason] || 0) + 1;
    if (!group.firstAt || at < group.firstAt) group.firstAt = at;
    if (!group.latestAt || at > group.latestAt) group.latestAt = at;
  });

  const snapIds = Object.keys(groups);
  const snaps = await getDocsById("snaps", snapIds);
  const users = await getDocsById(
    "users",
    Object.values(snaps).map((snap) => snap.userId)
  );

  return snapIds
    .filter((id) => snaps[id]) // snap no longer exists
    .map((id) => ({
      ...snapView(id, snaps[id], users),
      reportCount: groups[id].count,
      reasons: groups[id].reasons,
      firstReportedAt: groups[id].firstAt.toISOString(),
      latestReportedAt: groups[id].latestAt.toISOString(),
    }))
    .sort(
      (a, b) =>
        b.reportCount - a.reportCount ||
        new Date(b.latestReportedAt) - new Date(a.latestReportedAt)
    );
}

async function listHidden() {
  const snapshot = await db
    .collection("snaps")
    .where("status", "==", "hidden")
    .get();

  const snaps = {};
  snapshot.docs.forEach((doc) => {
    snaps[doc.id] = doc.data();
  });

  const users = await getDocsById(
    "users",
    Object.values(snaps).map((snap) => snap.userId)
  );

  return Object.keys(snaps)
    .map((id) => snapView(id, snaps[id], users))
    .sort((a, b) => new Date(b.hiddenAt || 0) - new Date(a.hiddenAt || 0));
}

async function listHistory() {
  const snapshot = await db
    .collection("reports")
    .where("status", "==", "resolved")
    .get();

  return snapshot.docs
    .map((doc) => {
      const report = doc.data();

      return {
        id: doc.id,
        snapId: report.snapId,
        reason: report.reason,
        action: report.action,
        snapCaption: report.snapCaption || "",
        resolvedAt: toISO(report.resolvedAt),
      };
    })
    .sort((a, b) => new Date(b.resolvedAt || 0) - new Date(a.resolvedAt || 0))
    .slice(0, HISTORY_LIMIT);
}

async function listForAdmin(tab) {
  if (tab === "hidden") return listHidden();
  if (tab === "history") return listHistory();

  return listPending();
}

// ---------- admin: act on a Snap ----------

async function moderateSnap(snapId, action, adminId) {
  if (!ADMIN_ACTIONS.includes(action)) {
    throw new ModerationError(400, "Unknown action");
  }

  const snapRef = db.collection("snaps").doc(snapId);
  const first = await snapRef.get();

  if (!first.exists) {
    throw new ModerationError(404, "Snap not found (it may already be deleted)");
  }

  const snapBefore = first.data();

  if (action === "hide") {
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(snapRef);

      if (!doc.exists) throw new ModerationError(404, "Snap not found");

      const snap = doc.data();

      if (snap.status === "hidden") return; // already hidden

      transaction.update(snapRef, {
        status: "hidden",
        hiddenPrevStatus: snap.status,
        hiddenAt: new Date(),
        hiddenBy: adminId,
      });
    });
  }

  if (action === "unhide") {
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(snapRef);

      if (!doc.exists) throw new ModerationError(404, "Snap not found");

      const snap = doc.data();

      if (snap.status !== "hidden") {
        throw new ModerationError(409, "This Snap is not hidden.");
      }

      transaction.update(snapRef, {
        status: snap.hiddenPrevStatus || "published",
        hiddenPrevStatus: FieldValue.delete(),
        hiddenAt: FieldValue.delete(),
        hiddenBy: FieldValue.delete(),
      });
    });
  }

  if (action === "safe") {
    await snapRef.update({
      moderation: {
        status: "safe",
        reviewedAt: new Date(),
        reviewedBy: adminId,
      },
    });
  }

  if (action === "delete") {
    const spaceRef = snapBefore.spaceId
      ? db.collection("spaces").doc(snapBefore.spaceId)
      : null;

    await db.runTransaction(async (transaction) => {
      const spaceDoc = spaceRef ? await transaction.get(spaceRef) : null;

      // Free the space so somebody else can take it.
      if (spaceDoc?.exists && spaceDoc.data().snapId === snapId) {
        transaction.update(spaceRef, {
          status: "available",
          snapId: null,
          occupiedBy: FieldValue.delete(),
          occupiedAt: FieldValue.delete(),
        });
      }

      transaction.delete(snapRef);
    });

    // Likes / saves live under the Snap; clean them up too.
    await db.recursiveDelete(snapRef.collection("likes"));
    await db.recursiveDelete(snapRef.collection("saves"));
    await deleteSnapFile(snapBefore.storagePath);
  }

  // "unhide" is not a verdict on a report, so it leaves reports alone.
  if (action !== "unhide") {
    await resolvePendingReports(snapId, action, adminId, snapBefore);
  }

  return { snapId, action };
}

module.exports = {
  ModerationError,
  REPORT_REASONS,
  reportSnap,
  listForAdmin,
  moderateSnap,
};