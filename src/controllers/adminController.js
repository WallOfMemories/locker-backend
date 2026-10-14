const wallService = require("../services/wallService");
const settingsService = require("../services/settingsService");
const paymentService = require("../services/paymentService");
const dashboardService = require("../services/dashboardService");

function handleError(res, error, fallbackMessage) {
  if (error instanceof wallService.WallError) {
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

// Wall-size settings the admin is allowed to change. Returns only the
// fields that were sent, or { error } describing the first bad one.
function validateWallSettings(body = {}) {
  const updates = {};

  if (body.expansionThreshold !== undefined) {
    const value = Number(body.expansionThreshold);

    if (!Number.isInteger(value) || value < 1 || value > 100) {
      return { error: "Threshold must be a whole number from 1 to 100." };
    }

    updates.expansionThreshold = value;
  }

  if (body.expansionBatchSize !== undefined) {
    const value = Number(body.expansionBatchSize);

    if (
      !Number.isInteger(value) ||
      value < 1 ||
      value > wallService.MAX_ADD_PER_ACTION
    ) {
      return {
        error: `Batch size must be a whole number from 1 to ${wallService.MAX_ADD_PER_ACTION}.`,
      };
    }

    updates.expansionBatchSize = value;
  }

  if (body.autoExpand !== undefined) {
    if (typeof body.autoExpand !== "boolean") {
      return { error: "autoExpand must be true or false." };
    }

    updates.autoExpand = body.autoExpand;
  }

  if (Object.keys(updates).length === 0) {
    return { error: "Nothing to update." };
  }

  return { updates };
}

// GET /api/admin/dashboard
async function getDashboard(req, res) {
  try {
    const dashboard = await dashboardService.getDashboard();

    return res.status(200).json({ success: true, ...dashboard });
  } catch (error) {
    return handleError(res, error, "Failed to load the dashboard");
  }
}

// GET /api/admin/payments
async function getPayments(req, res) {
  try {
    const data = await paymentService.listForAdmin();

    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    return handleError(res, error, "Failed to load payments");
  }
}

// GET /api/admin/wall
async function getWall(req, res) {
  try {
    const [wall, settings, expansions] = await Promise.all([
      wallService.getWallInfo(),
      settingsService.getSnapWallSettings(),
      wallService.listExpansions(),
    ]);

    return res.status(200).json({
      success: true,
      wall,
      settings: {
        expansionThreshold: settings?.expansionThreshold ?? 80,
        expansionBatchSize: settings?.expansionBatchSize ?? 50,
        autoExpand: settings?.autoExpand === true,
      },
      limits: {
        maxAddPerAction: wallService.MAX_ADD_PER_ACTION,
        maxTotalSpaces: wallService.MAX_TOTAL_SPACES,
      },
      expansions,
    });
  } catch (error) {
    return handleError(res, error, "Failed to load the wall");
  }
}

// POST /api/admin/wall/expand   { count }
async function expandWall(req, res) {
  try {
    const result = await wallService.expandWall({
      count: req.body?.count,
      source: "manual",
      adminId: req.user.uid,
    });

    return res.status(201).json({
      success: true,
      message: `Added ${result.added} spaces.`,
      ...result,
    });
  } catch (error) {
    return handleError(res, error, "Failed to expand the wall");
  }
}

// PUT /api/admin/wall/settings   { autoExpand?, expansionThreshold?, expansionBatchSize? }
async function updateWallSettings(req, res) {
  try {
    const { updates, error } = validateWallSettings(req.body);

    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    const settings = await settingsService.updateSnapWallSettings(updates);

    return res.status(200).json({
      success: true,
      message: "Wall settings saved.",
      settings: {
        expansionThreshold: settings.expansionThreshold,
        expansionBatchSize: settings.expansionBatchSize,
        autoExpand: settings.autoExpand === true,
      },
    });
  } catch (error) {
    return handleError(res, error, "Failed to save wall settings");
  }
}

module.exports = {
  getDashboard,
  getPayments,
  getWall,
  expandWall,
  updateWallSettings,
};