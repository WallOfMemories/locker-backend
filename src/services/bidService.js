const { db, adminAuth } = require("../config/firebase");
const {
  notifyBidWon,
  notifyBidEnded,
  notifyBidCountered,
  notifyBidRejected,
  notifyBidExpired,
  notifyBidCounterExpired,
} = require("./notificationService");
const { sendBidEmailToAdmin, sendBidderEmail } = require("./mailService");
const { runInBackground } = require("../utils/background");

// ------------------------------------------------------------
// NEW: bidding on the first boxes of the wall.
//
// Rules
//  - Only boxes 1..BID_BOX_COUNT (default 20) take bids, and only while the
//    box is EMPTY. A box that already has a Snap is never touched.
//  - These boxes are BID-ONLY: there is no normal purchase at the standard
//    price. The only way in is a bid the admin accepts.
//  - A person has ONE bid per box. When they bid, the admin gets an email
//    (with their details) and sees it on /admin/bids.
//  - For each bid the admin can:
//        ACCEPT  -> that person wins at their bid. Other bids on the box are
//                   rejected. The winner pays their amount and creates the Snap.
//        REJECT  -> the bid is declined (the person may bid again).
//        COUNTER -> the admin proposes a different amount. The person then
//                   accepts (they win at the counter amount) or declines.
//  - Nobody pays anything just to bid.
//  - NEW: once a bid is accepted the winner has BID_PAY_HOURS (default 48)
//    to pay and create their Snap. If they don't, the box opens up again:
//    their bid becomes "expired", they are told, and others can bid. This
//    is enforced the moment anything touches the box (so it is exact), and
//    a daily cron (/api/cron/bid-expiry) tidies up the rest.
//  - NEW: once the winner has PAID, the box is theirs until they post their
//    Snap — no deadline any more. The 48 hours only apply to paying.
//  - NEW: a counter offer must be answered within BID_REPLY_HOURS (default 48)
//    or it expires (the person can bid again).
//  - The bidder gets an email for: accepted, counter offer, rejected, expired.
//    (See mailService.js — emailing bidders needs a verified Resend domain.)
//
// Data
//   bids/{spaceId}_{userId}  spaceId, boxNumber, userId, amount (₹),
//                            status: "pending" | "countered" | "rejected" | "accepted" | "expired",
//                            counterAmount, createdAt, updatedAt
//   bidResults/{spaceId}     spaceId, boxNumber, winnerId, amount (₹), via, closedAt, closedBy,
//                            expiresAt (closedAt + the payment window)
// ------------------------------------------------------------

const BID_BOX_COUNT = Math.max(0, Number(process.env.BID_BOX_COUNT) || 20);
const MAX_BID_RUPEES = 1000000; // sanity cap (₹10 lakh)
// NEW: how long an accepted bidder has to pay and create their Snap.
const PAY_WINDOW_HOURS = Math.max(1, Number(process.env.BID_PAY_HOURS) || 48);
// NEW: how long the bidder has to answer a counter offer.
const REPLY_WINDOW_HOURS = Math.max(1, Number(process.env.BID_REPLY_HOURS) || 48);

const bidsCollection = db.collection("bids");
const resultsCollection = db.collection("bidResults");

class BidError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function boxNumber(spaceId) {
  const match = /^space_(\d{1,6})$/.exec(String(spaceId));

  return match ? Number(match[1]) : 0;
}

function isBidBox(spaceId) {
  const number = boxNumber(spaceId);

  return number >= 1 && number <= BID_BOX_COUNT;
}

function toMs(value) {
  return value?.toMillis?.() ?? value?.getTime?.() ?? 0;
}

// NEW: has this accepted result run out of time? (An old result with no
// expiresAt never expires.)
function isPast(value) {
  const ms = toMs(value);

  return ms > 0 && ms <= Date.now();
}

function isExpired(result) {
  return isPast(result?.expiresAt);
}

