const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// "Pay first, post whenever you want": a PAID space stays reserved for that
// person with no deadline, and the wall shows it as reserved.

function makeFakeDb(seed) {
  const data = {};
  const col = (name) => (data[name] ||= new Map());

  Object.entries(seed).forEach(([name, docs]) =>
    Object.entries(docs).forEach(([id, value]) => col(name).set(id, value))
  );

  const snap = (name, id) => {
    const value = col(name).get(id);

    return { id, exists: value !== undefined, data: () => value, _col: name };
  };

  const docRef = (name, id) => ({
    _col: name,
    id,
    get: async () => snap(name, id),
    set: async (value) => col(name).set(id, value),
    create: async (value) => {
      if (col(name).has(id)) {
        const error = new Error("ALREADY_EXISTS");

        error.code = 6;
        throw error;
      }

      col(name).set(id, value);
    },
    update: async (value) => col(name).set(id, { ...col(name).get(id), ...value }),
  });

  const query = (name, filters = []) => ({
    where: (field, op, value) => query(name, [...filters, { field, value }]),
    orderBy: () => query(name, filters),
    async get() {
      const docs = [...col(name).entries()]
        .filter(([, value]) => filters.every(({ field, value: want }) => value[field] === want))
        .map(([id]) => snap(name, id));

      return { docs, size: docs.length, empty: docs.length === 0, forEach: (fn) => docs.forEach(fn) };
    },
  });

  const db = {
    collection: (name) => ({ doc: (id) => docRef(name, id), ...query(name) }),
    getAll: async (...refs) => refs.map((ref) => snap(ref._col, ref.id)),
    async runTransaction(fn) {
      return fn({
        get: (ref) => ref.get(),
        getAll: (...refs) => db.getAll(...refs),
        set: (ref, value) => ref.set(value),
        delete: (ref) => col(ref._col).delete(ref.id),
      });
    },
  };

  return { db, data };
}

function load(seed = {}) {
  const fake = makeFakeDb(seed);

  const stub = (relative, exports) => {
    const file = require.resolve(path.join(__dirname, "..", "src", relative));

    require.cache[file] = { id: file, filename: file, loaded: true, exports };
  };

  stub("config/firebase.js", { db: fake.db });
  stub("config/razorpay.js", {});
  stub("services/capsuleService.js", { toISO: () => null, isSnapLocked: () => false });
  stub("services/notificationService.js", { notifyRefund: async () => {} });
  stub("services/privacyService.js", { getPrivacy: async () => ({}) });

  for (const name of ["reservationService", "paymentService", "spaceService"]) {
    delete require.cache[require.resolve(`../src/services/${name}.js`)];
  }

  return {
    fake,
    reservations: require("../src/services/reservationService.js"),
    payments: require("../src/services/paymentService.js"),
    spaces: require("../src/services/spaceService.js"),
  };
}

const free = { spaces: { space_030: { status: "available" }, space_031: { status: "available" } } };

test("who counts as 'reserved by someone else'", () => {
  const { reservations } = load();
  const live = new Date(Date.now() + 60000);
  const past = new Date(Date.now() - 60000);

  assert.equal(reservations.isReservedByOther(null, "u1"), false);
  assert.equal(reservations.isReservedByOther({ userId: "u1", expiresAt: live }, "u1"), false);
  assert.equal(reservations.isReservedByOther({ userId: "u2", expiresAt: live }, "u1"), true);
  assert.equal(reservations.isReservedByOther({ userId: "u2", expiresAt: past }, "u1"), false);
  // a PAID reservation never runs out
  assert.equal(reservations.isReservedByOther({ userId: "u2", paid: true, expiresAt: null }, "u1"), true);
  assert.equal(reservations.isReservedByOther({ userId: "u1", paid: true, expiresAt: null }, "u1"), false);
});

test("once paid, the space is reserved for good: others can't take it", async () => {
  const { reservations, fake } = load(free);

  await reservations.reserveSpace("space_030", "u1");
  await reservations.markReservationPaid("space_030", "u1", "pay_1");

  const held = fake.data.reservations.get("space_030");

  assert.equal(held.paid, true);
  assert.equal(held.expiresAt, null);
  assert.equal(held.paymentId, "pay_1");

  await assert.rejects(() => reservations.reserveSpace("space_030", "u2"), (error) => {
    assert.equal(error.code, "SPACE_RESERVED");
    assert.match(error.message, /reserved by someone else/);
    return true;
  });
});

test("the owner can come back later and it stays paid; closing a window doesn't free it", async () => {
  const { reservations, fake } = load(free);

  await reservations.markReservationPaid("space_030", "u1", "pay_1");

  await reservations.reserveSpace("space_030", "u1"); // opens the page again
  assert.equal(fake.data.reservations.get("space_030").paid, true);

  await reservations.releaseSpace("space_030", "u1"); // "I'll do it later"
  assert.equal(fake.data.reservations.has("space_030"), true);
});

test("a normal 10-minute hold is still released when the window closes", async () => {
  const { reservations, fake } = load(free);

  await reservations.reserveSpace("space_030", "u1");
  await reservations.releaseSpace("space_030", "u1");

  assert.equal(fake.data.reservations.has("space_030"), false);
});

test("a refund gives the space back, but only for the matching payment", async () => {
  const { reservations, fake } = load(free);

  await reservations.markReservationPaid("space_030", "u1", "pay_1");

  await reservations.releasePaidReservation("space_030", "pay_OTHER");
  assert.equal(fake.data.reservations.has("space_030"), true);

  await reservations.releasePaidReservation("space_030", "pay_1");
  assert.equal(fake.data.reservations.has("space_030"), false);
});

test("recording a space payment reserves the space; a replay or a test payment doesn't", async () => {
  const { payments, fake } = load(free);

  await payments.recordPayment({ paymentId: "pay_1", userId: "u1", kind: "space", spaceId: "space_030" });
  assert.equal(fake.data.reservations.get("space_030").userId, "u1");
  assert.equal(fake.data.reservations.get("space_030").paid, true);

  await payments.recordPayment({ paymentId: "pay_t", userId: "u2", kind: "test" });
  assert.equal(fake.data.reservations.size, 1);

  // replaying the same payment changes nothing
  fake.data.reservations.delete("space_030");
  assert.deepEqual(
    await payments.recordPayment({ paymentId: "pay_1", userId: "u1", kind: "space", spaceId: "space_030" }),
    { created: false }
  );
  assert.equal(fake.data.reservations.has("space_030"), false);
});

test("the wall marks paid-reserved boxes (yes/no only), never occupied ones", async () => {
  const { reservations, spaces } = load({
    spaces: {
      space_030: { status: "available" },
      space_031: { status: "available" },
      space_032: { status: "occupied" },
    },
  });

  await reservations.markReservationPaid("space_030", "u1", "pay_1");
  await reservations.markReservationPaid("space_032", "u2", "pay_2");
  await reservations.reserveSpace("space_031", "u3"); // only a 10-minute hold

  const list = await spaces.getAllSpaces();
  const byId = Object.fromEntries(list.map((space) => [space.id, space]));

  assert.equal(byId.space_030.reserved, true);
  assert.equal(byId.space_031.reserved, undefined);
  assert.equal(byId.space_032.reserved, undefined);
  assert.equal("userId" in byId.space_030, false); // who is never exposed
});