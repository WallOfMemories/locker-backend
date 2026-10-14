const { db } = require("../config/firebase");
const razorpay = require("../config/razorpay");
const { toISO } = require("./capsuleService");

// ------------------------------------------------------------
// Payments
//
// payments/{razorpayPaymentId}
//   paymentId, orderId, userId, amountPaise, currency,
//   kind:   "space" | "test"
//   spaceId
//   status: "paid" | "refunding" | "refunded"
//   snapId: id of the Snap this payment bought (null until it is used)
//   createdAt, usedAt, refundId, refundedAt, refundReason
//
// The document id IS the Razorpay payment id, so recording the same
// payment twice is impossible (a replayed /verify request is harmless),
// and one payment can only ever buy one Snap.
// ------------------------------------------------------------

const paymentsCollection = db.collection("payments");

const LIST_LIMIT = 200;
const USER_LIST_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

function isAlreadyExists(error) {
  return error?.code === 6 || /ALREADY_EXISTS/i.test(error?.message || "");
}

// -> { created: true } the first time, { created: false } on a replay.
async function recordPayment(payment) {
  try {
    await paymentsCollection.doc(payment.paymentId).create({
      ...payment,
      status: "paid",
      snapId: null,
      createdAt: new Date(),
    });

    return { created: true };
  } catch (error) {
    if (isAlreadyExists(error)) return { created: false };

    throw error;
  }
}

// NEW: gives the money back for a payment that did NOT buy a Snap
// (e.g. the space was taken while the person was paying).
// Safe to call twice: the first call "claims" the refund inside a
// transaction, so Razorpay is only asked once.
// -> { refunded: true | false }
async function refundPayment(paymentId, reason) {
  const ref = paymentsCollection.doc(paymentId);

  const claimed = await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(ref);

    if (!doc.exists) return false;

    const data = doc.data();

    // Already refunded, being refunded, or already used for a Snap.
    if (data.status !== "paid" || data.snapId) return false;

    transaction.update(ref, { status: "refunding" });

    return true;
  });

  if (!claimed) return { refunded: false };

  try {
    // No amount = refund the whole payment.
    const refund = await razorpay.payments.refund(paymentId, {
      speed: "normal",
      notes: { reason },
    });

    await ref.update({
      status: "refunded",
      refundId: refund.id,
      refundedAt: new Date(),
      refundReason: reason,
    });

    return { refunded: true };
  } catch (error) {
    console.error("Refund failed for", paymentId, error);

    // Put it back so it can be refunded by hand / retried.
    await ref.update({ status: "paid" });

    return { refunded: false };
  }
}

async function getUsersById(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const byId = {};

  for (let i = 0; i < unique.length; i += 100) {
    const docs = await db.getAll(
      ...unique.slice(i, i + 100).map((id) => db.collection("users").doc(id))
    );

    docs.forEach((doc) => {
      if (doc.exists) byId[doc.id] = doc.data();
    });
  }

  return byId;
}

function emptyTotals() {
  return { count: 0, amountPaise: 0 };
}

// ---------- admin ----------

