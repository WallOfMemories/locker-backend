const express = require("express");

const {
  getPrivacy,
  updatePrivacy,
  getSummary,
  requestAccountDeletion,
  cancelAccountDeletion,
  sendSupportRequest,
} = require("../controllers/accountController");

const { requireAuth } = require("../middleware/authMiddleware");

const router = express.Router();

// Privacy controls
router.get("/privacy", requireAuth, getPrivacy);
router.put("/privacy", requireAuth, updatePrivacy);

// Delete account
router.get("/summary", requireAuth, getSummary);
router.post("/delete-request", requireAuth, requestAccountDeletion);
router.post("/cancel-deletion", requireAuth, cancelAccountDeletion);

// Help & Support -> "Report a problem"
router.post("/support", requireAuth, sendSupportRequest);

module.exports = router;