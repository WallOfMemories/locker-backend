const crypto = require("crypto");

const razorpay = require("../config/razorpay");

const SNAP_PRICE = 2;
const AMOUNT_IN_PAISE = SNAP_PRICE * 100;

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

    const { spaceId } = req.body;

    if (!spaceId) {
      return res.status(400).json({
        success: false,
        message: "Space ID is required",
      });
    }

    const order = await razorpay.orders.create({
      amount: AMOUNT_IN_PAISE,
      currency: "INR",
      receipt: makeReceipt("snap"),
      notes: {
        userId,
        spaceId: String(spaceId),
        purpose: "SnapWall space",
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
    return handleRazorpayError(
      res,
      error,
      "Failed to create payment order"
    );
  }
}

// POST /api/payments/test-order  (TEST ONLY)
async function createTestOrder(req, res) {
  try {
    const userId = req.user.uid;

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
        purpose: "SnapWall test payment",
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

  // TODO (full implementation): this is where the payment is recorded and
  // the space is unlocked. Before doing that, also (1) fetch the order with
  // razorpay.orders.fetch(orderId) and confirm notes.userId === req.user.uid
  // and the amount, and (2) make it idempotent so a replayed request can't
  // grant a space twice.
  return res.status(200).json({
    success: true,
    message: "Payment verified",
    orderId,
    paymentId,
  });
}

module.exports = {
  createPaymentOrder,
  createTestOrder,
  verifyPayment,
};