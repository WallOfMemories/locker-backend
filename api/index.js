// Vercel entry point: every request is rewritten to this function (see
// vercel.json). On an always-on server (Render, Railway, Docker) use
// `npm start` (src/start.js) instead.
const { loadConfig } = require("../src/config/env");

const { config, problems, warnings } = loadConfig();

warnings.forEach((warning) => console.warn(`[config] WARNING: ${warning}`));

let handler;

if (problems.length > 0) {
  problems.forEach((problem) => console.error(`[config] ERROR: ${problem}`));

  // Never run half-configured: answer every request with a clear 500 and
  // leave the reason in the function logs.
  handler = (req, res) => {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ success: false, message: "Server is not configured" }));
  };
} else {
  const { createApp } = require("../src/createApp");

  handler = createApp(config);
}

module.exports = handler;