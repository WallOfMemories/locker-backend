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

const router = express.Router();

router.get("/me", requireAuth, getMyProfile);

router.put("/me", requireAuth, updateMyProfile);

router.post("/setup", requireAuth, setupProfile);

router.get(
  "/username-available",
  requireAuth,
  checkUsername
);

module.exports = router;