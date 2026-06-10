#!/usr/bin/env node
// Guard: every wire-affecting constant the Rust client mirrors from the TS
// source must agree. The wire contract is one source of truth
// (src/daemon/protocol.ts, src/daemon/client.ts, src/render/error-glyph.ts);
// the Rust binary embeds each value as a literal const because mirroring is
// cheaper than codegen at this scale. This script diffs the entire mirrored
// set — protocol version, frame cap and header, timeout budgets, error-code
// vocabulary, and the diagnostic glyph styling — so a drift in ANY of them
// fails `prepublishOnly`, not production.
//
// [LAW:one-source-of-truth] The mirror is legal only because this file
// proves synchronization. Adding a new mirrored constant without adding a
// row to CHECKS reopens the drift hole — add both in the same commit.
// Escalation path (recorded in ticket brandon-protocol-d55): if the mirrored
// set outgrows a handful, replace mirror+check with a wire-spec data file
// both runtimes embed.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const sources = new Map();
function read(relPath) {
  if (!sources.has(relPath)) {
    sources.set(relPath, readFileSync(resolve(ROOT, relPath), "utf8"));
  }
  return sources.get(relPath);
}

// --- extractors -----------------------------------------------------------
// Each extractor returns the canonical string for one side, or null when the
// anchor is missing. [LAW:no-silent-failure] null is a loud failure below —
// a vanished anchor means the mirror became unverifiable, which is the same
// defect as a drift.

// Integer constant, allowing a product expression like `16 * 1024 * 1024`.
function num(relPath, regex) {
  return () => {
    const m = read(relPath).match(regex);
    if (!m) return null;
    const factors = m[1].split("*").map((s) => s.trim());
    if (!factors.every((f) => /^\d+$/.test(f))) return null;
    return String(factors.reduce((acc, f) => acc * Number(f), 1));
  };
}

// String-literal constant. Decodes \xNN, \uNNNN (TS) and \u{...} (Rust)
// escapes so the comparison is on the actual bytes, not the spelling.
function lit(relPath, regex) {
  return () => {
    const m = read(relPath).match(regex);
    if (!m) return null;
    const decoded = m[1]
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) =>
        String.fromCodePoint(parseInt(h, 16)),
      )
      .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h) =>
        String.fromCodePoint(parseInt(h, 16)),
      )
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
        String.fromCodePoint(parseInt(h, 16)),
      );
    return JSON.stringify(decoded);
  };
}

// Set of string members: collect every capture of a global regex within the
// slice matched by blockRegex, canonicalized as a sorted joined list.
function memberSet(relPath, blockRegex, memberRegex) {
  return () => {
    const block = read(relPath).match(blockRegex);
    if (!block) return null;
    const members = [...block[0].matchAll(memberRegex)].map((m) => m[1]);
    if (members.length === 0) return null;
    return [...new Set(members)].sort().join(", ");
  };
}

// Structural marker: every pattern must appear; the canonical value is the
// shared description, so both sides agree iff both still use the primitive.
function markers(relPath, patterns, description) {
  return () =>
    patterns.every((p) => p.test(read(relPath))) ? description : null;
}

// --- the mirrored set -----------------------------------------------------

const TS_PROTOCOL = "src/daemon/protocol.ts";
const TS_CLIENT = "src/daemon/client.ts";
const TS_GLYPH = "src/render/error-glyph.ts";
const RS_MAIN = "rust-client/src/main.rs";
const RS_GLYPH = "rust-client/src/error_glyph.rs";

