// TEMPORARY standalone Razorpay check. Delete this file after testing.
// Put it in the backend root (next to package.json) and run:  node razorpay-test.js
// It does NOT touch Firebase, your routes, or any database.

require("dotenv").config(); // reads backend/.env
const crypto = require("crypto");
const Razorpay = require("razorpay");

const keyId = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_KEY_SECRET;

// STEP 0: show what was actually loaded (secret is never printed)
console.log("1) Loaded credentials");
console.log("   KEY_ID        :", JSON.stringify(keyId));
console.log("   KEY_ID length :", keyId?.length, "(expected 22)");
console.log("   SECRET length :", keySecret?.length, "(expected 24)");

if (!keyId || !keySecret) {
  console.error("\n❌ RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET missing in backend/.env");
  process.exit(1);
}
if (!keyId.startsWith("rzp_test_")) {
  console.error("\n⚠️  Not a test key. Stopping so no real order is created.");
  process.exit(1);
}

const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });

(async () => {
  // STEP 1: create a ₹1 order (100 paise = Razorpay's minimum)
  console.log("\n2) Creating a ₹1 test order...");
  let order;
  try {
    order = await razorpay.orders.create({
      amount: 100,
      currency: "INR",
      receipt: `test_${Date.now()}`.slice(0, 40), // max 40 chars
    });
    console.log("   ✅ Order created:", order.id, `(${order.amount} ${order.currency})`);
  } catch (err) {
    console.error("   ❌ Order failed:", err?.statusCode, err?.error?.description || err.message);
    if (err?.statusCode === 401) {
      console.error("   → Razorpay rejected the key pair. Regenerate test keys in the dashboard (Test Mode),");
      console.error("     update backend/.env, and run this again.");
    }
    process.exit(1);
  }

  // STEP 2: check the signature logic with a fake payment id
  // (a real signature only exists after a real checkout; this proves the maths + the rejection path)
  console.log("\n3) Signature check (simulated)");
  const fakePaymentId = "pay_TEST123456789";
  const sign = (o, p) =>
    crypto.createHmac("sha256", keySecret).update(`${o}|${p}`).digest("hex");

  const good = sign(order.id, fakePaymentId);
  const matches = (a, b) =>
    a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

  console.log("   correct signature accepted :", matches(good, sign(order.id, fakePaymentId)) ? "✅" : "❌");
  console.log("   tampered signature rejected:", !matches(good, "0".repeat(good.length)) ? "✅" : "❌");

  console.log("\nDone. Keys work ✅  — delete razorpay-test.js now.");
})();