const { db } = require("../config/firebase");
const {
  toDate,
  toISO,
  isSnapLocked,
} = require("../services/capsuleService");
const { autoExpandIfNeeded } = require("../services/wallService");
const { refundPayment } = require("../services/paymentService");
const { isReservedByOther } = require("../services/reservationService");
// NEW: notify the owner when their Snap is liked
const { notifySnapLiked } = require("../services/notificationService");
// NEW: honour each author's privacy settings
const { getPrivacy } = require("../services/privacyService");
const { runInBackground } = require("../utils/background");
const {
  isSafeId,
  isSpaceId,
  isOwnSnapStoragePath,
  isFirebaseDownloadUrl,
} = require("../utils/validate");

// Time-lock limits (the browser enforces these too, but the server is the
// one that actually decides).
const MIN_LOCK_MS = 60 * 1000; // at least 1 minute ahead
const MAX_LOCK_YEARS = 10;
const MAX_CAPTION_LENGTH = 100; // keep in sync with CreateSnap.jsx

// Validates the optional location picked on the Create Snap page.
// -> { ok: true, value: null | {...} } | { ok: false }
function sanitizeLocation(raw) {
  if (raw === undefined || raw === null) {
    return { ok: true, value: null };
  }

  if (typeof raw !== "object") return { ok: false };

  const name = String(raw.name || "").trim().slice(0, 120);
  const address = String(raw.address || "").trim().slice(0, 255);

  if (!name) return { ok: false };

  // NEW: a place the person typed themselves (not found in the map data)
  // is allowed without coordinates. If coordinates ARE sent they must be
  // valid.
  const hasCoords =
    raw.lat !== null &&
    raw.lat !== undefined &&
    raw.lng !== null &&
    raw.lng !== undefined;

  let lat = null;
  let lng = null;

  if (hasCoords) {
    lat = Number(raw.lat);
    lng = Number(raw.lng);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      return { ok: false };
    }
  }

  return {
    ok: true,
    value: {
      name,
      address,
      lat,
      lng,
      placeId: raw.id ? String(raw.id).slice(0, 64) : null,
    },
  };
}

// Timestamps -> ISO strings for the browser; hides internal fields.
function serializeSnap(snap) {
  const { pendingUnlockAt, ...rest } = snap; // eslint-disable-line no-unused-vars

  return {
    ...rest,
    unlockAt: toISO(snap.unlockAt),
    publishedAt: toISO(snap.publishedAt),
    // NEW: when the owner hid it (the flag itself, ownerHidden, comes
    // through in ...rest)
    ownerHiddenAt: toISO(snap.ownerHiddenAt),
  };
}

// Snaps only store the author's userId. Liked / Saved lists show other
// people's Snaps, so look up each author once and attach their username +
// photo (the browser can't read other users' profiles itself).
// CHANGED: takes the viewer's id, so a person always still sees their own
// photo / location on their own Snaps.
async function withAuthors(snaps, viewerId) {
  const userIds = [
    ...new Set(snaps.map((snap) => snap.userId).filter(Boolean)),
  ];

  if (userIds.length === 0) return snaps;

  const userDocs = await db.getAll(
    ...userIds.map((id) => db.collection("users").doc(id))
  );

  const authors = {};

  userDocs.forEach((doc) => {
    if (doc.exists) authors[doc.id] = doc.data();
  });

  return snaps.map((snap) => {
    const author = authors[snap.userId] || {};

    // NEW: Settings > Privacy. Authors can hide their photo / location from
    // other people (never from themselves).
    const privacy = getPrivacy(author);
    const isViewer = snap.userId === viewerId;

    return {
      ...snap,
      username: author.username || "",
      userPhotoURL: isViewer || privacy.showPhoto ? author.photoURL || "" : "",
      location: isViewer || privacy.showLocation ? snap.location || null : null,
    };
  });
}

const HIDDEN_RESPONSE = {
  success: false,
  message: "This Snap has been hidden by the moderators.",
};

// NEW: the owner hid their own Snap
const OWNER_HIDDEN_RESPONSE = {
  success: false,
  message: "This Snap has been hidden by its owner.",
};