function deadlineIn(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

function payDeadline() {
  return deadlineIn(PAY_WINDOW_HOURS);
}

function replyDeadline() {
  return deadlineIn(REPLY_WINDOW_HOURS);
}

function toIso(value) {
  if (!value) return null;

  return (value.toDate ? value.toDate() : value).toISOString();
}

// NEW: an unused, paid payment this person made for this box (or null).
// While one exists, the box is theirs until they post — no deadline.
async function findPaidPayment(spaceId, userId, transaction) {
  const query = db.collection("payments").where("spaceId", "==", spaceId);
  const snapshot = transaction ? await transaction.get(query) : await query.get();

  const doc = snapshot.docs.find((candidate) => {
    const payment = candidate.data();

    return (
      payment.userId === userId &&
      payment.kind === "space" &&
      payment.status === "paid" &&
      !payment.snapId
    );
  });

  return doc ? doc.id : null;
}

function wholeRupees(amount) {
  return Number.isInteger(amount) && amount >= 1 && amount <= MAX_BID_RUPEES;
}

const BAD_AMOUNT = () =>
  new BidError(
    "BAD_AMOUNT",
    400,
    `Enter a whole-rupee amount between ₹1 and ₹${MAX_BID_RUPEES.toLocaleString("en-IN")}`
  );

async function readBasePrice() {
  const { getTheLockerSettings } = require("./settingsService");
  const settings = await getTheLockerSettings();

  return Number(settings?.spacePrice) || 10;
}

// What the public (and the bidder) may see about one box. Other people's
// bids are never shown.
function publicSummary(spaceId, myBid, result, userId, paidPaymentId = null) {
  return {
    spaceId,
    myBid: myBid
      ? {
          amount: myBid.amount,
          status: myBid.status || "pending",
          counterAmount: myBid.counterAmount || null,
          // NEW: when their time to answer a counter offer runs out
          counterBy: toIso(myBid.counterExpiresAt),
          expiredReason: myBid.expiredReason || null,
        }
      : null,
    // NEW: the winner already paid and only has to post their Snap
    paidPaymentId: result && userId && result.winnerId === userId ? paidPaymentId : null,
    closed: Boolean(result),
    iAmWinner: Boolean(result) && Boolean(userId) && result.winnerId === userId,
    winningAmount: result && userId && result.winnerId === userId ? result.amount : null,
    // NEW: when the winner's time to pay runs out (only the winner sees it)
    payBy:
      result && userId && result.winnerId === userId && result.expiresAt && !paidPaymentId
        ? toIso(result.expiresAt)
        : null,
  };
}

// ---------- reading ----------

// One call for the wall popup: which boxes take bids, this person's own
// bids, and which boxes are already decided.
async function getBidOverview(userId) {
  const basePrice = await readBasePrice();

  if (BID_BOX_COUNT === 0) {
    return { bidBoxCount: 0, basePrice, boxes: {} };
  }

  const [resultsSnap, mySnap] = await Promise.all([
    resultsCollection.where("boxNumber", "<=", BID_BOX_COUNT).get(),
    userId ? bidsCollection.where("userId", "==", userId).get() : null,
  ]);

  const results = {};

  resultsSnap.forEach((doc) => {
    const data = doc.data();

    if (isExpired(data)) {
      // Out of time: treat the box as open, and tidy up (+ tell the winner).
      runInBackground(releaseExpired(doc.id), "Release expired bid");
      return;
    }

    results[doc.id] = data;
  });

  const mine = {};

  mySnap?.forEach((doc) => {
    let data = doc.data();

    if (data.boxNumber > BID_BOX_COUNT) return;

    // A counter offer they didn't answer in time: show it as expired now,
    // and tidy up (+ tell them) in the background.
    if (data.status === "countered" && isPast(data.counterExpiresAt)) {
      runInBackground(expireCounters(data.spaceId), "Expire counter offer");
      data = { ...data, status: "expired", expiredReason: "counter" };
    }

    mine[data.spaceId] = data;
  });

  const boxes = {};

  for (const spaceId of new Set([...Object.keys(results), ...Object.keys(mine)])) {
    // The winner may already have paid; then they just finish posting.
    const paidPaymentId =
      userId && results[spaceId]?.winnerId === userId
        ? await findPaidPayment(spaceId, userId)
        : null;

    boxes[spaceId] = publicSummary(
      spaceId,
      mine[spaceId],
      results[spaceId],
      userId,
      paidPaymentId
    );
  }

  return { bidBoxCount: BID_BOX_COUNT, basePrice, boxes };
}

// ---------- the person's own actions ----------

async function loadBidderDetails(userId) {
  const [userDoc, authUser] = await Promise.all([
    db.collection("users").doc(userId).get(),
    adminAuth.getUser(userId).catch(() => null),
  ]);

  const data = userDoc.exists ? userDoc.data() : {};

  return {
    uid: userId,
    name: data.displayName || authUser?.displayName || "",
    username: data.username || "",
    email: data.email || authUser?.email || "",
  };
}

// NEW: email a bidder (in the background; never blocks or breaks anything).
function emailBidder(userId, kind, info) {
  runInBackground(
    loadBidderDetails(userId).then((user) =>
      sendBidderEmail(kind, { to: user.email, payHours: PAY_WINDOW_HOURS, ...info })
    ),
    `Bidder email (${kind})`
  );
}

// NEW: if the accepted bidder ran out of time TO PAY, open the box again:
// remove the result, mark their bid "expired", and tell them. Safe to call
// any time; it does nothing unless a result has really expired.
//
// It does NOT expire a winner who has already PAID (the box is theirs until
// they post), who already posted, or who is paying at this very moment.
async function releaseExpired(spaceId) {
  const outcome = await db.runTransaction(async (transaction) => {
    const resultRef = resultsCollection.doc(spaceId);
    const result = await transaction.get(resultRef);

    if (!result.exists || !isExpired(result.data())) return null;

    const { winnerId, amount } = result.data();
    const bidRef = bidsCollection.doc(`${spaceId}_${winnerId}`);

    const [bid, space, reservation] = await transaction.getAll(
      bidRef,
      db.collection("spaces").doc(spaceId),
      db.collection("reservations").doc(spaceId)
    );

    const paidPaymentId = await findPaidPayment(spaceId, winnerId, transaction);

    // They DID pay and post: the box is taken, just tidy up quietly.
    if (space.exists && space.data().status === "occupied") {
      transaction.delete(resultRef);

      return null;
    }

    // They PAID but haven't posted yet: the box stays theirs, with no deadline.
    if (paidPaymentId) {
      transaction.update(resultRef, { expiresAt: null, paidAt: new Date() });

      return null;
    }

    // They are in the middle of paying right now: try again later.
    if (
      reservation.exists &&
      reservation.data().userId === winnerId &&
      toMs(reservation.data().expiresAt) > Date.now()
    ) {
      return null;
    }

    transaction.delete(resultRef);

    if (bid.exists) {
      transaction.update(bidRef, {
        status: "expired",
        expiredReason: "payment",
        updatedAt: new Date(),
      });
    }

    return { winnerId, amount };
  });

  if (outcome) {
    await notifyBidExpired(outcome.winnerId, spaceId, PAY_WINDOW_HOURS);
    emailBidder(outcome.winnerId, "expired", {
      boxLabel: `#${boxNumber(spaceId)}`,
      amount: outcome.amount,
    });
  }

  return Boolean(outcome);
}

// NEW: a counter offer the bidder didn't answer in time becomes "expired".
async function expireOneCounter(bidRef) {
  const outcome = await db.runTransaction(async (transaction) => {
    const bid = await transaction.get(bidRef);

    if (!bid.exists) return null;

    const data = bid.data();

    if (data.status !== "countered" || !isPast(data.counterExpiresAt)) return null;

    transaction.update(bidRef, {
      status: "expired",
      expiredReason: "counter",
      counterExpiresAt: null,
      updatedAt: new Date(),
    });

    return data;
  });

  if (outcome) {
    await notifyBidCounterExpired(outcome.userId, outcome.spaceId, REPLY_WINDOW_HOURS);
    emailBidder(outcome.userId, "counterExpired", {
      boxLabel: `#${boxNumber(outcome.spaceId)}`,
      amount: outcome.amount,
      counterAmount: outcome.counterAmount,
    });
  }

  return Boolean(outcome);
}

async function expireCounters(spaceId) {
  const snapshot = await bidsCollection.where("spaceId", "==", spaceId).get();
  let expired = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();

    if (data.status === "countered" && isPast(data.counterExpiresAt)) {
      if (await expireOneCounter(doc.ref)) expired += 1;
    }
  }

  return expired;
}

