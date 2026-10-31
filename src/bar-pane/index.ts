// `cc-candybar bar-pane <pane>`: the bar of the Claude Code session in tmux
// pane <pane>, drawn in the pane this runs in as the daemon pushes it — lane C
// of the animation epic (candybar-animation-wbxz.oy3), behind its toggle,
// `🧪 tmux pane (C)` (src/config/lanes.ts).
//
// Claude Code reruns its statusline once a second at best, so an effect or a
// menu opened by a click moves at that rate there. Here the frames are the
// daemon's push (src/daemon/frame-feed.ts): the statusline's own render of the
// session's own data, sent the moment it changes, through the same
// `planOutcome` the statusline prints with. They are written to a pane, where
// the terminal draws their links as it does the statusline's, so a click works
// the same.

import process from "node:process";
import { parseArgs as parseCliArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { renderOutcomeOf, trySessionInPane } from "../daemon/client";
import { describeFailure } from "../daemon/client-transport";
import { followFrames, type FrameFollower } from "../daemon/frame-follow";
import { obtainDaemonKick } from "../daemon/acquire";
import { socketPath } from "../daemon/paths";
import { planOutcome } from "../render/outcome-plan";
import { detectTmuxHint, type TmuxHint } from "../tmux-hint";
import { processLauncher } from "../proc/launch";
import { runTmuxAsync, type TmuxRun } from "../proc/tmux";
import {
  LIST_CLIENTS_FORMAT,
  LIST_PANES_FORMAT,
  controlledSessions,
  shownPanes,
} from "../daemon/pane-visibility";
import { DRAWING, RESTORED, paint } from "./paint";

// How stale the pane's placement and its session may be: a window switched to
// waits this long for its first frame, and a /clear this long for its new
// session's.
const TICK_MS = 500;
// How long a tmux call may go unanswered (tmuxPatience).
const TMUX_PATIENCE_MS = 5000;
const USAGE = "usage: cc-candybar bar-pane <claude-code-pane-id, e.g. %3>";

// [LAW:types-are-the-program] Where the bar pane stands. `shown`: a client
// shows it — frames are seen where they are drawn, so a frame drawn while it is
// not is seen by nobody (Brandon: "if we can find some way of not rendering
// terminals that aren't visible that would be great"). `zoomed`: it is shown as
// the zoomed pane, which a resize would unzoom. `gone`: the session's pane has
// closed, and with it the bar this pane draws.
export type Placement =
  | { readonly kind: "shown"; readonly zoomed: boolean }
  | { readonly kind: "hidden" }
  | { readonly kind: "gone" };

// [LAW:one-source-of-truth] Whether the bar pane is shown is the daemon's own
// rule for a session's pane (src/daemon/pane-visibility.ts), over tmux's answers
// in its formats: `list-panes` for the session's pane and the bar pane (`own`),
// one line per session holding the pane's window, and `list-clients`.
// [LAW:effects-at-boundaries] Pure.
export function placementFrom(
  listPanes: string,
  listClients: string,
  pane: string,
  own: string,
): Placement {
  const lines = listPanes.split("\n").map((line) => line.trim().split(" "));
  if (!lines.some(([id]) => id === pane)) return { kind: "gone" };
  if (!shownPanes(listPanes, controlledSessions(listClients)).has(own))
    return { kind: "hidden" };
  return {
    kind: "shown",
    zoomed: lines.some(([id, , , , zoomed]) => id === own && zoomed === "1"),
  };
}

type TmuxMissed = Exclude<TmuxRun, { kind: "ok" }>;

async function askPlacement(
  tmux: TmuxHint,
  pane: string,
): Promise<
  { readonly kind: "ok"; readonly placement: Placement } | TmuxMissed
> {
  const [panes, clients] = await Promise.all([
    runTmuxAsync(processLauncher, tmux, "bar-pane.tmux", [
      "list-panes",
      "-a",
      "-f",
      `#{||:#{==:#{pane_id},${pane}},#{==:#{pane_id},${tmux.pane}}}`,
      "-F",
      LIST_PANES_FORMAT,
    ]),
    runTmuxAsync(processLauncher, tmux, "bar-pane.tmux", [
      "list-clients",
      "-F",
      LIST_CLIENTS_FORMAT,
    ]),
  ]);
  if (panes.kind !== "ok") return panes;
  if (clients.kind !== "ok") return clients;
  return {
    kind: "ok",
    placement: placementFrom(panes.stdout, clients.stdout, pane, tmux.pane),
  };
}

// [LAW:one-type-per-behavior] How long one tmux call may go unanswered before
// the bar pane gives up: a loaded machine misses a call now and then, a tmux
// server that is gone misses them all. One per call the bar pane makes, so a
// call that keeps failing is not excused by another that answers.
function tmuxPatience(): (run: { readonly kind: "ok" } | TmuxMissed) => void {
  let answeredAt = Date.now();
  return (run) => {
    if (run.kind === "ok") answeredAt = Date.now();
    else if (Date.now() - answeredAt > TMUX_PATIENCE_MS)
      throw new Error(
        `tmux has not answered for ${TMUX_PATIENCE_MS / 1000} s: ${run.reason}`,
      );
  };
}

export function parseArgs(argv: readonly string[]): { pane: string } {
  // Strict: an unknown flag is refused, never run past.
  const { positionals } = (() => {
    try {
      return parseCliArgs({ args: [...argv], allowPositionals: true });
    } catch (e) {
      throw new Error(`${(e as Error).message}\n${USAGE}`);
    }
  })();
  const [pane, ...extra] = positionals;
  if (pane === undefined || extra.length > 0 || !/^%\d+$/.test(pane))
    throw new Error(USAGE);
  return { pane };
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
  const { pane } = parseArgs(argv);
  const tmux = detectTmuxHint(process.env);
  if (tmux === null)
    throw new Error("cc-candybar bar-pane runs in a tmux pane");
  if (!process.stdout.isTTY)
    throw new Error("cc-candybar bar-pane draws on its pane's terminal");
  // [LAW:no-silent-failure] A pane id this tmux server does not have is a
  // mistake to say, not a pane that closed.
  const first = await askPlacement(tmux, pane);
  if (first.kind !== "ok") throw new Error(first.reason);
  let placement = first.placement;
  if (placement.kind === "gone")
    throw new Error(`no pane ${pane} on this tmux server (${tmux.socket})`);

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
  const die = (e: unknown): never => {
    process.stderr.write(`cc-candybar bar-pane: ${(e as Error).message}\n`);
    process.exit(1);
  };

  // The session's frames while the bar pane is shown: one follower, for the
  // session tmux pane `pane` holds now, and the last thing it said. Hidden, it
  // follows nothing, so the daemon draws nothing for it.
  let following: {
    readonly sessionId: string;
    readonly said: { latest: string | null };
    readonly follower: FrameFollower;
  } | null = null;
  // What the loop last learned of the pane's session, shown until its follower
  // says something.
  let status = `waiting for pane ${pane}'s bar`;
  // [LAW:one-source-of-truth] What the pane shows is derived, never set: a
  // lookup that fails beside a live follower cannot cover its frames.
  const text = (): string => following?.said.latest ?? status;

  // What the pane last painted. Anything that disturbs the pane — a resize, a
  // line written to its stderr — makes the next draw paint the frame whole.
  let painted = "";
  const resizeAnswered = tmuxPatience();
  // The pane's height follows the frame's, except while the bar pane is the
  // zoomed pane, which a resize would unzoom. The height compared is the
  // pane's own, so an unzoom or a hand resize is put right too.
  const drawOnce = async (): Promise<void> => {
    if (placement.kind !== "shown") return;
    const next = paint(text());
    if (next.rows !== process.stdout.rows && !placement.zoomed)
      // Missed: the pane keeps its height, and the next draw asks again.
      resizeAnswered(
        await runTmuxAsync(processLauncher, tmux, "bar-pane.tmux", [
          "resize-pane",
          "-t",
          tmux.pane,
          "-y",
          String(next.rows),
        ]),
      );
    if (next.bytes !== painted) process.stdout.write(next.bytes);
    painted = next.bytes;
  };
  // [LAW:no-ambient-temporal-coupling] One draw at a time: a frame arriving
  // while one is drawn is drawn after it, the newest only, so no frame is
  // written over a newer one and no two resizes race.
  let drawing: Promise<void> | null = null;
  let stale = false;
  const redraw = (): void => {
    stale = true;
    drawing ??= (async () => {
      try {
        while (stale) {
          stale = false;
          await drawOnce();
        }
      } finally {
        drawing = null;
      }
    })();
    void drawing.catch(die);
  };
  process.stdout.on("resize", () => {
    painted = "";
    redraw();
  });

  const follow = (sessionId: string | null): void => {
    if (following?.sessionId === sessionId) return;
    following?.follower.close();
    if (sessionId === null) {
      following = null;
      return;
    }
    const said: { latest: string | null } = { latest: null };
    const say = (line: string): void => {
      said.latest = line;
      redraw();
    };
    following = {
      sessionId,
      said,
      follower: followFrames(socketPath(), sessionId, "pane", {
        frame: (resp) => say(planOutcome(renderOutcomeOf(resp)).output),
        off: (resp) => say(resp.error),
        fault: say,
        exit: (reason) => die(new Error(reason)),
      }),
    };
  };

  // [LAW:no-ambient-temporal-coupling] This loop is the one clock for where
  // the pane is and whose bar it shows; the frames arrive on their own.
  const placementAnswered = tmuxPatience();
  while (placement.kind !== "gone") {
    if (placement.kind === "hidden") {
      follow(null);
    } else {
      const found = await trySessionInPane(tmux.socket, pane);
      if (found.kind === "ok") {
        follow(found.value);
        status =
          found.value === null
            ? `waiting for pane ${pane}'s statusline to render on ${socketPath()}`
            : `waiting for pane ${pane}'s bar`;
      } else {
        if (found.kind === "transient") {
          obtainDaemonKick();
          // The kick may say why on stderr, which is this pane.
          painted = "";
        }
        status = describeFailure(found);
      }
    }
    redraw();
    await sleep(TICK_MS);
    const asked = await askPlacement(tmux, pane);
    placementAnswered(asked);
    if (asked.kind === "ok") placement = asked.placement;
  }
  follow(null);
  process.stderr.write(`cc-candybar bar-pane: pane ${pane} closed\n`);
}