const LOCKED_RESPONSE = {
  success: false,
  message: "This Snap is still locked. It becomes public when its time is up.",
};

async function createSnap(req, res) {
  // NEW: set once the payment has been checked, so that if the SPACE turns
  // out to be gone we know there is a valid payment to give back.
  let paymentToRefund = null;

  try {
    const {
        spaceId,
        imageUrl,
        storagePath,
        caption,
        snapType,
        location,
        unlockAt,
        paymentId, // NEW: the verified Razorpay payment that buys this space
    } = req.body || {};

    const userId = req.user.uid;

    // ---------- Payment (NEW) ----------
    // Posting a Snap costs money: no verified payment, no Snap.
    if (typeof paymentId !== "string" || paymentId.trim() === "") {
      return res.status(402).json({
        success: false,
        message: "Payment is required to post a Snap",
      });
    }

    if (
      !userId ||
      !spaceId ||
      !imageUrl ||
      !storagePath
    ) {
      return res.status(400).json({
        success: false,
        message: "Missing required Snap information",
      });
    }

    // ---------- Shape checks (everything here is untrusted input) ----------
    if (!isSpaceId(spaceId) || !isSafeId(paymentId.trim())) {
      return res.status(400).json({
        success: false,
        message: "Invalid space or payment",
      });
    }

    if (caption !== undefined && caption !== null && typeof caption !== "string") {
      return res.status(400).json({
        success: false,
        message: "Caption must be text",
      });
    }

    if (
      snapType !== undefined &&
      snapType !== null &&
      snapType !== "post" &&
      snapType !== "capsule"
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid Snap type",
      });
    }

    // The photo must be one this person uploaded to OUR Storage bucket.
    if (
      !isOwnSnapStoragePath(storagePath, userId) ||
      !isFirebaseDownloadUrl(imageUrl, {
        bucket: process.env.FIREBASE_STORAGE_BUCKET || "",
        storagePath,
      })
    ) {
      return res.status(400).json({
        success: false,
        message: "That photo is not valid. Please upload it again.",
      });
    }

    // ---------- Caption (max 100 characters) ----------
    if (caption && String(caption).trim().length > MAX_CAPTION_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `Caption can be at most ${MAX_CAPTION_LENGTH} characters`,
      });
    }

    // ---------- Location (optional) ----------
    const locationCheck = sanitizeLocation(location);

    if (!locationCheck.ok) {
      return res.status(400).json({
        success: false,
        message: "That location is not valid",
      });
    }

    // ---------- Locker (Time Capsule only) ----------
    const isCapsule = snapType === "capsule";
    let unlockDate = null;

    if (isCapsule) {
      unlockDate = toDate(unlockAt);

      if (!unlockDate) {
        return res.status(400).json({
          success: false,
          message: "Please choose when this capsule should unlock",
        });
      }

      const nowMs = Date.now();

      if (unlockDate.getTime() < nowMs + MIN_LOCK_MS) {
        return res.status(400).json({
          success: false,
          message: "The unlock time must be in the future",
        });
      }

      const latest = new Date();
      latest.setFullYear(latest.getFullYear() + MAX_LOCK_YEARS);

      if (unlockDate > latest) {
        return res.status(400).json({
          success: false,
          message: `A capsule can be locked for at most ${MAX_LOCK_YEARS} years`,
        });
      }
    }

    const spaceRef = db
      .collection("spaces")
      .doc(String(spaceId));

    const snapRef = db.collection("snaps").doc();

    // NEW: the payment this Snap is bought with, and the hold on the space.
    const paymentRef = db.collection("payments").doc(paymentId.trim());
    const reservationRef = db.collection("reservations").doc(String(spaceId));

    const result = await db.runTransaction(
      async (transaction) => {
        // All reads first (a Firestore transaction must read before it writes).
        const [spaceSnapshot, paymentSnapshot, reservationSnapshot] =
          await transaction.getAll(spaceRef, paymentRef, reservationRef);

        // ---- 1. Is the payment real, this person's, for THIS space, unused?
        // Checked before the space so a bad payment is never "refunded".
        if (!paymentSnapshot.exists) {
          throw new Error("PAYMENT_INVALID");
        }

        const payment = paymentSnapshot.data();

        if (
          payment.userId !== userId ||
          payment.kind !== "space" ||
          payment.spaceId !== String(spaceId) ||
          payment.status !== "paid"
        ) {
          throw new Error(
            payment.status === "refunded" || payment.status === "refunding"
              ? "PAYMENT_REFUNDED"
              : "PAYMENT_INVALID"
          );
        }

        if (payment.snapId) {
          throw new Error("PAYMENT_USED");
        }

        paymentToRefund = paymentId.trim();

        // ---- 2. Is the space still available to this person?
        if (!spaceSnapshot.exists) {
          throw new Error("SPACE_NOT_FOUND");
        }

        const spaceData = spaceSnapshot.data();

        if (spaceData.status === "occupied") {
          throw new Error("SPACE_ALREADY_OCCUPIED");
        }

        // Someone else paid for it after this person's hold ran out.
        if (
          reservationSnapshot.exists &&
          isReservedByOther(reservationSnapshot.data(), userId)
        ) {
          throw new Error("SPACE_ALREADY_OCCUPIED");
        }

        const now = new Date();

        const snapData = {
          userId,
          spaceId: String(spaceId),
          imageUrl,
          storagePath,
          caption: caption?.trim() || "",
          location: locationCheck.value,
          type: isCapsule ? "capsule" : "post",
          createdAt: now,
          ...(isCapsule
            ? {
                // Locked: hidden from everyone but the owner until
                // unlockAt, then published automatically.
                status: "locked",
                unlockAt: unlockDate,
                pendingUnlockAt: unlockDate,
              }
            : {
                status: "published",
                publishedAt: now,
              }),
        };

        transaction.set(snapRef, snapData);

        transaction.update(spaceRef, {
          status: "occupied",
          snapId: snapRef.id,
          occupiedBy: userId,
          occupiedAt: now,
        });

        // NEW: the payment is now spent on this Snap, and the hold is over.
        transaction.update(paymentRef, {
          snapId: snapRef.id,
          usedAt: now,
        });

        transaction.delete(reservationRef);

        return snapData;
      }
    );

    // NEW: if auto-expansion is on and the wall is getting full, add more
    // spaces. Runs in the background — it must never slow down or fail
    // the post the person just made.
    runInBackground(autoExpandIfNeeded(), "Auto-expand");

    return res.status(201).json({
      success: true,
      message: "Snap created successfully",
      snap: {
        id: snapRef.id,
        ...serializeSnap(result),
      },
    });

  } catch (error) {
    console.error("Create Snap error:", error);

    // NEW: payment problems
    if (error.message === "PAYMENT_INVALID") {
      return res.status(403).json({
        success: false,
        message: "This payment can't be used for this space",
      });
    }

    if (error.message === "PAYMENT_REFUNDED") {
      return res.status(403).json({
        success: false,
        message: "This payment has been refunded and can't be used",
      });
    }

    if (error.message === "PAYMENT_USED") {
      return res.status(409).json({
        success: false,
        message: "This payment has already been used for a Snap",
      });
    }

    // CHANGED: if the space is gone AFTER a valid payment, the money goes
    // straight back to the person — they never pay for nothing.
    if (
      error.message === "SPACE_NOT_FOUND" ||
      error.message === "SPACE_ALREADY_OCCUPIED"
    ) {
      const notFound = error.message === "SPACE_NOT_FOUND";
      const base = notFound
        ? "Space not found."
        : "This space has already been taken.";

      let refunded = false;

      if (paymentToRefund) {
        try {
          ({ refunded } = await refundPayment(
            paymentToRefund,
            notFound ? "space not found" : "space already taken"
          ));
        } catch (refundError) {
          console.error("Refund error:", refundError);
        }
      }

      return res.status(notFound ? 404 : 409).json({
        success: false,
        refunded,
        message: refunded
          ? `${base} Your payment has been refunded.`
          : `${base} We couldn't refund your payment automatically — please contact support with payment ID ${paymentToRefund}.`,
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to create Snap",
    });
  }
}

