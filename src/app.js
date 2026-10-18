const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const { db } = require("./config/firebase");
const { globalLimiter } = require("./middleware/rateLimiters");
const { razorpayWebhook } = require("./controllers/paymentController");

const spaceRoutes = require("./routes/spaceRoutes");
const settingsRoutes = require("./routes/settingsRoutes");
const snapRoutes = require("./routes/snapRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const userRoutes = require("./routes/userRoutes");
const authRoutes = require("./routes/authRoutes");
const locationRoutes = require("./routes/locationRoutes");
const adminRoutes = require("./routes/adminRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const accountRoutes = require("./routes/accountRoutes");

const DEV_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
];

function createApp(config) {
  const app = express();

  // Behind a platform proxy (Render, Railway, Cloud Run, Nginx...) the real
  // client IP is in X-Forwarded-For. Without this every visitor would share
  // one rate-limit bucket.
  app.set("trust proxy", config.trustProxy);
  app.disable("x-powered-by");

  // Security headers (HSTS, no-sniff, frame denial, ...).
  app.use(helmet());

  // ---------- CORS: only our own frontend ----------
  const allowed = new Set(
    config.corsOrigins.length > 0
      ? config.corsOrigins
      : config.isProduction
        ? []
        : DEV_ORIGINS
  );

  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header = not a browser (health checks, curl, server to
        // server). Browsers always send one on cross-origin requests.
        if (!origin || allowed.has(origin)) return callback(null, true);

        return callback(null, false);
      },
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      allowedHeaders: ["Authorization", "Content-Type"],
      maxAge: 600,
    })
  );

  // Access log without query strings (they can hold coordinates).
  app.use((req, res, next) => {
    if (req.path === "/api/health") return next();

    const started = Date.now();

    res.on("finish", () => {
      console.log(
        `${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms`
      );
    });

    next();
  });

  app.use(globalLimiter);

  // Razorpay's webhook needs the RAW bytes (its signature covers them), so
  // it is registered before the JSON parser.
  app.post(
    "/api/payments/webhook",
    express.raw({ type: "*/*", limit: "100kb" }),
    razorpayWebhook
  );

  // Every request body here is tiny JSON; images go straight to Storage.
  app.use(express.json({ limit: "20kb" }));

  // ---------- Health ----------
  app.get("/", (req, res) => {
    res.json({ success: true, message: "SnapWall API is running" });
  });

  // Liveness: is the process up? (cheap — platform probes call it often)
  app.get("/api/health", (req, res) => {
    res.json({ success: true, message: "SnapWall backend is healthy" });
  });

  // Readiness: can we reach the database? No details are exposed.
  app.get("/api/ready", async (req, res) => {
    try {
      await Promise.race([
        db.collection("settings").doc("snapwall").get(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 5000)
        ),
      ]);

      res.json({ success: true });
    } catch (error) {
      console.error("Readiness check failed:", error.message);

      res.status(503).json({ success: false });
    }
  });

  // ---------- API ----------
  app.use("/api/spaces", spaceRoutes);
  app.use("/api/settings", settingsRoutes);
  app.use("/api/snaps", snapRoutes);
  app.use("/api/payments", paymentRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/auth", authRoutes);
  app.use("/api/locations", locationRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api/account", accountRoutes);

  // ---------- Not found + errors ----------
  app.use((req, res) => {
    res.status(404).json({ success: false, message: "Not found" });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (error?.type === "entity.parse.failed") {
      return res.status(400).json({ success: false, message: "Invalid JSON" });
    }

    if (error?.type === "entity.too.large") {
      return res
        .status(413)
        .json({ success: false, message: "Request is too large" });
    }

    console.error("Unhandled error:", error);

    // Never send stack traces or internals to the browser.
    res.status(500).json({ success: false, message: "Something went wrong" });
  });

  return app;
}

module.exports = { createApp };
