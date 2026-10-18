// ------------------------------------------------------------
// Calls Firebase Auth's REST API from the server, so the browser never
// needs to be told which email belongs to a username.
//
// Needs FIREBASE_WEB_API_KEY (the same public "Web API key" the frontend
// uses). If that key is restricted by HTTP referrer in Google Cloud, set
// the first CORS_ORIGINS entry to an allowed referrer (it is sent along).
// ------------------------------------------------------------

const TIMEOUT_MS = 8000;

class AuthRestError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code; // e.g. INVALID_LOGIN_CREDENTIALS
    this.status = status;
  }
}

async function call(path, body) {
  const key = process.env.FIREBASE_WEB_API_KEY;

  if (!key) throw new Error("FIREBASE_WEB_API_KEY is not set");

  const origin = (process.env.CORS_ORIGINS || "").split(",")[0].trim();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/${path}?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(origin ? { Referer: `${origin}/` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      // "TOO_MANY_ATTEMPTS_TRY_LATER : Access to this account ..." -> first word
      const code = String(data?.error?.message || "UNKNOWN").split(/[\s:]/)[0];

      throw new AuthRestError(code, response.status);
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

// -> { uid } or throws AuthRestError
async function verifyPassword(email, password) {
  const data = await call("accounts:signInWithPassword", {
    email,
    password,
    returnSecureToken: false,
  });

  return { uid: data.localId };
}

// Sends Firebase's normal "reset your password" email.
async function sendPasswordReset(email) {
  await call("accounts:sendOobCode", {
    requestType: "PASSWORD_RESET",
    email,
  });
}

module.exports = { AuthRestError, verifyPassword, sendPasswordReset };
