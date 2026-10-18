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

const router = express.Router();

router.get("/", requireAuth, getMyNotifications);

// Fixed paths first, so "unread-count" / "read-all" are never mistaken for an :id.
router.get("/unread-count", requireAuth, getUnreadCount);
router.put("/read-all", requireAuth, readAll);

router.put("/:id/read", requireAuth, readOne);

router.delete("/", requireAuth, deleteAll);
router.delete("/:id", requireAuth, deleteOne);

module.exports = router;