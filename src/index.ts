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

// The diagnostic strip's row cap reads this (src/render/diagnostic-strip.ts);
// like termCols it is a client fact the detached daemon cannot observe.
function detectTermRows(): number | undefined {
  return detectTermExtent(process.env.LINES, process.stderr.rows);
}

// The env vars an SSH login shell inherits from sshd. Any one of them present
// and non-empty means this session arrived over the network.
//
// [LAW:one-source-of-truth] This vocabulary is mirrored by the Rust client
// (rust-client/src/main.rs) and diffed by scripts/check-protocol.mjs, which
// anchors on the declaration below — keep it a named const holding string
// literals, or repoint the CHECKS row in the same commit. Both runtimes must
// agree on what "SSH" means or the fast path and the fallback path would
// disagree about the same session.
//
// All three are checked, not just SSH_CONNECTION: SSH_CLIENT is what older
// sshd builds (and the user's git-taculous zsh theme) key on, and SSH_TTY is
// the one that survives some `sudo` env_keep policies. Extra names can only
// widen recall of a fact that is otherwise reported as a plain `false`.
const SSH_ENV_VARS = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"] as const;

const hasFlag = (flags: readonly string[]): boolean =>
  flags.some((f) => process.argv.includes(f));

// [LAW:dataflow-not-control-flow] A fold over the vocabulary, not a chain of
// ifs — adding a name is a data edit.
//
// Unlike detectTermCols this is TOTAL: the client reads its own environment, so
// "no SSH var set" is the affirmative answer "local", never a failure to
// determine. It therefore always reports, and the daemon reads an ABSENT `ssh`
// hint as "this client is too old to answer" rather than as "local".
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
    // [LAW:one-type-per-behavior] Answers "what is THIS binary" from the baked
    // stamp alone — never a daemon probe, which would fail exactly when the
    // flag is most needed (no working daemon). Daemon skew is the stats
    // snapshot's `version` field.
    if (hasFlag(NODE_FLAGS.version)) {
      console.log(`cc-candybar ${PACKAGE_VERSION}`);
      process.exit(0);
    }

    // [LAW:dataflow-not-control-flow] Subcommand dispatch is data: argv[2]
    // selects the handler. Each handler short-circuits via process.exit().
    // Default fallthrough = the existing stdin-driven render flow.
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
      await runCheck(process.argv.slice(3)); // owns its own exit code (0/1/2)
      return;
    }
    if (subcommand === "schema") {
      runSchema(); // owns its own exit code
      return;
    }
    // [LAW:single-enforcer] The doctor's CLI projection: the SAME check fold
    // the bar's 🩺 click runs, over this process's own environment (which IS
    // Claude Code's when run from a Claude Code shell).
    if (subcommand === "doctor") {
      runDoctorCli(process.argv.slice(3)); // owns its own exit code
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
    // [LAW:single-enforcer] Client hints are captured here, in the user's
    // shell environment, then trusted by the daemon. The daemon's own env
    // reflects whichever shell launched it minutes/hours ago, so it can
    // measure neither the active terminal nor whether THIS session came in
    // over SSH — only the live client can. One daemon serves a local session
    // and an SSH session at the same time, so the answer genuinely differs per
    // request.
    const outcome = await tryRenderViaDaemon(
      hookData,
      process.argv,
      process.cwd(),
      {
        termCols: detectTermCols(),
        termRows: detectTermRows(),
        ssh: detectSsh(),
        // Total like ssh: `null` is the affirmative "not in tmux", so an
        // absent hint on the daemon side means only "client too old".
        tmux: detectTmuxHint(process.env),
        // Conditional like termCols: absent IS "no override", so the daemon
        // resolves the precedence chain. The daemon reads no env of its own.
        configEnv: detectConfigEnv(process.env),
      },
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
