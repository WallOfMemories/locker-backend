const express = require("express");

const {
  getReports,
  moderateSnap,
} = require("../controllers/moderationController");

const {
  getDashboard,
  getPayments,
  getWall,
  expandWall,
  updateWallSettings,
} = require("../controllers/adminController");

const { requireAuth } = require("../middleware/authMiddleware");
const { requireAdmin } = require("../middleware/adminMiddleware");

const router = express.Router();

// Everything under /api/admin needs a logged-in admin.
router.use(requireAuth, requireAdmin);

// Dashboard
router.get("/dashboard", getDashboard);

// Reports / moderation
router.get("/reports", getReports);
router.post("/snaps/:snapId/action", moderateSnap);

// Payments
router.get("/payments", getPayments);

// Wall size
router.get("/wall", getWall);
router.post("/wall/expand", expandWall);
router.put("/wall/settings", updateWallSettings);

module.exports = router;