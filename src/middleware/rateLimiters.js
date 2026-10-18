const { rateLimit, ipKeyGenerator, MINUTE } = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");

const { getRedis } = require("../config/redis");

// ------------------------------------------------------------
// Rate limits (per IP, or per signed-in person / username where noted).
//
// Counters live in Redis when REDIS_URL is set (shared by every instance),
// otherwise in memory (per instance).
// ------------------------------------------------------------

function reply(message) {
  return (req, res) =>
    res.status(429).json({ success: false, message });
}

// The limiters are built while the server is still starting, before the
// Redis connection is up. Wait briefly for it instead of failing the
// store's start-up; if Redis is genuinely down, fail fast (and the request
// is let through, see passOnStoreError).
function whenReady(redis, timeoutMs = 5000) {
  if (redis.isReady) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      redis.off("ready", onReady);
      reject(new Error("Redis is not ready"));
    }, timeoutMs);

    function onReady() {
      clearTimeout(timer);
      resolve();
    }

    redis.once("ready", onReady);
  });
}

function makeStore(name) {
  const redis = getRedis();

  if (!redis) return undefined; // default in-memory store

  return new RedisStore({
    prefix: `rl:${name}:`,
    sendCommand: async (...args) => {
      await whenReady(redis);

      return redis.sendCommand(args);
    },
  });
}

function make({ name, windowMs, limit, message, key }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: reply(message),
    store: makeStore(name),
    // If Redis is unreachable, let requests through instead of failing them.
    passOnStoreError: true,
    keyGenerator: key || ((req) => ipKeyGenerator(req.ip)),
    // The health checks must always answer for the platform's probes.
    skip: (req) => req.path === "/api/health" || req.path === "/api/ready",
  });
}

const perUser = (req) =>
  req.user?.uid ? `u:${req.user.uid}` : ipKeyGenerator(req.ip);

// Everything, per IP.
const globalLimiter = make({
  name: "global",
  windowMs: MINUTE,
  limit: 300,
  message: "Too many requests. Please slow down and try again shortly.",
});

// Public pre-login endpoints (username login, forgot password), per IP.
const loginLimiter = make({
  name: "login-ip",
  windowMs: 15 * MINUTE,
  limit: 20,
  message: "Too many attempts. Please try again in a few minutes.",
});

// Same endpoints, per username: stops one account being guessed at from
// many different IPs.
const usernameAttemptLimiter = make({
  name: "login-user",
  windowMs: 15 * MINUTE,
  limit: 10,
  message: "Too many attempts. Please try again in a few minutes.",
  key: (req) =>
    `n:${String(req.body?.username || "").trim().toLowerCase().slice(0, 40)}`,
});

// Create order / verify / release / test-order. Per person.
const paymentLimiter = make({
  name: "payment",
  windowMs: 10 * MINUTE,
  limit: 30,
  message: "Too many payment requests. Please wait a few minutes.",
  key: perUser,
});

// Posting, editing, deleting, reporting, support. Per person.
const writeLimiter = make({
  name: "write",
  windowMs: MINUTE,
  limit: 40,
  message: "You're doing that too fast. Please wait a moment.",
  key: perUser,
});

// Map provider calls cost money / are rate limited upstream. Per person.
const locationLimiter = make({
  name: "location",
  windowMs: MINUTE,
  limit: 40,
  message: "Too many location searches. Please wait a moment.",
  key: perUser,
});

// Public wall data is heavy (reads every space). Per IP.
const publicReadLimiter = make({
  name: "public-read",
  windowMs: MINUTE,
  limit: 60,
  message: "Too many requests. Please try again shortly.",
});

module.exports = {
  globalLimiter,
  loginLimiter,
  usernameAttemptLimiter,
  paymentLimiter,
  writeLimiter,
  locationLimiter,
  publicReadLimiter,
};
