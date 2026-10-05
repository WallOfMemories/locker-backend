const { db } = require("../config/firebase");

const {
  ProfileError,
  USERNAME_RULES,
  normalizeUsername,
  isValidUsername,
  isUsernameAvailable,
  saveProfile,
} = require("../services/profileService");

function handleProfileError(res, error, fallbackMessage) {
  if (error instanceof ProfileError) {
    return res.status(error.status).json({
      success: false,
      message: error.message,
    });
  }

  console.error(fallbackMessage, error);

  return res.status(500).json({
    success: false,
    message: fallbackMessage,
  });
}

async function getMyProfile(req, res) {
  try {
    const userId = req.user.uid;

    const userSnapshot = await db
      .collection("users")
      .doc(userId)
      .get();

    if (!userSnapshot.exists) {
      return res.status(404).json({
        success: false,
        message: "Profile not found",
      });
    }

    return res.status(200).json({
      success: true,
      profile: {
        id: userSnapshot.id,
        ...userSnapshot.data(),
      },
    });
  } catch (error) {
    console.error("Get profile error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to get profile",
    });
  }
}

// First-time profile setup after registration.
async function setupProfile(req, res) {
  try {
    const userId = req.user.uid;

    const { username, displayName, bio, photoURL } = req.body;

    if (!displayName || !String(displayName).trim()) {
      return res.status(400).json({
        success: false,
        message: "Name is required.",
      });
    }

    if (!username || !String(username).trim()) {
      return res.status(400).json({
        success: false,
        message: "Username is required.",
      });
    }

    const profile = await saveProfile(userId, {
      username,
      displayName,
      bio: bio ?? "",
      photoURL,
    });

    return res.status(200).json({
      success: true,
      message: "Profile created successfully",
      profile,
    });
  } catch (error) {
    return handleProfileError(
      res,
      error,
      "Failed to create profile"
    );
  }
}

async function updateMyProfile(req, res) {
  try {
    const userId = req.user.uid;

    const { username, displayName, bio, photoURL } = req.body;

    const profile = await saveProfile(userId, {
      username,
      displayName,
      bio,
      photoURL,
    });

    return res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      profile,
    });
  } catch (error) {
    return handleProfileError(
      res,
      error,
      "Failed to update profile"
    );
  }
}

async function checkUsername(req, res) {
  try {
    const userId = req.user.uid;

    const username = normalizeUsername(req.query.username);

    if (!isValidUsername(username)) {
      return res.status(200).json({
        success: true,
        available: false,
        message: USERNAME_RULES,
      });
    }

    const available = await isUsernameAvailable(
      username,
      userId
    );

    return res.status(200).json({
      success: true,
      available,
      message: available
        ? "Username is available."
        : "That username is already taken.",
    });
  } catch (error) {
    console.error("Check username error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to check username",
    });
  }
}

module.exports = {
  getMyProfile,
  setupProfile,
  updateMyProfile,
  checkUsername,
};