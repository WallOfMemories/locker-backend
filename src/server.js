require("dotenv").config();

const { loadConfig } = require("./config/env");

// Check the environment BEFORE anything connects to Firebase / Razorpay, so
// a missing or unsafe setting stops the deploy with a readable message.
const { config, problems, warnings } = loadConfig();

warnings.forEach((warning) => console.warn(`[config] WARNING: ${warning}`));

if (problems.length > 0) {
  problems.forEach((problem) => console.error(`[config] ERROR: ${problem}`));
  console.error("Fix the settings above (see .env.example) and start again.");
  process.exit(1);
}

const { createApp } = require("./app");
const { closeRedis } = require("./config/redis");
const { startAccountDeletionScheduler } = require("./services/accountService");
const { startCapsuleScheduler } = require("./services/capsuleService");

const app = createApp(config);

const server = app.listen(config.port, () => {
  console.log(
    `SnapWall backend running on port ${config.port} (${
      config.isProduction ? "production" : "development"
    })`
  );

  // Background jobs. With more than one instance, run them on ONE only
  // (set RUN_SCHEDULERS=false on the others).
  if (config.runSchedulers) {
    // Unlocks Time Capsules whose date has passed (checks every minute).
    startCapsuleScheduler();

    // Permanently deletes accounts whose 30-day grace period is over.
    startAccountDeletionScheduler();
  }
});

// Slow-loris protection and sane keep-alive behind a load balancer.
server.headersTimeout = 20 * 1000;
server.requestTimeout = 30 * 1000;
server.keepAliveTimeout = 65 * 1000;

// ---------- graceful shutdown (deploys send SIGTERM) ----------
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;
  console.log(`${signal} received — shutting down`);

  server.close(() => closeRedis().finally(() => process.exit(0)));

  // Don't hang forever on open connections.
  setTimeout(() => process.exit(1), 10 * 1000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  shutdown("uncaughtException");
});
