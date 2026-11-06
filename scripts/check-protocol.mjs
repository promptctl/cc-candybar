#!/usr/bin/env node
// Guard: every wire-affecting constant the Rust client — or the vendored
// statusline push lane B runs (vendor/cc-extra) — mirrors from the TS source
// must agree. The wire contract is one source of truth
// (src/daemon/protocol.ts, src/daemon/client.ts, src/render/error-glyph.ts,
// src/render/diagnostic-style.ts, src/render/diagnostic-text.ts);
// the Rust binary embeds each value as a literal const because mirroring is
// cheaper than codegen at this scale. This script diffs the entire mirrored
// set — protocol version, frame cap and header, timeout budgets, error-code
// vocabulary, the diagnostic glyph styling, and the code points its sanitizer
// neutralizes — so a drift in ANY of them fails `prepublishOnly`, not
// production.
//
// [LAW:one-source-of-truth] The mirror is legal only because this file
// proves synchronization. Adding a new mirrored constant without adding a
// row to CHECKS reopens the drift hole — add both in the same commit.
// What belongs here: a fact either runtime can spell as a literal an anchor
// reads. A fact only behaviour can state is a fixture both test suites read
// instead (test/fixtures/frame-follow-cases.json, jest and `cargo test`).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as reads from "./protocol-source.js";

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
// An extractor is a reader from protocol-source.js bound to one file: it
// returns the canonical string for one side, or null when the anchor is
// missing. [LAW:no-silent-failure] null is a loud failure below — a vanished
// anchor means the mirror became unverifiable, which is the same defect as a
// drift. Every reader sees the source less its comment lines, so a block an
// extractor slices is delimited by code (a declaration, a function), never by
// a comment.
const inFile =
  (reader) =>
  (relPath, ...anchors) =>
  () =>
    reader(read(relPath), ...anchors);
const num = inFile(reads.num);
const lit = inFile(reads.lit);
const sgrOfHex = inFile(reads.sgrOfHex);
const memberSet = inFile(reads.memberSet);
const codeRanges = inFile(reads.codeRanges);
const markers = inFile(reads.markers);

// --- the mirrored set -----------------------------------------------------

const TS_PROTOCOL = "src/daemon/protocol.ts";
const TS_CLIENT_HINTS = "src/client-hints.ts";
const TS_CLI_FLAGS = "src/cli-flags.ts";
const TS_TMUX_HINT = "src/tmux-hint.ts";
const TS_CONFIG_HINT = "src/config-hint.ts";
const TS_TERMINAL_HINT = "src/terminal-hint.ts";
const TS_CLIENT_HINT = "src/client-hint.ts";
const TS_CLAUDE_SETTINGS = "src/claude-settings.ts";
const TS_GLYPH = "src/render/error-glyph.ts";
const TS_DIAG_TEXT = "src/render/diagnostic-text.ts";
const TS_STYLE = "src/render/diagnostic-style.ts";
const TS_PATHS = "src/daemon/paths.ts";
const TS_HOME = "src/daemon/home.ts";
const TS_HOME_TEST = "test/renderer-home.test.ts";
const TS_ACQUIRE = "src/daemon/acquire.ts";
const TS_LIMITS_TEST = "test/daemon-limits.test.ts";
const TS_LIMITS = "src/daemon/limits.ts";
const RS_MAIN = "rust-client/src/main.rs";
const RS_LAUNCH = "rust-client/src/launch.rs";
const RS_GLYPH = "rust-client/src/error_glyph.rs";
const TS_LANES = "src/config/lanes.ts";
const TS_FRAME_FOLLOW = "src/daemon/frame-follow.ts";
// cc-extra's statusline push, vendored (scripts/vendor-cc-extra.mjs): lane B's
// subscriber, the third runtime speaking the wire contract.
const JS_PUSH = "vendor/cc-extra/src/statusline-push.js";
const TS_ENTRY = "src/index.ts";
const TS_DEBUG_TYPES = "src/daemon/debug-types.ts";
const RS_FOLLOW = "rust-client/src/follow.rs";
// The URL handler app, the fourth runtime speaking the wire: one frame (the
// header and the `url` kind, versioned by itself), the per-uid directory, and
// the address it reads off a link to choose the socket in it.
const SWIFT_HANDLER = "url-handler/main.swift";
const SWIFT_ADDRESS = "url-handler/address.swift";
const SWIFT_ADDRESS_TEST = "url-handler/address-test.swift";
const TS_WIRE = "src/click/wire.ts";

