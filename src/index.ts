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
import { HELP_TEXT } from "./help-text";
import { NODE_FLAGS } from "./cli-flags";
import { PACKAGE_VERSION } from "./version";
import { detectTermExtent } from "./term-extent";
import { detectTmuxHint } from "./tmux-hint";
import { detectConfigEnv } from "./config-hint";
import { runDoctorCli } from "./doctor/cli";

function detectTermCols(): number | undefined {
  return detectTermExtent(process.env.COLUMNS, process.stderr.columns);
}

function detectTermRows(): number | undefined {
  return detectTermExtent(process.env.LINES, process.stderr.rows);
}

// [LAW:one-source-of-truth] Mirrored by the Rust client and diffed by
// scripts/check-protocol.mjs, which anchors on the declaration below.
const SSH_ENV_VARS = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"] as const;

const hasFlag = (flags: readonly string[]): boolean =>
  flags.some((f) => process.argv.includes(f));

// [LAW:dataflow-not-control-flow] A fold over the vocabulary; adding a name is a
// data edit. TOTAL, unlike termCols: "no SSH var set" is the answer "local".
function detectSsh(): boolean {
  return SSH_ENV_VARS.some((name) => (process.env[name] ?? "") !== "");
}

function showHelpText(): void {
  console.log(HELP_TEXT);
}

async function main(): Promise<void> {
  try {
    if (hasFlag(NODE_FLAGS.help)) {
      showHelpText();
      process.exit(0);
    }
    // [LAW:one-type-per-behavior] The baked stamp alone, never a daemon probe.
    if (hasFlag(NODE_FLAGS.version)) {
      console.log(`cc-candybar ${PACKAGE_VERSION}`);
      process.exit(0);
    }

    const subcommand = process.argv[2];
    if (subcommand === "install") {
      await runInstall(process.argv.slice(3));
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
      return;
    }
    if (subcommand === "daemon-stats") {
      await runDaemonStats(process.argv.slice(3));
      process.exit(0);
    }
    if (subcommand === "check" || subcommand === "lint") {
      await runCheck(process.argv.slice(3));
      return;
    }
    if (subcommand === "schema") {
      runSchema();
      return;
    }
    if (subcommand === "doctor") {
      runDoctorCli(process.argv.slice(3));
      return;
    }
    // [LAW:dataflow-not-control-flow] The subcommand name IS the DebugWhat.
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

    // [LAW:one-source-of-truth] The daemon is the ONLY renderer; this is a dumb
    // relay. [LAW:single-enforcer] Hints are captured here because one daemon
    // serves a local session and an SSH session at the same time.
    const outcome = await tryRenderViaDaemon(
      hookData,
      process.argv,
      process.cwd(),
      {
        termCols: detectTermCols(),
        termRows: detectTermRows(),
        ssh: detectSsh(),
        // Total like ssh: `null` is the affirmative "not in tmux".
        tmux: detectTmuxHint(process.env),
        // Conditional like termCols: absent IS "no override".
        configEnv: detectConfigEnv(process.env),
      },
    );
    // [LAW:dataflow-not-control-flow] planOutcome maps each variant to a plan
    // value; kicking on a `permanent` failure would respawn a daemon forever.
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
