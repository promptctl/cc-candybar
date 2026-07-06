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
import { basename } from "node:path";

// --- effects at the edges -------------------------------------------------

// The whole hook payload, or {} if stdin was empty / unparseable.
function readPayload() {
  try {
    const raw = readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
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
  return {
    name: basename(root),
    sha: git(cwd, ["rev-parse", "--short", "HEAD"]) ?? "",
    branch: git(cwd, ["branch", "--show-current"]) || "detached",
    stashed: (git(cwd, ["stash", "list"]) ?? "").split("\n").filter(Boolean)
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
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function gitSegment(g) {
  if (!g) return "";
  const stash = g.stashed > 0 ? ` (${g.stashed} stashed)` : "";
  return c("32", `(git) ${g.name} ${g.sha} ⎇ ${g.branch}${stash}`);
}

function sessionSegment(cost, ctx) {
  const parts = [];
  if (ctx) parts.push(`${tokens(ctx.total)} tok`);
  if (typeof cost === "number") parts.push(`$${cost.toFixed(2)}`);
  return parts.length ? c("33", parts.join(" ")) : "";
}

function contextSegment(ctx) {
  if (!ctx) return "";
  const pct = Math.round((ctx.used / ctx.max) * 100);
  return c("36", `ctx ${tokens(ctx.used)}/${tokens(ctx.max)} (${pct}%)`);
}

// Derive the two token views from context_window, when present.
function contextTokens(cw) {
  if (!cw) return { session: null, context: null };
  const u = cw.current_usage;
  const context = u
    ? {
        used:
          (u.input_tokens || 0) +
          (u.cache_creation_input_tokens || 0) +
          (u.cache_read_input_tokens || 0),
        max: cw.context_window_size,
      }
    : null;
  const session = {
    total: (cw.total_input_tokens || 0) + (cw.total_output_tokens || 0),
  };
  return { session, context };
}

function render(data, g) {
  const cwd = data.workspace?.current_dir ?? data.cwd ?? "";
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
const cwd = data.workspace?.current_dir ?? data.cwd ?? process.cwd();
process.stdout.write(render(data, gitInfo(cwd)) + "\n");
