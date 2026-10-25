const express = require("express");

const {
  createSnap, updateSnap, getMySnaps, likeSnap, unlikeSnap, getSnapLikeInfo, saveSnap, unsaveSnap, getSnapSaveInfo, getSavedSnaps,
  getLikedSnaps
} = require("../controllers/snapController");

const {
  reportSnap,
} = require("../controllers/moderationController");

// The owner hides / shows / deletes their own Snap
const {
  setSnapVisibility,
  deleteSnap,
} = require("../controllers/snapOwnerController");

const {
  optionalAuth,
  requireAuth,
} = require("../middleware/authMiddleware");

const { writeLimiter, publicReadLimiter } = require("../middleware/rateLimiters");
const { validateParams } = require("../utils/validate");

const router = express.Router();

// PUBLIC (declared before requireAuth): visitors who are not logged in can see
// how many likes a Snap has. Signed-in people also get their own liked / saved
// state back. Nobody can like or save without logging in (routes below).
router.get(
  "/:snapId/likes",
  publicReadLimiter,
  optionalAuth,
  validateParams("snapId"),
  getSnapLikeInfo
);
router.get(
  "/:snapId/save",
  publicReadLimiter,
  optionalAuth,
  validateParams("snapId"),
  getSnapSaveInfo
);

// Every other route here needs a signed-in person, and every :snapId is checked
// before it can reach the database.
router.use(requireAuth);

router.post("/", writeLimiter, createSnap);

// Fixed paths first (they must never be read as a :snapId).
router.get("/my", getMySnaps);
router.get("/saved", getSavedSnaps);
router.get("/liked", getLikedSnaps);

router.patch("/:snapId", writeLimiter, validateParams("snapId"), updateSnap);

// Hide / show my Snap  { hidden: true | false }
router.put(
  "/:snapId/visibility",
  writeLimiter,
  validateParams("snapId"),
  setSnapVisibility
);

// Delete my Snap (the space becomes available again, no refund)
router.delete("/:snapId", writeLimiter, validateParams("snapId"), deleteSnap);

router.post("/:snapId/like", writeLimiter, validateParams("snapId"), likeSnap);
router.delete("/:snapId/like", writeLimiter, validateParams("snapId"), unlikeSnap);

router.post("/:snapId/save", writeLimiter, validateParams("snapId"), saveSnap);
router.delete("/:snapId/save", writeLimiter, validateParams("snapId"), unsaveSnap);

router.post("/:snapId/report", writeLimiter, validateParams("snapId"), reportSnap);

module.exports = router;