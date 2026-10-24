// ------------------------------------------------------------
// One place that reads and checks the environment.
// Call loadConfig() once at start-up: it fails fast with a clear message
// instead of letting the server run half-configured in production.
// ------------------------------------------------------------

function list(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function loadConfig(env = process.env) {
  const isProduction = env.NODE_ENV === "production";

  const config = {
    isProduction,
    port: Number(env.PORT) || 5000,
    // Origins allowed to call the API from a browser, e.g.
    // "https://snapwall.app,https://www.snapwall.app"
    corsOrigins: list(env.CORS_ORIGINS),
    // How many reverse proxies sit in front of the app (Render/Railway/
    // Heroku/Cloud Run = 1). Needed so rate limits see the real client IP.
    trustProxy: env.TRUST_PROXY !== undefined ? Number(env.TRUST_PROXY) : isProduction ? 1 : 0,
    adminUids: list(env.ADMIN_UIDS),
    storageBucket: env.FIREBASE_STORAGE_BUCKET || "",
    runSchedulers: env.RUN_SCHEDULERS !== "false",
    // Running as Vercel serverless functions (no always-on process).
    isServerless: Boolean(env.VERCEL),
    // Revoked / disabled accounts are rejected on money + admin routes.
    checkRevoked: env.AUTH_CHECK_REVOKED !== "false",
  };

  const problems = [];
  const warnings = [];

  const required = [
    "FIREBASE_PROJECT_ID",
    "FIREBASE_CLIENT_EMAIL",
    "FIREBASE_PRIVATE_KEY",
    // Username login + password reset run on the server.
    "FIREBASE_WEB_API_KEY",
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
  ];

  required.forEach((name) => {
    if (!env[name]) problems.push(`${name} is not set`);
  });

  if (config.isServerless) {
    if (!env.CRON_SECRET) {
      problems.push(
        "CRON_SECRET is not set — Time Capsules would never open and deleted accounts would never be purged (no always-on process on Vercel)"
      );
    }

    if (!env.REDIS_URL) {
      problems.push(
        "REDIS_URL is required on Vercel — each request can run on a different instance, so in-memory rate limits would not work"
      );
    }
  }

  if (isProduction) {
    if (config.corsOrigins.length === 0) {
      problems.push("CORS_ORIGINS must list your frontend origin(s) in production");
    }

    if (config.corsOrigins.some((origin) => origin === "*" || !/^https:\/\//.test(origin))) {
      problems.push("CORS_ORIGINS must be explicit https:// origins in production (no '*')");
    }

    if (!env.RAZORPAY_WEBHOOK_SECRET) {
      problems.push(
        "RAZORPAY_WEBHOOK_SECRET is not set — payments made when the browser closes early would be lost"
      );
    }

    if (!env.REDIS_URL) {
      warnings.push(
        "REDIS_URL is empty — rate limits are per instance. Fine for ONE instance; set it before running several"
      );
    }

    if (/^rzp_test_/.test(env.RAZORPAY_KEY_ID || "")) {
      warnings.push("RAZORPAY_KEY_ID is a TEST key — no real money will move");
    }

    if (config.adminUids.length === 0) {
      warnings.push(
        "ADMIN_UIDS is empty — admin access falls back to users/{uid}.role. Set ADMIN_UIDS to lock it to specific accounts"
      );
    }

    if (!config.storageBucket) {
      warnings.push(
        "FIREBASE_STORAGE_BUCKET is empty — deleted Snap photos will stay in Storage, and Snap image URLs can't be checked against your bucket"
      );
    }
  }

  return { config, problems, warnings };
}

module.exports = { loadConfig, list };
