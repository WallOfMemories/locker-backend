const settingsService = require("../services/settingsService");

async function initializeTheLockerSettings(req, res) {
  try {
    const result =
      await settingsService.createDefaultTheLockerSettings();

    res.status(200).json({
      success: true,
      created: result.created,
      settings: result.settings,
    });
  } catch (error) {
    console.error(
      "Error initializing The Locker settings:",
      error
    );

    res.status(500).json({
      success: false,
      message: "Failed to initialize The Locker settings.",
    });
  }
}

async function getTheLockerSettings(req, res) {
  try {
    const settings =
      await settingsService.getTheLockerSettings();

    if (!settings) {
      return res.status(404).json({
        success: false,
        message: "The Locker settings not found.",
      });
    }

    res.status(200).json({
      success: true,
      settings,
    });
  } catch (error) {
    console.error(
      "Error fetching The Locker settings:",
      error
    );

    res.status(500).json({
      success: false,
      message: "Failed to fetch The Locker settings.",
    });
  }
}

module.exports = {
  initializeTheLockerSettings,
  getTheLockerSettings,
};