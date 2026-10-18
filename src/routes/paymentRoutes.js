const express = require("express");

const {
  createPaymentOrder,
  releaseSpaceReservation,
  getMyPayments,
  createTestOrder,
  verifyPayment,
} = require("../controllers/paymentController");

const { requireStrictAuth } = require("../middleware/authMiddleware");
const { paymentLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

// Money routes: account must still be enabled (checkRevoked) and each
// person is rate limited.
router.use(requireStrictAuth, paymentLimiter);

router.post("/create-order", createPaymentOrder);

// The person closed the payment window — free the space again.
router.post("/release", releaseSpaceReservation);

// The logged-in person's payments (Payment History page).
router.get("/my", getMyPayments);

// TEST ONLY: ₹1 order for the Razorpay test button. Disabled in production
// unless ENABLE_TEST_PAYMENTS=true.
router.post("/test-order", createTestOrder);

// Checks the signature Razorpay Checkout returns after payment.
router.post("/verify", verifyPayment);

module.exports = router;
