const express = require("express");

const {
  getSpaces,
  initializeSpaces,
} = require("../controllers/spaceController");

const router = express.Router();

router.get("/", getSpaces);

router.post("/initialize", initializeSpaces);

module.exports = router;