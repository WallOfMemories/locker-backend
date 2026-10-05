const { db } = require("../config/firebase");

// Resolves a username to its login email (used by username + password login).
async function resolveUsername(req, res) {
  try {
    const username = String(req.body?.username || "")
      .trim()
      .toLowerCase();

    if (!username) {
      return res.status(400).json({
        success: false,
        message: "Username is required",
      });
    }

    const snapshot = await db
      .collection("users")
      .where("username", "==", username)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({
        success: false,
        message: "No account found with this username",
      });
    }

    const { email } = snapshot.docs[0].data();

    if (!email) {
      return res.status(404).json({
        success: false,
        message: "No account found with this username",
      });
    }

    return res.status(200).json({
      success: true,
      email,
    });
  } catch (error) {
    console.error("Resolve username error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to look up username",
    });
  }
}

module.exports = {
  resolveUsername,
};