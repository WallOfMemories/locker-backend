const settingsService = require("../services/settingsService");

async function initializeSnapWallSettings(req, res) {
  try {
    const result =
      await settingsService.createDefaultSnapWallSettings();

    res.status(200).json({
      success: true,
      created: result.created,
      settings: result.settings,
    });
  } catch (error) {
    console.error(
      "Error initializing SnapWall settings:",
      error
    );

    res.status(500).json({
      success: false,
      message: "Failed to initialize SnapWall settings.",
    });
  }
}

async function getSnapWallSettings(req, res) {
  try {
    const settings =
      await settingsService.getSnapWallSettings();

    if (!settings) {
      return res.status(404).json({
        success: false,
        message: "SnapWall settings not found.",
      });
    }

    res.status(200).json({
      success: true,
      settings,
    });
  } catch (error) {
    console.error(
      "Error fetching SnapWall settings:",
      error
    );

    res.status(500).json({
      success: false,
      message: "Failed to fetch SnapWall settings.",
    });
  }
}

module.exports = {
  initializeSnapWallSettings,
  getSnapWallSettings,
};