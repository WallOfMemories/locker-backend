# SnapWall backend — deployment & security notes

> Deploying on **Vercel**? Follow `VERCEL.md`. This file covers always-on hosting (Render, Railway, Docker) and the security notes.

## 1. Deploy checklist

1. **Environment**: copy `.env.example` to your host's environment settings and fill every value.
   The server refuses to start in production if a required value is missing or `CORS_ORIGINS` is not an explicit `https://` list.
2. **Firebase rules** (important — without them the browser can write to your database directly):
   ```
   npm i -g firebase-tools
   firebase login
   firebase deploy --only firestore:rules,storage --project <your-project-id>
   ```
   `firestore.rules` and `storage.rules` are in this folder. They block all direct browser access except
   creating the person's own first `users/{uid}` profile (always `role: "user"`) and uploading their own photos.
3. **Storage bucket**: `FIREBASE_STORAGE_BUCKET` must be *exactly* the bucket the frontend uses
   (`VITE_FIREBASE_STORAGE_BUCKET`, e.g. `my-app.firebasestorage.app`). Snap photo URLs are checked against it.
4. **Admins**: set `ADMIN_UIDS` to your admin Firebase UID(s).
5. **Razorpay**: switch to `rzp_live_...` keys when ready. Leave `ENABLE_TEST_PAYMENTS` unset in production.
6. **Run it**: `npm ci --omit=dev && npm start`, or build the included `Dockerfile`.
   Health checks: `/api/health` (liveness) and `/api/ready` (database reachable).
7. **One-time data**: `POST /api/spaces/initialize` and `POST /api/settings/initialize` now need an admin token
   (they were public before). Set the price with `node src/scripts/setSpacePrice.js 10`.
8. **Firebase Auth**: add your frontend domain under Authentication → Settings → Authorized domains.
9. **Multiple instances**: set `REDIS_URL` so rate limits are shared, and run the background jobs on one instance only
   (`RUN_SCHEDULERS=false` on the rest).
10. **Webhook**: add the Razorpay webhook described in section 3.

Run `npm test` before deploying.

## 2. What was hardened

| Area | Before | Now |
|---|---|---|
| `/api/spaces/initialize`, `/api/settings/initialize` | open to anyone | admin only |
| `/api/firebase-test` | public | removed (`/api/ready` reports status only) |
| CORS | any origin | allow-list from `CORS_ORIGINS` |
| Headers | none | `helmet` (HSTS, nosniff, frame denial…) |
| Rate limits | none | global, login (per IP + per username), payments, writes, location, public reads; Redis-backed when `REDIS_URL` is set |
| Request bodies | unlimited | 20 KB JSON limit, clean 400/413 errors |
| Snap `imageUrl` / `storagePath` | any string | must be the caller's own file in your Storage bucket (stops arbitrary URLs and deleting other people's files) |
| Profile `photoURL` | any string | empty, Google photo, or your Storage bucket only |
| IDs in URLs/bodies | unchecked | validated (`:snapId`, `:id`, `spaceId`, `paymentId`) |
| Caption / snapType types | unchecked (type errors → 500) | validated |
| Money, admin, delete-account routes | token signature only | also reject disabled / revoked accounts |
| ₹1 test-payment endpoint | always on | off in production unless `ENABLE_TEST_PAYMENTS=true` |
| Firestore / Storage rules | none in repo | included (`firestore.rules`, `storage.rules`) |
| Errors | could include internals | generic 500; stack traces only in server logs |
| Start-up | crashed on first use if misconfigured | validates env, graceful SIGTERM shutdown, request timeouts |

## 3. Second pass: the four items that were left open

**Username login no longer exposes emails.** `POST /api/auth/resolve-username` is removed. Instead:
- `POST /api/auth/username-login {username, password}` — the server finds the email, checks the password with Firebase
  and returns a Firebase *custom token* (the frontend signs in with it). Unknown username and wrong password return the
  identical `401 Incorrect username or password.` (a decoy check keeps timing similar).
- `POST /api/auth/forgot-password {username}` — always answers 200; the reset email is sent server-side.
- Both are limited per IP (20 / 15 min) **and** per username (10 / 15 min).
- Needs `FIREBASE_WEB_API_KEY` (the public Web API key). If that key is restricted by HTTP referrer in Google Cloud,
  put an allowed origin first in `CORS_ORIGINS` (it is sent as the Referer), or restrict by API instead.
- The frontend (`authService.js`, `Login.jsx`, `ForgotPassword.jsx`) was updated to use these. Email login still goes
  straight to Firebase.

**Razorpay webhook.** `POST /api/payments/webhook` verifies `X-Razorpay-Signature` over the raw body, asks Razorpay for
the order, and records the payment exactly like `/verify` (idempotent — both arriving is harmless). Set it up in
Razorpay Dashboard → Settings → Webhooks: URL `https://<your-api>/api/payments/webhook`, events `payment.captured` and
`order.paid`, secret = `RAZORPAY_WEBHOOK_SECRET` (required in production). A payment recovered this way shows as
"unused" in Payment History until a Snap is posted with it, or you refund it from the Razorpay dashboard.

**Shared rate limits.** Set `REDIS_URL` (`redis://` or `rediss://`) and every limiter uses Redis, so limits hold across
instances (tested with two instances against a real Redis). If Redis is down the limiters let requests through rather
than failing them. Start Redis before the app: the limiters wait up to 5 s for it at boot.
Without `REDIS_URL` it falls back to per-instance memory (one-instance deployments).

**Dependencies.** `uuid` is pinned to a patched version through `overrides`; `npm audit --omit=dev` reports 0
vulnerabilities. (`npm audit` still lists dev-only issues in `nodemon`, which is not installed in production.)

## 4. Remaining notes

- Liked / Saved lists scan every published Snap (one read each). Fine for a small wall; at scale switch to a
  collection-group query on `likes` / `saves`.
- `GET /api/spaces` (public) includes each owner's `ownerId` (Firebase UID) so the wall can mark your own Snaps.
- Background jobs (capsule unlock, account purge) must run on one instance only (`RUN_SCHEDULERS=false` on the rest).