async function getMySnaps(req, res) {
  try {
    const userId = req.user.uid;

    const snapshot = await db
      .collection("snaps")
      .where("userId", "==", userId)
      .get();

    const snaps = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    snaps.sort((a, b) => {
      const dateA = a.createdAt?.toDate
        ? a.createdAt.toDate()
        : new Date(0);

      const dateB = b.createdAt?.toDate
        ? b.createdAt.toDate()
        : new Date(0);

      return dateB - dateA;
    });

    // The owner always sees their own snaps, locked or not.
    return res.status(200).json({
      success: true,
      count: snaps.length,
      snaps: snaps.map(serializeSnap),
    });
  } catch (error) {
    console.error(
      "Get my snaps error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to fetch your snaps",
    });
  }
}

async function updateSnap(req, res) {
  try {
    const userId = req.user.uid;
    const { snapId } = req.params;
    const { caption, location, unlockAt } = req.body || {};

    if (!snapId) {
      return res.status(400).json({
        success: false,
        message: "Snap ID is required",
      });
    }

    const snapRef = db.collection("snaps").doc(snapId);
    const snapshot = await snapRef.get();

    if (!snapshot.exists) {
      return res.status(404).json({
        success: false,
        message: "Snap not found",
      });
    }

    const current = snapshot.data();

    if (current.userId !== userId) {
      return res.status(403).json({
        success: false,
        message: "You can only edit your own Snaps",
      });
    }

    // Moderators hid it: the owner must not be able to rewrite it.
    if (current.status === "hidden") {
      return res.status(403).json({
        success: false,
        message: "This Snap was hidden by the moderators and cannot be edited.",
      });
    }

    // Only caption, location and (capsules) unlock time can change.
    // Image, space and type are never touched here.
    const updates = {};

    // ---------- Caption ----------
    if (caption !== undefined) {
      const text = String(caption ?? "").trim();

      if (text.length > MAX_CAPTION_LENGTH) {
        return res.status(400).json({
          success: false,
          message: `Caption can be at most ${MAX_CAPTION_LENGTH} characters`,
        });
      }

      updates.caption = text;
    }

    // ---------- Location (null removes it) ----------
    if (location !== undefined) {
      const locationCheck = sanitizeLocation(location);

      if (!locationCheck.ok) {
        return res.status(400).json({
          success: false,
          message: "That location is not valid",
        });
      }

      updates.location = locationCheck.value;
    }

    // ---------- Unlock time (Time Capsule, still sealed) ----------
    if (unlockAt !== undefined) {
      if (current.type !== "capsule") {
        return res.status(400).json({
          success: false,
          message: "Only Time Capsules have an unlock time",
        });
      }

      if (!isSnapLocked(current)) {
        return res.status(400).json({
          success: false,
          message: "This capsule has already opened, so its time can't be changed",
        });
      }

      const unlockDate = toDate(unlockAt);

      if (!unlockDate) {
        return res.status(400).json({
          success: false,
          message: "Please choose when this capsule should unlock",
        });
      }

      if (unlockDate.getTime() < Date.now() + MIN_LOCK_MS) {
        return res.status(400).json({
          success: false,
          message: "The unlock time must be in the future",
        });
      }

      const latest = new Date();
      latest.setFullYear(latest.getFullYear() + MAX_LOCK_YEARS);

      if (unlockDate > latest) {
        return res.status(400).json({
          success: false,
          message: `A capsule can be locked for at most ${MAX_LOCK_YEARS} years`,
        });
      }

      updates.unlockAt = unlockDate;
      updates.pendingUnlockAt = unlockDate;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: "Nothing to update",
      });
    }

    updates.updatedAt = new Date();

    await snapRef.update(updates);

    const updated = { ...current, ...updates };

    return res.status(200).json({
      success: true,
      message: "Snap updated successfully",
      snap: {
        id: snapId,
        ...serializeSnap(updated),
        updatedAt: toISO(updated.updatedAt),
      },
    });
  } catch (error) {
    console.error("Update Snap error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update Snap",
    });
  }
}

