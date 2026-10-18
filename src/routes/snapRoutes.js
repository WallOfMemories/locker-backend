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
  requireAuth,
} = require("../middleware/authMiddleware");

const { writeLimiter } = require("../middleware/rateLimiters");
const { validateParams } = require("../utils/validate");

const router = express.Router();

// Every route here needs a signed-in person, and every :snapId is checked
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
router.get("/:snapId/likes", validateParams("snapId"), getSnapLikeInfo);

router.post("/:snapId/save", writeLimiter, validateParams("snapId"), saveSnap);
router.delete("/:snapId/save", writeLimiter, validateParams("snapId"), unsaveSnap);
router.get("/:snapId/save", validateParams("snapId"), getSnapSaveInfo);

router.post("/:snapId/report", writeLimiter, validateParams("snapId"), reportSnap);

module.exports = router;
