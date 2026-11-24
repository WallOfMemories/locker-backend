const { db } = require("../config/firebase");

// ------------------------------------------------------------
// Space reservations
//
// While someone is paying for a space it is held for them, so a second
// person can't pay for the same space at the same moment (and then find
// out it was taken after their money was charged).
//
// reservations/{spaceId} = { userId, expiresAt, createdAt }
//
// NEW — PAID reservations ("pay first, post whenever you want"):
// once a person has PAID for a space, the reservation becomes permanent:
//   { userId, paid: true, paymentId, paidAt, expiresAt: null }
// It has no deadline. Nobody else can pay for or post to that space until
// the person posts their Snap (which removes it) or the payment is refunded.
//
// It lives in its own collection (not on the space) because the wall
// endpoint sends every space field to the browser.
// ------------------------------------------------------------

const RESERVATION_MS = 10 * 60 * 1000; // long enough for a slow checkout

const reservationsCollection = db.collection("reservations");

class SpaceError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function toMs(value) {
  return value?.toMillis?.() ?? value?.getTime?.() ?? 0;
}

// True when someone OTHER than `userId` holds a live reservation.
function isReservedByOther(reservation, userId) {
  if (!reservation) return false;

  if (reservation.userId === userId) return false;

  // NEW: a PAID reservation never runs out.
  if (reservation.paid) return true;

  return toMs(reservation.expiresAt) > Date.now();
}

// Holds the space for `userId` for RESERVATION_MS.
// Throws SpaceError if the space doesn't exist, is taken, or is being
// paid for by someone else right now.
async function reserveSpace(spaceId, userId) {
  const spaceRef = db.collection("spaces").doc(spaceId);
  const reservationRef = reservationsCollection.doc(spaceId);

  await db.runTransaction(async (transaction) => {
    const [space, reservation] = await transaction.getAll(
      spaceRef,
      reservationRef
    );

    if (!space.exists) {
      throw new SpaceError("SPACE_NOT_FOUND", 404, "Space not found");
    }

    if (space.data().status === "occupied") {
      throw new SpaceError(
        "SPACE_ALREADY_OCCUPIED",
        409,
        "This space has already been taken"
      );
    }

    if (reservation.exists && isReservedByOther(reservation.data(), userId)) {
      throw new SpaceError(
        "SPACE_RESERVED",
        409,
        reservation.data().paid
          ? "This space has been reserved by someone else. Please pick another space."
          : "Someone else is paying for this space right now. Try again in a few minutes, or pick another space."
      );
    }

    // NEW: never downgrade a PAID reservation back to a 10-minute hold.
    if (reservation.exists && reservation.data().paid && reservation.data().userId === userId) {
      return;
    }

    transaction.set(reservationRef, {
      userId,
      expiresAt: new Date(Date.now() + RESERVATION_MS),
      createdAt: new Date(),
    });
  });
}

// Frees the space again (the person closed the payment window).
// Only the person who holds the reservation can free it.
async function releaseSpace(spaceId, userId) {
  const reservationRef = reservationsCollection.doc(spaceId);

  await db.runTransaction(async (transaction) => {
    const reservation = await transaction.get(reservationRef);

    // NEW: a PAID reservation is not released by closing a window.
    if (
      reservation.exists &&
      reservation.data().userId === userId &&
      !reservation.data().paid
    ) {
      transaction.delete(reservationRef);
    }
  });
}

// NEW: the person paid — make the reservation permanent (no deadline).
// If someone else somehow already holds a paid reservation, leave it.
async function markReservationPaid(spaceId, userId, paymentId) {
  const reservationRef = reservationsCollection.doc(spaceId);

  await db.runTransaction(async (transaction) => {
    const reservation = await transaction.get(reservationRef);

    if (
      reservation.exists &&
      reservation.data().paid &&
      reservation.data().userId !== userId
    ) {
      return;
    }

    transaction.set(reservationRef, {
      userId,
      paid: true,
      paymentId,
      paidAt: new Date(),
      expiresAt: null,
      createdAt: reservation.exists ? reservation.data().createdAt || new Date() : new Date(),
    });
  });
}

// NEW: the payment was refunded — give the space back to everyone.
async function releasePaidReservation(spaceId, paymentId) {
  const reservationRef = reservationsCollection.doc(spaceId);

  await db.runTransaction(async (transaction) => {
    const reservation = await transaction.get(reservationRef);

    if (
      reservation.exists &&
      reservation.data().paid &&
      reservation.data().paymentId === paymentId
    ) {
      transaction.delete(reservationRef);
    }
  });
}

// NEW: ids of every space that is held by a PAID reservation (for the wall).
async function listPaidReservedSpaceIds() {
  const snapshot = await reservationsCollection.where("paid", "==", true).get();

  return new Set(snapshot.docs.map((doc) => doc.id));
}

module.exports = {
  SpaceError,
  RESERVATION_MS,
  isReservedByOther,
  reserveSpace,
  releaseSpace,
  markReservationPaid,
  releasePaidReservation,
  listPaidReservedSpaceIds,
};