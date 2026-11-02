#!/usr/bin/env node
// Fails when a JSON list gained an entry since a base commit: a transitional
// list may shrink and never grow. Usage: check-shrinks.cjs <file> <base-sha>.
// It fetches the base itself, because CI's checkout is depth 1 and holds no base
// commit, and fails loudly, naming the ref, when it cannot read it.
//
// A file the base does not hold is new, so there is nothing to compare; that is
// the change that introduces the list. Deleted with the list it guards.

const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");

/** @param {readonly string[]} base @param {readonly string[]} head @returns {string[]} */
function addedEntries(base, head) {
  return head.filter((entry) => !base.includes(entry));
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function listOf(text, source) {
  const list = JSON.parse(text);
  if (!Array.isArray(list) || list.some((entry) => typeof entry !== "string")) {
    throw new Error(`${source} must hold a JSON list of strings`);
  }
  return list;
}

function main(file, sha) {
  if (!file || !sha) throw new Error("usage: check-shrinks.cjs <file> <base-sha>");
  try {
    git(["fetch", "--depth=1", "origin", sha]);
    git(["cat-file", "-e", `${sha}^{commit}`]);
  } catch (error) {
    throw new Error(`cannot read base commit ${sha}: ${error.stderr || error.message}`);
  }
  let baseText;
  try {
    baseText = git(["show", `${sha}:${file}`]);
  } catch {
    console.log(`${file} is not in ${sha}: new in this change, nothing to compare`);
    return;
  }
  const added = addedEntries(listOf(baseText, `${file} at ${sha}`), listOf(readFileSync(file, "utf8"), file));
  if (added.length > 0) {
    throw new Error(`${file} grew since ${sha}: ${added.join(", ")}. The list may only shrink.`);
  }
  console.log(`${file} did not grow since ${sha}`);
}

module.exports = { addedEntries };

if (require.main === module) {
  try {
    main(process.argv[2], process.argv[3]);
  } catch (error) {
    console.error(`check-shrinks: ${error.message}`);
    process.exit(1);
  }
}
