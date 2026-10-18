const express = require("express");

const {
  getPrivacy,
  updatePrivacy,
  getSummary,
  requestAccountDeletion,
  cancelAccountDeletion,
  sendSupportRequest,
} = require("../controllers/accountController");

const {
  requireAuth,
  requireStrictAuth,
} = require("../middleware/authMiddleware");

const { writeLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

// Privacy controls
router.get("/privacy", requireAuth, getPrivacy);
router.put("/privacy", requireAuth, writeLimiter, updatePrivacy);

// Delete account
router.get("/summary", requireAuth, getSummary);
router.post("/delete-request", requireStrictAuth, writeLimiter, requestAccountDeletion);
router.post("/cancel-deletion", requireStrictAuth, writeLimiter, cancelAccountDeletion);

// Help & Support -> "Report a problem"
router.post("/support", requireAuth, writeLimiter, sendSupportRequest);

module.exports = router;
