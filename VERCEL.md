# Deploying the SnapWall backend on Vercel

Vercel runs the backend as **serverless functions**: each request may run on a fresh, short-lived instance, and there
is no always-on process. This project is adapted for that (`api/index.js` + `vercel.json`), with these consequences:

| Always-on server | On Vercel |
|---|---|
| Timers open Time Capsules every minute and purge deleted accounts | **Cron endpoints** (`/api/cron/capsules`, `/api/cron/accounts`) called by Vercel Cron or an outside pinger |
| Rate limits can live in memory | **Redis is required** (`REDIS_URL`) |
| Work after the response (like notifications, wall auto-expand) just keeps running | Handed to Vercel's `waitUntil` so it finishes |

## 1. Create a Redis database (free)
Upstash (via Vercel's Marketplace, or upstash.com) > create a Redis database in a region near your functions
(Mumbai if available) > copy the **TLS connection string**, which looks like `rediss://default:PASSWORD@host:6379`.
Use the `rediss://` (TCP) URL, not the REST URL.

## 2. Create the Vercel project
1. Push the backend folder to its own GitHub repo (or set **Root Directory** to it in a monorepo).
2. vercel.com > **Add New > Project** > import it. **Framework Preset: Other.** Leave build/output settings empty.
3. **Environment Variables** (Production). Everything in `.env.example`, in particular:
   - `NODE_ENV=production`
   - `CORS_ORIGINS` = your frontend address, e.g. `https://your-frontend.vercel.app` (no trailing slash)
   - `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (paste the key as in the downloaded JSON,
     with the `\n` sequences; no surrounding quotes), `FIREBASE_STORAGE_BUCKET`, `FIREBASE_WEB_API_KEY`
   - `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`
   - `ADMIN_UIDS`
   - `REDIS_URL` (step 1) and `CRON_SECRET` (any long random string)
4. **Deploy.** Your API address is `https://<project>.vercel.app`. Check `https://<project>.vercel.app/api/ready`
   returns `{"success":true}`. If every request returns "Server is not configured", open the deployment's **Logs**:
   it lists exactly which setting is missing.

`vercel.json` runs the functions in Mumbai (`bom1`). Change `regions` to be close to your Firestore location.

## 3. Background jobs (important)
`vercel.json` registers two **daily** Vercel Cron jobs. That is the most the free (Hobby) plan allows, and it is
fine for deleting accounts, but **too slow for Time Capsules**: a capsule is already hidden/shown correctly the
moment its time passes (that check is live), but its "your capsule is open" notification and its
`published` status would wait up to 24 hours.

For minute-level opening, use one of:
- **Free outside pinger** (cron-job.org or similar), every minute: `GET https://<project>.vercel.app/api/cron/capsules`
  with the header `Authorization: Bearer <your CRON_SECRET>`.
- **Vercel Pro**: change the capsule schedule in `vercel.json` to `"* * * * *"`.

## 4. Connect the rest
- Frontend: set `VITE_API_BASE_URL=https://<project>.vercel.app` and redeploy the frontend.
- Razorpay webhook URL: `https://<project>.vercel.app/api/payments/webhook`
  (events `payment.captured`, `order.paid`; same secret as `RAZORPAY_WEBHOOK_SECRET`). After the first test payment,
  check the webhook's delivery log in Razorpay shows a `200`.

## 5. Troubleshooting
- **Every request fails with `ERR_REQUIRE_ESM` (jwks-rsa / jose) in the logs**: an old copy of `package.json` /
  `package-lock.json` is deployed. The fix is the `overrides` block in `package.json` (pins `jwks-rsa` to 3.x).
  Commit **both** `package.json` and `package-lock.json`, push, and redeploy (Vercel installs from the lockfile).
- **Home page `/` shows 500 `FUNCTION_INVOCATION_FAILED`, log says `Invalid export found in module ... app.js`**:
  Vercel treats files named `app.js` / `server.js` / `index.js` as the entry point. They were renamed to
  `src/createApp.js` and `src/start.js`; make sure the OLD `src/app.js` and `src/server.js` are deleted from your repo.
- **`[redis] error: Socket closed unexpectedly` / "Redis is not ready" in the logs**: the app cannot connect to
  Redis (rate limits then run per instance and are not shared). Open `https://<backend>/api/ready`: it shows
  `"rateLimitStore":"redis"` when connected, `"redis-down"` when not. The first log line `[redis] connecting to ...`
  shows the scheme, host and port being used. Usually the scheme is wrong: use `rediss://` (two s) when your provider
  needs TLS (Upstash), `redis://` when it does not (many free Redis Cloud databases). Also check host, port and
  password come from the same database.
- **"Server is not configured"**: open the deployment Logs; each missing setting is listed.
- **CORS errors in the browser**: `CORS_ORIGINS` must equal the frontend address exactly.

## 6. Limits to know about
- Free (Hobby) functions have a time limit (30 s is configured here); every route in this app is far quicker.
- Cold starts add a moment to the first request after idle.
- The place-search cache and the wall-expansion lock are per instance (harmless: worst case a repeated map lookup
  or two simultaneous expansions, which the database already refuses).
- Prefer an always-on host (Render, Railway) if you later need minute-level jobs without an outside pinger.
