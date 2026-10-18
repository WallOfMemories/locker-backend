const express = require("express");

const {
  getMyProfile,
  setupProfile,
  updateMyProfile,
  checkUsername,
} = require("../controllers/userController");

const {
  requireAuth,
} = require("../middleware/authMiddleware");

const { writeLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

router.get("/me", requireAuth, getMyProfile);

router.put("/me", requireAuth, writeLimiter, updateMyProfile);

router.post("/setup", requireAuth, writeLimiter, setupProfile);

router.get(
  "/username-available",
  requireAuth,
  writeLimiter,
  checkUsername
);

module.exports = router;