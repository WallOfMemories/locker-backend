const {
  listForUser,
  countUnread,
  markRead,
  markAllRead,
  remove,
  removeAll,
} = require("../services/notificationService");

// Every handler only ever touches req.user.uid's own notifications, so one
// person can never read or change someone else's.

function fail(res, label, error, message) {
  console.error(`${label}:`, error);

  return res.status(500).json({ success: false, message });
}

// GET /api/notifications -> { notifications, unreadCount }
async function getMyNotifications(req, res) {
  try {
    const data = await listForUser(req.user.uid);

    return res.json({ success: true, ...data });
  } catch (error) {
    return fail(res, "List notifications error", error, "Failed to load notifications");
  }
}

// GET /api/notifications/unread-count -> { unreadCount }   (cheap, polled)
async function getUnreadCount(req, res) {
  try {
    const unreadCount = await countUnread(req.user.uid);

    return res.json({ success: true, unreadCount });
  } catch (error) {
    return fail(res, "Unread count error", error, "Failed to load notifications");
  }
}

// PUT /api/notifications/:id/read
async function readOne(req, res) {
  try {
    const found = await markRead(req.user.uid, req.params.id);

    if (!found) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }

    return res.json({ success: true });
  } catch (error) {
    return fail(res, "Mark read error", error, "Failed to update notification");
  }
}

// PUT /api/notifications/read-all
async function readAll(req, res) {
  try {
    const updated = await markAllRead(req.user.uid);

    return res.json({ success: true, updated });
  } catch (error) {
    return fail(res, "Mark all read error", error, "Failed to update notifications");
  }
}

// DELETE /api/notifications/:id
async function deleteOne(req, res) {
  try {
    await remove(req.user.uid, req.params.id);

    return res.json({ success: true });
  } catch (error) {
    return fail(res, "Delete notification error", error, "Failed to delete notification");
  }
}

// DELETE /api/notifications   (clear everything)
async function deleteAll(req, res) {
  try {
    await removeAll(req.user.uid);

    return res.json({ success: true });
  } catch (error) {
    return fail(res, "Clear notifications error", error, "Failed to clear notifications");
  }
}

module.exports = {
  getMyNotifications,
  getUnreadCount,
  readOne,
  readAll,
  deleteOne,
  deleteAll,
};