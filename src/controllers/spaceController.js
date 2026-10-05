const spaceService = require("../services/spaceService");

async function getSpaces(req, res) {
  try {
    const spaces = await spaceService.getAllSpaces();

    res.status(200).json({
      success: true,
      count: spaces.length,
      spaces,
    });
  } catch (error) {
    console.error("Error fetching spaces:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch SnapWall spaces.",
    });
  }
}

async function initializeSpaces(req, res) {
  try {
    const result =
      await spaceService.createInitialSpaces();

    res.status(200).json({
      success: true,
      message: "SnapWall spaces initialized successfully.",
      created: result.created,
      total: result.total,
    });
  } catch (error) {
    console.error(
      "Error initializing SnapWall spaces:",
      error
    );

    res.status(500).json({
      success: false,
      message: "Failed to initialize SnapWall spaces.",
    });
  }
}

module.exports = {
  getSpaces,
  initializeSpaces,
};