async function likeSnap(req, res) {
  try {
    const userId = req.user.uid;
    const { snapId } = req.params;

    if (!snapId) {
      return res.status(400).json({
        success: false,
        message: "Snap ID is required",
      });
    }

    const snapRef = db
      .collection("snaps")
      .doc(snapId);

    const snapSnapshot = await snapRef.get();

    if (!snapSnapshot.exists) {
      return res.status(404).json({
        success: false,
        message: "Snap not found",
      });
    }

    // Locked snaps are not public yet, so nobody can like them.
    if (isSnapLocked(snapSnapshot.data())) {
      return res.status(403).json(LOCKED_RESPONSE);
    }

    if (snapSnapshot.data().status === "hidden") {
      return res.status(403).json(HIDDEN_RESPONSE);
    }

    if (snapSnapshot.data().ownerHidden === true) {
      return res.status(403).json(OWNER_HIDDEN_RESPONSE);
    }

    const likeRef = snapRef
      .collection("likes")
      .doc(userId);

    const likeSnapshot = await likeRef.get();

    if (likeSnapshot.exists) {
      return res.status(200).json({
        success: true,
        liked: true,
        message: "Snap already liked",
      });
    }

    await likeRef.set({
      userId,
      createdAt: new Date(),
    });

    // NEW: tell the owner. Not awaited — the like must feel instant, and
    // a notification problem must never fail it (it never throws anyway).
    // One notification per person per Snap, and none for your own Snap.
    runInBackground(
      notifySnapLiked(snapId, snapSnapshot.data(), userId),
      "Like notification"
    );

    return res.status(200).json({
      success: true,
      liked: true,
      message: "Snap liked successfully",
    });
  } catch (error) {
    console.error(
      "Like snap error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to like Snap",
    });
  }
}


