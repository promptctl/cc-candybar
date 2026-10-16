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
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { tryRenderViaDaemon } from "../daemon/client";
import { obtainDaemonKick } from "../daemon/acquire";
import { planOutcome } from "../render/outcome-plan";
import { detectClientHints } from "../client-hints";
import { detectTmuxHint, type TmuxHint } from "../tmux-hint";
import { runTmuxAsync } from "../proc/tmux";
import { DRAWING, RESTORED, paint, type Paint } from "./paint";
import { readRecording, serverOf, type Recording } from "./recording";

const DEFAULT_FPS = 20;
// How stale the pane's visibility may be: a window switched to waits this long
// for its first frame, one switched away renders this long for nobody.
const PLACEMENT_EVERY_MS = 500;
// The recorder, where the bundle (dist/index.mjs) ships beside it.
const RECORDER = fileURLToPath(
  new URL("../scripts/bar-pane/record-statusline", import.meta.url),
);

interface Extent {
  readonly columns: number;
  readonly rows: number;
}

// Where the session's pane sits, as tmux says. `visible`: its window is the
// one shown in an attached session — a frame drawn anywhere else is seen by
// nobody (Brandon: "if we can find some way of not rendering terminals that
// aren't visible that would be great"). A zoomed neighbour still counts as
// visible; tmux does not say which panes a zoom hides. `extent`: the
// session's pane, whose size its statusline reports.
type Placement =
  | {
      readonly kind: "placed";
      readonly visible: boolean;
      readonly extent: Extent;
    }
  | { readonly kind: "gone" };

async function placementOf(tmux: TmuxHint, pane: string): Promise<Placement> {
  const run = await runTmuxAsync(tmux, "bar-pane.tmux", [
    "list-panes",
    "-a",
    "-f",
    `#{==:#{pane_id},${pane}}`,
    "-F",
    "#{session_attached} #{window_active} #{pane_width} #{pane_height}",
  ]);
  // [LAW:no-silent-failure] A tmux that did not answer is a fault, never a
  // pane that closed: only tmux's own answer — no such pane — ends the loop.
  if (run.kind !== "ok") throw new Error(run.reason);
  const line = run.stdout.trim();
  if (line === "") return { kind: "gone" };
  const [attached, active, columns, rows] = line.split(" ").map(Number);
  return {
    kind: "placed",
    visible: attached! > 0 && active === 1,
    extent: { columns: columns!, rows: rows! },
  };
}

// The text this pane shows for the recording it found, given the text it
// shows now.
async function frameOf(
  recording: Recording,
  pane: string,
  extent: Extent,
  shown: string,
): Promise<string> {
  if (recording.kind === "absent") {
    return `waiting for pane ${pane}'s statusline to record ${recording.path} (${RECORDER})`;
  }
  const { hookData, cwd, argv, env } = recording.invocation;
  // [LAW:one-source-of-truth] The statusline client's own request, replayed:
  // its argv (a `--config`), its cwd, and the hints detectClientHints derives
  // from its environment, with the extent its tty answers — the session's
  // pane. The daemon records a session's hints and render origin from every
  // render, so a request that differed from the statusline's would rewrite
  // them, and invalidate the session's state, on every frame of either.
  const outcome = await tryRenderViaDaemon(
    hookData,
    [...argv],
    cwd,
    detectClientHints(env, cwd, extent),
  );
  const plan = planOutcome(outcome);
  if (plan.kick) obtainDaemonKick();
  // A transient outcome is a daemon between processes, back within a frame
  // or two: the bar it drew stays rather than blanking and resizing the pane.
  return outcome.kind === "transient" ? shown : plan.output;
}

function parseArgs(argv: readonly string[]): { pane: string; fps: number } {
  const [pane, flag, value] = argv;
  const fps = flag === "--fps" ? Number(value) : DEFAULT_FPS;
  if (pane === undefined || !/^%\d+$/.test(pane) || !(fps > 0)) {
    throw new Error(
      "usage: cc-candybar bar-pane <claude-code-pane-id, e.g. %3> [--fps N]",
    );
  }
  return { pane, fps };
}

export async function runBarPane(argv: readonly string[]): Promise<void> {
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
  let frame = "";
  let shown: Paint = { bytes: "", rows: 0 };
  let placement = await placementOf(tmux, pane);
  let placedAt = performance.now();
  while (placement.kind === "placed") {
    const tickAt = performance.now();
    if (placement.visible) {
      frame = await frameOf(
        readRecording(server, pane),
        pane,
        placement.extent,
        frame,
      );
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
  process.stderr.write(`cc-candybar bar-pane: pane ${pane} closed\n`);
}
