// Boots the real app (no network needed) and checks the security wiring.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

Object.assign(process.env, {
  NODE_ENV: "production",
  FIREBASE_PROJECT_ID: "demo",
  FIREBASE_CLIENT_EMAIL: "x@demo.iam.gserviceaccount.com",
  FIREBASE_PRIVATE_KEY: privateKey.replace(/\n/g, "\\n"),
  RAZORPAY_KEY_ID: "rzp_test_x",
  RAZORPAY_KEY_SECRET: "secret",
  CORS_ORIGINS: "https://app.example.com",
  FIREBASE_WEB_API_KEY: "web-key",
  RAZORPAY_WEBHOOK_SECRET: "whsec_test",
  CRON_SECRET: "cron_test_secret",
});

const { loadConfig } = require("../src/config/env");
const { createApp } = require("../src/app");

const { config, problems } = loadConfig();
const app = createApp(config);

let server;
let base;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

test("config has no problems with a complete production env", () => {
  assert.deepEqual(problems, []);
});

test("config rejects an unsafe production env", () => {
  const bad = loadConfig({ NODE_ENV: "production", CORS_ORIGINS: "*" });
  assert.ok(bad.problems.some((p) => /CORS_ORIGINS/.test(p)));
  assert.ok(bad.problems.some((p) => /FIREBASE_PRIVATE_KEY/.test(p)));
});

test("health works and sends security headers", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("strict-transport-security"));
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-powered-by"), null);
});

test("the old public test endpoint is gone", async () => {
  const res = await fetch(`${base}/api/firebase-test`);
  assert.equal(res.status, 404);
});

test("CORS: only the configured origin is allowed", async () => {
  const ok = await fetch(`${base}/api/health`, { headers: { Origin: "https://app.example.com" } });
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://app.example.com");

  const bad = await fetch(`${base}/api/health`, { headers: { Origin: "https://evil.example" } });
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
});

test("protected routes need a token", async () => {
  const routes = [
    ["GET", "/api/users/me"],
    ["POST", "/api/snaps"],
    ["POST", "/api/payments/create-order"],
    ["GET", "/api/admin/dashboard"],
    ["POST", "/api/spaces/initialize"],
    ["POST", "/api/settings/initialize"],
    ["GET", "/api/locations/search?q=abc"],
  ];

  for (const [method, path] of routes) {
    const res = await fetch(`${base}${path}`, { method });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test("a garbage token is rejected", async () => {
  const res = await fetch(`${base}/api/admin/dashboard`, {
    headers: { Authorization: "Bearer not-a-real-token" },
  });
  assert.equal(res.status, 401);
});

test("bad JSON and oversized bodies are handled cleanly", async () => {
  const bad = await fetch(`${base}/api/auth/username-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{nope",
  });
  assert.equal(bad.status, 400);

  const big = await fetch(`${base}/api/auth/username-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "a".repeat(50_000) }),
  });
  assert.equal(big.status, 413);
});

test("the old public username -> email lookup is gone", async () => {
  const res = await fetch(`${base}/api/auth/resolve-username`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "someone" }),
  });
  assert.equal(res.status, 404);
});

test("wrong-username login and forgot-password give nothing away", async () => {
  const login = await fetch(`${base}/api/auth/username-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "!!", password: "x" }),
  });
  assert.equal(login.status, 401);
  assert.equal((await login.json()).message, "Incorrect username or password.");

  const forgot = await fetch(`${base}/api/auth/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "!!" }),
  });
  assert.equal(forgot.status, 200);
});

test("razorpay webhook checks the signature", async () => {
  const crypto = require("node:crypto");
  const body = JSON.stringify({ event: "payment.failed", payload: {} });
  const sign = (b, secret) =>
    crypto.createHmac("sha256", secret).update(b).digest("hex");
  const post = (signature) =>
    fetch(`${base}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(signature ? { "X-Razorpay-Signature": signature } : {}),
      },
      body,
    });

  assert.equal((await post(null)).status, 400);
  assert.equal((await post(sign(body, "wrong-secret"))).status, 400);
  assert.equal((await post("short")).status, 400);

  const ok = await post(sign(body, "whsec_test"));
  assert.equal(ok.status, 200); // valid, but not an event we act on
  assert.equal((await ok.json()).ignored, true);
});

test("cron endpoints need the secret", async () => {
  for (const path of ["/api/cron/capsules", "/api/cron/accounts"]) {
    assert.equal((await fetch(`${base}${path}`)).status, 401);

    const wrong = await fetch(`${base}${path}`, {
      headers: { Authorization: "Bearer nope" },
    });
    assert.equal(wrong.status, 401);
  }
});

test("unknown routes return JSON 404", async () => {
  const res = await fetch(`${base}/api/nope`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).success, false);
});

test("username lookup is rate limited", async () => {
  // An invalid username is rejected before touching the database (401),
  // but every call still counts toward the limit.
  let limited = 0;

  for (let i = 0; i < 25; i += 1) {
    const res = await fetch(`${base}/api/auth/username-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "" }),
    });

    if (res.status === 429) limited += 1;
  }

  assert.ok(limited >= 4, `expected 429s, got ${limited}`);
});
