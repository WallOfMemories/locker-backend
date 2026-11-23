const {
  BidError,
  getBidOverview,
  placeBid,
  respondToCounter,
  getAdminBoard,
  acceptBid,
  rejectBid,
  counterBid,
  cancelBidding,
} = require("../services/bidService");
const { isSpaceId } = require("../utils/validate");
const { isDeletionPending } = require("../services/accountService");

function sendError(res, error, fallback) {
  if (error instanceof BidError) {
    return res.status(error.status).json({
      success: false,
      code: error.code,
      message: error.message,
    });
  }

  console.error(`${fallback}:`, error);

  return res.status(500).json({ success: false, message: fallback });
}

function badSpace(res) {
  return res.status(400).json({
    success: false,
    message: "A valid space ID is required",
  });
}

// ---------- public ----------

// GET /api/bids — which boxes take bids + the state of each box with bids
async function getOverview(req, res) {
  try {
    const overview = await getBidOverview(req.user?.uid || null);

    res.json({ success: true, ...overview });
  } catch (error) {
    sendError(res, error, "Failed to load bids");
  }
}

// ---------- signed-in ----------

// POST /api/bids/:spaceId   { amount }   (whole rupees)
async function bid(req, res) {
  try {
    const userId = req.user.uid;

    if (!isSpaceId(req.params.spaceId)) return badSpace(res);

    if (await isDeletionPending(userId)) {
      return res.status(403).json({
        success: false,
        message: "Your account is scheduled for deletion, so you can't place bids.",
      });
    }

    const amount = req.body?.amount;

    // Must be a real number, not a string like "100".
    if (typeof amount !== "number") {
      return res.status(400).json({
        success: false,
        message: "Enter your bid as a number",
      });
    }

    const box = await placeBid(req.params.spaceId, userId, amount);

    res.status(201).json({ success: true, box });
  } catch (error) {
    sendError(res, error, "Failed to place bid");
  }
}

// POST /api/bids/:spaceId/respond   { action: "accept" | "decline" }
// The bidder answers the admin's counter offer.
async function respond(req, res) {
  try {
    if (!isSpaceId(req.params.spaceId)) return badSpace(res);

    const box = await respondToCounter(
      req.params.spaceId,
      req.user.uid,
      req.body?.action
    );

    res.json({ success: true, box });
  } catch (error) {
    sendError(res, error, "Failed to answer the counter offer");
  }
}

// ---------- admin ----------

async function adminBoard(req, res) {
  try {
    res.json({ success: true, ...(await getAdminBoard()) });
  } catch (error) {
    sendError(res, error, "Failed to load bids");
  }
}

function bidderParam(req, res) {
  const { spaceId, userId } = req.params;

  if (!isSpaceId(spaceId) || !/^[A-Za-z0-9]{6,128}$/.test(userId)) {
    badSpace(res);
    return null;
  }

  return { spaceId, userId };
}

// Accept a bid: that person wins at their bid.
async function adminAccept(req, res) {
  try {
    const target = bidderParam(req, res);

    if (!target) return;

    res.json({
      success: true,
      ...(await acceptBid(target.spaceId, target.userId, req.user.uid)),
    });
  } catch (error) {
    sendError(res, error, "Failed to accept the bid");
  }
}

// Reject a bid.
async function adminReject(req, res) {
  try {
    const target = bidderParam(req, res);

    if (!target) return;

    res.json({ success: true, ...(await rejectBid(target.spaceId, target.userId)) });
  } catch (error) {
    sendError(res, error, "Failed to reject the bid");
  }
}

// Counter offer: { amount } in whole rupees.
async function adminCounter(req, res) {
  try {
    const target = bidderParam(req, res);

    if (!target) return;

    if (typeof req.body?.amount !== "number") {
      return res.status(400).json({
        success: false,
        message: "Enter the counter offer as a number",
      });
    }

    res.json({
      success: true,
      ...(await counterBid(target.spaceId, target.userId, req.body.amount)),
    });
  } catch (error) {
    sendError(res, error, "Failed to send the counter offer");
  }
}

async function adminCancel(req, res) {
  try {
    if (!isSpaceId(req.params.spaceId)) return badSpace(res);

    const result = await cancelBidding(req.params.spaceId);

    res.json({ success: true, ...result });
  } catch (error) {
    sendError(res, error, "Failed to cancel bidding");
  }
}

module.exports = {
  getOverview,
  bid,
  respond,
  adminBoard,
  adminAccept,
  adminReject,
  adminCounter,
  adminCancel,
};