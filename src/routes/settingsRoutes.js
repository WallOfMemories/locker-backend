const express = require("express");

const {
  initializeTheLockerSettings,
  getTheLockerSettings,
} = require("../controllers/settingsController");

const { requireStrictAuth } = require("../middleware/authMiddleware");
const { requireAdmin } = require("../middleware/adminMiddleware");
const { publicReadLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

router.get("/", publicReadLimiter, getTheLockerSettings);

// One-time set-up: admins only.
router.post(
  "/initialize",
  requireStrictAuth,
  requireAdmin,
  initializeTheLockerSettings
);

module.exports = router;