// Handles everything that may have run out of time on this box.
async function settleBox(spaceId) {
  await releaseExpired(spaceId);
  await expireCounters(spaceId);
}

// NEW: used by the daily cron — release every payment window and every
// counter offer that has run out.
async function sweepExpired() {
  const results = await resultsCollection
    .where("expiresAt", "<=", new Date())
    .get();

  let released = 0;

  for (const doc of results.docs) {
    if (await releaseExpired(doc.id)) released += 1;
  }

  const counters = await bidsCollection
    .where("counterExpiresAt", "<=", new Date())
    .get();

  let countersExpired = 0;

  for (const doc of counters.docs) {
    if (await expireOneCounter(doc.ref)) countersExpired += 1;
  }

  return { checked: results.size, released, countersExpired };
}

async function placeBid(spaceId, userId, amount) {
  await settleBox(spaceId);

  if (!isBidBox(spaceId)) {
    throw new BidError("NOT_A_BID_BOX", 400, "Bidding is not open on this box");
  }

  if (!wholeRupees(amount)) throw BAD_AMOUNT();

  const minimum = (await readBasePrice()) + 1;

  if (amount < minimum) {
    throw new BidError("BID_TOO_LOW", 409, `Your bid must be at least ₹${minimum}`);
  }

  const isUpdate = await db.runTransaction(async (transaction) => {
    const [space, result, reservation, existing] = await transaction.getAll(
      db.collection("spaces").doc(spaceId),
      resultsCollection.doc(spaceId),
      db.collection("reservations").doc(spaceId),
      bidsCollection.doc(`${spaceId}_${userId}`)
    );

    if (!space.exists) {
      throw new BidError("SPACE_NOT_FOUND", 404, "Box not found");
    }

    // An occupied box is left exactly as it is.
    if (space.data().status === "occupied") {
      throw new BidError("SPACE_ALREADY_OCCUPIED", 409, "This box has already been taken");
    }

    if (result.exists) {
      throw new BidError("BIDDING_CLOSED", 409, "This box has already been given to a bidder");
    }

    if (
      reservation.exists &&
      reservation.data().userId !== userId &&
      toMs(reservation.data().expiresAt) > Date.now()
    ) {
      throw new BidError(
        "SPACE_RESERVED",
        409,
        "Someone is using this box right now. Try again in a few minutes."
      );
    }

    const now = new Date();
    const previous = existing.exists ? existing.data() : null;

    // A new or changed bid goes back to the admin for a decision.
    transaction.set(bidsCollection.doc(`${spaceId}_${userId}`), {
      spaceId,
      boxNumber: boxNumber(spaceId),
      userId,
      amount,
      status: "pending",
      counterAmount: null,
      counterExpiresAt: null,
      expiredReason: null,
      createdAt: previous ? previous.createdAt : now,
      updatedAt: now,
    });

    return Boolean(previous);
  });

  // Tell the admin (email + their page). Never slows or breaks the bid.
  runInBackground(
    loadBidderDetails(userId).then((user) =>
      sendBidEmailToAdmin({
        boxLabel: `#${boxNumber(spaceId)}`,
        amount,
        user,
        isUpdate,
      })
    ),
    "Bid email"
  );

  const overview = await getBidOverview(userId);

  return overview.boxes[spaceId];
}

