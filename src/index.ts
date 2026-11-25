#!/usr/bin/env node

import type { ClaudeHookData } from "./utils/claude";

import process from "node:process";
import { fileURLToPath } from "node:url";
import { json } from "node:stream/consumers";
import { debug, setDebug } from "./utils/logger";
import {
  daemonWorld,
  machineReadings,
  processWorld,
  type Host,
  type World,
} from "./host";
import type { Timekeeper } from "./time";
import {
  runInstall,
  runInstallUrlHandler,
  runRecordHostBundle,
  runUrlHandle,
  stableAttachPreload,
} from "./install";
import { runDaemon } from "./daemon/server";
import { runRenderer } from "./renderer-process.js";
import { tryRenderViaDaemon } from "./daemon/client";
import { daemonStatsPlan } from "./daemon/client-stats";
import { debugCommandPlan } from "./daemon/client-debug";
import { DEBUG_WHATS } from "./daemon/foundations/debug-types";
import { schemaPlan } from "./config-cli";
import { sshConfigFacts, sshConfigPlan } from "./ssh-cli";
import { runPlugin } from "./plugin-install";
import { obtainDaemonKick } from "./daemon/acquire";
import { planAfterKick, planOutcome } from "./outcome-plan";
import { HELP_TEXT } from "./help-text";
import { attachCommandLine } from "./attach-launcher";
import fs from "node:fs";
import { LANES } from "./config/lanes";
import { NODE_FLAGS } from "./cli-flags";
import { PACKAGE_VERSION } from "./version";
import { terminalObservation } from "./client-hints";
import { nodeClientHint } from "./client-hint";
import { runFrames } from "./frames-cli";
import { runBarPane } from "./bar-pane";
import { exitWith } from "./cli-plan";
import { recordPlan, replayPlan } from "./recording-cli.js";
import { replayRecording } from "./renderer/replay.js";

// [LAW:one-source-of-truth] The bundle this process runs: the file this entry
// was loaded from, which Node's loader resolved through every link (an npm
// global bin is a symlink, and argv[1] keeps the link). It stages on install
// and names a Node client.
const RUNNING_BUNDLE = fileURLToPath(import.meta.url);

// [LAW:effects-at-boundaries] Commands that act on the machine assemble its
// world as they run and configure their debug channel from that environment.
function debugged<C extends Timekeeper>(world: World<C>): World<C> {
  setDebug(Boolean(world.host.env.CC_CANDYBAR_DEBUG));
  return world;
}
const commandWorld = (): World => debugged(processWorld());

const hasFlag = (flags: readonly string[]): boolean =>
  flags.some((f) => process.argv.includes(f));

function showHelpText(host: Host): void {
  console.log(HELP_TEXT);
  // The one line of help that names this install: where its preload sits.
  const preload = stableAttachPreload(RUNNING_BUNDLE, host);
  const missing = fs.existsSync(preload)
    ? ""
    : "  (nothing is there yet: run `cc-candybar install` first — in a checkout, `pnpm build`)\n";
  console.log(
    `Starting Claude Code on ${LANES.statusline.label} yourself (a Bun-compiled Claude Code):\n  ${attachCommandLine(preload, { dir: undefined, env: [], program: "claude", args: [] })}\n${missing}`,
  );
}

