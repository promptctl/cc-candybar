#!/usr/bin/env node

import type { ClaudeHookData } from "./utils/claude";

import process from "node:process";
import { json } from "node:stream/consumers";
import { PowerlineRenderer } from "./powerline";
import { loadConfigFromCLI } from "./config/loader";
import { debug } from "./utils/logger";
import { runInstall, runInstallUrlHandler, runUrlHandle } from "./install";
import { runDaemon } from "./daemon/server";
import { tryRenderViaDaemon } from "./daemon/client";
import { runDaemonStats } from "./daemon/client-stats";
import { spawnDaemonDetached } from "./daemon/spawn";

function showHelpText(): void {
  console.log(`
claude-powerline - Beautiful powerline statusline for Claude Code

Usage: claude-powerline [options]

Standalone Commands:
  -h, --help               Show this help

Debugging:
  CLAUDE_POWERLINE_DEBUG=1 Enable debug logging for troubleshooting

Claude Code Options (for settings.json):
  --theme=THEME            Set theme: dark, light, nord, tokyo-night, rose-pine, custom
  --style=STYLE            Set separator style: minimal, powerline, capsule, tui
  --charset=CHARSET        Set character set: unicode (default), text
  --config=PATH            Use custom config file path
  --layout=LAYOUT          Define lines and segment order, e.g.
                           "directory model session today | block context | git"
                           (segments inherit defaults; use --set to override)
  --show SEG=A,B,C         Shorthand: enable show* booleans on a segment.
                           Each comma-separated flag F becomes
                           segment.SEG.show<Capitalize(F)>=true. Example:
                             --show git=workingTree,upstream,timeSinceCommit
                           is equivalent to:
                             --set segment.git.showWorkingTree
                             --set segment.git.showUpstream
                             --set segment.git.showTimeSinceCommit
  --display K=V,K=V        Shorthand for display.K=V (comma-separated). Example:
                             --display autoWrap=false,padding=1
                           is equivalent to:
                             --set display.autoWrap=false
                             --set display.padding=1
  --segment SEG.K=V,...    Shorthand for segment.SEG.K=V (comma-separated).
                           Example:
                             --segment block.type=weighted,sessionId.length=8
                           is equivalent to:
                             --set segment.block.type=weighted
                             --set segment.sessionId.length=8
Subcommands (macOS):
  install [args...]        One-shot setup. Creates the URL handler app, registers
                           the cpwl:// scheme, and writes the renderer command
                           into ~/.claude/settings.json. With no args, uses
                           Brandon's default config; pass renderer flags to
                           override.
  install-url-handler      Just create + register the URL handler app
                           (~/Applications/ClaudePowerlineURLHandler.app).
  url-handle URL           Internal — invoked by the URL handler app on
                           cmd-click. Parses cpwl://<verb>/<value> and
                           dispatches (currently: copy to clipboard).
  daemon-stats [--json]    Query the running daemon for runtime stats:
                           uptime, RSS, cache hit rates, watcher count,
                           request totals. Does not spawn a daemon.

  --set KEY=VALUE          Override any config value (repeatable). Examples:
                             --set theme=custom
                             --set display.style=capsule
                             --set segment.git.showWorkingTree=true
                             --set segment.session.type=both
                             --set color.git=#3a3a3a/#d0d0d0
                             --set color.session.bg=#5a5a5a
                             --set budget.today.amount=5
                             --set modelLimit.sonnet=200000
                           Bareword (no '=') means '=true'. Numbers and
                           true/false are auto-parsed. Anything else is a
                           string. Unknown short prefixes fall through as
                           literal dotted paths.

See example config at: https://github.com/Owloops/claude-powerline/blob/main/.claude-powerline.json

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
      runUrlHandle(process.argv[3]);
      process.exit(0);
    }
    if (subcommand === "daemon") {
      runDaemon();
      return; // daemon owns its own lifecycle
    }
    if (subcommand === "daemon-stats") {
      await runDaemonStats(process.argv.slice(3));
      process.exit(0);
    }

    if (process.stdin.isTTY === true) {
      console.error(`Error: This tool requires input from Claude Code

claude-powerline is designed to be used as a Claude Code statusLine command.
It reads hook data from stdin and outputs formatted statusline.

Add to ~/.claude/settings.json:
{
  "statusLine": {
    "type": "command",
    "command": "claude-powerline --style=powerline"
  }
}

Run with --help for more options.

To test output manually:
echo '{"session_id":"test-session","workspace":{"project_dir":"/path/to/project"},"model":{"id":"claude-sonnet-4-5","display_name":"Claude"}}' | claude-powerline --style=powerline`);
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

    // [LAW:dataflow-not-control-flow] Daemon path is an *optimization*, never
    // a correctness dependency. Any failure (no socket, refused, timeout,
    // version mismatch) falls through to inline render and fires a detached
    // daemon spawn so the *next* invocation finds it.
    const useDaemon = process.env.CLAUDE_POWERLINE_NO_DAEMON !== "1";
    if (useDaemon) {
      const outcome = await tryRenderViaDaemon(
        hookData,
        process.argv,
        process.cwd(),
      );
      if (outcome.ok && outcome.output !== undefined) {
        process.stdout.write(outcome.output);
        process.exit(0);
      }
      // Fall through. Spawn detached for next invocation.
      spawnDaemonDetached();
    }

    const projectDir = hookData.workspace?.project_dir;
    const config = loadConfigFromCLI(process.argv, projectDir);
    const renderer = new PowerlineRenderer(config);
    const statusline = await renderer.generateStatusline(hookData);

    console.log(statusline);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error generating statusline:", errorMessage);
    process.exit(1);
  }
}

main();