// The person answers the admin's counter offer: "accept" | "decline".
async function respondToCounter(spaceId, userId, action) {
  await settleBox(spaceId);

  if (!isBidBox(spaceId)) {
    throw new BidError("NOT_A_BID_BOX", 400, "Bidding is not open on this box");
  }

  if (action !== "accept" && action !== "decline") {
    throw new BidError("BAD_ACTION", 400, "Choose accept or decline");
  }

  const losers = await db.runTransaction(async (transaction) => {
    const bidRef = bidsCollection.doc(`${spaceId}_${userId}`);

    const [space, result, bidDoc] = await transaction.getAll(
      db.collection("spaces").doc(spaceId),
      resultsCollection.doc(spaceId),
      bidRef
    );

    if (!bidDoc.exists) {
      throw new BidError("NO_COUNTER", 409, "There is no counter offer to answer");
    }

    const current = bidDoc.data();

    if (
      (current.status === "expired" && current.expiredReason === "counter") ||
      (current.status === "countered" && isPast(current.counterExpiresAt))
    ) {
      throw new BidError(
        "COUNTER_EXPIRED",
        409,
        "This counter offer has expired. You can place a new bid."
      );
    }

    if (current.status !== "countered") {
      throw new BidError("NO_COUNTER", 409, "There is no counter offer to answer");
    }

    if (action === "decline") {
      transaction.update(bidRef, { status: "rejected", updatedAt: new Date() });

      return [];
    }

    if (space.exists && space.data().status === "occupied") {
      throw new BidError("SPACE_ALREADY_OCCUPIED", 409, "This box has already been taken");
    }

    if (result.exists) {
      throw new BidError("BIDDING_CLOSED", 409, "This box has already been given to a bidder");
    }

    const otherBids = await transaction.get(
      bidsCollection.where("spaceId", "==", spaceId)
    );

    transaction.set(resultsCollection.doc(spaceId), {
      spaceId,
      boxNumber: boxNumber(spaceId),
      winnerId: userId,
      amount: bidDoc.data().counterAmount,
      via: "counter",
      closedAt: new Date(),
      closedBy: "bidder",
      expiresAt: payDeadline(), // NEW: 48 hours to pay
    });

    transaction.update(bidRef, {
      status: "accepted",
      counterExpiresAt: null,
      updatedAt: new Date(),
    });

    const others = otherBids.docs.filter((doc) => doc.id !== bidRef.id);

    others.forEach((doc) =>
      transaction.update(doc.ref, { status: "rejected", updatedAt: new Date() })
    );

    return others.map((doc) => doc.data().userId);
  });

  if (action === "accept") {
    const overview = await getBidOverview(userId);
    const box = overview.boxes[spaceId];

    await Promise.all(losers.map((id) => notifyBidEnded(id, spaceId, "lost")));

    // Confirm by email with the payment deadline.
    emailBidder(userId, "accepted", {
      boxLabel: `#${boxNumber(spaceId)}`,
      amount: box?.winningAmount,
      payBy: box?.payBy,
    });

    return box;
  }

  return (await getBidOverview(userId)).boxes[spaceId];
}

