// ------------------------------------------------------------
// "Do this after the response has been sent" (notifications, auto-expanding
// the wall). On an always-on server a plain promise is enough. On Vercel the
// function can be frozen the moment the response is sent, so the work is
// handed to waitUntil() which keeps it alive until it finishes.
// ------------------------------------------------------------
let waitUntil = null;

if (process.env.VERCEL) {
  try {
    ({ waitUntil } = require("@vercel/functions"));
  } catch {
    waitUntil = null;
  }
}

function runInBackground(promise, label = "Background task") {
  const safe = Promise.resolve(promise).catch((error) => {
    console.error(`${label} failed:`, error);
  });

  if (waitUntil) {
    try {
      waitUntil(safe);
    } catch {
      // not inside a Vercel request: the plain promise still runs
    }
  }

  return safe;
}

module.exports = { runInBackground };
