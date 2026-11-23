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

// NEW: bidding
const {
  adminBoard,
  adminAccept,
  adminReject,
  adminCounter,
  adminCancel,
} = require("../controllers/bidController");

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

// NEW: Bids (first boxes of the wall)
router.get("/bids", adminBoard);
router.post("/bids/:spaceId/:userId/accept", writeLimiter, adminAccept);
router.post("/bids/:spaceId/:userId/reject", writeLimiter, adminReject);
router.post("/bids/:spaceId/:userId/counter", writeLimiter, adminCounter);
router.post("/bids/:spaceId/cancel", writeLimiter, adminCancel);

module.exports = router;