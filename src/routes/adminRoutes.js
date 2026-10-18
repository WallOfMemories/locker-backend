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

const { requireStrictAuth } = require("../middleware/authMiddleware");
const { requireAdmin } = require("../middleware/adminMiddleware");
const { writeLimiter } = require("../middleware/rateLimiters");
const { validateParams } = require("../utils/validate");

const router = express.Router();

// Everything under /api/admin needs a logged-in, still-enabled admin.
router.use(requireStrictAuth, requireAdmin);

// Dashboard
router.get("/dashboard", getDashboard);

// Reports / moderation
router.get("/reports", getReports);
router.post(
  "/snaps/:snapId/action",
  writeLimiter,
  validateParams("snapId"),
  moderateSnap
);

// Payments
router.get("/payments", getPayments);

// Wall size
router.get("/wall", getWall);
router.post("/wall/expand", writeLimiter, expandWall);
router.put("/wall/settings", writeLimiter, updateWallSettings);

module.exports = router;
