const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// ------------------------------------------------------------
// Bidding rules, tested against a tiny in-memory Firestore (no network).
// ------------------------------------------------------------

function makeFakeDb(seed) {
  const data = {}; // collection -> Map(id -> doc data)

  const col = (name) => (data[name] ||= new Map());

  Object.entries(seed).forEach(([name, docs]) =>
    Object.entries(docs).forEach(([id, value]) => col(name).set(id, value))
  );

  function docRef(name, id) {
    return {
      _col: name,
      id,
      async get() {
        return snap(name, id);
      },
      async set(value) {
        col(name).set(id, value);
      },
      async create(value) {
        col(name).set(id, value);
      },
      async update(value) {
        col(name).set(id, { ...col(name).get(id), ...value });
      },
    };
  }

  function snap(name, id) {
    const value = col(name).get(id);

    return { id, exists: value !== undefined, data: () => value, ref: docRef(name, id) };
  }

  function query(name, filters = [], max = Infinity) {
    return {
      where(field, op, value) {
        return query(name, [...filters, { field, op, value }], max);
      },
      limit(n) {
        return query(name, filters, n);
      },
      async get() {
        const docs = [...col(name).entries()]
          .filter(([, value]) =>
            filters.every(({ field, op, value: want }) =>
              op === "==" ? value[field] === want : value[field] <= want
            )
          )
          .slice(0, max)
          .map(([id]) => snap(name, id));

        return { docs, size: docs.length, empty: docs.length === 0, forEach: (fn) => docs.forEach(fn) };
      },
      _isQuery: true,
    };
  }

  const db = {
    collection: (name) => ({ doc: (id) => docRef(name, id), ...query(name) }),
    async getAll(...refs) {
      return refs.map((ref) => snap(ref._col, ref.id));
    },
    async runTransaction(fn) {
      const transaction = {
        getAll: (...refs) => db.getAll(...refs),
        get: (target) => target.get(),
        set: (ref, value) => ref.set(value),
        update: (ref, value) => ref.update(value),
        delete: (ref) => col(ref._col).delete(ref.id),
      };

      return fn(transaction);
    },
    batch() {
      const ops = [];

      return {
        delete: (ref) => ops.push(() => col(ref._col).delete(ref.id)),
        async commit() {
          ops.forEach((op) => op());
        },
      };
    },
  };

  return { db, data };
}

function load(seed) {
  const fake = makeFakeDb(seed);
  const notes = [];
  const emails = [];
  const bidderEmails = [];

  const stub = (relative, exports) => {
    const file = require.resolve(path.join(__dirname, "..", "src", relative));

    require.cache[file] = { id: file, filename: file, loaded: true, exports };
  };

  stub("config/firebase.js", {
    db: fake.db,
    adminAuth: { getUser: async (uid) => ({ email: `${uid}@auth.test` }) },
  });
  stub("services/notificationService.js", {
    notifyBidWon: async (u, s, a) => notes.push(["won", u, s, a]),
    notifyBidEnded: async (u, s, k) => notes.push([k, u, s]),
    notifyBidCountered: async (u, s, a) => notes.push(["countered", u, s, a]),
    notifyBidRejected: async (u, s) => notes.push(["rejected", u, s]),
    notifyBidExpired: async (u, s) => notes.push(["expired", u, s]),
    notifyBidCounterExpired: async (u, s) => notes.push(["counterExpired", u, s]),
  });
  stub("services/mailService.js", {
    sendBidEmailToAdmin: async (bid) => emails.push(bid),
    sendBidderEmail: async (kind, info) => bidderEmails.push({ kind, ...info }),
  });
  stub("services/settingsService.js", {
    getTheLockerSettings: async () => ({ spacePrice: 10 }),
  });

  delete require.cache[require.resolve("../src/services/bidService.js")];

  return { bids: require("../src/services/bidService.js"), fake, notes, emails, bidderEmails };
}

