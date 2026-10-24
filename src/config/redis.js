// Optional shared store for rate limits. Set REDIS_URL (e.g.
// redis://default:password@host:6379, or rediss:// for TLS) to share limits
// between several server instances. Without it, each instance keeps its own
// in-memory counters (fine for a single instance).
const { createClient } = require("redis");

let client = null;
let lastLogged = 0;

function getRedis() {
  if (!process.env.REDIS_URL) return null;
  if (client) return client;

  // Log WHERE we connect (never the password) so a wrong URL is obvious.
  try {
    const u = new URL(process.env.REDIS_URL);
    console.log(`[redis] connecting to ${u.protocol}//${u.hostname}:${u.port || "6379"}`);
  } catch {
    console.error("[redis] REDIS_URL is not a valid URL");
  }

  client = createClient({
    url: process.env.REDIS_URL,
    // Fail fast instead of queueing: if Redis is down the limiter lets the
    // request through (passOnStoreError) rather than hanging every request.
    disableOfflineQueue: true,
  });

  // Every limiter waits for "ready" at start-up; that is expected.
  client.setMaxListeners(50);

  client.on("error", (error) => {
    // Log at most once a minute so an outage doesn't flood the logs.
    if (Date.now() - lastLogged > 60 * 1000) {
      lastLogged = Date.now();
      console.error("[redis] error:", error.message);

      if (/socket closed|ECONNRESET|EPROTO|wrong version/i.test(error.message)) {
        console.error(
          "[redis] hint: the connection was dropped right away. Check the scheme in REDIS_URL: " +
            "use rediss:// (two s) if your provider requires TLS (e.g. Upstash), " +
            "or redis:// if it does not (many free Redis Cloud databases)."
        );
      }
    }
  });

  client.connect().catch(() => {});

  return client;
}

async function closeRedis() {
  if (client) await client.quit().catch(() => {});
}

// "memory" | "redis" | "redis-down" — shown by /api/ready for debugging.
function rateLimitStoreStatus() {
  if (!process.env.REDIS_URL) return "memory";

  return client && client.isReady ? "redis" : "redis-down";
}

module.exports = { getRedis, closeRedis, rateLimitStoreStatus };
