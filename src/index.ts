#!/usr/bin/env node

import type { ClaudeHookData } from "./utils/claude";

import process from "node:process";
import { json } from "node:stream/consumers";
import { debug } from "./utils/logger";
import { runInstall, runInstallUrlHandler, runUrlHandle } from "./install";
import { runDaemon } from "./daemon/server";
import { tryRenderViaDaemon } from "./daemon/client";
import { runDaemonStats } from "./daemon/client-stats";
import { runDebug } from "./daemon/client-debug";
import { isDebugWhat } from "./daemon/debug-types";
import { runSchema } from "./config/cli";
import { runCheck } from "./check";
import { obtainDaemonKick } from "./daemon/acquire";
import { planOutcome } from "./render/outcome-plan";

// Read terminal width from the live shell context (no subprocess). Returns
// undefined when nothing reliable is available; the daemon falls back to its
// own pure lookup chain in that case. Always-COLUMNS-first because Bash
// exports it on resize and Claude Code propagates it to hook commands.
// stderr (not stdout) is the TTY-side fallback: when invoked as a Claude
// statusline hook, stdin is the hook JSON pipe and stdout is the captured
// statusline pipe, leaving stderr as the only stream still attached to the
// parent terminal. Mirrors the Rust client's TIOCGWINSZ-on-STDERR_FILENO.
function detectTermCols(): number | undefined {
  const env = process.env.COLUMNS;
  if (env) {
    const n = parseInt(env, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  const cols = process.stderr.columns;
  if (cols && cols > 0) return cols;
  return undefined;
}

function showHelpText(): void {
  console.log(`
cc-candybar - Beautiful powerline statusline for Claude Code

Usage: cc-candybar [options]

Standalone Commands:
  -h, --help               Show this help

Debugging:
  CC_CANDYBAR_DEBUG=1      Enable debug logging for troubleshooting

Configuration:
  Layout and segment options are defined in .cc-candybar.json5 (place in your
  project dir, cwd, or ~/.config/cc-candybar/config.json5). Use CC_CANDYBAR_CONFIG
  to point at a specific file. See the default config for all available options:
    node dist/index.mjs debug --project-dir . --cwd .

Subcommands (macOS):
  install                  One-shot setup: creates the URL handler app, registers
                           the cc-candybar:// scheme, and writes the statusLine
                           command into ~/.claude/settings.json.
  install-url-handler      Just create + register the URL handler app
                           (~/Applications/CCCandybarURLHandler.app).
  url-handle URL           Internal — invoked by the URL handler app on
                           cmd-click. Parses cc-candybar://<verb>/<value> and
                           dispatches (currently: copy to clipboard).
  daemon-stats [--json]    Query the running daemon for runtime stats:
                           uptime, RSS, cache hit rates, watcher count,
                           request totals. Does not spawn a daemon.

Config tooling:
  check [config-file]      Validate a config on the full render pipeline (parse
                           → merge → validate → register → render) with no
                           daemon. With no path, checks the same file the daemon
                           would load from here. Exit 0 clean (warnings on
                           stderr), 1 invalid, 2 unreadable. "lint" is an alias.
  schema                   Print the JSON Schema for the config file shape
                           (.cc-candybar.json5). Point an editor's $schema at it
                           for autocomplete + structural validation.
  vars [--json]            Declared variables: source kind, value, last error.
  segments [--json]        Segment templates and their last rendered output.
  config [--json]          The effective merged config. (All three query the
                           running daemon; none spawn one.)

`);
}

async function main(): Promise<void> {
  try {
    const showHelp =
      process.argv.includes("--help") || process.argv.includes("-h");

    if (showHelp) {
      showHelpText();
      process.exit(0);
    }

    // [LAW:dataflow-not-control-flow] Subcommand dispatch is data: argv[2]
    // selects the handler. Each handler short-circuits via process.exit().
    // Default fallthrough = the existing stdin-driven render flow.
    const subcommand = process.argv[2];
    if (subcommand === "install") {
      runInstall(process.argv.slice(3));
      process.exit(0);
    }
    if (subcommand === "install-url-handler") {
      runInstallUrlHandler();
      process.exit(0);
    }
    if (subcommand === "url-handle") {
      await runUrlHandle(process.argv[3]);
      return;
    }
    if (subcommand === "daemon") {
      runDaemon();
      return; // daemon owns its own lifecycle
    }
    if (subcommand === "daemon-stats") {
      await runDaemonStats(process.argv.slice(3));
      process.exit(0);
    }
    // [LAW:one-type-per-behavior] `lint` is an alias of `check` — one config
    // verdict, one pipeline, one exit-code contract (0/1/2). check subsumes the
    // old lint (same loader, plus register + render coverage).
    if (subcommand === "check" || subcommand === "lint") {
      runCheck(process.argv.slice(3)); // owns its own exit code (0/1/2)
    }
    if (subcommand === "schema") {
      runSchema(); // owns its own exit code
      return;
    }
    // [LAW:dataflow-not-control-flow] vars/segments/config are ONE handler
    // parameterized by `what` — the subcommand name IS the DebugWhat. The guard
    // is the canonical list (debug-types), so a new debug projection is reachable
    // here with no second-site edit.
    if (isDebugWhat(subcommand)) {
      await runDebug(subcommand, process.argv.slice(3));
      process.exit(0);
    }

    if (process.stdin.isTTY === true) {
      console.error(`Error: This tool requires input from Claude Code

cc-candybar is designed to be used as a Claude Code statusLine command.
It reads hook data from stdin and outputs formatted statusline.

Add to ~/.claude/settings.json:
{
  "statusLine": {
    "type": "command",
    "command": "cc-candybar --style=powerline"
  }
}

Run with --help for more options.

To test output manually:
echo '{"session_id":"test-session","workspace":{"project_dir":"/path/to/project"},"model":{"id":"claude-sonnet-4-5","display_name":"Claude"}}' | cc-candybar --style=powerline`);
      process.exit(1);
    }

    debug(`Working directory: ${process.cwd()}`);
    debug(`Process args:`, process.argv);

    const hookData = (await json(process.stdin)) as ClaudeHookData;
    debug(`Received hook data:`, JSON.stringify(hookData, null, 2));

    if (!hookData) {
      console.error("Error: No input data received from stdin");
      showHelpText();
      process.exit(1);
    }

    // [LAW:one-source-of-truth] The daemon is the *only* renderer. The CLI is
    // a dumb relay: forward stdin to the daemon, print whatever comes back.
    // There is no inline render path — two renderers would drift (the CLI has
    // no shared gitService/usageProvider, no per-session state, no warm
    // caches). On daemon miss we spawn detached and emit empty output; the
    // next status-line refresh hits the warm daemon and renders for real.
    //
    // [LAW:single-enforcer] Terminal width is captured here, in the user's
    // shell environment, then trusted by the daemon. The daemon's own env
    // reflects whichever shell launched it minutes/hours ago, so it can't
    // measure the active terminal — only the live client can.
    const outcome = await tryRenderViaDaemon(
      hookData,
      process.argv,
      process.cwd(),
      detectTermCols(),
    );
    // [LAW:types-are-the-program] Three variants, one per outcome kind. The
    // "kick on every failure" pattern was the load-bearing half of the
    // 452-corpse spiral (kz8.5) — kicking on `permanent` failures keeps
    // respawning a daemon that will refuse the next request identically.
    // [LAW:dataflow-not-control-flow] planOutcome maps each variant to a
    // plan value (output, kick, debug); the side effects below run against
    // the plan in fixed order. Variability lives in the data.
    const plan = planOutcome(outcome);
    if (plan.debug !== null) {
      debug(plan.debug);
    }
    if (plan.kick) {
      obtainDaemonKick();
    }
    process.stdout.write(plan.output);
    process.exit(0);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error generating statusline:", errorMessage);
    process.exit(1);
  }
}

main();
