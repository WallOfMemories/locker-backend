const { db } = require("../config/firebase");
const { getPrivacy } = require("./privacyService");

// ------------------------------------------------------------
// Notifications
//
// users/{userId}/notifications/{notificationId}
//   type:      "capsule_opened" | "snap_liked" |
//              "snap_hidden" | "snap_restored" | "snap_removed" |
//              "payment_refunded"
//   message:   ready-to-show text ("sam liked your Snap")
//   snapId, snapCaption     (optional) what it is about
//   actorId, actorName, actorPhotoURL   (optional) who did it
//   read:      false until the owner opens / marks it
//   createdAt
//
// Stored under the user (not in one big top-level collection) so that
// "my newest notifications" is a plain orderBy on one field — no composite
// index to create in the Firebase console.
//
// IMPORTANT: creating a notification must never break the thing that caused
// it (a like, a capsule unlock, a refund...). notify() therefore swallows
// its own errors and just logs them.
// ------------------------------------------------------------

const LIST_LIMIT = 50;
const BATCH_SIZE = 400; // Firestore batches allow 500 writes
const CAPTION_PREVIEW = 60;

function notificationsRef(userId) {
  return db.collection("users").doc(userId).collection("notifications");
}

function isAlreadyExists(error) {
  return error?.code === 6 || /ALREADY_EXISTS/i.test(error?.message || "");
}

// (kept local on purpose: capsuleService requires THIS file, so requiring
// capsuleService back would create a circular import)
function toISO(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value.toDate === "function") return value.toDate().toISOString();

  return null;
}

function captionPreview(caption) {
  const text = String(caption || "").trim();

  if (!text) return "";

  return text.length > CAPTION_PREVIEW
    ? `${text.slice(0, CAPTION_PREVIEW)}…`
    : text;
}

// Who did it? Looks up the username + photo of the person who liked / saved.
async function getActor(userId) {
  try {
    const doc = await db.collection("users").doc(userId).get();
    const data = doc.exists ? doc.data() : {};

    return {
      actorId: userId,
      actorName: data.username || data.displayName || "Someone",
      actorPhotoURL: data.photoURL || "",
    };
  } catch (error) {
    console.error("Notification actor lookup failed:", error);

    return { actorId: userId, actorName: "Someone", actorPhotoURL: "" };
  }
}

// Builds a notification document WITHOUT writing it, so callers that already
// use a batch / transaction (the capsule scheduler) can add it to that batch.
// -> { ref, data }
function buildNotification(userId, id, fields) {
  return {
    ref: notificationsRef(userId).doc(id),
    data: {
      type: fields.type,
      message: fields.message,
      snapId: fields.snapId || null,
      snapCaption: captionPreview(fields.snapCaption),
      actorId: fields.actorId || null,
      actorName: fields.actorName || "",
      actorPhotoURL: fields.actorPhotoURL || "",
      read: false,
      createdAt: new Date(),
    },
  };
}

// Writes ONE notification, but only if that id doesn't exist yet.
// A fixed id per event (e.g. "like_<snapId>_<likerId>") means liking /
// unliking / liking again doesn't spam the owner. Never throws.
// -> true when a notification was created
async function notify(userId, id, fields) {
  try {
    if (!userId) return false;

    const { ref, data } = buildNotification(userId, id, fields);

    await ref.create(data);

    return true;
  } catch (error) {
    if (!isAlreadyExists(error)) {
      console.error("Create notification failed:", error);
    }

    return false;
  }
}

// ---------- the events ----------

// Someone liked the owner's Snap.
async function notifySnapLiked(snapId, snap, likerId) {
  if (!snap?.userId || snap.userId === likerId) return false; // own like

  // NEW: the owner can switch like notifications off in Settings > Privacy.
  // If we can't read their setting, err on the side of telling them.
  try {
    const owner = await db.collection("users").doc(snap.userId).get();

    if (getPrivacy(owner.data()).notifyOnLikes === false) return false;
  } catch (error) {
    console.error("Could not read notification preference:", error);
  }

  const actor = await getActor(likerId);

  return notify(snap.userId, `like_${snapId}_${likerId}`, {
    type: "snap_liked",
    message: `${actor.actorName} liked your Snap`,
    snapId,
    snapCaption: snap.caption,
    ...actor,
  });
}