// [LAW:dataflow-not-control-flow] Subcommand dispatch is data: argv[2] names
// a handler. A one-shot handler (stats, the debug projections,
// schema, the render relay) folds its outcome into a plan and delivers it
// through the one exit (src/cli-plan.ts), in one shape:
// `exitWith(await <command>Plan(args))`. install and plugin print as they go
// and exit directly, which holds only while their whole output stays under
// one pipe buffer (64 KiB): past that, an exit drops the queued tail. The
// daemon, the stream and the pane own their own lifecycles. The
// stdin-driven render takes flags only (`--config`), so a positional argv[2]
// naming no handler is a mistake, refused rather than read as a render.
// The native client handles its own subcommands before dispatching here.
// scripts/check-protocol.mjs holds the two sets apart.
type Subcommand = (args: readonly string[]) => Promise<void>;
const SUBCOMMANDS: Readonly<Record<string, Subcommand>> = {
  install: async (args) => {
    await runInstall(args, RUNNING_BUNDLE, commandWorld());
    process.exit(0);
  },
  "record-host-bundle": async () => {
    runRecordHostBundle(RUNNING_BUNDLE, commandWorld());
    process.exit(0);
  },
  "install-url-handler": async () => {
    runInstallUrlHandler(RUNNING_BUNDLE, commandWorld());
    process.exit(0);
  },
  "ssh-config": async (args) => {
    await exitWith(sshConfigPlan(args, await sshConfigFacts(commandWorld())));
  },
  "url-handle": async (args) => {
    await runUrlHandle(args[0], commandWorld());
  },
  // The daemon owns its own lifecycle. What any of its tasks throws shows on
  // every bar; every other command's world ends on a throw.
  daemon: async () => {
    runDaemon(debugged(daemonWorld()));
  },
  // A renderer's own process, which its daemon starts and talks to over its
  // stdio; it ends when its stdin does.
  renderer: async () => {
    runRenderer(() => machineReadings.monotonic());
  },
  "daemon-stats": async (args) => {
    await exitWith(await daemonStatsPlan(commandWorld(), args));
  },
  record: async (args) => {
    await exitWith(await recordPlan(commandWorld(), process.cwd(), args));
  },
  replay: async (args) => {
    await exitWith(await replayPlan(args, replayRecording));
  },
  // The stream owns its own lifecycle.
  frames: async () => {
    await runFrames(process.argv, RUNNING_BUNDLE, commandWorld());
  },
  plugin: async (args) => {
    process.exit(runPlugin(args, commandWorld()));
  },
  schema: async () => {
    await exitWith(schemaPlan());
  },
  // Runs until the pane closes.
  "bar-pane": async (args) => {
    process.exit(await runBarPane(args, commandWorld()));
  },
  ...Object.fromEntries(
    DEBUG_WHATS.map((what): [string, Subcommand] => [
      what,
      async (args) => {
        await exitWith(await debugCommandPlan(commandWorld(), what, args));
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
      showHelpText(commandWorld().host);
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

    const world = commandWorld();
    const { host } = world;
    debug(`Working directory: ${process.cwd()}`);
    debug(`Process args:`, process.argv);

    const hookData = (await json(process.stdin)) as ClaudeHookData;
    debug(`Received hook data:`, JSON.stringify(hookData, null, 2));

    if (!hookData) {
      console.error("Error: No input data received from stdin");
      showHelpText(host);
      process.exit(1);
    }

    // [LAW:one-source-of-truth] The daemon chooses the session's renderer. The
    // statusline client forwards stdin to the daemon and prints its frame.
    // While the daemon is starting or a reply is overdue, the client can
    // report transport status without gathering or rendering session data.
    //
    // Terminal dimensions and client identity belong to this tick. The host
    // can derive the other hints from the environment it holds for the session.
    const outcome = await tryRenderViaDaemon(
      world,
      hookData,
      // The wire's `args` shape (RenderRequest): the client's path, then its
      // flags — so not the node binary in front of them.
      process.argv.slice(1),
      process.cwd(),
      {
        ...terminalObservation(host.env, process.stderr),
        client: nodeClientHint("node", RUNNING_BUNDLE),
      },
    );
    // [LAW:types-are-the-program] Three variants, one per outcome kind. The
    // "kick on every failure" pattern was the load-bearing half of the
    // 452-corpse spiral (kz8.5) — kicking on `permanent` failures keeps
    // respawning a daemon that will refuse the next request identically.
    // [LAW:dataflow-not-control-flow] planOutcome maps each variant to a
    // plan value (output, kick, debug); the kick runs when the plan asks, and
    // its outcome amends the plan before the side effects below run against
    // it in fixed order. Variability lives in the data.
    const asked = planOutcome(outcome, host.env.XDG_STATE_HOME);
    // [LAW:no-silent-failure] A kick the install's record refuses reaches the
    // bar: the frame is delivered after the kick's outcome is known.
    const plan = planAfterKick(
      asked,
      asked.kick ? obtainDaemonKick(world) : null,
    );
    if (plan.debug !== null) {
      debug(plan.debug);
    }
    await exitWith({ stdout: plan.output, stderr: "", code: 0 });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // [LAW:no-silent-failure] Named for what was running: a subcommand whose
    // delivery failed (for example, while writing a schema) is reported as that
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

await main();
