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

  return reservation.userId !== userId && toMs(reservation.expiresAt) > Date.now();
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
        "Someone else is paying for this space right now. Try again in a few minutes, or pick another space."
      );
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

    if (reservation.exists && reservation.data().userId === userId) {
      transaction.delete(reservationRef);
    }
  });
}

module.exports = {
  SpaceError,
  RESERVATION_MS,
  isReservedByOther,
  reserveSpace,
  releaseSpace,
};