// A moderator acted on the owner's Snap.
//   action: "hide" | "unhide" | "delete"
async function notifyModeration(snapId, snap, action) {
  if (!snap?.userId) return false;

  const content = {
    hide: {
      type: "snap_hidden",
      message: "A moderator hid your Snap",
    },
    unhide: {
      type: "snap_restored",
      message: "Good news — your Snap was reviewed and is visible again",
    },
    delete: {
      type: "snap_removed",
      message: "A moderator removed your Snap",
    },
  }[action];

  if (!content) return false;

  // Timestamp in the id: a Snap can be hidden, restored and hidden again,
  // and each of those should be its own notification.
  return notify(snap.userId, `mod_${action}_${snapId}_${Date.now()}`, {
    ...content,
    snapId: action === "delete" ? null : snapId, // deleted: nothing to open
    snapCaption: snap.caption,
  });
}

// The person's payment was automatically refunded.
async function notifyRefund(userId, paymentId, reason) {
  return notify(userId, `refund_${paymentId}`, {
    type: "payment_refunded",
    message: reason
      ? `Your payment was refunded (${reason})`
      : "Your payment was refunded",
  });
}

// ---------- reading / managing (used by the API) ----------

function serialize(doc) {
  const data = doc.data();

  return {
    id: doc.id,
    type: data.type,
    message: data.message,
    snapId: data.snapId || null,
    snapCaption: data.snapCaption || "",
    actorName: data.actorName || "",
    actorPhotoURL: data.actorPhotoURL || "",
    read: data.read === true,
    createdAt: toISO(data.createdAt),
  };
}

async function countUnread(userId) {
  const result = await notificationsRef(userId)
    .where("read", "==", false)
    .count()
    .get();

  return result.data().count;
}

// "Saved your Snap" notifications were removed from the app. Any that were
// already created before that are deleted here the first time the list loads.
const LEGACY_TYPES = ["snap_saved"];

// -> { notifications: [...newest first], unreadCount }
async function listForUser(userId) {
  const snapshot = await notificationsRef(userId)
    .orderBy("createdAt", "desc")
    .limit(LIST_LIMIT)
    .get();

  const legacy = snapshot.docs.filter((doc) =>
    LEGACY_TYPES.includes(doc.data().type)
  );

  if (legacy.length > 0) {
    const batch = db.batch();

    legacy.forEach((doc) => batch.delete(doc.ref));

    await batch.commit().catch((error) => {
      console.error("Legacy notification cleanup failed:", error);
    });
  }

  // Count AFTER the cleanup so the badge and the list agree.
  const unreadCount = await countUnread(userId);

  return {
    notifications: snapshot.docs
      .filter((doc) => !LEGACY_TYPES.includes(doc.data().type))
      .map(serialize),
    unreadCount,
  };
}

// -> true if it existed
async function markRead(userId, id) {
  const ref = notificationsRef(userId).doc(id);
  const doc = await ref.get();

  if (!doc.exists) return false;

  if (doc.data().read !== true) await ref.update({ read: true });

  return true;
}

async function markAllRead(userId) {
  let updated = 0;

  for (;;) {
    const snapshot = await notificationsRef(userId)
      .where("read", "==", false)
      .limit(BATCH_SIZE)
      .get();

    if (snapshot.empty) break;

    const batch = db.batch();

    snapshot.docs.forEach((doc) => batch.update(doc.ref, { read: true }));

    await batch.commit();

    updated += snapshot.size;

    if (snapshot.size < BATCH_SIZE) break;
  }

  return updated;
}

async function remove(userId, id) {
  await notificationsRef(userId).doc(id).delete();
}

async function removeAll(userId) {
  await db.recursiveDelete(notificationsRef(userId));
}

module.exports = {
  buildNotification,
  notify,
  notifySnapLiked,
  notifyModeration,
  notifyRefund,
  countUnread,
  listForUser,
  markRead,
  markAllRead,
  remove,
  removeAll,
};