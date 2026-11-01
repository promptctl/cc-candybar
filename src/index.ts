#!/usr/bin/env node

import type { ClaudeHookData } from "./utils/claude";

import process from "node:process";
import { fileURLToPath } from "node:url";
import { json } from "node:stream/consumers";
import { debug } from "./utils/logger";
import {
  runInstall,
  runInstallUrlHandler,
  runUrlHandle,
  stableAttachPreload,
} from "./install";
import { processLauncher } from "./proc/launch";
import { runDaemon } from "./daemon/server";
import { tryRenderViaDaemon } from "./daemon/client";
import { daemonStatsPlan } from "./daemon/client-stats";
import { debugCommandPlan } from "./daemon/client-debug";
import { DEBUG_WHATS } from "./daemon/debug-types";
import { schemaPlan } from "./config/cli";
import { checkCommandPlan } from "./check";
import { runPlugin } from "./plugin-install";
import { obtainDaemonKick } from "./daemon/acquire";
import { planOutcome } from "./render/outcome-plan";
import { HELP_TEXT } from "./help-text";
import { attachCommandLine } from "./attach-launcher";
import fs from "node:fs";
import { LANES } from "./config/lanes";
import { NODE_FLAGS } from "./cli-flags";
import { PACKAGE_VERSION } from "./version";
import { detectClientHints } from "./client-hints";
import { nodeClientHint } from "./client-hint";
import { doctorCommandPlan } from "./doctor/cli";
import { runFrames } from "./frames-cli";
import { runBarPane } from "./bar-pane";
import { exitWith } from "./cli-plan";

// [LAW:one-source-of-truth] The bundle this process runs: the file this entry
// was loaded from, which Node's loader resolved through every link (an npm
// global bin is a symlink, and argv[1] keeps the link). It stages on install
// and names a Node client to the doctor.
const RUNNING_BUNDLE = fileURLToPath(import.meta.url);

const hasFlag = (flags: readonly string[]): boolean =>
  flags.some((f) => process.argv.includes(f));

function showHelpText(): void {
  console.log(HELP_TEXT);
  // The one line of help that names this install: where its preload sits.
  const preload = stableAttachPreload(RUNNING_BUNDLE);
  const missing = fs.existsSync(preload)
    ? ""
    : "  (nothing is there yet: run `cc-candybar install` first — in a checkout, `pnpm build`)\n";
  console.log(
    `Starting Claude Code on ${LANES.statusline.label} yourself (a Bun-compiled Claude Code):\n  ${attachCommandLine(preload, { dir: undefined, env: [], program: "claude", args: [] })}\n${missing}`,
  );
}

// [LAW:dataflow-not-control-flow] Subcommand dispatch is data: argv[2] names
// a handler. A one-shot handler (stats, the debug projections, check, doctor,
// schema, the render relay) folds its outcome into a plan and delivers it
// through the one exit (src/cli-plan.ts), in one shape:
// `exitWith(await <command>Plan(args))`. install and plugin print as they go
// and exit directly, which holds only while their whole output stays under
// one pipe buffer (64 KiB): past that, an exit drops the queued tail. The
// daemon, the stream and the pane own their own lifecycles. The
// stdin-driven render takes flags only (`--config`), so a positional argv[2]
// naming no handler is a mistake, refused rather than read as a render.
// `lint` is an alias of `check` — one config verdict, one pipeline, one
// exit-code contract (0/1/2) — and the debug projections join by DEBUG_WHATS,
// the subcommand name being the DebugWhat. The native client's own subcommands
// (rust-client/src/main.rs NATIVE_SUBCOMMANDS) never reach here, and
// scripts/check-protocol.mjs holds the two sets apart.
type Subcommand = (args: readonly string[]) => Promise<void>;
const SUBCOMMANDS: Readonly<Record<string, Subcommand>> = {
  install: async (args) => {
    await runInstall(args, RUNNING_BUNDLE, processLauncher);
    process.exit(0);
  },
  "install-url-handler": async () => {
    runInstallUrlHandler(RUNNING_BUNDLE, processLauncher);
    process.exit(0);
  },
  "url-handle": async (args) => {
    await runUrlHandle(args[0]);
  },
  // The daemon owns its own lifecycle.
  daemon: async () => {
    runDaemon();
  },
  "daemon-stats": async (args) => {
    await exitWith(await daemonStatsPlan(args));
  },
  // The stream owns its own lifecycle.
  frames: async () => {
    await runFrames(process.argv, RUNNING_BUNDLE);
  },
  check: async (args) => {
    await exitWith(await checkCommandPlan(args));
  },
  lint: async (args) => {
    await exitWith(await checkCommandPlan(args));
  },
  plugin: async (args) => {
    process.exit(runPlugin(args));
  },
  schema: async () => {
    await exitWith(schemaPlan());
  },
  // [LAW:single-enforcer] The doctor's CLI projection: the SAME check fold
  // the bar's 🩺 click runs, over this process's own environment (which IS
  // Claude Code's when run from a Claude Code shell).
  doctor: async (args) => {
    await exitWith(await doctorCommandPlan(args));
  },
  // Runs until the pane closes.
  "bar-pane": async (args) => {
    process.exit(await runBarPane(args));
  },
  ...Object.fromEntries(
    DEBUG_WHATS.map((what): [string, Subcommand] => [
      what,
      async (args) => {
        await exitWith(await debugCommandPlan(what, args));
      },
    ]),
  ),
};

async function main(): Promise<void> {
  const subcommand = process.argv[2];
  const named =
    subcommand !== undefined && !subcommand.startsWith("-") ? subcommand : null;
  try {
    // [LAW:no-silent-failure] Before the help flag, so `<typo> --help` names
    // the typo rather than printing help that does not mention it.
    if (named !== null && !Object.hasOwn(SUBCOMMANDS, named)) {
      console.error(
        `cc-candybar: unknown subcommand ${JSON.stringify(named)} — see --help`,
      );
      process.exit(2);
    }
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
    if (named !== null) {
      await SUBCOMMANDS[named]!(process.argv.slice(3));
      return;
    }

    if (process.stdin.isTTY === true) {
      console.error(`Error: This tool requires input from Claude Code

cc-candybar is designed to be used as a Claude Code statusLine command.
It reads hook data from stdin and outputs formatted statusline.

Add to ~/.claude/settings.json:
{
  "statusLine": {
    "type": "command",
    "command": "cc-candybar"
  }
}

Run with --help for more options.

To test output manually:
echo '{"session_id":"test-session","workspace":{"project_dir":"/path/to/project"},"model":{"id":"claude-sonnet-4-5","display_name":"Claude"}}' | cc-candybar`);
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
      // The wire's `args` shape (RenderRequest): the client's path, then its
      // flags — so not the node binary in front of them.
      process.argv.slice(1),
      process.cwd(),
      {
        ...detectClientHints(process.env, process.cwd(), process.stderr),
        client: nodeClientHint("node", RUNNING_BUNDLE),
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
    await exitWith({ stdout: plan.output, stderr: "", code: 0 });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // [LAW:no-silent-failure] Named for what was running: a subcommand whose
    // delivery failed (a full disk under `check`) is reported as that
    // subcommand, not as a statusline render. The report goes through the
    // same delivery, so it is waited for like any plan; a stream that refuses
    // this too rejects out of main, and Node's unhandled-rejection report is
    // the loud end.
    await exitWith({
      stdout: "",
      stderr: `cc-candybar ${named ?? "statusline"}: ${errorMessage}\n`,
      code: 1,
    });
  }
}

main();
