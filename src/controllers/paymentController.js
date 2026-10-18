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
const { isSpaceId } = require("../utils/validate");

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

    const { spaceId } = req.body || {};

    if (!isSpaceId(spaceId)) {
      return res.status(400).json({
        success: false,
        message: "A valid space ID is required",
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

    if (!isSpaceId(spaceId)) {
      return res.status(400).json({
        success: false,
        message: "A valid space ID is required",
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
  // The ₹1 test button must not exist on a live site (it would let anyone
  // create real charges that are never refunded). Opt in with
  // ENABLE_TEST_PAYMENTS=true when testing on a staging deployment.
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ENABLE_TEST_PAYMENTS !== "true"
  ) {
    return res.status(404).json({
      success: false,
      message: "Not found",
    });
  }

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
    (value) =>
      typeof value === "string" &&
      value.trim() !== "" &&
      value.length <= 128
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

// POST /api/payments/webhook   (called by Razorpay, not by the browser)
//
// Safety net for "paid, then closed the tab before /verify ran". Razorpay
// tells us about every captured payment; we check its signature, ask
// Razorpay for the order (the source of truth for who it belongs to), and
// record it exactly like /verify does. Recording is idempotent, so it makes
// no difference whether /verify, the webhook, or both arrive.
//
// Set up in Razorpay Dashboard > Settings > Webhooks:
//   URL:    https://<your-api>/api/payments/webhook
//   Secret: same value as RAZORPAY_WEBHOOK_SECRET
//   Events: payment.captured (and order.paid)
//
// Must receive the RAW body (see app.js) — the signature covers exact bytes.
async function razorpayWebhook(req, res) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (!secret) {
    return res.status(503).json({ success: false, message: "Webhook not configured" });
  }

  const rawBody = req.body;
  const received = req.get("x-razorpay-signature") || "";

  if (!Buffer.isBuffer(rawBody) || !received) {
    return res.status(400).json({ success: false, message: "Invalid webhook" });
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(400).json({ success: false, message: "Invalid signature" });
  }

  let event;

  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ success: false, message: "Invalid JSON" });
  }

  // Only successful payments matter here; acknowledge everything else so
  // Razorpay stops retrying it.
  if (event?.event !== "payment.captured" && event?.event !== "order.paid") {
    return res.status(200).json({ success: true, ignored: true });
  }

  try {
    const payment = event.payload?.payment?.entity;
    const paymentId = payment?.id;
    const orderId = payment?.order_id || event.payload?.order?.entity?.id;

    if (
      typeof paymentId !== "string" ||
      typeof orderId !== "string" ||
      !paymentId ||
      !orderId
    ) {
      return res.status(200).json({ success: true, ignored: true });
    }

    const order = await razorpay.orders.fetch(orderId);
    const userId = order?.notes?.userId;

    // Not an order created by this app: nothing to record.
    if (!userId) {
      return res.status(200).json({ success: true, ignored: true });
    }

    const { created } = await recordPayment({
      paymentId,
      orderId,
      userId,
      amountPaise: Number(order.amount) || 0,
      currency: order.currency || "INR",
      kind: order.notes?.purpose === TEST_PURPOSE ? "test" : "space",
      spaceId: order.notes?.spaceId || "",
    });

    if (created) console.log(`Webhook recorded payment ${paymentId}`);

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Webhook processing failed:", error);

    // 5xx makes Razorpay retry later.
    return res.status(500).json({ success: false, message: "Could not process webhook" });
  }
}

module.exports = {
  razorpayWebhook,
  createPaymentOrder,
  releaseSpaceReservation,
  getMyPayments,
  createTestOrder,
  verifyPayment,
};