// Proves rate limits are shared between two server instances when REDIS_URL
// is set. Skipped when redis-server isn't installed.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");

const hasRedis = spawnSync("redis-server", ["--version"]).status === 0;
const PORT = 6391;

test("rate limits are shared across instances via Redis", { skip: !hasRedis }, async (t) => {
  const redisProc = spawn("redis-server", ["--port", String(PORT), "--save", "", "--appendonly", "no"], {
    stdio: "ignore",
  });

  t.after(() => redisProc.kill());
  await new Promise((r) => setTimeout(r, 800));

  process.env.REDIS_URL = `redis://127.0.0.1:${PORT}`;

  const express = require("express");
  const { loginLimiter } = require("../src/middleware/rateLimiters");
  const { closeRedis } = require("../src/config/redis");

  const makeInstance = () => {
    const app = express();
    app.post("/x", loginLimiter, (req, res) => res.json({ ok: true }));
    return new Promise((resolve) => {
      const server = app.listen(0, () => resolve(server));
    });
  };

  const a = await makeInstance();
  const b = await makeInstance();

  t.after(async () => {
    a.close();
    b.close();
    await closeRedis();
  });

  await new Promise((r) => setTimeout(r, 300)); // let the client connect

  const hit = async (server) =>
    (await fetch(`http://127.0.0.1:${server.address().port}/x`, { method: "POST" })).status;

  const statuses = [];

  // loginLimiter allows 20 per 15 min per IP. 12 on A + 12 on B = 24 > 20.
  for (let i = 0; i < 12; i += 1) statuses.push(await hit(a));
  for (let i = 0; i < 12; i += 1) statuses.push(await hit(b));

  const limited = statuses.filter((s) => s === 429).length;

  assert.equal(limited, 4, `expected exactly 4 blocked, got ${limited}`);
});

test("limiter fails open (not hangs) when Redis is unreachable", async () => {
  const { spawnSync } = require("node:child_process");
  const script = `
    process.env.REDIS_URL = "redis://127.0.0.1:1";
    const express = require("express");
    const { loginLimiter } = require("./src/middleware/rateLimiters");
    const app = express();
    app.post("/x", loginLimiter, (q, r) => r.json({ ok: true }));
    const s = app.listen(0, async () => {
      const res = await fetch("http://127.0.0.1:" + s.address().port + "/x", { method: "POST" });
      process.stdout.write("STATUS=" + res.status);
      process.exit(0);
    });
  `;
  const out = spawnSync("node", ["-e", script], { cwd: __dirname + "/..", timeout: 15000, encoding: "utf8" });
  assert.match(out.stdout, /STATUS=200/);
});
