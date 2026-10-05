const { db } = require("../config/firebase");

// Must run AFTER requireAuth (it needs req.user).
//
// Who is an admin?
//   - If ADMIN_UIDS is set in .env (comma separated Firebase UIDs), ONLY
//     those accounts are admins. This is the safest option because nobody
//     can grant themselves access by editing their own profile document.
//   - Otherwise a user is an admin when users/{uid}.role === "admin".
async function requireAdmin(req, res, next) {
  try {
    const uid = req.user?.uid;

    const allowList = (process.env.ADMIN_UIDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    if (allowList.length > 0) {
      if (allowList.includes(uid)) return next();

      return res.status(403).json({
        success: false,
        message: "Admin access required",
      });
    }

    const userDoc = await db.collection("users").doc(uid).get();

    if (userDoc.exists && userDoc.data().role === "admin") {
      return next();
    }

    return res.status(403).json({
      success: false,
      message: "Admin access required",
    });
  } catch (error) {
    console.error("Admin check failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to verify admin access",
    });
  }
}

module.exports = { requireAdmin };