async function unlikeSnap(req, res) {
  try {
    const userId = req.user.uid;
    const { snapId } = req.params;

    if (!snapId) {
      return res.status(400).json({
        success: false,
        message: "Snap ID is required",
      });
    }

    const snapRef = db
      .collection("snaps")
      .doc(snapId);

    const snapSnapshot = await snapRef.get();

    if (!snapSnapshot.exists) {
      return res.status(404).json({
        success: false,
        message: "Snap not found",
      });
    }

    const likeRef = snapRef
      .collection("likes")
      .doc(userId);

    await likeRef.delete();

    return res.status(200).json({
      success: true,
      liked: false,
      message: "Snap unliked successfully",
    });
  } catch (error) {
    console.error(
      "Unlike snap error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to unlike Snap",
    });
  }
}

async function getSnapLikeInfo(req, res) {
  try {
    const userId = req.user.uid;
    const { snapId } = req.params;

    const snapRef = db
      .collection("snaps")
      .doc(snapId);

    const snapSnapshot = await snapRef.get();

    if (!snapSnapshot.exists) {
      return res.status(404).json({
        success: false,
        message: "Snap not found",
      });
    }

    const likesSnapshot =
      await snapRef
        .collection("likes")
        .get();

    const userLikeRef =
      snapRef
        .collection("likes")
        .doc(userId);

    const userLikeSnapshot =
      await userLikeRef.get();

    return res.status(200).json({
      success: true,
      likeCount: likesSnapshot.size,
      liked: userLikeSnapshot.exists,
    });
  } catch (error) {
    console.error(
      "Get like info error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to get like information",
    });
  }
}

async function saveSnap(req, res) {
  try {
    const userId = req.user.uid;
    const { snapId } = req.params;

    if (!snapId) {
      return res.status(400).json({
        success: false,
        message: "Snap ID is required",
      });
    }

    const snapRef = db
      .collection("snaps")
      .doc(snapId);

    const snapSnapshot = await snapRef.get();

    if (!snapSnapshot.exists) {
      return res.status(404).json({
        success: false,
        message: "Snap not found",
      });
    }

    // Locked snaps are not public yet, so nobody can save them.
    if (isSnapLocked(snapSnapshot.data())) {
      return res.status(403).json(LOCKED_RESPONSE);
    }

    if (snapSnapshot.data().status === "hidden") {
      return res.status(403).json(HIDDEN_RESPONSE);
    }

    if (snapSnapshot.data().ownerHidden === true) {
      return res.status(403).json(OWNER_HIDDEN_RESPONSE);
    }

    const saveRef = snapRef
      .collection("saves")
      .doc(userId);

    const saveSnapshot = await saveRef.get();

    if (saveSnapshot.exists) {
      return res.status(200).json({
        success: true,
        saved: true,
        message: "Snap already saved",
      });
    }

    await saveRef.set({
      userId,
      createdAt: new Date(),
    });

    return res.status(200).json({
      success: true,
      saved: true,
      message: "Snap saved successfully",
    });
  } catch (error) {
    console.error("Save snap error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to save Snap",
    });
  }
}


