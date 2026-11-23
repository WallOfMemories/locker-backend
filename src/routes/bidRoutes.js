const express = require("express");

const {
  getOverview,
  bid,
  respond,
} = require("../controllers/bidController");

const { optionalAuth, requireAuth } = require("../middleware/authMiddleware");
const { publicReadLimiter, writeLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

// Which boxes take bids, plus the signed-in person's own bids. Other
// people's bids are never shown.
router.get("/", publicReadLimiter, optionalAuth, getOverview);

// Placing a bid, and answering a counter offer, need a login.
router.post("/:spaceId", requireAuth, writeLimiter, bid);
router.post("/:spaceId/respond", requireAuth, writeLimiter, respond);

module.exports = router;