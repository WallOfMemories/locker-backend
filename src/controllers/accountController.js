const {
  AccountError,
  getPrivacySettings,
  savePrivacySettings,
  getAccountSummary,
  requestDeletion,
  cancelDeletion,
  createSupportRequest,
} = require("../services/accountService");

// One place that turns an AccountError into a clean JSON reply; anything
// unexpected becomes a generic 500 (and is logged).
function fail(res, label, error, fallbackMessage) {
  if (error instanceof AccountError) {
    return res.status(error.status).json({
      success: false,
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
  }

  console.error(`${label}:`, error);

  return res.status(500).json({ success: false, message: fallbackMessage });
}

// GET /api/account/privacy
async function getPrivacy(req, res) {
  try {
    const privacy = await getPrivacySettings(req.user.uid);

    return res.json({ success: true, privacy });
  } catch (error) {
    return fail(res, "Get privacy error", error, "Failed to load privacy settings");
  }
}

// PUT /api/account/privacy   body: { showPhoto?, showLocation?, notifyOnLikes? }
async function updatePrivacy(req, res) {
  try {
    const privacy = await savePrivacySettings(req.user.uid, req.body);

    return res.json({ success: true, privacy });
  } catch (error) {
    return fail(res, "Update privacy error", error, "Failed to save privacy settings");
  }
}

// GET /api/account/summary
async function getSummary(req, res) {
  try {
    const summary = await getAccountSummary(req.user.uid);

    return res.json({ success: true, summary });
  } catch (error) {
    return fail(res, "Account summary error", error, "Failed to load account details");
  }
}

// POST /api/account/delete-request
// req.user.auth_time = when the person last really signed in (seconds).
async function requestAccountDeletion(req, res) {
  try {
    const summary = await requestDeletion(req.user.uid, req.user.auth_time);

    return res.json({ success: true, summary });
  } catch (error) {
    return fail(res, "Request deletion error", error, "Failed to request account deletion");
  }
}

// POST /api/account/cancel-deletion
async function cancelAccountDeletion(req, res) {
  try {
    const summary = await cancelDeletion(req.user.uid);

    return res.json({ success: true, summary });
  } catch (error) {
    return fail(res, "Cancel deletion error", error, "Failed to cancel account deletion");
  }
}

// POST /api/account/support   body: { category, message }
async function sendSupportRequest(req, res) {
  try {
    const result = await createSupportRequest(
      req.user.uid,
      req.user.email,
      req.body
    );

    return res.status(201).json({ success: true, id: result.id });
  } catch (error) {
    return fail(res, "Support request error", error, "Failed to send your message");
  }
}

module.exports = {
  getPrivacy,
  updatePrivacy,
  getSummary,
  requestAccountDeletion,
  cancelAccountDeletion,
  sendSupportRequest,
};