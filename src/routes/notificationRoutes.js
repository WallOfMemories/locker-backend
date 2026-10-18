const express = require("express");

const {
  getMyNotifications,
  getUnreadCount,
  readOne,
  readAll,
  deleteOne,
  deleteAll,
} = require("../controllers/notificationController");

const { requireAuth } = require("../middleware/authMiddleware");
const { writeLimiter } = require("../middleware/rateLimiters");
const { validateParams } = require("../utils/validate");

const router = express.Router();

router.get("/", requireAuth, getMyNotifications);

// Fixed paths first, so "unread-count" / "read-all" are never mistaken for an :id.
router.get("/unread-count", requireAuth, getUnreadCount);
router.put("/read-all", requireAuth, writeLimiter, readAll);

router.put("/:id/read", requireAuth, writeLimiter, validateParams("id"), readOne);

router.delete("/", requireAuth, writeLimiter, deleteAll);
router.delete("/:id", requireAuth, writeLimiter, validateParams("id"), deleteOne);

module.exports = router;