// ---------- the purchase rule (used when a payment is started) ----------
//
//  not a bid box                       -> normal purchase
//  bid box, a bid was accepted         -> only the winner, at the agreed amount
//  bid box, nothing accepted yet       -> blocked: the only way in is a bid
async function getPurchaseRule(spaceId, userId) {
  if (!isBidBox(spaceId)) return { allowed: true };

  // Anyone who ran out of time loses their claim first.
  await settleBox(spaceId);

  const resultDoc = await resultsCollection.doc(spaceId).get();

  if (resultDoc.exists) {
    const result = resultDoc.data();

    if (result.winnerId === userId) {
      // Already paid? Don't let them pay twice — they only need to post.
      const paidPaymentId = await findPaidPayment(spaceId, userId);

      if (paidPaymentId) {
        return {
          allowed: false,
          code: "ALREADY_PAID",
          message:
            "You've already paid for this box. Open it on the wall to finish creating your Snap.",
        };
      }

      return { allowed: true, amountRupees: result.amount };
    }

    return {
      allowed: false,
      code: "BID_WON_BY_OTHER",
      message: "This box has been given to another bidder.",
    };
  }

  return {
    allowed: false,
    code: "BID_ONLY",
    message: "This box is only available through bidding. Place a bid to take it.",
  };
}

// ---------- admin ----------

