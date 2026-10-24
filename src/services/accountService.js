const { db, firebaseApp, adminAuth } = require("../config/firebase");
const { FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");

const { getPrivacy, validatePrivacyInput } = require("./privacyService");
const { deleteOwnSnap, OwnerError } = require("./snapOwnerService");

// ------------------------------------------------------------
// Everything behind the Settings page that needs the server:
//   - privacy controls
//   - "what will happen if I delete my account" summary
//   - account deletion: request -> 30 day grace period -> permanent purge
//   - "report a problem" messages to the support team
// ------------------------------------------------------------

// How long a deletion request can be cancelled.
const GRACE_DAYS = 30;
const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;

// A deletion request is only accepted if the person signed in (or re-entered
// their password / picked their Google account) in the last 5 minutes.
const REAUTH_WINDOW_SECONDS = 5 * 60;

const BATCH_SIZE = 400; // Firestore batches allow 500 writes
const SNAP_PAGE = 200; // 2 deletes per Snap (like + save) = 400 writes

const SUPPORT_COOLDOWN_MS = 60 * 1000; // one message per minute
const SUPPORT_CATEGORIES = ["bug", "payment", "account", "other"];
const SUPPORT_MIN = 10;
const SUPPORT_MAX = 1000;

class AccountError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || null;
  }
}

const usersCollection = db.collection("users");
const snapsCollection = db.collection("snaps");

function toISO(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value.toDate === "function") return value.toDate().toISOString();

  return null;
}

async function getUserData(uid) {
  const doc = await usersCollection.doc(uid).get();

  return doc.exists ? doc.data() : null;
}

// ---------- privacy ----------

async function getPrivacySettings(uid) {
  return getPrivacy(await getUserData(uid));
}

async function savePrivacySettings(uid, input) {
  const check = validatePrivacyInput(input);

  if (!check.ok) throw new AccountError(400, check.message);

  // merge:true merges INSIDE `privacy`, so changing one switch never
  // resets the others.
  await usersCollection
    .doc(uid)
    .set({ privacy: check.value, updatedAt: new Date() }, { merge: true });

  return getPrivacySettings(uid);
}

// ---------- summary + deletion status ----------

function deletionStatus(user) {
  const scheduledFor = toISO(user?.deletionScheduledFor);

  return {
    pending: Boolean(scheduledFor),
    requestedAt: toISO(user?.deletionRequestedAt),
    scheduledFor,
  };
}

// True while a deletion request is waiting out its grace period. Used to
// stop someone from paying for a new space on an account about to vanish.
async function isDeletionPending(uid) {
  return deletionStatus(await getUserData(uid)).pending;
}

async function getAccountSummary(uid) {
  const [user, total, sealed] = await Promise.all([
    getUserData(uid),
    snapsCollection.where("userId", "==", uid).count().get(),
    snapsCollection
      .where("userId", "==", uid)
      .where("status", "==", "locked")
      .count()
      .get(),
  ]);

  return {
    snaps: total.data().count,
    sealedCapsules: sealed.data().count,
    graceDays: GRACE_DAYS,
    isAdmin: user?.role === "admin",
    deletion: deletionStatus(user),
  };
}

// ---------- deletion: request / cancel ----------

// Runs `makeUpdate(doc)` for every doc in chunks of BATCH_SIZE.
async function updateInChunks(docs, makeUpdate) {
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = db.batch();

    docs.slice(i, i + BATCH_SIZE).forEach((doc) => {
      batch.update(doc.ref, makeUpdate(doc));
    });

    await batch.commit();
  }
}

