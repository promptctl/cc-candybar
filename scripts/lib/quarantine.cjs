// [LAW:one-source-of-truth] The quarantine list: the one place a flaky test is
// named as leaving the gate. A line holds the date it was listed, the lit ticket
// that owns the flake, and the case. It holds no cause and no state, because the
// ticket is the source for both (`lit show <id>`). The environment that lets a
// listed case fail without failing the run, the records and the report all read
// the list through here. CommonJS because the environment and the reporter load
// it untransformed. Time is an argument: nothing here reads a clock.

const { readFileSync } = require("node:fs");
const path = require("node:path");

// Where the list lives, relative to the package root. A run that needs another
// (the fixtures that prove the gate) names it in testEnvironmentOptions.
const QUARANTINE_FILE = "test/quarantine.txt";

// An entry older than this shows red in the report. It fails no merge: a date
// must not block a change that did not cause the flake.
const EXPIRY_DAYS = 7;

const DAY_MS = 86_400_000;

// `<YYYY-MM-DD> <ticket> <file> › <case name>`. The case name is the record's
// own (test-records.cjs caseName), which holds " › " itself, so the file is the
// text up to the first one.
const LINE = /^(\d{4}-\d{2}-\d{2}) (\S+) (\S+) › (.+)$/;
const TICKET = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+)*$/;

/**
 * @typedef {{ date: string, addedAt: number, ticket: string, file: string, name: string }} QuarantineEntry
 * `addedAt` is the date at midnight UTC, in epoch milliseconds.
 */

/** @param {string} date `YYYY-MM-DD` @returns {number | null} epoch ms, or null for a day that does not exist */
function midnightUtc(date) {
  const at = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== date ? null : at;
}

/**
 * [LAW:no-silent-failure] A line that does not parse throws, naming it. A line
 * skipped would be a test its author believes is quarantined and is not, or one
 * that stays quarantined after its line was mangled.
 * @param {string} text
 * @returns {QuarantineEntry[]}
 */
function parseQuarantine(text) {
  /** @type {QuarantineEntry[]} */
  const entries = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const where = `quarantine line ${index + 1}`;
    const match = LINE.exec(line);
    if (!match) {
      throw new Error(`${where}: expected "<YYYY-MM-DD> <ticket> <file> › <case name>", got: ${line}`);
    }
    const [, date, ticket, file, name] = match;
    const addedAt = midnightUtc(date);
    if (addedAt === null) throw new Error(`${where}: ${date} is not a date`);
    if (!TICKET.test(ticket)) throw new Error(`${where}: ${ticket} is not a lit ticket id`);
    if (entries.some((entry) => entry.file === file && entry.name === name)) {
      throw new Error(`${where}: ${file} › ${name} is listed twice`);
    }
    entries.push({ date, addedAt, ticket, file, name });
  });
  return entries;
}

/**
 * [LAW:no-silent-failure] A missing list throws: it is committed, and a run
 * that cannot read it has no honest answer to which tests have left the gate.
 * @param {string} rootDir
 * @param {string} [file] the list, relative to rootDir
 * @returns {QuarantineEntry[]}
 */
function readQuarantine(rootDir, file = QUARANTINE_FILE) {
  return parseQuarantine(readFileSync(path.join(rootDir, file), "utf8"));
}

// [LAW:nothing-unseen] The decision to let a case through travels with its
// failure. The environment appends this error to the errors it keeps, so the
// text shows beside the failure in any reporter and arrives in jest's failure
// messages, where the record reads it. Nothing else in a result says it: a
// skipped case under a failing beforeAll is pending and carries messages too.
//
// The mark is an Error of its own class, so its failure message opens with the
// class name and a test cannot forge one by throwing the same text. It keeps a
// real stack: a failure with none reads as a stale timer to
// test/stackless-failure-reporter.mjs, which runs in every tier.
class QuarantineMark extends Error {}
QuarantineMark.prototype.name = "QuarantineMark";
const MARK_PREFIX = "QuarantineMark: quarantined: ";

/** @param {string} ticket @returns {Error} */
function markError(ticket) {
  return new QuarantineMark(`quarantined: ${ticket}`);
}

/** @param {string[]} failureMessages @returns {string | undefined} the ticket the mark names */
function markedTicket(failureMessages) {
  const mark = failureMessages.find((message) => message.startsWith(MARK_PREFIX));
  return mark === undefined ? undefined : mark.slice(MARK_PREFIX.length).split("\n")[0];
}

/**
 * @param {QuarantineEntry[]} entries
 * @param {string} file path relative to the repository root
 * @param {string} name the case's record name
 * @returns {QuarantineEntry | undefined}
 */
function quarantined(entries, file, name) {
  return entries.find((entry) => entry.file === file && entry.name === name);
}

/** @param {QuarantineEntry} entry @param {number} now epoch ms @returns {number} whole days listed */
function ageDays(entry, now) {
  return Math.floor((now - entry.addedAt) / DAY_MS);
}

/**
 * Red: listed longer than the deadline, or dated in the future. A date that has
 * not happened is a typo, and a typo that read as young would never go red. A
 * line is dated by its author's calendar and read against UTC, so a date one day
 * ahead is the author east of UTC and not a typo.
 * @param {QuarantineEntry} entry @param {number} now epoch ms
 */
function expired(entry, now) {
  const age = ageDays(entry, now);
  return age > EXPIRY_DAYS || age < -1;
}

module.exports = {
  EXPIRY_DAYS,
  QUARANTINE_FILE,
  ageDays,
  expired,
  markError,
  markedTicket,
  parseQuarantine,
  quarantined,
  readQuarantine,
};
