const express = require("express");

const {
  search,
  reverse,
} = require("../controllers/locationController");

const { requireAuth } = require("../middleware/authMiddleware");

const router = express.Router();

// Login required so the free map provider can't be hammered anonymously.
router.get("/search", requireAuth, search);
router.get("/reverse", requireAuth, reverse);

module.exports = router;