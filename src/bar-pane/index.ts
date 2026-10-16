// `cc-candybar bar-pane <pane>`: the bar of the Claude Code session in tmux
// pane <pane>, redrawn in the pane this runs in, as often as it moves.
//
// Claude Code reruns its statusline once a second at best, so an effect or a
// menu opened by a click moves at that rate there. Here the frame rate is the
// loop's own (epic candybar-animation-wbxz.oy3). The frames are the
// statusline's — the same render request, the same daemon, the same
// `planOutcome` — written to a pane, where the terminal draws their links as
// it does the statusline's, so a click works the same.

import process from "node:process";
import { parseArgs as parseCliArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { tryRenderViaDaemon } from "../daemon/client";
import { obtainDaemonKick } from "../daemon/acquire";
import { planOutcome } from "../render/outcome-plan";
import { detectClientHints } from "../client-hints";
import { detectTmuxHint, type TmuxHint } from "../tmux-hint";
import { runTmuxAsync } from "../proc/tmux";
import { socketPath } from "../daemon/paths";
import { DRAWING, RESTORED, paint, type Paint } from "./paint";
import {
  readRecording,
  removeRecording,
  serverOf,
  type Recording,
} from "./recording";

const DEFAULT_FPS = 20;
// How stale the pane's visibility may be: a window switched to waits this long
// for its first frame, one switched away renders this long for nobody.
const PLACEMENT_EVERY_MS = 500;
const USAGE =
  "usage: cc-candybar bar-pane <claude-code-pane-id, e.g. %3> [--fps N]";

// `shown`: the bar pane's own window is the one shown in an attached session.
// Frames are seen where they are drawn, so a frame drawn while it is not is
// seen by nobody (Brandon: "if we can find some way of not rendering terminals
// that aren't visible that would be great"). A zoomed neighbour still counts
// as shown; tmux does not say which panes a zoom hides. `gone`: the session's
// pane has closed, and with it the bar this pane draws.
type Placement = "shown" | "hidden" | "gone";

async function placementOf(tmux: TmuxHint, pane: string): Promise<Placement> {
  const run = await runTmuxAsync(tmux, "bar-pane.tmux", [
    "list-panes",
    "-a",
    "-f",
    `#{||:#{==:#{pane_id},${pane}},#{==:#{pane_id},${tmux.pane}}}`,
    "-F",
    "#{pane_id} #{session_attached} #{window_active}",
  ]);
  // [LAW:no-silent-failure] A tmux that did not answer is a fault, never a
  // pane that closed: only tmux's own answer — no such pane — ends the loop.
  if (run.kind !== "ok") throw new Error(run.reason);
  // One line per session holding the pane's window: a window linked into
  // several sessions, or a grouped session, lists its panes once in each.
  const lines = run.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split(" "));
  if (!lines.some(([id]) => id === pane)) return "gone";
  return lines.some(
    ([id, attached, active]) =>
      id === tmux.pane && Number(attached) > 0 && active === "1",
  )
    ? "shown"
    : "hidden";
}

// What this pane shows before the daemon has answered once.
const FIRST_FRAME = "cc-candybar bar-pane: waiting for the daemon";

// The text this pane shows for the recording it found, given the text it
// shows now, and whether the daemon wants a kick.
async function frameOf(
  recording: Recording,
  pane: string,
  shown: string,
): Promise<{ readonly text: string; readonly kick: boolean }> {
  if (recording.kind === "absent") {
    return {
      text: [
        `waiting for pane ${pane}'s statusline to record`,
        recording.path,
        "(the cc-candybar package's scripts/bar-pane/record-statusline,",
        "in front of that session's statusline command)",
      ].join("\n"),
      kick: false,
    };
  }
  const { hookData, cwd, tty, argv, env } = recording.invocation;
  // [LAW:one-source-of-truth] The statusline client's own request, replayed:
  // its argv (a `--config`), its cwd, and the hints detectClientHints derives
  // from its environment and the terminal on its stderr. The daemon records a
  // session's hints and render origin from every render, so a request that
  // differed from the statusline's would rewrite them, and invalidate the
  // session's state, on every frame of either. The daemon it goes to is this
  // process's, so it must be the statusline's.
  if (socketPath(env) !== socketPath()) {
    throw new Error(
      `pane ${pane}'s statusline renders on ${socketPath(env)} and this bar pane on ${socketPath()}: run it with that session's CC_CANDYBAR_SOCKET`,
    );
  }
  const outcome = await tryRenderViaDaemon(
    hookData,
    [...argv],
    cwd,
    detectClientHints(env, cwd, tty),
  );
  const plan = planOutcome(outcome);
  // A transient outcome is a daemon between processes, back within a frame
  // or two: the bar it drew stays rather than blanking and resizing the pane.
  return {
    text: outcome.kind === "transient" ? shown : plan.output,
    kick: plan.kick,
  };
}