// Newest payments + totals over ALL payments.
// Test payments and refunds are counted separately so they never
// inflate revenue.
async function listForAdmin(limit = LIST_LIMIT) {
  const snapshot = await paymentsCollection
    .orderBy("createdAt", "desc")
    .get();

  const summary = {
    space: emptyTotals(),
    test: emptyTotals(),
    spaceLast30Days: emptyTotals(),
    refunded: emptyTotals(), // NEW
  };

  const since = Date.now() - 30 * DAY_MS;

  const all = snapshot.docs.map((doc) => {
    const data = doc.data();
    const kind = data.kind === "test" ? "test" : "space";
    const amountPaise = Number(data.amountPaise) || 0;
    const createdAt = data.createdAt?.toDate?.() || null;
    const refunded = data.status === "refunded";

    if (refunded) {
      summary.refunded.count += 1;
      summary.refunded.amountPaise += amountPaise;
    } else {
      summary[kind].count += 1;
      summary[kind].amountPaise += amountPaise;

      if (kind === "space" && createdAt && createdAt.getTime() >= since) {
        summary.spaceLast30Days.count += 1;
        summary.spaceLast30Days.amountPaise += amountPaise;
      }
    }

    return {
      id: doc.id,
      paymentId: data.paymentId || doc.id,
      orderId: data.orderId || "",
      userId: data.userId || "",
      spaceId: data.spaceId || "",
      kind,
      status: data.status || "paid",
      used: Boolean(data.snapId), // NEW: did it buy a Snap?
      deleted: Boolean(data.snapDeletedAt), // NEW: ...that was later deleted
      amountPaise,
      currency: data.currency || "INR",
      createdAt: toISO(data.createdAt),
    };
  });

  const items = all.slice(0, limit);
  const users = await getUsersById(items.map((item) => item.userId));

  return {
    summary,
    total: all.length,
    items: items.map((item) => {
      const user = users[item.userId] || {};

      return {
        ...item,
        user: {
          uid: item.userId,
          username: user.username || "",
          displayName: user.displayName || "",
          email: user.email || "",
        },
      };
    }),
  };
}

// ---------- the person's own payments (Payment History page) ----------

// What the Payment History page shows for each payment:
//   "used"     — it bought a Snap (snap = the Snap)
//   "deleted"  — it bought a Snap that the owner later deleted (no refund)
//   "unused"   — paid, but the Snap wasn't posted yet
//   "refunded" — money returned
//   "test"     — a ₹1 test payment
async function listForUser(userId) {
  // No orderBy here on purpose: filtering on userId AND sorting by date
  // would need a composite index. A person has few payments, so sort here.
  const snapshot = await paymentsCollection
    .where("userId", "==", userId)
    .get();

  const rows = snapshot.docs
    .map((doc) => {
      const data = doc.data();
      const created = data.createdAt?.toDate?.() || null;

      return {
        sortKey: created ? created.getTime() : 0,
        data,
        id: doc.id,
      };
    })
    .sort((a, b) => b.sortKey - a.sortKey)
    .slice(0, USER_LIST_LIMIT);

  const snapIds = [
    ...new Set(rows.map((row) => row.data.snapId).filter(Boolean)),
  ];

  const snapsById = {};

  if (snapIds.length > 0) {
    const snapDocs = await db.getAll(
      ...snapIds.map((id) => db.collection("snaps").doc(id))
    );

    snapDocs.forEach((doc) => {
      if (doc.exists) snapsById[doc.id] = doc.data();
    });
  }

  const summary = {
    paidPaise: 0, // real money kept (space payments, not refunded)
    refundedPaise: 0,
    spaces: 0, // Snaps bought
  };

  const items = rows.map(({ data, id }) => {
    const kind = data.kind === "test" ? "test" : "space";
    const amountPaise = Number(data.amountPaise) || 0;
    const snap = data.snapId ? snapsById[data.snapId] : null;

    let state = "unused";

    if (data.status === "refunded") state = "refunded";
    else if (kind === "test") state = "test";
    // NEW: it bought a Snap that the owner later deleted (no refund)
    else if (data.snapDeletedAt) state = "deleted";
    else if (data.snapId) state = "used";

    if (state === "refunded") summary.refundedPaise += amountPaise;
    else if (kind === "space") {
      summary.paidPaise += amountPaise;
      if (state === "used" || state === "deleted") summary.spaces += 1;
    }

    return {
      id,
      paymentId: data.paymentId || id,
      orderId: data.orderId || "",
      spaceId: data.spaceId || "",
      kind,
      state,
      amountPaise,
      currency: data.currency || "INR",
      createdAt: toISO(data.createdAt),
      usedAt: toISO(data.usedAt),
      refundedAt: toISO(data.refundedAt),
      snap: snap
        ? {
            id: data.snapId,
            imageUrl: snap.imageUrl || "",
            caption: snap.caption || "",
            type: snap.type === "capsule" ? "capsule" : "post",
            status: snap.status || "",
          }
        : null,
    };
  });

  return { summary, items };
}

module.exports = {
  recordPayment,
  refundPayment,
  listForAdmin,
  listForUser,
};