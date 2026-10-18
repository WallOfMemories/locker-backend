const express = require("express");

const {
  search,
  reverse,
} = require("../controllers/locationController");

const { requireAuth } = require("../middleware/authMiddleware");
const { locationLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

// Login required so the free map provider can't be hammered anonymously,
// and a per-person limit so one account can't either.
router.get("/search", requireAuth, locationLimiter, search);
router.get("/reverse", requireAuth, locationLimiter, reverse);

module.exports = router;
