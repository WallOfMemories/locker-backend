const { db, firebaseApp } = require("../config/firebase");
const { FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");

// ------------------------------------------------------------
// What a person can do with their OWN Snap
//
//   hide / unhide -> snap.ownerHidden = true (flag removed on unhide)
//        The space stays theirs and stays taken, but the photo and caption
//        are not shown to anyone else (wall, liked, saved, share link).
//        This is a separate flag from the moderators' status "hidden" on
//        purpose: a person can never un-hide something a moderator hid, and
//        the admin's "Hidden" list only ever shows moderator decisions.
//
//   delete -> the Snap is removed and its space becomes AVAILABLE again so
//        somebody else can take it. There is NO refund: the payment already
//        bought the Snap (payments/{id}.snapId stays set, so the refund code
//        can never touch it) — it is just marked "snap deleted" so Payment
//        History can say so.
// ------------------------------------------------------------

const snapsCollection = db.collection("snaps");

const BATCH_SIZE = 400;

class OwnerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- hide / unhide ----------

async function setOwnerHidden(snapId, userId, hidden) {
  const snapRef = snapsCollection.doc(snapId);

  await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(snapRef);

    if (!doc.exists) {
      throw new OwnerError(404, "Snap not found");
    }

    const snap = doc.data();

    if (snap.userId !== userId) {
      throw new OwnerError(403, "You can only change your own Snaps");
    }

    // Moderators' decision wins, in both directions.
    if (snap.status === "hidden") {
      throw new OwnerError(
        403,
        "This Snap was hidden by the moderators. Only they can show it again."
      );
    }

    if (hidden) {
      transaction.update(snapRef, {
        ownerHidden: true,
        ownerHiddenAt: new Date(),
      });
    } else {
      transaction.update(snapRef, {
        ownerHidden: FieldValue.delete(),
        ownerHiddenAt: FieldValue.delete(),
      });
    }
  });

  return { hidden };
}

// ---------- delete ----------

// Best effort, same as the admin delete: needs FIREBASE_STORAGE_BUCKET in
// the backend .env — without it the file is simply left in Storage.
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

// Reports on a Snap that no longer exists are closed, so they don't sit in
// the admin's "pending" count forever.
async function closePendingReports(snapId, userId, snap) {
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
        action: "deleted",
        resolvedAt: new Date(),
        resolvedBy: userId,
        resolvedByOwner: true,
        snapCaption: snap.caption || "",
      });
    });

    await batch.commit();
  }
}

async function deleteOwnSnap(snapId, userId) {
  const snapRef = snapsCollection.doc(snapId);
  const first = await snapRef.get();

  if (!first.exists) {
    throw new OwnerError(404, "Snap not found (it may already be deleted)");
  }

  const snapBefore = first.data();

  if (snapBefore.userId !== userId) {
    throw new OwnerError(403, "You can only delete your own Snaps");
  }

  // The payment that bought this Snap (if any) — noted as "snap deleted".
  const paymentQuery = await db
    .collection("payments")
    .where("snapId", "==", snapId)
    .limit(1)
    .get();

  const paymentRef = paymentQuery.docs[0]?.ref || null;

  const spaceRef = snapBefore.spaceId
    ? db.collection("spaces").doc(snapBefore.spaceId)
    : null;

  // One transaction: the Snap disappears and the space is freed together,
  // so there is never a moment where one has happened without the other.
  await db.runTransaction(async (transaction) => {
    const snapDoc = await transaction.get(snapRef);
    const spaceDoc = spaceRef ? await transaction.get(spaceRef) : null;

    if (!snapDoc.exists) {
      throw new OwnerError(404, "Snap not found (it may already be deleted)");
    }

    if (snapDoc.data().userId !== userId) {
      throw new OwnerError(403, "You can only delete your own Snaps");
    }

    // Free the space — but only if it still points at THIS Snap.
    if (spaceDoc?.exists && spaceDoc.data().snapId === snapId) {
      transaction.update(spaceRef, {
        status: "available",
        snapId: null,
        occupiedBy: FieldValue.delete(),
        occupiedAt: FieldValue.delete(),
      });
    }

    if (paymentRef) {
      transaction.update(paymentRef, {
        snapDeletedAt: new Date(),
        snapDeletedBy: "owner",
      });
    }

    transaction.delete(snapRef);
  });

  // Clean-up. The Snap is already gone and the space is already free, so a
  // problem here must not turn the delete into an error.
  try {
    await db.recursiveDelete(snapRef.collection("likes"));
    await db.recursiveDelete(snapRef.collection("saves"));
    await closePendingReports(snapId, userId, snapBefore);
  } catch (error) {
    console.error("Snap clean-up after delete failed:", error);
  }

  await deleteSnapFile(snapBefore.storagePath);

  return { snapId, spaceId: snapBefore.spaceId || "" };
}

module.exports = {
  OwnerError,
  setOwnerHidden,
  deleteOwnSnap,
};