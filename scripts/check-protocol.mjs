#!/usr/bin/env node
// [LAW:one-source-of-truth] The Rust client mirrors the wire contract as literal consts;
// that mirror is legal only because this file proves it. A new one needs a new CHECKS row.

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

// [LAW:no-silent-failure] A missing anchor is null, and an unverifiable mirror fails as drift does.

function num(relPath, regex) {
  return () => {
    const m = read(relPath).match(regex);
    if (!m) return null;
    // Compare by value, not by punctuation.
    const factors = m[1].split("*").map((s) => s.trim().replace(/_/g, ""));
    if (!factors.every((f) => /^\d+$/.test(f))) return null;
    return String(factors.reduce((acc, f) => acc * Number(f), 1));
  };
}

// Decodes escapes so the comparison is on the actual bytes, not the spelling.
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

// A member is its capture groups joined, so a multi-group regex compares values.
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

// Both sides agree iff both still use the primitive.
function markers(relPath, patterns, description) {
  return () =>
    patterns.every((p) => p.test(read(relPath))) ? description : null;
}

const TS_PROTOCOL = "src/daemon/protocol.ts";
const TS_CLIENT = "src/daemon/client.ts";
const TS_INDEX = "src/index.ts";
const TS_CLI_FLAGS = "src/cli-flags.ts";
const TS_TMUX_HINT = "src/tmux-hint.ts";
const TS_CONFIG_HINT = "src/config-hint.ts";
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
  // Field NAMES, not constants: a hint the Rust client stops sending degrades silently.
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
  // Members are `role=VAR`, so a swapped pair is drift even when the names are unchanged.
  {
    label: "tmux hint env vocabulary",
    ts: memberSet(
      TS_TMUX_HINT,
      /export const TMUX_ENV = \{[\s\S]+?\} as const;/,
      /(\w+): "([A-Z_]+)"/g,
    ),
    rust: memberSet(
      RS_MAIN,
      /const TMUX_ENV: TmuxEnv = TmuxEnv \{[\s\S]+?\};/,
      /(\w+): "([A-Z_]+)"/g,
    ),
  },
  {
    label: "config hint env var",
    ts: memberSet(
      TS_CONFIG_HINT,
      /export const CONFIG_ENV = "[A-Z_]+";/,
      /"([A-Z_]+)"/g,
    ),
    rust: memberSet(
      RS_MAIN,
      /const CONFIG_ENV: &str = "[A-Z_]+";/,
      /"([A-Z_]+)"/g,
    ),
  },
  {
    label: "tmux hint wire keys",
    ts: memberSet(
      TS_TMUX_HINT,
      /export interface TmuxHint \{[\s\S]+?\n\}/,
      /readonly (\w+):/g,
    ),
    rust: memberSet(
      RS_MAIN,
      /fn tmux_hint\([\s\S]+?json!\(\{[\s\S]+?\}\)/,
      /"(\w+)":/g,
    ),
  },
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
  // Each side's test drives its own parser from its own list; the lists are the fact.
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
    // The left boundary of the shared cooldown window; both runtimes read one file's mtime.
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
  // The heap cap must stay above the RSS backstop, or the hard cap sits below the graceful one.
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
