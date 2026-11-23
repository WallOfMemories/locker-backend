const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// "Paid but not posted": the server must recognise it so nobody pays twice.

function load(payments) {
  const store = new Map(Object.entries(payments));

  const query = (filters = []) => ({
    where: (field, op, value) => query([...filters, { field, value }]),
    async get() {
      const docs = [...store.entries()]
        .filter(([, data]) => filters.every(({ field, value }) => data[field] === value))
        .map(([id, data]) => ({ id, data: () => data }));

      return { docs, size: docs.length };
    },
  });

  const stub = (relative, exports) => {
    const file = require.resolve(path.join(__dirname, "..", "src", relative));

    require.cache[file] = { id: file, filename: file, loaded: true, exports };
  };

  stub("config/firebase.js", { db: { collection: () => ({ doc: () => ({}), ...query() }) } });
  stub("config/razorpay.js", {});
  stub("services/capsuleService.js", { toISO: () => null });
  stub("services/notificationService.js", { notifyRefund: async () => {} });

  delete require.cache[require.resolve("../src/services/paymentService.js")];

  return require("../src/services/paymentService.js");
}

const pay = (over = {}) => ({
  userId: "u1",
  kind: "space",
  spaceId: "space_010",
  status: "paid",
  snapId: null,
  ...over,
});

test("a paid, unused payment for this space is found", async () => {
  const { findUnusedPaidPayment } = load({ pay_1: pay() });

  assert.equal(await findUnusedPaidPayment("u1", "space_010"), "pay_1");
});

test("nothing is found for another person, another space, a used or a refunded payment", async () => {
  const { findUnusedPaidPayment } = load({
    pay_1: pay({ userId: "u2" }),
    pay_2: pay({ spaceId: "space_011" }),
    pay_3: pay({ snapId: "snap_1" }),
    pay_4: pay({ status: "refunded" }),
    pay_5: pay({ status: "refunding" }),
    pay_6: pay({ kind: "test" }),
  });

  assert.equal(await findUnusedPaidPayment("u1", "space_010"), null);
});