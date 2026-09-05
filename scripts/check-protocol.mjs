#!/usr/bin/env node
// Guard: every wire-affecting constant the Rust client mirrors from the TS
// source must agree. The wire contract is one source of truth
// (src/daemon/protocol.ts, src/daemon/client.ts, src/render/error-glyph.ts,
// src/render/diagnostic-style.ts);
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
    // Strip digit-group separators (`3_000`) so both runtimes' idiomatic
    // spellings compare by value, not by punctuation.
    const factors = m[1].split("*").map((s) => s.trim().replace(/_/g, ""));
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
// slice matched by blockRegex, canonicalized as a sorted joined list. A member
// is its capture groups joined by a fixed separator, so a multi-group regex
// compares values, never the formatting between them.
function memberSet(relPath, blockRegex, memberRegex) {
  return () => {
    const block = read(relPath).match(blockRegex);
    if (!block) return null;
    const members = [...block[0].matchAll(memberRegex)].map((m) =>
      m.slice(1).join("="),
    );
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
const TS_INDEX = "src/index.ts";
const TS_CLI_FLAGS = "src/cli-flags.ts";
const TS_TMUX_HINT = "src/tmux-hint.ts";
const TS_GLYPH = "src/render/error-glyph.ts";
const TS_STYLE = "src/render/diagnostic-style.ts";
const TS_PATHS = "src/daemon/paths.ts";
const TS_ACQUIRE = "src/daemon/acquire.ts";
const TS_LIMITS_TEST = "test/daemon-limits.test.ts";
const TS_LIMITS = "src/daemon/limits.ts";
const RS_MAIN = "rust-client/src/main.rs";
const RS_LAUNCH = "rust-client/src/launch.rs";
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
  // The client-hint wire keys. Unlike the rows above these are field NAMES, not
  // constants — but they drift the same way and break louder: a hint the Rust
  // client stops sending does not fail, it silently degrades to the daemon's
  // absent-field default on the ONLY client path that actually ships.
  {
    label: "client-hint wire keys",
    ts: memberSet(
      TS_PROTOCOL,
      /export interface ClientHints \{[\s\S]+?\n\}/,
      /readonly (\w+)\?:/g,
    ),
    rust: memberSet(
      RS_MAIN,
      /--- client hints[\s\S]+?--- end client hints ---/,
      /request\["(\w+)"\]/g,
    ),
  },
  // What "this session is over SSH" MEANS. Both runtimes answer the same
  // question for the same session; disagreeing on the vocabulary would make the
  // native fast path and the node fallback report a session differently.
  {
    label: "SSH env vocabulary",
    ts: memberSet(
      TS_INDEX,
      /const SSH_ENV_VARS = \[[\s\S]+?\] as const;/,
      /"(SSH_\w+)"/g,
    ),
    rust: memberSet(
      RS_MAIN,
      /const SSH_ENV_VARS: \[&str; \d+\] = \[[\s\S]+?\];/,
      /"(SSH_\w+)"/g,
    ),
  },
  // What "this session is in tmux" MEANS, and which env var Claude Code's own
  // truecolor switch lives in. Same drift hazard as the SSH row: the doctor's
  // tmux-truecolor check reasons over whichever client rendered last.
  {
    label: "tmux hint env vocabulary",
    ts: memberSet(
      TS_TMUX_HINT,
      /export const TMUX_ENV = \{[\s\S]+?\} as const;/,
      /"([A-Z_]+)"/g,
    ),
    rust: memberSet(
      RS_MAIN,
      /const TMUX_ENV: \[&str; \d+\] = \[[\s\S]+?\];/,
      /"([A-Z_]+)"/g,
    ),
  },
  // Which bare flags Node answers. The Rust client must route every spelling
  // to Node, or the shipped binary treats it as a render and fails on stdin.
  {
    label: "Node-answered flag vocabulary",
    ts: memberSet(
      TS_CLI_FLAGS,
      /const NODE_FLAGS = \{[\s\S]+?\} as const;/,
      /"(-{1,2}[A-Za-z]+)"/g,
    ),
    rust: memberSet(
      RS_MAIN,
      /const NODE_FLAGS: \[&str; \d+\] = \[[\s\S]+?\];/,
      /"(-{1,2}[A-Za-z]+)"/g,
    ),
  },
  {
    label: "glyph FG",
    ts: lit(TS_STYLE, /const DIAGNOSTIC_ERROR_FG = "((?:[^"\\]|\\.)*)";/),
    rust: lit(RS_GLYPH, /const FG: &str = "((?:[^"\\]|\\.)*)";/),
  },
  {
    label: "glyph BG",
    ts: lit(TS_STYLE, /const DIAGNOSTIC_ERROR_BG = "((?:[^"\\]|\\.)*)";/),
    rust: lit(RS_GLYPH, /const BG: &str = "((?:[^"\\]|\\.)*)";/),
  },
  {
    label: "glyph RESET",
    ts: lit(TS_STYLE, /const ANSI_RESET = "((?:[^"\\]|\\.)*)";/),
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
  // The budget grammar's test vectors: each side's test drives its own parser
  // from its own list, so the lists themselves are the mirrored fact.
  {
    label: "budget grammar: accepted vectors",
    ts: memberSet(TS_LIMITS_TEST, /const ACCEPT[\s\S]*?\];/, /"([^"]*)", ?(\d+)/g),
    rust: memberSet(RS_LAUNCH, /const ACCEPT[\s\S]*?\];/, /"([^"]*)", ?(\d+)/g),
  },
  {
    label: "budget grammar: rejected vectors",
    ts: memberSet(TS_LIMITS_TEST, /const REJECT[\s\S]*?\];/, /"([^"]*)"/g),
    rust: memberSet(RS_LAUNCH, /const REJECT[\s\S]*?\];/, /"([^"]*)"/g),
  },
  {
    label: "spawn-cooldown (ms)",
    ts: num(TS_ACQUIRE, /const SPAWN_COOLDOWN_MS = ([\d\s*_]+);/),
    rust: num(RS_MAIN, /const SPAWN_COOLDOWN_MS: u128 = ([\d\s*_]+);/),
  },
  {
    label: "spawn-cooldown filename",
    ts: lit(TS_PATHS, /const SPAWN_COOLDOWN_FILE = "((?:[^"\\]|\\.)*)";/),
    rust: lit(RS_MAIN, /const SPAWN_COOLDOWN_FILE: &str = "((?:[^"\\]|\\.)*)";/),
  },
  {
    // The left boundary of the shared cooldown window [-STALE_LOCK_MS,
    // SPAWN_COOLDOWN_MS): both runtimes read the SAME spawn.cooldown file's
    // mtime and use this to decide future-mtime garbage. A drift would make
    // them disagree on whether to spawn given identical on-disk state.
    label: "stale-lock window (ms)",
    ts: num(TS_ACQUIRE, /const STALE_LOCK_MS = ([\d\s*_]+);/),
    rust: num(RS_MAIN, /const STALE_LOCK_MS: u64 = ([\d\s*_]+);/),
  },
  {
    label: "spawn-backoff cap (ms)",
    ts: num(TS_ACQUIRE, /export const SPAWN_BACKOFF_CAP_MS = ([\d\s*_]+);/),
    rust: num(RS_MAIN, /const SPAWN_BACKOFF_CAP_MS: u128 = ([\d\s*_]+);/),
  },
  {
    label: "spawn-backoff max streak",
    ts: num(TS_ACQUIRE, /export const SPAWN_BACKOFF_MAX_STREAK = ([\d\s*_]+);/),
    rust: num(RS_MAIN, /const SPAWN_BACKOFF_MAX_STREAK: u32 = ([\d\s*_]+);/),
  },
  {
    label: "spawn-backoff filename",
    ts: lit(TS_PATHS, /const SPAWN_BACKOFF_FILE = "((?:[^"\\]|\\.)*)";/),
    rust: lit(RS_MAIN, /const SPAWN_BACKOFF_FILE: &str = "((?:[^"\\]|\\.)*)";/),
  },
  // The daemon's memory budget: both spawners derive node's --max-old-space-size
  // from it, the daemon derives its RSS backstop from it, and the cap must stay
  // above the backstop (limits.ts). All three pieces must agree or one runtime
  // spawns a daemon whose hard cap sits below its graceful one.
  {
    label: "rss-limit env var",
    ts: lit(TS_LIMITS, /export const RSS_LIMIT_ENV = "((?:[^"\\]|\\.)*)";/),
    rust: lit(RS_LAUNCH, /const RSS_LIMIT_ENV: &str = "((?:[^"\\]|\\.)*)";/),
  },
  {
    label: "default rss limit (MB)",
    ts: num(TS_LIMITS, /export const DEFAULT_RSS_LIMIT_MB = ([\d\s*_]+);/),
    rust: num(RS_LAUNCH, /const DEFAULT_RSS_LIMIT_MB: u64 = ([\d\s*_]+);/),
  },
  {
    label: "heap cap over rss (multiplier)",
    ts: num(TS_LIMITS, /export const HEAP_CAP_OVER_RSS = ([\d\s*_]+);/),
    rust: num(RS_LAUNCH, /const HEAP_CAP_OVER_RSS: u64 = ([\d\s*_]+);/),
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
