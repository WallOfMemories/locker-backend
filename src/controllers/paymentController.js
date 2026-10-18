const crypto = require("crypto");

const razorpay = require("../config/razorpay");
const { getSnapWallSettings } = require("../services/settingsService");
const {
  recordPayment,
  listForUser,
} = require("../services/paymentService");
const {
  SpaceError,
  reserveSpace,
  releaseSpace,
} = require("../services/reservationService");
// NEW: an account waiting to be deleted must not buy anything
const { isDeletionPending } = require("../services/accountService");

const DELETION_PENDING_RESPONSE = {
  success: false,
  message:
    "Your account is scheduled for deletion. Cancel the deletion in Settings before buying a space.",
};

// Fallback only — the real price is read from settings/snapwall.spacePrice.
// CHANGED: ₹2 -> ₹10
const DEFAULT_SNAP_PRICE = 10;

// Order notes use these so /verify knows what kind of payment it is.
const SPACE_PURPOSE = "SnapWall space";
const TEST_PURPOSE = "SnapWall test payment";

// Razorpay's minimum order is 100 paise (₹1).
const MIN_AMOUNT_IN_PAISE = 100;

// TEST ONLY: fixed ₹1 order used by the "Razorpay test" button on the
// Payment History page. The amount lives on the server, so the browser
// can never choose what it pays.
const TEST_AMOUNT_IN_PAISE = 100;

// Razorpay rejects receipts longer than 40 characters.
// CHANGED: the old receipt `snap_${userId}_${Date.now()}` was ~47 characters
// (a Firebase uid is 28), so Razorpay would have refused every order.
// The user id is still kept — in `notes`, which has no such limit.
function makeReceipt(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto
    .randomBytes(4)
    .toString("hex")}`;
}

// Maps a Razorpay SDK error to a response.
//   401 -> wrong / missing key id or secret (check backend/.env)
//   500 -> anything else
function handleRazorpayError(res, error, message) {
  console.error(`${message}:`, error);

  if (error?.statusCode === 401) {
    return res.status(401).json({
      success: false,
      message:
        "Razorpay authentication failed. Check RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in backend/.env.",
    });
  }

  return res.status(500).json({
    success: false,
    message,
  });
}

async function createPaymentOrder(req, res) {
  try {
    const userId = req.user.uid;

    if (await isDeletionPending(userId)) {
      return res.status(403).json(DELETION_PENDING_RESPONSE);
    }

    const { spaceId } = req.body;

    if (!spaceId) {
      return res.status(400).json({
        success: false,
        message: "Space ID is required",
      });
    }

    // NEW: make sure the space is still free, and hold it for this person
    // while they pay — so nobody pays for a space that gets taken.
    await reserveSpace(String(spaceId), userId);

    // CHANGED: the price used to be a hard-coded constant, so it could
    // drift from the price shown on the wall. Now both read settings.
    const settings = await getSnapWallSettings();
    const price = Number(settings?.spacePrice) || DEFAULT_SNAP_PRICE;

    const order = await razorpay.orders.create({
      amount: Math.round(price * 100),
      currency: "INR",
      receipt: makeReceipt("snap"),
      notes: {
        userId,
        spaceId: String(spaceId),
        purpose: SPACE_PURPOSE,
      },
    });

    return res.status(201).json({
      success: true,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
      },
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    if (error instanceof SpaceError) {
      return res.status(error.status).json({
        success: false,
        code: error.code,
        message: error.message,
      });
    }

    return handleRazorpayError(
      res,
      error,
      "Failed to create payment order"
    );
  }
}

// NEW — POST /api/payments/release   { spaceId }
// The person closed the payment window: free the space for others.
async function releaseSpaceReservation(req, res) {
  try {
    const { spaceId } = req.body || {};

    if (!spaceId) {
      return res.status(400).json({
        success: false,
        message: "Space ID is required",
      });
    }

    await releaseSpace(String(spaceId), req.user.uid);

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Failed to release space:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to release the space",
    });
  }
}

// NEW — GET /api/payments/my
// The logged-in person's payments, for the Payment History page.
async function getMyPayments(req, res) {
  try {
    const data = await listForUser(req.user.uid);

    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    console.error("Failed to load payments:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load your payments",
    });
  }
}

// POST /api/payments/test-order  (TEST ONLY)
async function createTestOrder(req, res) {
  try {
    const userId = req.user.uid;

    if (await isDeletionPending(userId)) {
      return res.status(403).json(DELETION_PENDING_RESPONSE);
    }

    if (TEST_AMOUNT_IN_PAISE < MIN_AMOUNT_IN_PAISE) {
      return res.status(400).json({
        success: false,
        message: "Amount must be at least 100 paise (₹1)",
      });
    }

    const order = await razorpay.orders.create({
      amount: TEST_AMOUNT_IN_PAISE,
      currency: "INR",
      receipt: makeReceipt("test"),
      notes: {
        userId,
        purpose: TEST_PURPOSE,
      },
    });

    return res.status(201).json({
      success: true,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
      },
      // The key ID is public by design. The secret never leaves the server.
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    return handleRazorpayError(
      res,
      error,
      "Failed to create test payment order"
    );
  }
}

// POST /api/payments/verify
// Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
//
// Razorpay signs "<order_id>|<payment_id>" with the account's key secret
// (HMAC-SHA256). We recompute it and only report success if it matches.
async function verifyPayment(req, res) {
  const {
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: signature,
  } = req.body || {};

  const hasAllFields = [orderId, paymentId, signature].every(
    (value) => typeof value === "string" && value.trim() !== ""
  );

  if (!hasAllFields) {
    return res.status(400).json({
      success: false,
      message:
        "razorpay_order_id, razorpay_payment_id and razorpay_signature are required",
    });
  }

  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(signature, "utf8");

  // timingSafeEqual throws when lengths differ, so check that first.
  const isValid =
    expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, receivedBuffer);

  if (!isValid) {
    // Do NOT mark anything as paid.
    return res.status(400).json({
      success: false,
      message: "Payment verification failed: invalid signature",
    });
  }

  // The payment is recorded (this is what the admin Payments page and the
  // person's Payment History list). Before recording, the order is fetched
  // from Razorpay to confirm it belongs to the logged-in user and to get the
  // real amount. Recording is idempotent: the payment id is the document id,
  // so a replayed request can't create a second record.
  //
  // The space is NOT claimed here — POST /api/snaps does that, and it only
  // accepts a recorded, unused payment for that exact space.
  try {
    let order;

    try {
      order = await razorpay.orders.fetch(orderId);
    } catch (error) {
      return handleRazorpayError(
        res,
        error,
        "Payment was verified but the order could not be confirmed"
      );
    }

    if (order?.notes?.userId !== req.user.uid) {
      return res.status(403).json({
        success: false,
        message: "This payment does not belong to your account",
      });
    }

    const { created } = await recordPayment({
      paymentId,
      orderId,
      userId: req.user.uid,
      amountPaise: Number(order.amount) || 0,
      currency: order.currency || "INR",
      kind: order.notes?.purpose === TEST_PURPOSE ? "test" : "space",
      spaceId: order.notes?.spaceId || "",
    });

    return res.status(200).json({
      success: true,
      message: created ? "Payment verified" : "Payment already verified",
      orderId,
      paymentId,
    });
  } catch (error) {
    console.error("Failed to record payment:", error);

    return res.status(500).json({
      success: false,
      message: "Payment was verified but could not be saved",
    });
  }
}

module.exports = {
  createPaymentOrder,
  releaseSpaceReservation,
  getMyPayments,
  createTestOrder,
  verifyPayment,
};