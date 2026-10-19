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
import { runTmuxAsync } from "../proc/tmux";
import { DRAWING, RESTORED, paint, type Paint } from "./paint";

// How stale the pane's placement and its session may be: a window switched to
// waits this long for its first frame, and a /clear this long for its new
// session's.
const TICK_MS = 500;
// How long tmux may go unanswered before the bar pane gives up: a loaded
// machine misses a call now and then, a tmux server that is gone misses them
// all.
const TMUX_PATIENCE_MS = 5000;
const USAGE = "usage: cc-candybar bar-pane <claude-code-pane-id, e.g. %3>";

// [LAW:types-are-the-program] Where the bar pane stands. `shown`: its window is
// the one shown in an attached session, and no zoom hides it — frames are seen
// where they are drawn, so a frame drawn while it is not is seen by nobody
// (Brandon: "if we can find some way of not rendering terminals that aren't
// visible that would be great"). `zoomed`: it is shown as the zoomed pane, which
// a resize would unzoom. `gone`: the session's pane has closed, and with it the
// bar this pane draws.
export type Placement =
  | { readonly kind: "shown"; readonly zoomed: boolean }
  | { readonly kind: "hidden" }
  | { readonly kind: "gone" };

export const PLACEMENT_FORMAT =
  "#{pane_id} #{session_attached} #{window_active} #{window_zoomed_flag} #{pane_active}";

// [LAW:effects-at-boundaries] Pure: tmux's answer for the session's pane and
// the bar pane (`own`), one line per session holding the pane's window — a
// window linked into several sessions, or a grouped session, lists its panes
// once in each.
export function placementFrom(
  stdout: string,
  pane: string,
  own: string,
): Placement {
  const lines = stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split(" "));
  if (!lines.some(([id]) => id === pane)) return { kind: "gone" };
  const seen = lines.find(
    ([id, attached, active, zoomed, paneActive]) =>
      id === own &&
      Number(attached) > 0 &&
      active === "1" &&
      (zoomed === "0" || paneActive === "1"),
  );
  return seen === undefined
    ? { kind: "hidden" }
    : { kind: "shown", zoomed: seen[3] === "1" };
}

function listPlacement(tmux: TmuxHint, pane: string) {
  return runTmuxAsync(tmux, "bar-pane.tmux", [
    "list-panes",
    "-a",
    "-f",
    `#{||:#{==:#{pane_id},${pane}},#{==:#{pane_id},${tmux.pane}}}`,
    "-F",
    PLACEMENT_FORMAT,
  ]);
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
  // [LAW:no-silent-failure] A pane id this tmux server does not have is a
  // mistake to say, not a pane that closed.
  const first = await listPlacement(tmux, pane);
  if (first.kind !== "ok") throw new Error(first.reason);
  let placement = placementFrom(first.stdout, pane, tmux.pane);
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

  // What the pane shows, and what it last painted. A resized pane no longer
  // holds what was painted: the next draw paints the frame whole.
  let text = `waiting for pane ${pane}'s bar`;
  let shown: Paint = { bytes: "", rows: 0 };
  process.stdout.on("resize", () => {
    shown = { ...shown, bytes: "" };
  });
  // The pane's height follows the frame's, except while the bar pane is the
  // zoomed pane, which a resize would unzoom.
  const draw = async (): Promise<void> => {
    if (placement.kind !== "shown") return;
    const next = paint(text);
    if (next.rows !== shown.rows && !placement.zoomed) {
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
  };
  const show = (next: string): void => {
    text = next;
    void draw().catch((e: unknown) => {
      process.stderr.write(`cc-candybar bar-pane: ${(e as Error).message}\n`);
      process.exit(1);
    });
  };

  // The session's frames while the bar pane is shown: one follower, for the
  // session tmux pane `pane` holds now. Hidden, it follows nothing, so the
  // daemon draws nothing for it.
  let following: { sessionId: string; follower: FrameFollower } | null = null;
  const follow = (sessionId: string | null): void => {
    if (following?.sessionId === sessionId) return;
    following?.follower.close();
    following =
      sessionId === null
        ? null
        : {
            sessionId,
            follower: followFrames(socketPath(), sessionId, "pane", {
              frame: (resp) => show(planOutcome(renderOutcomeOf(resp)).output),
              off: (resp) => show(resp.error),
              fault: (reason) => show(reason),
              exit: (reason) => {
                process.stderr.write(`cc-candybar bar-pane: ${reason}\n`);
                process.exit(1);
              },
            }),
          };
  };

  // [LAW:no-ambient-temporal-coupling] This loop is the one clock for where
  // the pane is and whose bar it shows; the frames arrive on their own.
  let tmuxAnsweredAt = Date.now();
  while (placement.kind !== "gone") {
    if (placement.kind === "hidden") {
      follow(null);
    } else {
      const found = await trySessionInPane(tmux.socket, pane);
      if (found.kind === "ok") {
        if (found.value === null) {
          follow(null);
          show(
            `waiting for pane ${pane}'s statusline to render on ${socketPath()}`,
          );
        } else {
          follow(found.value);
        }
      } else {
        if (found.kind === "transient") obtainDaemonKick();
        show(describeFailure(found));
      }
      await draw();
    }
    await sleep(TICK_MS);
    const listed = await listPlacement(tmux, pane);
    if (listed.kind === "ok") {
      tmuxAnsweredAt = Date.now();
      placement = placementFrom(listed.stdout, pane, tmux.pane);
    } else if (Date.now() - tmuxAnsweredAt > TMUX_PATIENCE_MS) {
      throw new Error(`tmux has not answered for 5 s: ${listed.reason}`);
    }
  }
  follow(null);
  process.stderr.write(`cc-candybar bar-pane: pane ${pane} closed\n`);
}
