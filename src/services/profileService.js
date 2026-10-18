const { db } = require("../config/firebase");
const { isAllowedPhotoUrl } = require("../utils/validate");

const USERNAME_REGEX = /^[a-z0-9_.]{3,20}$/;

const USERNAME_RULES =
  "Username must be 3-20 characters: letters, numbers, dot or underscore.";

class ProfileError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidUsername(username) {
  return USERNAME_REGEX.test(username);
}

// Non-transactional check, used for live availability feedback.
async function isUsernameAvailable(username, uid) {
  const mapping = await db
    .collection("usernames")
    .doc(username)
    .get();

  if (mapping.exists && mapping.data().uid !== uid) {
    return false;
  }

  const existing = await db
    .collection("users")
    .where("username", "==", username)
    .limit(2)
    .get();

  return !existing.docs.some((doc) => doc.id !== uid);
}

// Validates fields and writes the profile. When a username is
// included it is claimed inside a transaction so it stays unique.
async function saveProfile(uid, input) {
  const { username, displayName, bio, photoURL } = input || {};

  const updates = { updatedAt: new Date() };

  if (displayName !== undefined) {
    const value = String(displayName).trim();

    if (!value) {
      throw new ProfileError(400, "Name is required.");
    }

    if (value.length > 50) {
      throw new ProfileError(
        400,
        "Name must be 50 characters or less."
      );
    }

    updates.displayName = value;
  }

  if (bio !== undefined) {
    const value = String(bio).trim();

    if (value.length > 160) {
      throw new ProfileError(
        400,
        "Bio must be 160 characters or less."
      );
    }

    updates.bio = value;
  }

  if (photoURL !== undefined) {
    if (
      !isAllowedPhotoUrl(photoURL, {
        bucket: process.env.FIREBASE_STORAGE_BUCKET || "",
      })
    ) {
      throw new ProfileError(400, "That profile photo is not valid.");
    }

    updates.photoURL = photoURL || "";
  }

  let newUsername = null;

  if (username !== undefined) {
    newUsername = normalizeUsername(username);

    if (!isValidUsername(newUsername)) {
      throw new ProfileError(400, USERNAME_RULES);
    }

    updates.username = newUsername;
  }

  const userRef = db.collection("users").doc(uid);
  const usernames = db.collection("usernames");

  await db.runTransaction(async (transaction) => {
    const userSnapshot = await transaction.get(userRef);

    const oldUsername = userSnapshot.exists
      ? userSnapshot.data().username || ""
      : "";

    if (newUsername) {
      const mappingRef = usernames.doc(newUsername);

      const mappingSnapshot = await transaction.get(mappingRef);

      if (
        mappingSnapshot.exists &&
        mappingSnapshot.data().uid !== uid
      ) {
        throw new ProfileError(
          409,
          "That username is already taken."
        );
      }

      if (newUsername !== oldUsername) {
        const duplicates = await transaction.get(
          db
            .collection("users")
            .where("username", "==", newUsername)
            .limit(2)
        );

        if (duplicates.docs.some((doc) => doc.id !== uid)) {
          throw new ProfileError(
            409,
            "That username is already taken."
          );
        }
      }

      transaction.set(mappingRef, {
        uid,
        createdAt: new Date(),
      });

      if (oldUsername && oldUsername !== newUsername) {
        transaction.delete(usernames.doc(oldUsername));
      }
    }

    transaction.set(userRef, updates, { merge: true });
  });

  const updated = await userRef.get();

  return {
    id: updated.id,
    ...updated.data(),
  };
}

module.exports = {
  ProfileError,
  USERNAME_RULES,
  normalizeUsername,
  isValidUsername,
  isUsernameAvailable,
  saveProfile,
};