// Every box that has bids (or a decided result), with who bid.
async function getAdminBoard() {
  await sweepExpired(); // out-of-time winners are released before we list

  const [bidsSnap, resultsSnap] = await Promise.all([
    bidsCollection.where("boxNumber", "<=", BID_BOX_COUNT).get(),
    resultsCollection.where("boxNumber", "<=", BID_BOX_COUNT).get(),
  ]);

  const bidsBySpace = {};

  bidsSnap.forEach((doc) => {
    const data = doc.data();

    (bidsBySpace[data.spaceId] ||= []).push(data);
  });

  const resultsBySpace = {};

  resultsSnap.forEach((doc) => {
    resultsBySpace[doc.id] = doc.data();
  });

  const spaceIds = [
    ...new Set([...Object.keys(bidsBySpace), ...Object.keys(resultsBySpace)]),
  ];

  if (spaceIds.length === 0) {
    return { bidBoxCount: BID_BOX_COUNT, boxes: [] };
  }

  const userIds = [
    ...new Set(Object.values(bidsBySpace).flat().map((bid) => bid.userId)),
  ];

  const [spaceDocs, userDocs] = await Promise.all([
    db.getAll(...spaceIds.map((id) => db.collection("spaces").doc(id))),
    userIds.length > 0
      ? db.getAll(...userIds.map((id) => db.collection("users").doc(id)))
      : [],
  ]);

  const taken = {};

  spaceDocs.forEach((doc) => {
    taken[doc.id] = doc.exists && doc.data().status === "occupied";
  });

  const people = {};

  userDocs.forEach((doc) => {
    const data = doc.exists ? doc.data() : {};

    people[doc.id] = {
      name: data.displayName || data.username || "Unknown",
      username: data.username || "",
      email: data.email || "",
    };
  });

  const boxes = spaceIds
    .map((spaceId) => {
      const bids = (bidsBySpace[spaceId] || [])
        .slice()
        .sort((a, b) => toMs(b.updatedAt) - toMs(a.updatedAt))
        .map((bid) => ({
          userId: bid.userId,
          ...(people[bid.userId] || { name: "Unknown", username: "", email: "" }),
          amount: bid.amount,
          status: bid.status || "pending",
          counterAmount: bid.counterAmount || null,
          counterBy: toIso(bid.counterExpiresAt),
          expiredReason: bid.expiredReason || null,
          at: bid.updatedAt?.toDate?.().toISOString?.() || null,
        }));

      const result = resultsBySpace[spaceId] || null;

      return {
        spaceId,
        number: boxNumber(spaceId),
        taken: taken[spaceId] === true,
        bids,
        result: result
          ? {
              winnerId: result.winnerId,
              winnerName: people[result.winnerId]?.name || "Unknown",
              amount: result.amount,
              payBy: toIso(result.expiresAt), // null once they have paid
              paid: !result.expiresAt && Boolean(result.paidAt),
            }
          : null,
      };
    })
    .sort((a, b) => a.number - b.number);

  return { bidBoxCount: BID_BOX_COUNT, boxes };
}

// Shared by accept / reject / counter: load the bid and the box state.
async function loadForDecision(transaction, spaceId, bidderId) {
  const bidRef = bidsCollection.doc(`${spaceId}_${bidderId}`);

  const [space, result, bidDoc] = await transaction.getAll(
    db.collection("spaces").doc(spaceId),
    resultsCollection.doc(spaceId),
    bidRef
  );

  if (!bidDoc.exists) {
    throw new BidError("BID_NOT_FOUND", 404, "That bid no longer exists");
  }

  if (space.exists && space.data().status === "occupied") {
    throw new BidError("SPACE_ALREADY_OCCUPIED", 409, "This box has already been taken");
  }

  if (result.exists) {
    throw new BidError("BIDDING_CLOSED", 409, "A bid has already been accepted on this box");
  }

  return { bidRef, bid: bidDoc.data() };
}

function checkBidBox(spaceId) {
  if (!isBidBox(spaceId)) {
    throw new BidError("NOT_A_BID_BOX", 400, "Bidding is not open on this box");
  }
}

