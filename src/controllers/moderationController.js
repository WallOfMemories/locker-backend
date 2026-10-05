const moderationService = require("../services/moderationService");

function handleError(res, error, fallbackMessage) {
  if (error instanceof moderationService.ModerationError) {
    return res.status(error.status).json({
      success: false,
      message: error.message,
    });
  }

  console.error(fallbackMessage, error);

  return res.status(500).json({
    success: false,
    message: fallbackMessage,
  });
}

// POST /api/snaps/:snapId/report   { reason? }
async function reportSnap(req, res) {
  try {
    await moderationService.reportSnap(
      req.params.snapId,
      req.user.uid,
      req.body?.reason
    );

    return res.status(201).json({
      success: true,
      message: "Thanks — our team will review this Snap.",
    });
  } catch (error) {
    return handleError(res, error, "Failed to report Snap");
  }
}

// GET /api/admin/reports?tab=pending|hidden|history
async function getReports(req, res) {
  try {
    const tab = String(req.query.tab || "pending");
    const items = await moderationService.listForAdmin(tab);

    return res.status(200).json({
      success: true,
      tab,
      count: items.length,
      items,
    });
  } catch (error) {
    return handleError(res, error, "Failed to load reports");
  }
}

// POST /api/admin/snaps/:snapId/action   { action: hide|unhide|safe|delete }
async function moderateSnap(req, res) {
  try {
    const result = await moderationService.moderateSnap(
      req.params.snapId,
      String(req.body?.action || ""),
      req.user.uid
    );

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    return handleError(res, error, "Failed to update Snap");
  }
}

module.exports = {
  reportSnap,
  getReports,
  moderateSnap,
};