const express = require("express");

const {
  getReports,
  moderateSnap,
} = require("../controllers/moderationController");

const { requireAuth } = require("../middleware/authMiddleware");
const { requireAdmin } = require("../middleware/adminMiddleware");

const router = express.Router();

// Everything under /api/admin needs a logged-in admin.
router.use(requireAuth, requireAdmin);

router.get("/reports", getReports);
router.post("/snaps/:snapId/action", moderateSnap);

module.exports = router;