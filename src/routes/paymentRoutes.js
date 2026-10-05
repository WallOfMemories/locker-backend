const express = require("express");

const {
  createPaymentOrder,
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