const CHECKS = [
  {
    label: "PROTOCOL_VERSION",
    ts: num(TS_PROTOCOL, /export const PROTOCOL_VERSION = ([\d\s*]+);/),
    rust: num(RS_MAIN, /const PROTOCOL_VERSION: u32 = ([\d\s*]+);/),
  },
  {
    label: "MAX_FRAME_BYTES",
    ts: num(TS_PROTOCOL, /export const MAX_FRAME_BYTES = ([\d\s*]+);/),
    rust: num(RS_MAIN, /const MAX_FRAME_BYTES: u32 = ([\d\s*]+);/),
  },
  {
    label: "FRAME_HEADER_BYTES",
    ts: num(TS_PROTOCOL, /export const FRAME_HEADER_BYTES = ([\d\s*]+);/),
    rust: num(RS_MAIN, /const FRAME_HEADER_BYTES: usize = ([\d\s*]+);/),
  },
  {
    label: "frame-header byte order",
    ts: markers(
      TS_PROTOCOL,
      [/writeUInt32BE/, /readUInt32BE/],
      "u32 big-endian",
    ),
    rust: markers(RS_MAIN, [/to_be_bytes/, /from_be_bytes/], "u32 big-endian"),
  },
  {
    label: "connect timeout (ms)",
    ts: num(TS_CLIENT, /const CONNECT_TIMEOUT_MS = ([\d\s*]+);/),
    rust: num(
      RS_MAIN,
      /const CONNECT_TIMEOUT: Duration = Duration::from_millis\(([\d\s*]+)\);/,
    ),
  },
  {
    label: "total render budget (ms)",
    ts: num(TS_CLIENT, /const TOTAL_BUDGET_MS = ([\d\s*]+);/),
    rust: num(
      RS_MAIN,
      /const TOTAL_BUDGET: Duration = Duration::from_millis\(([\d\s*]+)\);/,
    ),
  },
  {
    label: "error-code vocabulary",
    ts: memberSet(
      TS_PROTOCOL,
      /export type ErrorCode =[^;]+;/,
      /"([A-Z_]+)"/g,
    ),
    rust: memberSet(RS_MAIN, /match code \{[\s\S]+?\n {4}\}/, /"([A-Z_]+)" =>/g),
  },
  {
    label: "glyph FG",
    ts: lit(TS_GLYPH, /const FG = "((?:[^"\\]|\\.)*)";/),
    rust: lit(RS_GLYPH, /const FG: &str = "((?:[^"\\]|\\.)*)";/),
  },
  {
    label: "glyph BG",
    ts: lit(TS_GLYPH, /const BG = "((?:[^"\\]|\\.)*)";/),
    rust: lit(RS_GLYPH, /const BG: &str = "((?:[^"\\]|\\.)*)";/),
  },
  {
    label: "glyph RESET",
    ts: lit(TS_GLYPH, /const RESET = "((?:[^"\\]|\\.)*)";/),
    rust: lit(RS_GLYPH, /const RESET: &str = "((?:[^"\\]|\\.)*)";/),
  },
  {
    label: "glyph PREFIX",
    ts: lit(TS_GLYPH, /const PREFIX = "((?:[^"\\]|\\.)*)";/),
    rust: lit(RS_GLYPH, /const PREFIX: &str = "((?:[^"\\]|\\.)*)";/),
  },
  {
    label: "glyph MAX_MESSAGE_LEN",
    ts: num(TS_GLYPH, /const MAX_MESSAGE_LEN = ([\d\s*]+);/),
    rust: num(RS_GLYPH, /const MAX_MESSAGE_LEN: usize = ([\d\s*]+);/),
  },
];

// --- runner ----------------------------------------------------------------

const failures = [];
for (const { label, ts, rust } of CHECKS) {
  const tsValue = ts();
  const rustValue = rust();
  if (tsValue === null || rustValue === null) {
    const missing = [tsValue === null && "TS", rustValue === null && "Rust"]
      .filter(Boolean)
      .join(" and ");
    failures.push(`${label}: anchor not found in ${missing} source`);
    continue;
  }
  if (tsValue !== rustValue) {
    failures.push(`${label}: TS=${tsValue} vs Rust=${rustValue}`);
  }
}

if (failures.length > 0) {
  console.error("check-protocol: TS↔Rust mirror drift detected:");
  for (const f of failures) console.error(`  - ${f}`);
  console.error("Update both runtimes in lockstep when changing the wire contract.");
  process.exit(1);
}

console.log(
  `check-protocol: ${CHECKS.length} mirrored constants verified (TS and Rust agree).`,
);
