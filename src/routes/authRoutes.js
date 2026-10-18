const express = require("express");

const {
  usernameLogin,
  forgotPassword,
} = require("../controllers/authController");

const {
  loginLimiter,
  usernameAttemptLimiter,
} = require("../middleware/rateLimiters");

const router = express.Router();

// Public by necessity (they run before sign-in), so they are limited both
// per IP and per username (stops guessing one account from many IPs).
router.post("/username-login", loginLimiter, usernameAttemptLimiter, usernameLogin);
router.post("/forgot-password", loginLimiter, usernameAttemptLimiter, forgotPassword);

module.exports = router;
