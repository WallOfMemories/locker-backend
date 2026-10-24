// Checks the Vercel entry point (api/index.js) the way Vercel calls it.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

function run(env, body) {
  const script = `
    const handler = require("./api/index.js");
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(b) { process.stdout.write("RESULT=" + JSON.stringify({ status: this.statusCode, body: b })); process.exit(0); },
    };
    ${body}
  `;
  return spawnSync("node", ["-e", script], {
    cwd: __dirname + "/..",
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
    timeout: 20000,
  });
}

test("on Vercel without CRON_SECRET / REDIS_URL it refuses to run", () => {
  const out = run(
    { VERCEL: "1", NODE_ENV: "production" },
    `handler({ method: "GET", url: "/api/health", headers: {} }, res);`
  );
  assert.match(out.stdout, /"status":500/);
  assert.match(out.stdout, /Server is not configured/);
  assert.match(out.stderr, /CRON_SECRET is not set/);
  assert.match(out.stderr, /REDIS_URL is required on Vercel/);
});