// ACCEPT: this person wins at their bid; every other bid on the box is rejected.
async function acceptBid(spaceId, bidderId, adminId) {
  checkBidBox(spaceId);
  await settleBox(spaceId);

  const outcome = await db.runTransaction(async (transaction) => {
    const { bidRef, bid } = await loadForDecision(transaction, spaceId, bidderId);

    if (bid.status !== "pending") {
      throw new BidError("NOT_PENDING", 409, "Only a pending bid can be accepted");
    }

    const all = await transaction.get(bidsCollection.where("spaceId", "==", spaceId));
    const deadline = payDeadline();

    transaction.set(resultsCollection.doc(spaceId), {
      spaceId,
      boxNumber: boxNumber(spaceId),
      winnerId: bidderId,
      amount: bid.amount,
      via: "accept",
      closedAt: new Date(),
      closedBy: adminId,
      expiresAt: deadline, // NEW: 48 hours to pay
    });

    transaction.update(bidRef, { status: "accepted", updatedAt: new Date() });

    const others = all.docs.filter((doc) => doc.id !== bidRef.id);

    others.forEach((doc) =>
      transaction.update(doc.ref, { status: "rejected", updatedAt: new Date() })
    );

    return {
      amount: bid.amount,
      payBy: deadline,
      otherIds: others.map((doc) => doc.data().userId),
    };
  });

  await notifyBidWon(bidderId, spaceId, outcome.amount, PAY_WINDOW_HOURS);
  await Promise.all(outcome.otherIds.map((id) => notifyBidEnded(id, spaceId, "lost")));

  // NEW: email the winner with the amount and the deadline.
  emailBidder(bidderId, "accepted", {
    boxLabel: `#${boxNumber(spaceId)}`,
    amount: outcome.amount,
    payBy: outcome.payBy,
  });

  return { winnerId: bidderId, amount: outcome.amount };
}

// REJECT: decline this bid (the person may bid again).
async function rejectBid(spaceId, bidderId) {
  checkBidBox(spaceId);
  await settleBox(spaceId);

  let amount = null;

  await db.runTransaction(async (transaction) => {
    const { bidRef, bid } = await loadForDecision(transaction, spaceId, bidderId);

    if (bid.status !== "pending" && bid.status !== "countered") {
      throw new BidError("NOT_PENDING", 409, "This bid is already decided");
    }

    amount = bid.amount;
    transaction.update(bidRef, { status: "rejected", updatedAt: new Date() });
  });

  await notifyBidRejected(bidderId, spaceId);
  emailBidder(bidderId, "rejected", { boxLabel: `#${boxNumber(spaceId)}`, amount });

  return { rejected: true };
}

// COUNTER: propose a different amount. The person accepts or declines.
async function counterBid(spaceId, bidderId, counterAmount) {
  checkBidBox(spaceId);
  await settleBox(spaceId);

  if (!wholeRupees(counterAmount)) throw BAD_AMOUNT();

  let original = null;
  const deadline = replyDeadline();

  await db.runTransaction(async (transaction) => {
    const { bidRef, bid } = await loadForDecision(transaction, spaceId, bidderId);

    if (bid.status !== "pending" && bid.status !== "countered") {
      throw new BidError("NOT_PENDING", 409, "This bid is already decided");
    }

    original = bid.amount;
    transaction.update(bidRef, {
      status: "countered",
      counterAmount,
      counterExpiresAt: deadline, // NEW: they have 48 hours to answer
      expiredReason: null,
      updatedAt: new Date(),
    });
  });

  await notifyBidCountered(bidderId, spaceId, counterAmount, REPLY_WINDOW_HOURS);
  emailBidder(bidderId, "countered", {
    boxLabel: `#${boxNumber(spaceId)}`,
    amount: original,
    counterAmount,
    counterBy: deadline,
    replyHours: REPLY_WINDOW_HOURS,
  });

  return { counterAmount };
}

// Throw every bid (and any accepted result) away so the box can start over.
// Use it if the winner never pays.
async function cancelBidding(spaceId) {
  checkBidBox(spaceId);

  const bidsSnap = await bidsCollection.where("spaceId", "==", spaceId).get();
  const bidderIds = bidsSnap.docs.map((doc) => doc.data().userId);

  const batch = db.batch();

  bidsSnap.forEach((doc) => batch.delete(doc.ref));
  batch.delete(resultsCollection.doc(spaceId));

  await batch.commit();

  await Promise.all(bidderIds.map((id) => notifyBidEnded(id, spaceId, "cancelled")));

  return { removed: bidderIds.length };
}

module.exports = {
  BID_BOX_COUNT,
  BidError,
  isBidBox,
  getBidOverview,
  placeBid,
  respondToCounter,
  getPurchaseRule,
  getAdminBoard,
  sweepExpired,
  PAY_WINDOW_HOURS,
  REPLY_WINDOW_HOURS,
  acceptBid,
  rejectBid,
  counterBid,
  cancelBidding,
};