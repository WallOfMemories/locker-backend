const express = require("express");

const {
  createPaymentOrder,
  releaseSpaceReservation,
  getMyPayments,
  createTestOrder,
  verifyPayment,
} = require("../controllers/paymentController");

const {
  requireAuth,
} = require("../middleware/authMiddleware");

const router = express.Router();

router.post(
  "/create-order",
  requireAuth,
  createPaymentOrder
);

// NEW: the person closed the payment window — free the space again.
router.post(
  "/release",
  requireAuth,
  releaseSpaceReservation
);

// NEW: the logged-in person's payments (Payment History page).
router.get(
  "/my",
  requireAuth,
  getMyPayments
);

// TEST ONLY: ₹1 order for the Razorpay test button.
router.post(
  "/test-order",
  requireAuth,
  createTestOrder
);

// Checks the signature Razorpay Checkout returns after payment.
router.post(
  "/verify",
  requireAuth,
  verifyPayment
);

module.exports = router;