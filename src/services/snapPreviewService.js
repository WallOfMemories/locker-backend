const { db } = require("../config/firebase");
const { isSnapLocked, toISO } = require("./capsuleService");
const { getPrivacy } = require("./privacyService");

// ------------------------------------------------------------
// NEW: what a shared Snap link may show in a WhatsApp / Instagram / X preview.
//
// The preview follows EXACTLY the same privacy rules as the wall:
//   - a Time Capsule that hasn't opened yet  -> no photo, no caption
//   - hidden by a moderator or by the owner  -> no photo, no caption
//   - the owner's "hide my location" setting -> no country
// Only fields that are already public on the wall are ever returned, and
// never anything about who the person is beyond their public name.
// ------------------------------------------------------------

// -> null (no such Snap) or one of:
//    { available: false, reason: "locked" | "hidden", unlockAt? }
//    { available: true, image, caption, username, displayName, country }
async function getSnapPreview(snapId) {
  const snapDoc = await db.collection("snaps").doc(snapId).get();

  if (!snapDoc.exists) return null;

  const snap = snapDoc.data();

  if (isSnapLocked(snap)) {
    return { available: false, reason: "locked", unlockAt: toISO(snap.unlockAt) };
  }

  if (snap.status === "hidden" || snap.ownerHidden === true) {
    return { available: false, reason: "hidden" };
  }

  const userDoc = snap.userId
    ? await db.collection("users").doc(snap.userId).get()
    : null;

  const user = userDoc?.exists ? userDoc.data() : {};

  return {
    available: true,
    image: snap.imageUrl || "",
    caption: snap.caption || "",
    username: user.username || "",
    displayName: user.displayName || "",
    country: getPrivacy(user).showLocation ? snap.location?.name || "" : "",
  };
}

module.exports = { getSnapPreview };