// The names of the native client's own subcommands that Node does NOT also
// name. Compared against the native list itself, so the row agrees exactly
// when the two sets share no name: a Node subcommand the native binary shadows
// is drift, since the binary would answer it and Node never would.
function nativeNamesNodeLacks() {
  const native = memberSet(
    RS_MAIN,
    /const NATIVE_SUBCOMMANDS: [^=]+= \[[^;]+;/,
    /\("([a-z][a-z-]*)",/g,
  )();
  const node = memberSet(
    TS_ENTRY,
    /const SUBCOMMANDS: [^=]+= \{[\s\S]*?\n\};/,
    /^ {2}"?([a-z][a-z-]*)"?: async/gm,
  )();
  const debug = memberSet(
    TS_DEBUG_TYPES,
    /export const DEBUG_WHATS = \[[^\]]+\]/,
    /"([a-z]+)"/g,
  )();
  return reads.without(native, node, debug);
}

// A code is any upper-case literal in the block, on either side. A narrower
// form (`| "CODE"` lines, `"CODE" =>` arms) reads nothing from a layout it
// did not foresee — a one-line union, an or-pattern arm — and a code that
// vanishes from both sides passes silently. [LAW:no-silent-failure] A literal
// that is not a code, in a trailing comment or a label, fails this row
// loudly and by name instead.
const errorCodes = memberSet(
  TS_PROTOCOL,
  /export type ErrorCode =[^;]+;/,
  /"([A-Z_]+)"/g,
);
// The four decisions, from the first to the close of the last: the two that
// decide by a code today, and the two beside them, so a code a decision comes
// to spell is read wherever among them it lands.
const followerCodes = memberSet(
  RS_FOLLOW,
  /^fn classify\([\s\S]+?^fn next_retry_ms\([\s\S]+?^\}/m,
  /"([A-Z_]+)"/g,
);

const clientHintKeys = memberSet(
  TS_PROTOCOL,
  /export interface ClientHints \{[\s\S]+?\n\}/,
  /readonly (\w+)\?:/g,
);

// The wire keys the native client sets on a render request: those in the
// request literal and after it, then the hints client_hints sets by a call
// that names no key. Read as one set, so a hint RenderRequest no longer
// spells, or a key the client stops sending, is drift here either way.
const rustHintKeys = memberSet(
  RS_MAIN,
  /^fn client_hints\([\s\S]+?^\}/m,
  /request\["(\w+)"\]/g,
);
function renderRequestRustKeys() {
  const own = memberSet(
    RS_MAIN,
    /let mut request = serde_json::json!\(\{[\s\S]+?let body = match serde_json::to_vec\(&request\)/,
    /(?:^ +"|request\[")(\w+)"(?::|\])/gm,
  )();
  return reads.union(own, rustHintKeys());
}

// The error codes the native follower decides by, less any the daemon's
// ErrorCode does not name. Compared against the follower's own list, so the
// row agrees exactly when every code it spells is one the daemon sends: a
// renamed code would otherwise fall through to its `exit` arm.
function followerCodesTheDaemonSends() {
  return reads.within(followerCodes(), errorCodes());
}

// [LAW:one-source-of-truth] A row's mirror is the Rust client (`rust`), the
// vendored statusline push (`push`) or the Swift URL handler (`swift`); the
// runner diffs any of them against TS.
const CHECKS = [
  {
    label: "FRAME_HEADER_BYTES, as the URL handler writes frames",
    ts: num(TS_PROTOCOL, /export const FRAME_HEADER_BYTES = ([\d\s*]+);/),
    swift: num(SWIFT_HANDLER, /^let FRAME_HEADER_BYTES = ([\d\s*]+)$/m),
  },
  {
    label: "frame-header byte order, as the URL handler writes it",
    ts: markers(TS_PROTOCOL, [/writeUInt32BE/], "u32 big-endian"),
    swift: markers(SWIFT_HANDLER, [/UInt32\(body\.count\)\.bigEndian/], "u32 big-endian"),
  },
  {
    label: "the URL handler's frame kind",
    ts: lit(TS_PROTOCOL, /export const URL_FRAME_KIND = "([a-z]+)";/),
    swift: lit(SWIFT_HANDLER, /^let URL_FRAME_KIND = "([a-z]+)"$/m),
  },
  {
    label: "the URL handler's frame version",
    ts: num(TS_PROTOCOL, /export const URL_FRAME_VERSION = ([\d\s*]+);/),
    swift: num(SWIFT_HANDLER, /^let URL_FRAME_VERSION = ([\d\s*]+)$/m),
  },
  // The frame's field names, as the daemon reads them and the app writes them.
  {
    label: "the URL handler's frame fields",
    ts: memberSet(TS_PROTOCOL, /export interface UrlFrame \{[\s\S]+?\n\}/, /^ {2}(\w+):/gm),
    swift: memberSet(SWIFT_HANDLER, /withJSONObject: \[[^\]]+\]/, /"(\w+)":/g),
  },
  // The per-uid /tmp directory (src/daemon/home.ts) every renderer's socket
  // sits in. The app starts with no shell's environment, so it has no home
  // to honour: the link's name chooses the file in it.
  {
    label: "the per-uid runtime directory, as the URL handler derives it",
    ts: markers(TS_HOME, [/path\.join\("\/tmp", `cc-candybar-\$\{uid\}`\)/], "/tmp/cc-candybar-<uid>"),
    rust: markers(RS_MAIN, [/format!\("\/tmp\/cc-candybar-\{uid\}"\)/], "/tmp/cc-candybar-<uid>"),
    swift: markers(SWIFT_HANDLER, [/"\/tmp\/cc-candybar-\\\(uid\)\/\\\(file\)"/], "/tmp/cc-candybar-<uid>"),
  },
  // The socket file a name selects there: main's, or the name's with the
  // suffix (the suffix's row is below).
  {
    label: "main's socket file",
    ts: lit(TS_HOME, /export const MAIN_SOCKET_FILE = "((?:[^"\\]|\\.)*)";/),
    rust: lit(RS_MAIN, /const MAIN_SOCKET_FILE: &str = "((?:[^"\\]|\\.)*)";/),
    swift: lit(SWIFT_ADDRESS, /^let MAIN_SOCKET_FILE = "((?:[^"\\]|\\.)*)"$/m),
  },
  {
    label: "the main renderer's name",
    ts: lit(TS_HOME, /export const MAIN_NAME: "main" = "((?:[^"\\]|\\.)*)";/),
    rust: lit(RS_MAIN, /const MAIN_NAME: &str = "((?:[^"\\]|\\.)*)";/),
    swift: lit(SWIFT_ADDRESS, /^let MAIN_NAME = "((?:[^"\\]|\\.)*)"$/m),
  },
  // The segment a link's address follows (`cc-candybar://to/<name>/…`), as
  // the minter writes it and the URL handler reads it.
  {
    label: "a link's address segment",
    ts: lit(TS_WIRE, /export const LINK_TO = "((?:[^"\\]|\\.)*)";/),
    swift: lit(SWIFT_ADDRESS, /^let LINK_TO = "((?:[^"\\]|\\.)*)"$/m),
  },
  // The renderer's home (src/daemon/home.ts): a client started with the two
  // variables derives the socket, state and cache the daemon does.
  {
    label: "the home's root variable",
    ts: lit(TS_HOME, /export const HOME_ENV = "((?:[^"\\]|\\.)*)";/),
    rust: lit(RS_MAIN, /const HOME_ENV: &str = "((?:[^"\\]|\\.)*)";/),
  },
  {
    label: "the home's name variable",
    ts: lit(TS_HOME, /export const NAME_ENV = "((?:[^"\\]|\\.)*)";/),
    rust: lit(RS_MAIN, /const NAME_ENV: &str = "((?:[^"\\]|\\.)*)";/),
  },
  {
    label: "the runtime directory's override variable",
    ts: lit(TS_HOME, /export const RUNTIME_DIR_ENV = "((?:[^"\\]|\\.)*)";/),
    rust: lit(RS_MAIN, /const RUNTIME_DIR_ENV: &str = "((?:[^"\\]|\\.)*)";/),
  },
  {
    label: "a named home's socket suffix",
    ts: lit(TS_HOME, /export const NAMED_SOCKET_SUFFIX = "((?:[^"\\]|\\.)*)";/),
    rust: lit(RS_MAIN, /const NAMED_SOCKET_SUFFIX: &str = "((?:[^"\\]|\\.)*)";/),
    swift: lit(SWIFT_ADDRESS, /^let NAMED_SOCKET_SUFFIX = "((?:[^"\\]|\\.)*)"$/m),
  },
  {
    label: "a named home's state directory",
    ts: lit(TS_HOME, /export const HOME_STATE_DIR = "((?:[^"\\]|\\.)*)";/),
    rust: lit(RS_MAIN, /const HOME_STATE_DIR: &str = "((?:[^"\\]|\\.)*)";/),
  },
  {
    label: "a named home's cache directory",
    ts: lit(TS_HOME, /export const HOME_CACHE_DIR = "((?:[^"\\]|\\.)*)";/),
    rust: lit(RS_MAIN, /const HOME_CACHE_DIR: &str = "((?:[^"\\]|\\.)*)";/),
  },
  {
    label: "a renderer name's length",
    ts: num(TS_HOME, /export const RENDERER_NAME_MAX = ([\d\s*]+);/),
    rust: num(RS_MAIN, /const RENDERER_NAME_MAX: usize = ([\d\s*]+);/),
    swift: num(SWIFT_ADDRESS, /^let RENDERER_NAME_MAX = ([\d\s*]+)$/m),
  },
  // The name rule, spelled in three runtimes, and the home's parse, in two:
  // each side's test drives its own parser from its own list, so the lists
  // are the mirrored fact.
  {
    label: "renderer name rule: accepted vectors",
    ts: memberSet(TS_HOME_TEST, /const NAME_ACCEPT[\s\S]*?\];/, /"([^"]*)"/g),
    rust: memberSet(RS_MAIN, /const NAME_ACCEPT[\s\S]*?\];/, /"([^"]*)"/g),
    swift: memberSet(SWIFT_ADDRESS_TEST, /^let NAME_ACCEPT[\s\S]*?\n\]/m, /"([^"]*)"/g),
  },
  {
    label: "renderer name rule: rejected vectors",
    ts: memberSet(TS_HOME_TEST, /const NAME_REJECT[\s\S]*?\];/, /"([^"]*)"/g),
    rust: memberSet(RS_MAIN, /const NAME_REJECT[\s\S]*?\];/, /"([^"]*)"/g),
    swift: memberSet(SWIFT_ADDRESS_TEST, /^let NAME_REJECT[\s\S]*?\n\]/m, /"([^"]*)"/g),
  },
  {
    label: "the home's parse: its cases",
    ts: memberSet(TS_HOME_TEST, /const HOME_CASES[\s\S]*?\];/, /"([^"]*)"/g),
    rust: memberSet(RS_MAIN, /const HOME_CASES[\s\S]*?\];/, /"([^"]*)"/g),
  },
  {
    label: "lane B's name, as the statusline push subscribes",
    ts: lit(TS_LANES, /^ {2}(statusline): \{/m),
    push: lit(JS_PUSH, /^const LANE = '([a-z]+)';/m),
  },
  {
    label: "PROTOCOL_VERSION, as the statusline push speaks it",
    ts: num(TS_PROTOCOL, /export const PROTOCOL_VERSION = ([\d\s*]+);/),
    push: num(JS_PUSH, /^const PROTOCOL_VERSION = ([\d\s*]+);/m),
  },
  {
    label: "MAX_FRAME_BYTES, as the statusline push reads frames",
    ts: num(TS_PROTOCOL, /export const MAX_FRAME_BYTES = ([\d\s*]+);/),
    push: num(JS_PUSH, /^const MAX_FRAME_BYTES = ([\d\s*]+);/m),
  },
  {
    label: "FRAME_HEADER_BYTES, as the statusline push reads frames",
    ts: num(TS_PROTOCOL, /export const FRAME_HEADER_BYTES = ([\d\s*]+);/),
    push: num(JS_PUSH, /^const HEADER_BYTES = ([\d\s*]+);/m),
  },
  {
    label: "SWITCHED_OFF_RETRY_MS, as the statusline push waits",
    ts: num(TS_FRAME_FOLLOW, /export const SWITCHED_OFF_RETRY_MS = ([\d\s*_]+);/),
    push: num(JS_PUSH, /^const SWITCHED_OFF_RETRY_MS = ([\d\s*_]+);/m),
  },
  {
    label: "animation lane names",
    ts: memberSet(TS_LANES, /export const LANES = \{[\s\S]*?\} as const;/, /^ {2}([A-Za-z]+): \{/gm),
    rust: memberSet(RS_FOLLOW, /const LANE_NAMES: \[&str; \d+\] = \[[^\]]+\]/, /"([A-Za-z]+)"/g),
  },
  {
    label: "RECONNECT_FIRST_MS",
    ts: num(TS_FRAME_FOLLOW, /export const RECONNECT_FIRST_MS = ([\d\s*_]+);/),
    rust: num(RS_FOLLOW, /const RECONNECT_FIRST_MS: u64 = ([\d\s*_]+);/),
  },
  {
    label: "RECONNECT_MAX_MS",
    ts: num(TS_FRAME_FOLLOW, /export const RECONNECT_MAX_MS = ([\d\s*_]+);/),
    rust: num(RS_FOLLOW, /const RECONNECT_MAX_MS: u64 = ([\d\s*_]+);/),
  },
  {
    label: "SWITCHED_OFF_RETRY_MS",
    ts: num(TS_FRAME_FOLLOW, /export const SWITCHED_OFF_RETRY_MS = ([\d\s*_]+);/),
    rust: num(RS_FOLLOW, /const SWITCHED_OFF_RETRY_MS: u64 = ([\d\s*_]+);/),
  },
  {
    label: "native subcommands Node does not name",
    ts: nativeNamesNodeLacks,
    rust: memberSet(RS_MAIN, /const NATIVE_SUBCOMMANDS: [^=]+= \[[^;]+;/, /\("([a-z][a-z-]*)",/g),
  },
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
    ts: num(TS_PROTOCOL, /const CONNECT_TIMEOUT_MS = ([\d\s*]+);/),
    rust: num(
      RS_MAIN,
      /const CONNECT_TIMEOUT: Duration = Duration::from_millis\(([\d\s*]+)\);/,
    ),
  },
  {
    label: "total render budget (ms)",
    ts: num(TS_PROTOCOL, /const TOTAL_BUDGET_MS = ([\d\s*]+);/),
    rust: num(
      RS_MAIN,
      /const TOTAL_BUDGET: Duration = Duration::from_millis\(([\d\s*]+)\);/,
    ),
  },
  {
    label: "error-code vocabulary",
    ts: errorCodes,
    rust: memberSet(RS_MAIN, /match code \{[\s\S]+?\n {4}\}/, /"([A-Z_]+)" =>/g),
  },
  {
    label: "error codes the native follower decides by",
    ts: followerCodesTheDaemonSends,
    rust: followerCodes,
  },
  // The client-hint wire keys. Unlike the rows above these are field NAMES, not
  // constants — but they drift the same way and break louder: a hint the Rust
  // client stops sending does not fail, it silently degrades to the daemon's
  // absent-field default on the ONLY client path that actually ships.
  {
    label: "client-hint wire keys",
    ts: clientHintKeys,
    rust: rustHintKeys,
  },
  // Every wire key the shipped clients send on a render request, hints
  // included; a key only a script sends sits on ReaderRenderRequest. A key the
  // native client stops sending degrades the same silent way: a `deadline`
  // spelled differently reads as a client too old to state one, and every
  // answer waits by the guessed budget instead of its client's.
  {
    label: "render request wire keys",
    ts: memberSet(
      TS_PROTOCOL,
      /export interface RenderRequest \{[\s\S]+?\n\}/,
      /^ {2}(\w+)\??:/gm,
    ),
    rust: renderRequestRustKeys,
  },
  // What the native client says it is: the field names of the `client` hint.
  // A renamed field would make every native render read as "unreported" to
  // the doctor's install check, on the one client path that ships.
  {
    label: "client hint fields",
    ts: memberSet(
      TS_CLIENT_HINT,
      /export interface ClientHint \{[\s\S]+?\n\}/,
      /readonly (\w+):/g,
    ),
    rust: memberSet(
      RS_MAIN,
      /fn client_hint\([\s\S]+?\n\}/,
      /"(\w+)": /g,
    ),
  },
  // What "this session is over SSH" MEANS. Both runtimes answer the same
  // question for the same session; disagreeing on the vocabulary would make the
  // native fast path and the node fallback report a session differently.
  {
    label: "SSH env vocabulary",
    ts: memberSet(
      TS_CLIENT_HINTS,
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
  // tmux-truecolor check reasons over whichever client rendered last. Both
  // sides are named roles, so the member is `role=VAR` — a swapped pair is
  // drift even when the set of names is unchanged.
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
  // Which env var names the client's explicit config. Same drift hazard as
  // the tmux row: a renamed variable would not fail — the native client would
  // silently stop reporting the override the node fallback still reports.
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
  // Which env var names Claude Code's configuration directory. Same drift
  // hazard: a renamed variable would not fail — the native client would
  // silently stop reporting the directory the node fallback still reports, and
  // the daemon would read the default directory's settings.json for it.
  {
    label: "Claude config dir env var",
    ts: memberSet(
      TS_CLAUDE_SETTINGS,
      /export const CLAUDE_CONFIG_DIR_ENV = "[A-Z_]+";/,
      /"([A-Z_]+)"/g,
    ),
    rust: memberSet(
      RS_MAIN,
      /const CLAUDE_CONFIG_DIR_ENV: &str = "[A-Z_]+";/,
      /"([A-Z_]+)"/g,
    ),
  },
  // Which env vars name the session's terminal. Same drift hazard: a variable
  // one runtime stops reporting would not fail — the doctor would read the
  // session's terminal as one it cannot name under whichever client rendered
  // last.
  {
    label: "terminal env vocabulary",
    ts: memberSet(
      TS_TERMINAL_HINT,
      /export const TERMINAL_ENV_VARS = \[[\s\S]+?\] as const;/,
      /"([A-Z_]+)"/g,
    ),
    rust: memberSet(
      RS_MAIN,
      /const TERMINAL_ENV_VARS: \[&str; \d+\] = \[[\s\S]+?\];/,
      /"([A-Z_]+)"/g,
    ),
  },
  // The tmux hint's own wire shape: the field names the Rust client builds
  // into the object against the TS type the daemon sanitizes it into. A
  // renamed field would not fail — sanitizeTmux would read every native
  // hint as "unreported".
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
    ts: sgrOfHex(TS_STYLE, /const DIAGNOSTIC_ERROR_COLORS: DiagnosticColors = \{[^}]*\bfg: "(#[0-9a-f]{6})"/, 38),
    rust: lit(RS_GLYPH, /const FG: &str = "((?:[^"\\]|\\.)*)";/),
  },
  {
    label: "glyph BG",
    ts: sgrOfHex(TS_STYLE, /const DIAGNOSTIC_ERROR_COLORS: DiagnosticColors = \{[^}]*\bbg: "(#[0-9a-f]{6})"/, 48),
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
  // The code points the diagnostic sanitizer turns into spaces. The tables
  // alone would not do: a term beside the fold, in the predicate or at its one
  // use, changes the set with the tables still equal — so the second row
  // anchors both whole (whitespace aside): a term added to either breaks it.
  {
    label: "diagnostic sanitizer code points",
    ts: codeRanges(TS_DIAG_TEXT, /const NEUTRALIZED_RANGES = \[([\s\S]*?)\] as const;/),
    rust: codeRanges(RS_GLYPH, /const NEUTRALIZED_RANGES: &\[\(u32, u32\)\] = &\[([\s\S]*?)\];/),
  },
  {
    label: "diagnostic sanitizer predicate",
    ts: markers(
      TS_DIAG_TEXT,
      [
        /export function isControlChar\(code: number\): boolean \{\s*return NEUTRALIZED_RANGES\.some\(\(\[lo, hi\]\) => code >= lo && code <= hi\);\s*\}/,
        /sanitized \+= isControlChar\(ch\.codePointAt\(0\) \?\? 0\) \? " " : ch;/,
      ],
      "the fold over NEUTRALIZED_RANGES, mapped to a space",
    ),
    rust: markers(
      RS_GLYPH,
      [
        /fn neutralized\(ch: char\) -> bool \{\s*NEUTRALIZED_RANGES\.iter\(\)\.any\(\|&\(lo, hi\)\| \(lo\.\.=hi\)\.contains\(&u32::from\(ch\)\)\)\s*\}/,
        /let ch = if neutralized\(raw\) \{ ' ' \} else \{ raw \};/,
      ],
      "the fold over NEUTRALIZED_RANGES, mapped to a space",
    ),
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

const MIRRORS = { rust: "Rust", push: "statusline push", swift: "Swift URL handler" };
const failures = [];
for (const row of CHECKS) {
  const keys = Object.keys(MIRRORS).filter((k) => k in row);
  // [LAW:no-silent-failure] A row naming no mirror is a mistake in this file,
  // said by its label, not a TypeError from calling what it lacks.
  if (keys.length === 0) {
    throw new Error(
      `check-protocol: row "${row.label}" names no mirror (one of ${Object.keys(MIRRORS).join(", ")})`,
    );
  }
  // [LAW:no-silent-failure] Every mirror a row names is held to TS: a row
  // that spells a fact in three runtimes is a check on all three.
  const tsValue = row.ts();
  for (const key of keys) {
    const mirrorName = MIRRORS[key];
    const mirrorValue = row[key]();
    if (tsValue === null || mirrorValue === null) {
      const missing = [tsValue === null && "TS", mirrorValue === null && mirrorName]
        .filter(Boolean)
        .join(" and ");
      failures.push(`${row.label}: anchor not found in ${missing} source`);
      continue;
    }
    if (tsValue !== mirrorValue) {
      failures.push(`${row.label}: TS=${tsValue} vs ${mirrorName}=${mirrorValue}`);
    }
  }
}

if (failures.length > 0) {
  console.error("check-protocol: wire-contract mirror drift detected:");
  for (const f of failures) console.error(`  - ${f}`);
  console.error("Update both runtimes in lockstep when changing the wire contract.");
  process.exit(1);
}

console.log(
  `check-protocol: ${CHECKS.length} mirrored constants verified (TS, Rust, the statusline push and the Swift URL handler agree).`,
);