// `authTime` = when the ID token's owner last really signed in (seconds).
async function requestDeletion(uid, authTime) {
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (!authTime || nowSeconds - authTime > REAUTH_WINDOW_SECONDS) {
    throw new AccountError(
      401,
      "For your security, please confirm your sign-in again.",
      "reauth-required"
    );
  }

  const user = await getUserData(uid);

  if (!user) throw new AccountError(404, "Account not found");

  // An admin who deletes their account by accident could lock everyone out
  // of moderation. Admin accounts are handled by hand.
  if (user.role === "admin") {
    throw new AccountError(
      403,
      "Admin accounts can't be deleted from Settings. Please contact the team."
    );
  }

  // Asking twice just returns the first request.
  if (deletionStatus(user).pending) {
    return getAccountSummary(uid);
  }

  // 1. Hide their Snaps from everyone right away. `hiddenForDeletion` marks
  //    the ones WE hid, so cancelling can show exactly those again and
  //    never un-hide something the person hid on purpose.
  const snaps = await snapsCollection.where("userId", "==", uid).get();
  const toHide = snaps.docs.filter((doc) => doc.data().ownerHidden !== true);

  await updateInChunks(toHide, () => ({
    ownerHidden: true,
    ownerHiddenAt: new Date(),
    hiddenForDeletion: true,
  }));

  // 2. Only now schedule it — if step 1 failed nothing was scheduled and
  //    the person can simply try again.
  await usersCollection.doc(uid).update({
    deletionRequestedAt: new Date(),
    deletionScheduledFor: new Date(Date.now() + GRACE_MS),
  });

  return getAccountSummary(uid);
}

async function cancelDeletion(uid) {
  const user = await getUserData(uid);

  if (!user) throw new AccountError(404, "Account not found");

  if (!deletionStatus(user).pending) return getAccountSummary(uid);

  // Show again only the Snaps the deletion request hid.
  const snaps = await snapsCollection.where("userId", "==", uid).get();
  const toShow = snaps.docs.filter(
    (doc) => doc.data().hiddenForDeletion === true
  );

  await updateInChunks(toShow, () => ({
    ownerHidden: FieldValue.delete(),
    ownerHiddenAt: FieldValue.delete(),
    hiddenForDeletion: FieldValue.delete(),
  }));

  await usersCollection.doc(uid).update({
    deletionRequestedAt: FieldValue.delete(),
    deletionScheduledFor: FieldValue.delete(),
  });

  return getAccountSummary(uid);
}

// ---------- deletion: the permanent part ----------

// Their likes and saves on OTHER people's Snaps. Deleting a document that
// doesn't exist is a harmless no-op, so we don't need to look first.
async function removeActivityOnOtherSnaps(uid) {
  const snapRefs = await snapsCollection.listDocuments();

  for (let i = 0; i < snapRefs.length; i += SNAP_PAGE) {
    const batch = db.batch();

    snapRefs.slice(i, i + SNAP_PAGE).forEach((ref) => {
      batch.delete(ref.collection("likes").doc(uid));
      batch.delete(ref.collection("saves").doc(uid));
    });

    await batch.commit();
  }
}

async function removeReservations(uid) {
  const held = await db
    .collection("reservations")
    .where("userId", "==", uid)
    .get();

  for (let i = 0; i < held.docs.length; i += BATCH_SIZE) {
    const batch = db.batch();

    held.docs.slice(i, i + BATCH_SIZE).forEach((doc) => batch.delete(doc.ref));

    await batch.commit();
  }
}

// Best effort (same as the Snap delete): needs FIREBASE_STORAGE_BUCKET in
// the backend .env — without it the files are simply left in Storage.
async function removeStorageFiles(uid) {
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;

  if (!bucketName) return;

  const bucket = getStorage(firebaseApp).bucket(bucketName);

  // users/<uid>/profile/...  = profile photos, snaps/<uid>/... = Snap photos
  for (const prefix of [`users/${uid}/`, `snaps/${uid}/`]) {
    try {
      await bucket.deleteFiles({ prefix });
    } catch (error) {
      console.error(`Could not delete Storage files under ${prefix}:`, error);
    }
  }
}

