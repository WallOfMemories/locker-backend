const express = require("express");

const {
  resolveUsername,
} = require("../controllers/authController");

const router = express.Router();

router.post("/resolve-username", resolveUsername);

module.exports = router;