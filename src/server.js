const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { db } = require("./config/firebase");

const spaceRoutes = require("./routes/spaceRoutes");
const settingsRoutes = require("./routes/settingsRoutes");
const snapRoutes = require("./routes/snapRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const userRoutes = require("./routes/userRoutes");
const authRoutes = require("./routes/authRoutes");
const locationRoutes = require("./routes/locationRoutes");
const adminRoutes = require("./routes/adminRoutes");
// NEW: notifications (liked, saved, capsule opened, moderation, refunds)
const notificationRoutes = require("./routes/notificationRoutes");
// NEW: Settings page (privacy, delete account, support)
const accountRoutes = require("./routes/accountRoutes");
const { startAccountDeletionScheduler } = require("./services/accountService");
const { startCapsuleScheduler } = require("./services/capsuleService");

const app = express();

const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());



// ===============================
// Basic Routes
// ===============================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "SnapWall API is running",
  });
});


app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "SnapWall backend is healthy",
  });
});


// ===============================
// Firebase Test
// ===============================

app.get("/api/firebase-test", async (req, res) => {
  try {
    await db.collection("users").limit(1).get();

    res.json({
      success: true,
      message: "Firebase Admin connected successfully",
    });
  } catch (error) {
    console.error("Firebase connection error:", error);

    res.status(500).json({
      success: false,
      message: "Firebase connection failed",
    });
  }
});


// ===============================
// SnapWall Routes
// ===============================

app.use("/api/spaces", spaceRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/snaps", snapRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/users", userRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/locations", locationRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/notifications", notificationRoutes); // NEW
app.use("/api/account", accountRoutes); // NEW


// ===============================
// Start Server
// ===============================

app.listen(PORT, () => {
  console.log(
    `SnapWall backend running on port ${PORT}`
  );

  // Unlocks Time Capsules whose date has passed (checks every minute).
  startCapsuleScheduler();

  // NEW: permanently deletes accounts whose 30-day grace period is over.
  startAccountDeletionScheduler();
});