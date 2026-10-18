const { db, adminAuth } = require("../config/firebase");
const {
  AuthRestError,
  verifyPassword,
  sendPasswordReset,
} = require("../services/firebaseAuthRest");

// The username -> email lookup used to be a public endpoint that returned
// the email. It is gone: the email never leaves the server now.
//
//   POST /api/auth/username-login   { username, password } -> { customToken }
//   POST /api/auth/forgot-password  { username }           -> always 200
//
// Both answer exactly the same whether or not the username exists.

const USERNAME = /^[a-z0-9_.]{3,20}$/;

const BAD_LOGIN = {
  success: false,
  message: "Incorrect username or password.",
};

function readUsername(value) {
  const username = String(value || "").trim().toLowerCase();

  return USERNAME.test(username) ? username : "";
}

async function findEmail(username) {
  const snapshot = await db
    .collection("users")
    .where("username", "==", username)
    .limit(1)
    .get();

  if (snapshot.empty) return null;

  const { email } = snapshot.docs[0].data();

  return email ? { uid: snapshot.docs[0].id, email } : null;
}

// Wrong username and wrong password must look (and take about as long) the
// same, so run a throw-away check when there is no such account.
async function decoyCheck(password) {
  try {
    await verifyPassword("no-such-user@invalid.example", password);
  } catch {
    // expected
  }
}

async function usernameLogin(req, res) {
  try {
    const username = readUsername(req.body?.username);
    const password = req.body?.password;

    if (
      !username ||
      typeof password !== "string" ||
      password.length < 1 ||
      password.length > 200
    ) {
      return res.status(401).json(BAD_LOGIN);
    }

    const account = await findEmail(username);

    if (!account) {
      await decoyCheck(password);

      return res.status(401).json(BAD_LOGIN);
    }

    let uid;

    try {
      ({ uid } = await verifyPassword(account.email, password));
    } catch (error) {
      if (error instanceof AuthRestError) {
        if (error.code === "TOO_MANY_ATTEMPTS_TRY_LATER") {
          return res.status(429).json({
            success: false,
            message: "Too many failed attempts. Please try again later.",
          });
        }

        // wrong password, Google-only account, disabled account...
        return res.status(401).json(BAD_LOGIN);
      }

      throw error;
    }

    const customToken = await adminAuth.createCustomToken(uid);

    return res.status(200).json({ success: true, customToken });
  } catch (error) {
    console.error("Username login error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to log in right now. Please try again.",
    });
  }
}

async function forgotPassword(req, res) {
  const reply = () =>
    res.status(200).json({
      success: true,
      message: "If an account exists, a reset email has been sent.",
    });

  try {
    const username = readUsername(req.body?.username);
    const account = username ? await findEmail(username) : null;

    if (account) {
      try {
        await sendPasswordReset(account.email);
      } catch (error) {
        console.error("Password reset send failed:", error.code || error.message);
      }
    }
  } catch (error) {
    console.error("Forgot password error:", error);
  }

  return reply();
}

module.exports = { usernameLogin, forgotPassword };
