const {
  OwnerError,
  setOwnerHidden,
  deleteOwnSnap,
} = require("../services/snapOwnerService");

function handleError(res, error, fallbackMessage) {
  if (error instanceof OwnerError) {
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

// PUT /api/snaps/:snapId/visibility    { hidden: true | false }
// Hide or show my own Snap. Safe to repeat (setting the same value again
// does nothing).
async function setSnapVisibility(req, res) {
  try {
    const { hidden } = req.body || {};

    if (typeof hidden !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "hidden must be true or false",
      });
    }

    const result = await setOwnerHidden(
      req.params.snapId,
      req.user.uid,
      hidden
    );

    return res.status(200).json({
      success: true,
      message: hidden ? "Snap hidden" : "Snap is visible again",
      ...result,
    });
  } catch (error) {
    return handleError(res, error, "Failed to update the Snap");
  }
}

// DELETE /api/snaps/:snapId
// Delete my own Snap. The space becomes available again. No refund.
async function deleteSnap(req, res) {
  try {
    const result = await deleteOwnSnap(req.params.snapId, req.user.uid);

    return res.status(200).json({
      success: true,
      message: "Snap deleted. Your space is free again.",
      ...result,
    });
  } catch (error) {
    return handleError(res, error, "Failed to delete the Snap");
  }
}

module.exports = {
  setSnapVisibility,
  deleteSnap,
};