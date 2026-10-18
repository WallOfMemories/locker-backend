// ------------------------------------------------------------
// Privacy settings — stored on users/{uid}.privacy
//
//   showPhoto      true  -> your profile photo is shown next to your Snaps
//                           (Liked / Saved lists of other people)
//   showLocation   true  -> the place you tagged is shown on your Snaps
//   notifyOnLikes  true  -> you get a notification when someone likes a Snap
//
// A person who never opened Settings has no `privacy` field at all, so every
// reader goes through getPrivacy(), which fills in the defaults. Everything
// is ON by default, which is exactly how the app behaved before this
// existed.
// ------------------------------------------------------------

const DEFAULT_PRIVACY = {
  showPhoto: true,
  showLocation: true,
  notifyOnLikes: true,
};

const PRIVACY_KEYS = Object.keys(DEFAULT_PRIVACY);

// users/{uid} document data (or undefined) -> complete settings object
function getPrivacy(user) {
  const saved = user?.privacy || {};
  const result = {};

  PRIVACY_KEYS.forEach((key) => {
    result[key] = typeof saved[key] === "boolean" ? saved[key] : DEFAULT_PRIVACY[key];
  });

  return result;
}

// Checks what the browser sent. Only known keys, only true/false.
// -> { ok: true, value: {...} } | { ok: false, message }
function validatePrivacyInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "Privacy settings are required" };
  }

  const value = {};

  for (const key of Object.keys(input)) {
    if (!PRIVACY_KEYS.includes(key)) {
      return { ok: false, message: `Unknown privacy setting: ${key}` };
    }

    if (typeof input[key] !== "boolean") {
      return { ok: false, message: `${key} must be true or false` };
    }

    value[key] = input[key];
  }

  if (Object.keys(value).length === 0) {
    return { ok: false, message: "Nothing to update" };
  }

  return { ok: true, value };
}

module.exports = {
  DEFAULT_PRIVACY,
  getPrivacy,
  validatePrivacyInput,
};