function parseArgs(argv: readonly string[]): { pane: string; fps: number } {
  // Strict: an unknown flag is refused, never run past at the default rate.
  const { values, positionals } = (() => {
    try {
      return parseCliArgs({
        args: [...argv],
        options: { fps: { type: "string" } },
        allowPositionals: true,
      });
    } catch (e) {
      throw new Error(`${(e as Error).message}\n${USAGE}`);
    }
  })();
  const [pane, ...extra] = positionals;
  const fps = values.fps === undefined ? DEFAULT_FPS : Number(values.fps);
  if (
    pane === undefined ||
    extra.length > 0 ||
    !/^%\d+$/.test(pane) ||
    !(fps > 0)
  ) {
    throw new Error(USAGE);
  }
  return { pane, fps };
}

// The subcommand's own exit code: its failures are the bar pane's, named as
// such, never the statusline's.
export async function runBarPane(argv: readonly string[]): Promise<number> {
  try {
    await drawBarPane(argv);
    return 0;
  } catch (e) {
    process.stderr.write(`cc-candybar bar-pane: ${(e as Error).message}\n`);
    return 1;
  }
}

async function drawBarPane(argv: readonly string[]): Promise<void> {
  const { pane, fps } = parseArgs(argv);
  const tmux = detectTmuxHint(process.env);
  if (tmux === null)
    throw new Error("cc-candybar bar-pane runs in a tmux pane");
  // The same server's run as the pane it draws beside: detectTmuxHint found
  // `$TMUX` set.
  const server = serverOf(process.env.TMUX!);
  const periodMs = 1000 / fps;
  process.stdout.write(DRAWING);
  process.on("exit", () => process.stdout.write(RESTORED));
  // Node runs no exit listener when a signal ends it; exiting from the
  // signal's handler does.
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const) {
    process.once(signal, () => process.exit(code));
  }

  // [LAW:no-ambient-temporal-coupling] This loop is the one clock: each tick
  // renders, paints, then sleeps out the rest of its period, so a slow frame
  // delays the next rather than piling up behind it.
  let frame = FIRST_FRAME;
  let shown: Paint = { bytes: "", rows: 0 };
  // A resized pane no longer holds what was painted: the next tick paints
  // the frame whole, changed or not.
  process.stdout.on("resize", () => {
    shown = { ...shown, bytes: "" };
  });
  let placement = await placementOf(tmux, pane);
  let placedAt = performance.now();
  while (placement !== "gone") {
    const tickAt = performance.now();
    if (placement === "shown") {
      const { text, kick } = await frameOf(
        readRecording(server, pane),
        pane,
        frame,
      );
      frame = text;
      if (kick) {
        // The kick reports on stderr, this pane's terminal, over the frame
        // shown: the frame is painted whole below.
        obtainDaemonKick();
        shown = { ...shown, bytes: "" };
      }
      const next = paint(frame);
      if (next.rows !== shown.rows) {
        const resized = await runTmuxAsync(tmux, "bar-pane.tmux", [
          "resize-pane",
          "-t",
          tmux.pane,
          "-y",
          String(next.rows),
        ]);
        if (resized.kind !== "ok") throw new Error(resized.reason);
      }
      if (next.bytes !== shown.bytes) process.stdout.write(next.bytes);
      shown = next;
    }
    if (tickAt - placedAt >= PLACEMENT_EVERY_MS) {
      placement = await placementOf(tmux, pane);
      placedAt = tickAt;
    }
    await sleep(Math.max(0, periodMs - (performance.now() - tickAt)));
  }
  // The record holds the session's environment: it ends with the session.
  removeRecording(server, pane);
  process.stderr.write(`cc-candybar bar-pane: pane ${pane} closed\n`);
}
