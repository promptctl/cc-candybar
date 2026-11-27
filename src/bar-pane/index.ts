import process from "node:process";
import {
  renderOutcomeOf,
  tryClickViaDaemon,
  tryPointerViaDaemon,
} from "../daemon/client";
import { describeFailure } from "../daemon/client-transport";
import { followPane } from "./follow.js";
import {
  INSTANCE,
  PANE_ID,
  parsePaneHello,
  type PanePlacement,
} from "../daemon/pane-subscription.js";
import { socketPath } from "../daemon/paths";
import { planOutcome } from "../outcome-plan";
import { detectTmuxHint } from "../tmux-hint";
import type { World } from "../host";
import { type Timekeeper } from "../time";
import { runTmuxAsync, type TmuxRun } from "../proc/tmux";
import { DRAWING, RESTORED, paint, paintedLines } from "./paint";
import { readMouse } from "./mouse";
import { reportPointer, type Followed } from "./report";
import { singleFlight } from "./single-flight";
import { touchOf } from "./hit-test";
import { deliveredWithMouse } from "./pointer";
import type { OwnerFacts } from "../daemon/foundations/protocol";
import type { HitMap } from "../render/hit-map";

const TMUX_PATIENCE_MS = 5000;
const USAGE = "usage: cc-candybar bar-pane <source pane> <managed instance>";
type TmuxMissed = Exclude<TmuxRun, { kind: "ok" }>;

// [LAW:one-type-per-behavior] How long one tmux call may go unanswered before
// the bar pane gives up: a loaded machine misses a call now and then, a tmux
// server that is gone misses them all. One per call the bar pane makes, so a
// call that keeps failing is not excused by another that answers. The time
// counts from the first miss of a run of misses, and a miss that comes more
// than the patience after the one before it starts a run of its own, so a call
// made rarely (a press) is held to neither the time since its last answer nor
// a miss from long ago.
export function tmuxPatience(
  clock: Pick<Timekeeper, "monotonic">,
): (run: { readonly kind: "ok" } | TmuxMissed) => void {
  let missingSince: number | null = null;
  let lastMiss = 0;
  return (run) => {
    if (run.kind === "ok") {
      missingSince = null;
      return;
    }
    const now = clock.monotonic();
    if (missingSince === null || now - lastMiss > TMUX_PATIENCE_MS)
      missingSince = now;
    lastMiss = now;
    if (now - missingSince > TMUX_PATIENCE_MS)
      throw new Error(
        `tmux has not answered for ${TMUX_PATIENCE_MS / 1000} s: ${run.reason}`,
      );
  };
}

export function parseArgs(argv: readonly string[]): {
  pane: string;
  instance: string;
} {
  const [pane, instance] = argv;
  if (
    argv.length !== 2 ||
    !pane ||
    !PANE_ID.test(pane) ||
    !instance ||
    !INSTANCE.test(instance)
  )
    throw new Error(USAGE);
  return { pane, instance };
}

// The subcommand's own exit code: its failures are the bar pane's, named as
// such, never the statusline's.
export async function runBarPane(
  argv: readonly string[],
  world: World,
): Promise<number> {
  try {
    await drawBarPane(argv, world);
    return 0;
  } catch (e) {
    process.stderr.write(`cc-candybar bar-pane: ${(e as Error).message}\n`);
    return 1;
  }
}

