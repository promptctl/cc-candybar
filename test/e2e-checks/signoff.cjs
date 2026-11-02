// [LAW:one-source-of-truth] The end-to-end cap and assertion limit live in
// .claude/e2e-signoff.json and nowhere else; the cap reporter, the assertion
// check and the fixtures all read them through this file. Only Brandon changes
// the file (.claude/hooks/e2e-signoff.mjs refuses an agent's edit).
//
// [LAW:parse-dont-validate] The one place the file is checked. A caller gets two
// positive integers or an error naming the file and the field.

const { readFileSync } = require("node:fs");
const path = require("node:path");

const SIGNOFF_PATH = path.join(__dirname, "..", "..", ".claude", "e2e-signoff.json");
const FIELDS = ["cap", "assertionsPerTest"];

/**
 * @typedef {{ cap: number, assertionsPerTest: number }} Signoff
 * @param {string} text
 * @param {string} source
 * @returns {Signoff}
 */
function parseSignoff(text, source) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} is not JSON: ${error.message}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} must hold an object with ${FIELDS.join(" and ")}`);
  }
  for (const field of FIELDS) {
    if (!Number.isInteger(value[field]) || value[field] < 1) {
      throw new Error(`${source}: ${field} must be a positive integer, found ${JSON.stringify(value[field])}`);
    }
  }
  const extra = Object.keys(value).filter((key) => !FIELDS.includes(key));
  if (extra.length > 0) {
    throw new Error(`${source}: unknown field ${extra.join(", ")}`);
  }
  return { cap: value.cap, assertionsPerTest: value.assertionsPerTest };
}

/** @returns {Signoff} */
function readSignoff() {
  return parseSignoff(readFileSync(SIGNOFF_PATH, "utf8"), SIGNOFF_PATH);
}

module.exports = { SIGNOFF_PATH, parseSignoff, readSignoff };
