// ------------------------------------------------------------
// Sets the price of a space (in rupees) in Firestore
// (settings/snapwall.spacePrice) — the value the wall, the Create Snap
// button AND the Razorpay charge all read.
//
// Run it from the backend folder (the one with package.json and .env):
//
//     node src/scripts/setSpacePrice.js 10
//
// Changing the default in the code does NOT change a price that is already
// saved in Firestore — this script does.
// ------------------------------------------------------------

// must load .env BEFORE firebase.js is required (it reads the credentials)
require("dotenv").config();

const { updateSnapWallSettings } = require("../services/settingsService");

async function main() {
  const price = Number(process.argv[2]);

  // Razorpay's smallest order is ₹1; two decimals at most (paise).
  if (!Number.isFinite(price) || price < 1 || price > 100000) {
    console.error("Usage: node src/scripts/setSpacePrice.js <price in rupees, at least 1>");
    process.exit(1);
  }

  if (Math.round(price * 100) !== price * 100) {
    console.error("Use at most 2 decimal places, e.g. 10 or 9.50");
    process.exit(1);
  }

  // Changes ONLY spacePrice; the other wall settings are kept.
  const settings = await updateSnapWallSettings({ spacePrice: price });

  console.log(`Space price is now ₹${settings.spacePrice}`);
  process.exit(0);
}

main().catch((error) => {
  console.error("Could not set the price:", error);
  process.exit(1);
});