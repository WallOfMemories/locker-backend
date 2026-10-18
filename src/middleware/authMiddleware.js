const { adminAuth } = require("../config/firebase");

// Pulls "Bearer <token>" out of the Authorization header.
function readBearerToken(req) {
  const header = req.headers.authorization;

  if (typeof header !== "string") return null;

  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());

  return match ? match[1] : null;
}

function makeAuth({ checkRevoked }) {
  return async function auth(req, res, next) {
    const token = readBearerToken(req);

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    try {
      // checkRevoked also rejects accounts that were disabled or whose
      // sessions were revoked (costs one extra Firebase lookup).
      const decodedToken = await adminAuth.verifyIdToken(
        token,
        checkRevoked && process.env.AUTH_CHECK_REVOKED !== "false"
      );

      req.user = decodedToken;

      return next();
    } catch (error) {
      // Log the reason, never the token.
      console.warn("Authentication failed:", error?.code || error?.message);

      return res.status(401).json({
        success: false,
        message: "Invalid or expired authentication token",
      });
    }
  };
}

// Normal routes: signature + expiry check (no extra network call).
const requireAuth = makeAuth({ checkRevoked: false });

// Money, admin and account-deletion routes: also checks the account has not
// been disabled / signed out everywhere.
const requireStrictAuth = makeAuth({ checkRevoked: true });

module.exports = {
  requireAuth,
  requireStrictAuth,
};
