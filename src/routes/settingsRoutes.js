const express = require("express");

const {
  initializeSnapWallSettings,
  getSnapWallSettings,
} = require("../controllers/settingsController");

const { requireStrictAuth } = require("../middleware/authMiddleware");
const { requireAdmin } = require("../middleware/adminMiddleware");
const { publicReadLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

router.get("/", publicReadLimiter, getSnapWallSettings);

// One-time set-up: admins only.
router.post(
  "/initialize",
  requireStrictAuth,
  requireAdmin,
  initializeSnapWallSettings
);

module.exports = router;