async function drawBarPane(
  argv: readonly string[],
  world: World,
): Promise<void> {
  const { pane, instance } = parseArgs(argv);
  const tmux = detectTmuxHint(world.host.env);
  if (tmux === null)
    throw new Error("cc-candybar bar-pane runs in a tmux pane");
  if (!process.stdout.isTTY || !process.stdin.isTTY)
    throw new Error(
      "cc-candybar bar-pane draws on, and reads the mouse from, its pane's terminal",
    );
  const serverPid = Number(world.host.env.TMUX?.split(",").at(-2));
  const hello = parsePaneHello({
    socket: tmux.socket,
    source: pane,
    drawing: tmux.pane,
    serverPid,
    followerPid: process.pid,
    instance,
  });
  if (!hello) throw new Error("invalid managed tmux pane identity");
  let placement: PanePlacement | null = null;

  process.stdout.write(DRAWING);
  // [LAW:effects-at-boundaries] The terminal's mouse reports are read raw and
  // put back with the rest of the terminal on every exit the pane traps.
  process.stdin.setRawMode(true);
  process.on("exit", () => {
    process.stdout.write(RESTORED);
    process.stdin.setRawMode(false);
  });
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

  let following: Followed | null = null;
  let frame: string | null = null;
  let hits: HitMap | null = null;
  let hover: string | null = null;
  const facts = (): OwnerFacts => ({
    id: placement!.owner,
    gestures: [...deliveredWithMouse(placement?.mouse ?? false)],
    hover,
  });
  // [LAW:no-ambient-temporal-coupling] One report at a time, of the facts and
  // the session as they stand when it is sent: changes that arrive while one is
  // in flight are the one report after it, so the host never ends on an older
  // one and a burst is not a queue of identical requests.
  const report = singleFlight(async () => {
    const owner = placement?.owner;
    await reportPointer(
      following,
      (sessionId, owned) => tryPointerViaDaemon(world, sessionId, owned),
      facts,
      (message) => {
        if (placement?.owner === owner && following?.wire.attached)
          fail(message);
      },
    );
  }, die);
  let status = "waiting for the managed pane subscription";
  const text = () => frame ?? status;
  const fail = (message: string): void => {
    frame = null;
    hits = null;
    status = "cc-candybar bar-pane: " + message;
    redraw();
  };

  // What the pane last painted. A resize disturbs the pane, and makes the next
  // draw paint the frame whole.
  let painted = "";
  const resizeAnswered = tmuxPatience(world.clock);
  // The pane's height follows the frame's, except while the bar pane is the
  // zoomed pane, which a resize would unzoom. The height compared is the
  // pane's own, so an unzoom or a hand resize is put right too.
  const drawOnce = async (): Promise<void> => {
    if (!placement?.shown) return;
    const next = paint(text());
    if (next.rows !== process.stdout.rows && !placement.zoomed)
      // Missed: the pane keeps its height, and the next draw asks again.
      resizeAnswered(
        await runTmuxAsync(world.launcher, tmux, "bar-pane.tmux", [
          "if-shell",
          "-F",
          "-t",
          tmux.pane,
          "#{==:#{window_zoomed_flag},0}",
          `resize-pane -t ${tmux.pane} -y ${next.rows}`,
        ]),
      );
    if (next.bytes !== painted) process.stdout.write(next.bytes);
    painted = next.bytes;
  };
  // [LAW:no-ambient-temporal-coupling] One draw at a time: a frame arriving
  // while one is drawn is drawn after it, the newest only, so no frame is
  // written over a newer one and no two resizes race.
  const redraw = singleFlight(drawOnce, die);
  process.stdout.on("resize", () => {
    painted = "";
    redraw();
  });

  // [LAW:no-ambient-temporal-coupling] One press at a time, in the order the
  // terminal reported them: each opens its link, then gives the keyboard back.
  // tmux's own mouse binding selected this pane before the press reached it, so
  // the user's next keystrokes would go to the bar and not Claude Code's prompt.
  // A press on a cell with no link returns it too.
  const focusAnswered = tmuxPatience(world.clock);
  let pressing: Promise<void> = Promise.resolve();
  const press = (link: string | undefined): void => {
    const owner = placement?.owner;
    pressing = pressing.then(async () => {
      if (owner !== placement?.owner) return;
      if (link !== undefined) {
        const sent = await tryClickViaDaemon(world, link);
        if (sent.kind !== "ok") fail(`click failed: ${describeFailure(sent)}`);
      }
      focusAnswered(
        await runTmuxAsync(world.launcher, tmux, "bar-pane.tmux", [
          "if-shell",
          "-F",
          "-t",
          tmux.pane,
          "#{pane_active}",
          `last-pane -t ${tmux.pane}`,
        ]),
      );
    });
    void pressing.catch(die);
  };
  let unread = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    // Raw mode takes the interrupt key from the terminal, so it ends the pane
    // here as it would anywhere else.
    if (chunk.includes("\x03")) process.exit(130);
    const read = readMouse(unread + chunk);
    unread = read.rest;
    if (!following?.wire.attached || !placement?.shown) return;
    for (const event of read.events) {
      const touch = touchOf(hits ?? [], process.stdout.rows, event);
      if (touch === null) continue;
      // [LAW:single-enforcer] Hover is where the pointer last was, whatever
      // moved it there: only a change of action is reported, so moving within
      // one costs nothing.
      if (touch.hover !== hover) {
        hover = touch.hover;
        report();
      }
      if (touch.press !== null) press(touch.press.link);
    }
  });

  await new Promise<void>((resolve) => {
    const stream = followPane(
      socketPath(world.host),
      hello,
      world.clock,
      ({ placement: next, frame: response }) => {
        const changed = placement?.session !== next.session;
        const pointerChanged =
          placement?.owner !== next.owner ||
          changed ||
          placement?.mouse !== next.mouse ||
          !following?.wire.attached;
        if (changed) {
          hits = null;
          frame = null;
          status = "waiting for pane " + pane + "'s bar";
        }
        if (!placement?.shown && next.shown) painted = "";
        placement = next;
        following = { sessionId: next.session, wire: { attached: next.shown } };
        if (pointerChanged) {
          hover = null;
          if (next.shown) report();
        }
        if (response) {
          const outcome = renderOutcomeOf(response);
          frame = planOutcome(outcome, world.host.env.XDG_STATE_HOME).output;
          hits =
            outcome.kind === "ok" && response.ok && "hits" in response
              ? (response.hits?.slice(0, paintedLines(frame).length) ?? null)
              : null;
        }
        redraw();
      },
      (reason) => {
        if (following) following.wire.attached = false;
        fail(reason);
      },
      (reason) => {
        stream.close();
        process.stderr.write("cc-candybar bar-pane: " + reason + "\n");
        process.stdin.pause();
        resolve();
      },
    );
  });
}