const free = (status = "available") => ({
  spaces: { space_005: { status }, space_050: { status: "available" } },
  users: {
    u1: { displayName: "Asha", username: "asha", email: "asha@mail.test" },
    u2: { displayName: "Ravi", username: "ravi", email: "ravi@mail.test" },
  },
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("only the first 20 boxes are bid boxes", () => {
  const { bids } = load(free());

  assert.equal(bids.isBidBox("space_001"), true);
  assert.equal(bids.isBidBox("space_020"), true);
  assert.equal(bids.isBidBox("space_021"), false);
});

test("a taken box cannot be bid on (no change)", async () => {
  const { bids, fake } = load(free("occupied"));

  await assert.rejects(() => bids.placeBid("space_005", "u1", 50), { code: "SPACE_ALREADY_OCCUPIED" });
  assert.equal((fake.data.bids || new Map()).size, 0);
});

test("a bid is saved as pending and the admin is emailed the user's details", async () => {
  const { bids, emails } = load(free());

  const box = await bids.placeBid("space_005", "u1", 50);
  await settle();

  assert.deepEqual(box.myBid, {
    amount: 50,
    status: "pending",
    counterAmount: null,
    counterBy: null,
    expiredReason: null,
  });
  assert.equal(emails.length, 1);
  assert.equal(emails[0].amount, 50);
  assert.equal(emails[0].boxLabel, "#5");
  assert.deepEqual(emails[0].user, { uid: "u1", name: "Asha", username: "asha", email: "asha@mail.test" });
});

test("bad amounts and non-bid boxes are refused", async () => {
  const { bids } = load(free());

  await assert.rejects(() => bids.placeBid("space_005", "u1", 10), { code: "BID_TOO_LOW" });
  await assert.rejects(() => bids.placeBid("space_005", "u1", 12.5), { code: "BAD_AMOUNT" });
  await assert.rejects(() => bids.placeBid("space_005", "u1", -5), { code: "BAD_AMOUNT" });
  await assert.rejects(() => bids.placeBid("space_050", "u1", 50), { code: "NOT_A_BID_BOX" });
});

test("other people's bids are never shown", async () => {
  const { bids } = load(free());

  await bids.placeBid("space_005", "u1", 50);

  assert.equal((await bids.getBidOverview("u2")).boxes.space_005, undefined);
  assert.equal((await bids.getBidOverview("u1")).boxes.space_005.myBid.amount, 50);
});

test("bid boxes are bid-only until the admin accepts someone", async () => {
  const { bids } = load(free());

  assert.equal((await bids.getPurchaseRule("space_005", "u3")).code, "BID_ONLY");
  assert.deepEqual(await bids.getPurchaseRule("space_050", "u3"), { allowed: true });

  await bids.placeBid("space_005", "u1", 50);
  await bids.placeBid("space_005", "u2", 80);
  await bids.acceptBid("space_005", "u1", "admin1");

  assert.deepEqual(await bids.getPurchaseRule("space_005", "u1"), { allowed: true, amountRupees: 50 });
  assert.equal((await bids.getPurchaseRule("space_005", "u2")).code, "BID_WON_BY_OTHER");
});

test("accepting wins the box at that bid, rejects the others and locks the box", async () => {
  const { bids, notes, fake } = load(free());

  await bids.placeBid("space_005", "u1", 50);
  await bids.placeBid("space_005", "u2", 80);

  assert.deepEqual(await bids.acceptBid("space_005", "u1", "admin1"), { winnerId: "u1", amount: 50 });
  assert.equal(fake.data.bids.get("space_005_u2").status, "rejected");
  assert.deepEqual(notes, [["won", "u1", "space_005", 50], ["lost", "u2", "space_005"]]);

  await assert.rejects(() => bids.placeBid("space_005", "u3", 99), { code: "BIDDING_CLOSED" });
  await assert.rejects(() => bids.acceptBid("space_005", "u2", "admin1"), { code: "BIDDING_CLOSED" });
});

test("rejecting declines the bid and the person can bid again", async () => {
  const { bids, notes, fake } = load(free());

  await bids.placeBid("space_005", "u1", 50);
  await bids.rejectBid("space_005", "u1");

  assert.equal(fake.data.bids.get("space_005_u1").status, "rejected");
  assert.deepEqual(notes, [["rejected", "u1", "space_005"]]);

  const box = await bids.placeBid("space_005", "u1", 70);

  assert.equal(box.myBid.status, "pending");
  assert.equal(box.myBid.amount, 70);
});

test("a counter offer: the person accepts it and wins at the counter amount", async () => {
  const { bids, notes } = load(free());

  await bids.placeBid("space_005", "u1", 50);
  await bids.counterBid("space_005", "u1", 120);

  assert.deepEqual(notes[0], ["countered", "u1", "space_005", 120]);
  const countered = (await bids.getBidOverview("u1")).boxes.space_005.myBid;

  assert.equal(countered.amount, 50);
  assert.equal(countered.status, "countered");
  assert.equal(countered.counterAmount, 120);
  assert.ok(countered.counterBy); // the 48-hour reply deadline

  // a countered bid can't be accepted by the admin directly
  await assert.rejects(() => bids.acceptBid("space_005", "u1", "admin1"), { code: "NOT_PENDING" });

  const box = await bids.respondToCounter("space_005", "u1", "accept");

  assert.equal(box.iAmWinner, true);
  assert.equal(box.winningAmount, 120);
  assert.deepEqual(await bids.getPurchaseRule("space_005", "u1"), { allowed: true, amountRupees: 120 });
});

test("a counter offer the person declines is rejected", async () => {
  const { bids } = load(free());

  await bids.placeBid("space_005", "u1", 50);
  await assert.rejects(() => bids.respondToCounter("space_005", "u1", "accept"), { code: "NO_COUNTER" });

  await bids.counterBid("space_005", "u1", 120);
  const box = await bids.respondToCounter("space_005", "u1", "decline");

  assert.equal(box.myBid.status, "rejected");
  assert.equal(box.closed, false);
});

test("cancelling clears the bids; the box stays bid-only", async () => {
  const { bids } = load(free());

  await bids.placeBid("space_005", "u1", 50);
  await bids.acceptBid("space_005", "u1", "admin1");

  assert.deepEqual(await bids.cancelBidding("space_005"), { removed: 1 });
  assert.equal((await bids.getPurchaseRule("space_005", "u1")).code, "BID_ONLY");

  const box = await bids.placeBid("space_005", "u2", 60);

  assert.equal(box.myBid.status, "pending");
});

test("the admin board lists bidders with their details", async () => {
  const { bids } = load(free());

  await bids.placeBid("space_005", "u1", 50);

  const board = await bids.getAdminBoard();

  assert.equal(board.boxes[0].number, 5);
  assert.equal(board.boxes[0].bids[0].email, "asha@mail.test");
  assert.equal(board.boxes[0].bids[0].status, "pending");
});

test("someone using the box right now blocks a new bid", async () => {
  const { bids } = load({
    ...free(),
    reservations: { space_005: { userId: "buyer", expiresAt: new Date(Date.now() + 60000) } },
  });

  await assert.rejects(() => bids.placeBid("space_005", "u1", 50), { code: "SPACE_RESERVED" });
});

// ---------- NEW: the 48-hour payment window + bidder emails ----------

const HOUR = 60 * 60 * 1000;

test("an accepted bid has 48 hours to pay, and the winner is emailed", async () => {
  const { bids, fake, bidderEmails } = load(free());

  await bids.placeBid("space_005", "u1", 50);
  const before = Date.now();
  await bids.acceptBid("space_005", "u1", "admin1");
  await settle();

  const result = fake.data.bidResults.get("space_005");
  const hours = (result.expiresAt.getTime() - before) / HOUR;

  assert.ok(hours > 47.9 && hours < 48.1, `window was ${hours}h`);
  assert.equal(bidderEmails.length, 1);
  assert.equal(bidderEmails[0].kind, "accepted");
  assert.equal(bidderEmails[0].to, "asha@mail.test");
  assert.equal(bidderEmails[0].amount, 50);
  assert.equal(bidderEmails[0].payHours, 48);
  assert.ok(bidderEmails[0].payBy);

  // the winner (only) can see their deadline
  assert.ok((await bids.getBidOverview("u1")).boxes.space_005.payBy);
  assert.equal(await (async () => (await bids.getBidOverview("u2")).boxes.space_005.payBy)(), null);
});

test("a winner who doesn't pay in 48 hours loses the box and others can bid", async () => {
  const { bids, fake, notes, bidderEmails } = load(free());

  await bids.placeBid("space_005", "u1", 50);
  await bids.acceptBid("space_005", "u1", "admin1");

  // time passes: the deadline is now in the past
  fake.data.bidResults.get("space_005").expiresAt = new Date(Date.now() - 1000);

  // box is open again for everyone (and bid-only)
  assert.equal((await bids.getPurchaseRule("space_005", "u1")).code, "BID_ONLY");
  assert.equal(fake.data.bidResults.has("space_005"), false);
  assert.equal(fake.data.bids.get("space_005_u1").status, "expired");
  assert.ok(notes.some((n) => n[0] === "expired" && n[1] === "u1"));

  await settle();
  assert.ok(bidderEmails.some((e) => e.kind === "expired" && e.to === "asha@mail.test"));

  const box = await bids.placeBid("space_005", "u2", 60);

  assert.equal(box.myBid.status, "pending");
  assert.equal((await bids.getBidOverview("u1")).boxes.space_005.myBid.status, "expired");
});

test("a winner who already posted their Snap is NOT expired", async () => {
  const { bids, fake, notes } = load(free());

  await bids.placeBid("space_005", "u1", 50);
  await bids.acceptBid("space_005", "u1", "admin1");

  fake.data.spaces.set("space_005", { status: "occupied" });
  fake.data.bidResults.get("space_005").expiresAt = new Date(Date.now() - 1000);

  assert.equal(await bids.sweepExpired().then((r) => r.released), 0);
  assert.equal(notes.some((n) => n[0] === "expired"), false);
  assert.equal(fake.data.bids.get("space_005_u1").status, "accepted");
});

test("the daily sweep releases only the boxes that ran out of time", async () => {
  const { bids, fake } = load({
    spaces: { space_005: { status: "available" }, space_006: { status: "available" } },
    users: { u1: { displayName: "Asha", email: "a@x.test" }, u2: { displayName: "Ravi", email: "r@x.test" } },
  });

  await bids.placeBid("space_005", "u1", 50);
  await bids.placeBid("space_006", "u2", 70);
  await bids.acceptBid("space_005", "u1", "admin1");
  await bids.acceptBid("space_006", "u2", "admin1");

  fake.data.bidResults.get("space_005").expiresAt = new Date(Date.now() - 1000);

  const sweep = await bids.sweepExpired();

  assert.equal(sweep.released, 1);
  assert.equal(fake.data.bidResults.has("space_006"), true);
});

test("a counter offer accepted by the bidder also starts the 48 hours and emails them", async () => {
  const { bids, fake, bidderEmails } = load(free());

  await bids.placeBid("space_005", "u1", 50);
  await bids.counterBid("space_005", "u1", 120);
  await settle();
  assert.equal(bidderEmails.at(-1).kind, "countered");
  assert.equal(bidderEmails.at(-1).counterAmount, 120);

  await bids.respondToCounter("space_005", "u1", "accept");
  await settle();

  assert.ok(fake.data.bidResults.get("space_005").expiresAt instanceof Date);
  assert.equal(bidderEmails.at(-1).kind, "accepted");
  assert.equal(bidderEmails.at(-1).amount, 120);
});

test("a rejected bid emails the bidder", async () => {
  const { bids, bidderEmails } = load(free());

  await bids.placeBid("space_005", "u1", 50);
  await bids.rejectBid("space_005", "u1");
  await settle();

  assert.equal(bidderEmails.at(-1).kind, "rejected");
  assert.equal(bidderEmails.at(-1).amount, 50);
});

// ---------- NEW: paid = reserved for good; counter offers expire too ----------

const paidPayment = (overrides = {}) => ({
  userId: "u1",
  kind: "space",
  spaceId: "space_005",
  status: "paid",
  snapId: null,
  ...overrides,
});

test("once the winner has PAID, the box stays theirs with no deadline", async () => {
  const { bids, fake, notes } = load({ ...free(), payments: { pay_1: paidPayment() } });

  await bids.placeBid("space_005", "u1", 50);
  await bids.placeBid("space_005", "u2", 80);
  await bids.acceptBid("space_005", "u1", "admin1");

  // the 48 hours pass...
  fake.data.bidResults.get("space_005").expiresAt = new Date(Date.now() - 1000);

  assert.equal((await bids.getPurchaseRule("space_005", "u2")).code, "BID_WON_BY_OTHER");
  assert.equal(fake.data.bidResults.has("space_005"), true); // still reserved
  assert.equal(fake.data.bidResults.get("space_005").expiresAt, null); // no more deadline
  assert.equal(notes.some((n) => n[0] === "expired"), false);
  assert.equal(fake.data.bids.get("space_005_u1").status, "accepted");

  // days later: still theirs, and the daily sweep leaves it alone
  assert.equal((await bids.sweepExpired()).released, 0);
  await assert.rejects(() => bids.placeBid("space_005", "u3", 99), { code: "BIDDING_CLOSED" });
});

test("a winner who already paid sees 'finish posting', and can't be charged twice", async () => {
  const { bids } = load({ ...free(), payments: { pay_1: paidPayment() } });

  await bids.placeBid("space_005", "u1", 50);
  await bids.acceptBid("space_005", "u1", "admin1");

  const box = (await bids.getBidOverview("u1")).boxes.space_005;

  assert.equal(box.paidPaymentId, "pay_1");
  assert.equal(box.payBy, null);
  assert.equal((await bids.getPurchaseRule("space_005", "u1")).code, "ALREADY_PAID");
});

test("a payment that was refunded or already used does not hold the box", async () => {
  const { bids, fake } = load({
    ...free(),
    payments: { pay_1: paidPayment({ status: "refunded" }), pay_2: paidPayment({ snapId: "snap_9" }) },
  });

  await bids.placeBid("space_005", "u1", 50);
  await bids.acceptBid("space_005", "u1", "admin1");
  fake.data.bidResults.get("space_005").expiresAt = new Date(Date.now() - 1000);

  assert.equal((await bids.getPurchaseRule("space_005", "u2")).code, "BID_ONLY");
  assert.equal(fake.data.bids.get("space_005_u1").status, "expired");
});

test("a winner who is paying at this very moment is not expired yet", async () => {
  const { bids, fake } = load({
    ...free(),
    reservations: { space_005: { userId: "u1", expiresAt: new Date(Date.now() + 60000) } },
  });

  // (reservation is for u1, so u1 can bid)
  await bids.placeBid("space_005", "u1", 50);
  await bids.acceptBid("space_005", "u1", "admin1");
  fake.data.bidResults.get("space_005").expiresAt = new Date(Date.now() - 1000);

  assert.equal((await bids.getPurchaseRule("space_005", "u1")).allowed, true);
  assert.equal(fake.data.bidResults.has("space_005"), true);
});

test("a counter offer gives the bidder 48 hours to answer", async () => {
  const { bids, fake, bidderEmails } = load(free());

  await bids.placeBid("space_005", "u1", 50);
  const before = Date.now();
  await bids.counterBid("space_005", "u1", 120);
  await settle();

  const hours = (fake.data.bids.get("space_005_u1").counterExpiresAt.getTime() - before) / HOUR;

  assert.ok(hours > 47.9 && hours < 48.1, `reply window was ${hours}h`);
  assert.equal(bidderEmails.at(-1).kind, "countered");
  assert.equal(bidderEmails.at(-1).replyHours, 48);
  assert.ok(bidderEmails.at(-1).counterBy);
  assert.ok((await bids.getBidOverview("u1")).boxes.space_005.myBid.counterBy);
});

test("a counter offer not answered in 48 hours expires, and the person can bid again", async () => {
  const { bids, fake, notes, bidderEmails } = load(free());

  await bids.placeBid("space_005", "u1", 50);
  await bids.counterBid("space_005", "u1", 120);

  fake.data.bids.get("space_005_u1").counterExpiresAt = new Date(Date.now() - 1000);

  await assert.rejects(() => bids.respondToCounter("space_005", "u1", "accept"), { code: "COUNTER_EXPIRED" });

  const bid = fake.data.bids.get("space_005_u1");

  assert.equal(bid.status, "expired");
  assert.equal(bid.expiredReason, "counter");
  assert.ok(notes.some((n) => n[0] === "counterExpired" && n[1] === "u1"));

  await settle();
  assert.ok(bidderEmails.some((e) => e.kind === "counterExpired" && e.counterAmount === 120));

  const box = await bids.placeBid("space_005", "u1", 90);

  assert.equal(box.myBid.status, "pending");
  assert.equal(box.myBid.counterBy, null);
});

test("an expired counter shows as expired right away, and the daily sweep catches the rest", async () => {
  const { bids, fake } = load(free());

  await bids.placeBid("space_005", "u1", 50);
  await bids.counterBid("space_005", "u1", 120);
  fake.data.bids.get("space_005_u1").counterExpiresAt = new Date(Date.now() - 1000);

  const mine = (await bids.getBidOverview("u1")).boxes.space_005.myBid;

  assert.equal(mine.status, "expired");
  assert.equal(mine.expiredReason, "counter");

  await settle();
  assert.equal(fake.data.bids.get("space_005_u1").status, "expired");

  // a second one, caught only by the sweep
  await bids.placeBid("space_005", "u2", 60);
  await bids.counterBid("space_005", "u2", 100);
  fake.data.bids.get("space_005_u2").counterExpiresAt = new Date(Date.now() - 1000);

  assert.equal((await bids.sweepExpired()).countersExpired, 1);
  assert.equal(fake.data.bids.get("space_005_u2").status, "expired");
});

test("accepting a counter in time clears its deadline", async () => {
  const { bids, fake } = load(free());

  await bids.placeBid("space_005", "u1", 50);
  await bids.counterBid("space_005", "u1", 120);
  await bids.respondToCounter("space_005", "u1", "accept");

  assert.equal(fake.data.bids.get("space_005_u1").counterExpiresAt, null);
  assert.equal(fake.data.bids.get("space_005_u1").status, "accepted");
});