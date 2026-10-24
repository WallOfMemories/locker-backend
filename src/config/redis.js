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
    }
  });

  client.connect().catch(() => {});

  return client;
}

async function closeRedis() {
  if (client) await client.quit().catch(() => {});
}

module.exports = { getRedis, closeRedis };
