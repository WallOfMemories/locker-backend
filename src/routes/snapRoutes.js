const express = require("express");

const {
  createSnap, updateSnap, getMySnaps, likeSnap, unlikeSnap, getSnapLikeInfo, saveSnap, unsaveSnap, getSnapSaveInfo, getSavedSnaps,
  getLikedSnaps
} = require("../controllers/snapController");

const {
  reportSnap,
} = require("../controllers/moderationController");

// NEW: the owner hides / shows / deletes their own Snap
const {
  setSnapVisibility,
  deleteSnap,
} = require("../controllers/snapOwnerController");

const {
  requireAuth,
} = require("../middleware/authMiddleware");

const router = express.Router();

router.post(
  "/",
  requireAuth,
  createSnap
);
router.patch(
  "/:snapId",
  requireAuth,
  updateSnap
);
router.get(
  "/my",
  requireAuth,
  getMySnaps
);

// NEW: hide / show my Snap  { hidden: true | false }
router.put(
  "/:snapId/visibility",
  requireAuth,
  setSnapVisibility
);

// NEW: delete my Snap (the space becomes available again, no refund)
router.delete(
  "/:snapId",
  requireAuth,
  deleteSnap
);
router.post(
  "/:snapId/like",
  requireAuth,
  likeSnap
);

router.delete(
  "/:snapId/like",
  requireAuth,
  unlikeSnap
);

router.get(
  "/:snapId/likes",
  requireAuth,
  getSnapLikeInfo
);

router.post(
  "/:snapId/save",
  requireAuth,
  saveSnap
);

router.delete(
  "/:snapId/save",
  requireAuth,
  unsaveSnap
);

router.get(
  "/:snapId/save",
  requireAuth,
  getSnapSaveInfo
);

router.post(
  "/:snapId/report",
  requireAuth,
  reportSnap
);

router.get(
  "/saved",
  requireAuth,
  getSavedSnaps
);

router.get(
  "/liked",
  requireAuth,
  getLikedSnaps
);

module.exports = router;