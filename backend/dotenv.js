/**
 * Minimal dotenv loader — no npm install needed.
 * Reads KEY=value lines from a .env file and sets process.env.
 */
const fs = require("fs");
const path = require("path");

function config({ path: envPath = ".env" } = {}) {
  try {
    const content = fs.readFileSync(envPath, "utf8");
    content.split("\n").forEach((line) => {
      line = line.trim();
      if (!line || line.startsWith("#")) return;
      const eqIdx = line.indexOf("=");
      if (eqIdx < 1) return;
      const key = line.slice(0, eqIdx).trim();
      let val = line.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    });
  } catch {
    // No .env file — that's fine
  }
}

module.exports = { config };
