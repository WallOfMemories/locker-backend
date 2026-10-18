// ------------------------------------------------------------
// Small, dependency-free validators used by the controllers.
// Everything the browser sends is untrusted: check type, shape and size.
// ------------------------------------------------------------

// Firestore document ids: no slashes, not "." / "..", not "__x__".
const SAFE_ID = /^[A-Za-z0-9_\-.:]{1,256}$/;

function isSafeId(value) {
  return (
    typeof value === "string" &&
    SAFE_ID.test(value) &&
    value !== "." &&
    value !== ".." &&
    !/^__.*__$/.test(value)
  );
}

// space_001 ... space_99999
function isSpaceId(value) {
  return typeof value === "string" && /^space_\d{1,6}$/.test(value);
}

// Express middleware: rejects a bad :param before it reaches Firestore.
function validateParams(...names) {
  return (req, res, next) => {
    for (const name of names) {
      if (!isSafeId(req.params[name])) {
        return res.status(400).json({
          success: false,
          message: `Invalid ${name}`,
        });
      }
    }

    next();
  };
}

// Snap photos are uploaded by the browser straight to Firebase Storage at
//   snaps/<uid>/<file>
// and the server is then told the download URL + path. Never trust them:
// a person could otherwise attach any URL (tracking pixel, hot-linked
// content) or point storagePath at SOMEONE ELSE'S file, which the server
// would later delete when the Snap is deleted.
function isOwnSnapStoragePath(storagePath, uid) {
  if (typeof storagePath !== "string" || storagePath.length > 300) return false;
  if (storagePath.includes("..") || storagePath.includes("//")) return false;

  const prefix = `snaps/${uid}/`;

  return storagePath.startsWith(prefix) && storagePath.length > prefix.length;
}

// A Firebase Storage download URL for OUR bucket:
//   https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<encoded path>?alt=media&token=...
//   https://<bucket>.firebasestorage.app/...  (new-style buckets are also served
//   through the same googleapis host, so only the first form is accepted)
// When `bucket` is empty (not configured) only the host is checked.
function isFirebaseDownloadUrl(value, { bucket = "", storagePath = "" } = {}) {
  if (typeof value !== "string" || value.length > 2048) return false;

  let url;

  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;
  if (url.hostname !== "firebasestorage.googleapis.com") return false;
  if (url.username || url.password) return false;

  const match = /^\/v0\/b\/([^/]+)\/o\/([^/]+)$/.exec(url.pathname);

  if (!match) return false;
  if (bucket && match[1] !== bucket) return false;

  if (storagePath) {
    let decoded;

    try {
      decoded = decodeURIComponent(match[2]);
    } catch {
      return false;
    }

    if (decoded !== storagePath) return false;
  }

  return true;
}

// Profile photo: either empty, a Google account photo, or one of our own
// Storage URLs. https only.
function isAllowedPhotoUrl(value, { bucket = "" } = {}) {
  if (value === "" || value === null || value === undefined) return true;
  if (typeof value !== "string" || value.length > 2048) return false;

  let url;

  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "https:" || url.username || url.password) return false;

  if (url.hostname === "firebasestorage.googleapis.com") {
    const match = /^\/v0\/b\/([^/]+)\/o\//.exec(url.pathname);

    return Boolean(match) && (!bucket || match[1] === bucket);
  }

  // Google sign-in profile pictures
  return /^lh\d+\.googleusercontent\.com$/.test(url.hostname);
}

module.exports = {
  isSafeId,
  isSpaceId,
  validateParams,
  isOwnSnapStoragePath,
  isFirebaseDownloadUrl,
  isAllowedPhotoUrl,
};
