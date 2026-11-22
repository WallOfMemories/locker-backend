const crypto = require("crypto");
const express = require("express");

const { publishDueCapsules } = require("../services/capsuleService");
const { purgeDueAccounts } = require("../services/accountService");
const { cleanupOrphanUploads } = require("../services/orphanUploadService"); // NEW

// ------------------------------------------------------------
// Background jobs for hosting that has no always-on process (Vercel).
// On a normal server the timers in start.js do this instead.
//
// Callers must send   Authorization: Bearer <CRON_SECRET>
// (Vercel Cron does this automatically when CRON_SECRET is set; an outside
// pinger such as cron-job.org can be given the header by hand.)
// ------------------------------------------------------------

const router = express.Router();

function requireCronSecret(req, res, next) {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    return res.status(503).json({ success: false, message: "Cron not configured" });
  }

  const header = req.get("authorization") || "";
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(header);

  if (
    expected.length !== received.length ||
    !crypto.timingSafeEqual(expected, received)
  ) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  next();
}

router.use(requireCronSecret);

// Opens Time Capsules whose time has come (ideally every minute).
router.get("/capsules", async (req, res) => {
  try {
    const published = await publishDueCapsules();

    res.json({ success: true, published });
  } catch (error) {
    console.error("Cron capsules failed:", error);
    res.status(500).json({ success: false });
  }
});

// Permanently deletes accounts whose 30-day grace period is over.
router.get("/accounts", async (req, res) => {
  try {
    const purged = await purgeDueAccounts();

    res.json({ success: true, purged });
  } catch (error) {
    console.error("Cron accounts failed:", error);
    res.status(500).json({ success: false });
  }
});

// NEW: deletes Snap photos that were uploaded but never used (older than 48 h).
// Add ?dryRun=true to see what it WOULD delete without deleting anything.
router.get("/orphan-uploads", async (req, res) => {
  try {
    const result = await cleanupOrphanUploads({
      dryRun: req.query.dryRun === "true",
    });

    res.json({ success: true, ...result });
  } catch (error) {
    console.error("Cron orphan uploads failed:", error);
    res.status(500).json({ success: false });
  }
});

module.exports = router;