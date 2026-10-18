const express = require("express");

const {
  getSpaces,
  initializeSpaces,
} = require("../controllers/spaceController");

const { requireStrictAuth } = require("../middleware/authMiddleware");
const { requireAdmin } = require("../middleware/adminMiddleware");
const { publicReadLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

router.get("/", publicReadLimiter, getSpaces);

// One-time set-up: admins only (it used to be open to the whole internet).
router.post("/initialize", requireStrictAuth, requireAdmin, initializeSpaces);

module.exports = router;
