// Vercel treats files with these names as the app's entry point and expects
// them to export a server. Ours export helpers, so they must not exist
// (this once made "/" fail with "Invalid export found in module").
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("no accidental Vercel entry-point file names", () => {
  const root = path.join(__dirname, "..");
  const names = ["app", "index", "server"];
  const dirs = [".", "src"];
  const found = [];

  for (const dir of dirs) {
    for (const name of names) {
      for (const ext of ["js", "cjs", "mjs", "ts"]) {
        const file = path.join(root, dir, `${name}.${ext}`);
        if (fs.existsSync(file)) found.push(path.relative(root, file));
      }
    }
  }

  assert.deepEqual(found, []);
});