// Permanently removes one account. Called by the scheduler once the grace
// period is over. Throws if anything important fails — the account is then
// picked up again on the next run, so a half-finished purge always finishes.
async function purgeAccount(uid) {
  const user = await getUserData(uid);

  // Re-check everything: never purge something that was cancelled (or is an
  // admin) in the moments since the scheduler looked.
  if (user) {
    const scheduled = user.deletionScheduledFor?.toDate?.();

    if (!scheduled || scheduled.getTime() > Date.now()) return false;
    if (user.role === "admin") return false;
  }

  // 1. Their Snaps: frees each space, removes likes / saves, closes reports,
  //    deletes the photo. Same code as "delete my Snap" — and, as there,
  //    no refund.
  const snaps = await snapsCollection.where("userId", "==", uid).get();

  for (const doc of snaps.docs) {
    try {
      await deleteOwnSnap(doc.id, uid);
    } catch (error) {
      // already gone is fine, anything else must stop the purge
      if (!(error instanceof OwnerError && error.status === 404)) throw error;
    }
  }

  // 2. Everything else that is theirs
  await removeActivityOnOtherSnaps(uid);
  await removeReservations(uid);
  await db.recursiveDelete(usersCollection.doc(uid).collection("notifications"));
  await removeStorageFiles(uid);

  // 3. Sign-in account BEFORE the profile: if this fails the profile (and so
  //    the scheduled date) is still there and we retry; the other way round
  //    would leave a sign-in with no profile that nobody retries.
  try {
    await adminAuth.deleteUser(uid);
  } catch (error) {
    if (error?.code !== "auth/user-not-found") throw error;
  }

  // 4. Username + profile
  if (user?.username) {
    const mapping = db.collection("usernames").doc(user.username);
    const mappingDoc = await mapping.get();

    if (mappingDoc.exists && mappingDoc.data().uid === uid) {
      await mapping.delete();
    }
  }

  await usersCollection.doc(uid).delete();

  // Payment records are deliberately kept (accounting / legal). They only
  // hold the old user id — there is no profile left to link them to.
  return true;
}

// One pass: permanently deletes (up to 10) accounts whose grace period is
// over. Used by the hourly timer (always-on servers) and by the cron
// endpoint (serverless hosting such as Vercel).
async function purgeDueAccounts() {
  const due = await usersCollection
    .where("deletionScheduledFor", "<=", new Date())
    .limit(10)
    .get();

  let purgedCount = 0;

  for (const doc of due.docs) {
    try {
      const purged = await purgeAccount(doc.id);

      if (purged) {
        purgedCount += 1;
        console.log(`Account ${doc.id} permanently deleted`);
      }
    } catch (error) {
      console.error(`Account deletion failed for ${doc.id}:`, error);
    }
  }

  return purgedCount;
}

// Checks every hour for accounts whose grace period is over.
function startAccountDeletionScheduler() {
  let running = false;

  async function run() {
    if (running) return;

    running = true;

    try {
      await purgeDueAccounts();
    } catch (error) {
      console.error("Account deletion scheduler error:", error);
    } finally {
      running = false;
    }
  }

  setTimeout(run, 30 * 1000); // shortly after the server starts
  setInterval(run, 60 * 60 * 1000);
}

// ---------- help & support ----------

// Saved to supportRequests/{id} — read them in the Firebase console (or
// build an admin page on top of it later).
async function createSupportRequest(uid, email, input) {
  const category = String(input?.category || "").trim();
  const message = String(input?.message || "").trim();

  if (!SUPPORT_CATEGORIES.includes(category)) {
    throw new AccountError(400, "Please choose what your message is about");
  }

  if (message.length < SUPPORT_MIN) {
    throw new AccountError(
      400,
      `Please tell us a little more (at least ${SUPPORT_MIN} characters)`
    );
  }

  if (message.length > SUPPORT_MAX) {
    throw new AccountError(
      400,
      `Your message is too long (${SUPPORT_MAX} characters at most)`
    );
  }

  const user = (await getUserData(uid)) || {};

  // Simple spam brake that needs no database index.
  const last = user.lastSupportRequestAt?.toDate?.();

  if (last && Date.now() - last.getTime() < SUPPORT_COOLDOWN_MS) {
    throw new AccountError(
      429,
      "You just sent a message. Please wait a minute before sending another."
    );
  }

  const ref = db.collection("supportRequests").doc();
  const now = new Date();

  await ref.set({
    userId: uid,
    email: email || user.email || "",
    username: user.username || "",
    category,
    message,
    status: "open",
    createdAt: now,
  });

  await usersCollection
    .doc(uid)
    .set({ lastSupportRequestAt: now }, { merge: true });

  return { id: ref.id };
}

module.exports = {
  AccountError,
  GRACE_DAYS,
  getPrivacySettings,
  savePrivacySettings,
  getAccountSummary,
  isDeletionPending,
  requestDeletion,
  cancelDeletion,
  purgeAccount,
  purgeDueAccounts,
  startAccountDeletionScheduler,
  createSupportRequest,
};