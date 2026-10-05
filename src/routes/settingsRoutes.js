const express = require("express");

const {
  initializeSnapWallSettings,
  getSnapWallSettings,
} = require("../controllers/settingsController");

const router = express.Router();

router.get("/", getSnapWallSettings);

router.post("/initialize", initializeSnapWallSettings);

module.exports = router;