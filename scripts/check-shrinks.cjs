#!/usr/bin/env node
// Fails when a JSON file grew since a base commit: a transitional list may shrink
// and never grow. The file is a list of strings (an entry added grows it) or an
// object of numbers (a value raised, or a key added, grows it).
// Usage: check-shrinks.cjs <file> <base-sha>.
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

/**
 * @param {Readonly<Record<string, number>>} base
 * @param {Readonly<Record<string, number>>} head
 * @returns {string[]} each key whose number rose, or that the base lacked
 */
function risenCounts(base, head) {
  return Object.entries(head)
    .filter(([key, value]) => !(key in base) || value > base[key])
    .map(([key, value]) => (key in base ? `${key} ${base[key]} -> ${value}` : `${key} (new, ${value})`));
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// [LAW:one-source-of-truth] A file's shape says how it grows, so one reader names
// both, and a comparison across shapes is an error and not a pass.
function shrinkableOf(text, source) {
  const value = JSON.parse(text);
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return { kind: "list", value };
  }
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((n) => Number.isInteger(n) && n >= 0)
  ) {
    return { kind: "counts", value };
  }
  throw new Error(`${source} must hold a JSON list of strings or an object of non-negative integers`);
}

function grownBy(base, head, file, sha) {
  if (base.kind !== head.kind) throw new Error(`${file} was a ${base.kind} at ${sha} and is a ${head.kind} now`);
  return base.kind === "list" ? addedEntries(base.value, head.value) : risenCounts(base.value, head.value);
}

function main(file, sha) {
  if (!file || !sha) throw new Error("usage: check-shrinks.cjs <file> <base-sha>");
  try {
    git(["fetch", "--depth=1", "origin", sha]);
    git(["cat-file", "-e", `${sha}^{commit}`]);
  } catch (error) {
    throw new Error(`cannot read base commit ${sha}: ${error.stderr || error.message}`);
  }
  // [LAW:no-silent-failure] ls-tree answers "absent" with empty output and fails on
  // anything else (a corrupt object, a git error), so only absence reads as new.
  if (git(["ls-tree", "--name-only", sha, "--", file]).trim() === "") {
    console.log(`${file} is not in ${sha}: new in this change, nothing to compare`);
    return;
  }
  const baseText = git(["show", `${sha}:${file}`]);
  const grown = grownBy(
    shrinkableOf(baseText, `${file} at ${sha}`),
    shrinkableOf(readFileSync(file, "utf8"), file),
    file,
    sha,
  );
  if (grown.length > 0) {
    throw new Error(`${file} grew since ${sha}: ${grown.join(", ")}. It may only shrink.`);
  }
  console.log(`${file} did not grow since ${sha}`);
}

module.exports = { addedEntries, risenCounts };

if (require.main === module) {
  try {
    main(process.argv[2], process.argv[3]);
  } catch (error) {
    console.error(`check-shrinks: ${error.message}`);
    process.exit(1);
  }
}