async function unsaveSnap(req, res) {
  try {
    const userId = req.user.uid;
    const { snapId } = req.params;

    if (!snapId) {
      return res.status(400).json({
        success: false,
        message: "Snap ID is required",
      });
    }

    const snapRef = db
      .collection("snaps")
      .doc(snapId);

    const snapSnapshot = await snapRef.get();

    if (!snapSnapshot.exists) {
      return res.status(404).json({
        success: false,
        message: "Snap not found",
      });
    }

    const saveRef = snapRef
      .collection("saves")
      .doc(userId);

    await saveRef.delete();

    return res.status(200).json({
      success: true,
      saved: false,
      message: "Snap removed from saved",
    });
  } catch (error) {
    console.error("Unsave snap error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to unsave Snap",
    });
  }
}

async function getSnapSaveInfo(req, res) {
  try {
    const userId = req.user.uid;
    const { snapId } = req.params;

    const snapRef = db
      .collection("snaps")
      .doc(snapId);

    const snapSnapshot = await snapRef.get();

    if (!snapSnapshot.exists) {
      return res.status(404).json({
        success: false,
        message: "Snap not found",
      });
    }

    const saveRef = snapRef
      .collection("saves")
      .doc(userId);

    const saveSnapshot = await saveRef.get();

    return res.status(200).json({
      success: true,
      saved: saveSnapshot.exists,
    });
  } catch (error) {
    console.error(
      "Get save info error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to get save information",
    });
  }
}

async function getSavedSnaps(req, res) {
  try {
    const userId = req.user.uid;

    const snapsSnapshot = await db
      .collection("snaps")
      .where("status", "==", "published")
      .get();

    const savedSnaps = [];

    for (const snapDoc of snapsSnapshot.docs) {
      const saveDoc = await snapDoc.ref
        .collection("saves")
        .doc(userId)
        .get();

      // NEW: skip Snaps their owner has hidden
      if (saveDoc.exists && snapDoc.data().ownerHidden !== true) {
        savedSnaps.push({
          id: snapDoc.id,
          ...snapDoc.data(),
        });
      }
    }

    return res.status(200).json({
      success: true,
      snaps: (await withAuthors(savedSnaps, userId)).map(serializeSnap),
    });
  } catch (error) {
    console.error(
      "Get saved snaps error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to load saved Snaps",
    });
  }
}

async function getLikedSnaps(req, res) {
  try {
    const userId = req.user.uid;

    const snapsSnapshot = await db
      .collection("snaps")
      .where("status", "==", "published")
      .get();

    const likedSnaps = [];

    for (const snapDoc of snapsSnapshot.docs) {
      const likeDoc = await snapDoc.ref
        .collection("likes")
        .doc(userId)
        .get();

      // NEW: skip Snaps their owner has hidden
      if (likeDoc.exists && snapDoc.data().ownerHidden !== true) {
        likedSnaps.push({
          id: snapDoc.id,
          ...snapDoc.data(),
        });
      }
    }

    return res.status(200).json({
      success: true,
      snaps: (await withAuthors(likedSnaps, userId)).map(serializeSnap),
    });
  } catch (error) {
    console.error(
      "Get liked snaps error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to load liked Snaps",
    });
  }
}

module.exports = {
  createSnap,
  updateSnap,
  getMySnaps,
  likeSnap,
  unlikeSnap,
  getSnapLikeInfo,
  saveSnap,
  unsaveSnap,
  getSnapSaveInfo,
  getSavedSnaps,
  getLikedSnaps

};