#!/usr/bin/env node
// candybar-lite — a single-file Claude Code statusline.
//
// Reads the hook JSON on stdin, prints one status line. No daemon, no config,
// no caching, no dependencies. Point your Claude Code settings at it:
//
//   "statusLine": { "type": "command", "command": "node /path/to/candybar-lite.mjs" }
//
// The hook payload shape is Anthropic's statusline schema (model, workspace,
// cost, context_window). Fields that may be absent are treated as absent, not
// guessed.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, sep } from "node:path";

// --- effects at the edges -------------------------------------------------

// The whole hook payload. Empty stdin is a legitimate "no data" → {}. But a
// non-empty, unparseable payload is a real upstream break — surface it loudly
// rather than render a plausible bar from the launcher dir.
// [LAW:no-silent-failure]
function readPayload() {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8").trim();
  } catch {
    return {}; // no stdin at all — nothing to render from, legitimately empty
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    process.stdout.write(c("31", "⚠ candybar-lite: unparseable hook JSON") + "\n");
    process.stderr.write(
      `candybar-lite: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(1);
  }
}

// Run git in `cwd`, return trimmed stdout, or null if git exited non-zero
// (not a repo, no commits yet, etc.) — an absent value, not a masked error.
function git(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// Collect git facts once, as plain data, so render() stays pure.
function gitInfo(cwd) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return null; // not inside a repo — absent, no segment
  // stashed: number of stashes, or null when the lookup itself failed —
  // "no stashes" and "couldn't check" are distinct, neither fabricates a 0.
  const stashOut = git(cwd, ["stash", "list"]);
  return {
    name: basename(root),
    // null in a repo with no commits (HEAD unresolvable) — omitted, not blank.
    sha: git(cwd, ["rev-parse", "--short", "HEAD"]),
    branch: git(cwd, ["branch", "--show-current"]) || "detached",
    stashed: stashOut === null ? null : stashOut.split("\n").filter(Boolean)
      .length,
  };
}

// --- pure formatting core -------------------------------------------------

const c = (code, s) => (s ? `\x1b[${code}m${s}\x1b[0m` : "");

// 12345 -> "12.3k", 2_100_000 -> "2.1M"
function tokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function dir(p) {
  if (!p) return "";
  const home = homedir();
  if (p === home) return "~";
  // Boundary check: `/home/bob2` must not become `~2` under `$HOME=/home/bob`.
  if (p.startsWith(home + sep)) return `~${p.slice(home.length)}`;
  return p;
}

function gitSegment(g) {
  if (!g) return "";
  // Build from non-empty parts: a null sha (no-commit repo) or null/0 stash
  // count simply drop out — no blank gaps, no fabricated values.
  const stash = g.stashed ? `(${g.stashed} stashed)` : "";
  const parts = ["(git)", g.name, g.sha, "⎇", g.branch, stash].filter(Boolean);
  return c("32", parts.join(" "));
}

function sessionSegment(cost, ctx) {
  const parts = [];
  if (ctx) parts.push(`${tokens(ctx.total)} tok`);
  if (typeof cost === "number") parts.push(`$${cost.toFixed(2)}`);
  return parts.length ? c("33", parts.join(" ")) : "";
}

function contextSegment(ctx) {
  if (!ctx) return "";
  // Cap at 100 — usage over the window is still just "full", not 105%.
  const pct = Math.min(100, Math.round((ctx.used / ctx.max) * 100));
  return c("36", `ctx ${tokens(ctx.used)}/${tokens(ctx.max)} (${pct}%)`);
}

// Derive the two token views from context_window, when present.
function contextTokens(cw) {
  if (!cw) return { session: null, context: null };
  const u = cw.current_usage;
  const max = cw.context_window_size;
  // Require both live usage and a valid window size — a partial/malformed
  // payload drops the segment rather than printing `ctx 10/undefined (NaN%)`.
  const context =
    u && typeof max === "number" && max > 0
      ? {
          used:
            (u.input_tokens || 0) +
            (u.cache_creation_input_tokens || 0) +
            (u.cache_read_input_tokens || 0),
          max,
        }
      : null;
  const session = {
    total: (cw.total_input_tokens || 0) + (cw.total_output_tokens || 0),
  };
  return { session, context };
}

function render(data, cwd, g) {
  const { session, context } = contextTokens(data.context_window);
  return [
    c("34", dir(cwd)),
    gitSegment(g),
    c("2", data.model?.display_name ?? ""),
    sessionSegment(data.cost?.total_cost_usd, session),
    contextSegment(context),
  ]
    .filter(Boolean)
    .join(c("90", " │ "));
}

// --- wiring ---------------------------------------------------------------

const data = readPayload();
// [LAW:one-source-of-truth] one cwd, derived once, feeds both the rendered
// directory segment and the git lookup — they can never disagree, even when
// the payload is empty/malformed (both then use process.cwd()).
const cwd = data.workspace?.current_dir ?? data.cwd ?? process.cwd();
process.stdout.write(render(data, cwd, gitInfo(cwd)) + "\n");
