// `cc-candybar frames`: one session's bar, as the daemon pushes it, for
// whatever draws it faster than Claude Code reruns a statusline (epic
// candybar-animation-wbxz). Each frame is one line on stdout: the JSON of the
// message the daemon sent for the lane — for the statusline and pane lanes the
// response a render request is answered with, `{"ok":true,"output":"…"}` or
// why the bar could not be drawn; for the band lane its rows of styled runs
// (src/daemon/lane-frames.ts).
//
// `--lane <lane>` names the animation lane this stream serves
// (src/config/lanes.ts). While the session's toggle for it is off the daemon
// refuses the stream with SWITCHED_OFF: that refusal is the stream's state, so
// it is written to stdout like a frame — once, until a frame replaces it — and
// the client asks again on its own (src/daemon/frame-follow.ts), so turning
// the toggle on resumes the stream. stderr carries only what went wrong.
//
// stdin carries Claude Code's statusline JSON, one object a line, each
// forwarded to the daemon as a render request (this client is then that
// session's statusline client), and its `session_id` names the session — a new
// one after /clear moves the stream to it. stdin closing ends the stream. A
// session's frames drawn from its own statusline client's data, named by id,
// are the native client's `follow` (rust-client/src/follow.rs).
//
// The stream outlives the daemon: one that restarts (a rebuild, the memory
// backstop) is reconnected, spawning it when none answers, and handed the
// last statusline JSON again so it has data to draw from.

import process from "node:process";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import type { ClaudeHookData } from "./utils/claude";
import { tryRenderViaDaemon } from "./daemon/client";
import { followFrames, type FrameFollower } from "./daemon/frame-follow";
import { describeFailure } from "./daemon/client-transport";
import { obtainDaemonKick } from "./daemon/acquire";
import { socketPath } from "./daemon/paths";
import { detectClientHints } from "./client-hints";
import { nodeClientHint } from "./client-hint";
import { newestWins } from "./utils/newest-wins";
import { LANE_NAMES, parseLane } from "./config/lanes";

// `bundle`: the bundle this process runs, as its entry names it.
// What a stream last said: nothing yet, a frame or the lane-off refusal on
// stdout, or a fault on stderr, by its reason.
export type Said =
  | { readonly kind: "none" }
  | { readonly kind: "frame" }
  | { readonly kind: "off" }
  | { readonly kind: "fault"; readonly reason: string };
type Event = Exclude<Said, { kind: "none" }>;

// [LAW:types-are-the-program] One value, what the stream last said, decides
// what is said next: every frame (each is new), and any other event that
// differs from the last thing said. So a state that persists across retries —
// the lane off, the same fault — is said once, and every change is said: a
// refusal after a fault is written again, so a reader that clears what stderr
// said at the next stdout line (the band) always gets that line.
export function worthSaying(last: Said, next: Event): boolean {
  if (next.kind === "frame" || next.kind !== last.kind) return true;
  return (
    next.kind === "fault" &&
    last.kind === "fault" &&
    next.reason !== last.reason
  );
}

export async function runFrames(
  argv: readonly string[],
  bundle: string,
): Promise<void> {
  // argv is the process's: [node, script, "frames", ...flags].
  const { values, tokens } = parseArgs({
    args: argv.slice(3),
    options: {
      config: { type: "string" },
      lane: { type: "string" },
    },
    strict: true,
    tokens: true,
  });
  // The render args a statusline client sends: the binary, then the flags
  // the daemon reads (--config), as the statusline command spells them.
  const renderArgs = [
    argv[1]!,
    ...tokens.flatMap((t) =>
      t.kind === "option" && t.name === "config" ? [t.rawName, t.value!] : [],
    ),
  ];
  const cwd = process.cwd();
  const say = (line: string): void => {
    process.stderr.write(`cc-candybar frames: ${line}\n`);
  };
  const lane = parseLane(values.lane);
  if (lane === null) {
    say(`--lane needs one of ${LANE_NAMES.join(", ")}`);
    process.exit(2);
  }
  // [LAW:no-silent-failure] A reader that went away is the end of the stream,
  // not an error to keep writing into.
  process.stdout.on("error", () => process.exit(0));
  // A reader slower than the frames gets the newest one when it is ready for
  // it, as a subscriber of the daemon does.
  const emit = newestWins(process.stdout);

  let sessionId: string | null = null;
  let lastHook: ClaudeHookData | null = null;
  let follower: FrameFollower | null = null;
  let said: Said = { kind: "none" };
  const tell = (next: Event, write: () => void): void => {
    if (worthSaying(said, next)) write();
    said = next;
  };

  // The session's data, to the daemon, whose feed draws the stream's next
  // frame from it. The reply is drawn for a request, never a frame, so it is
  // discarded and only a failure is said here.
  const forward = async (hook: ClaudeHookData): Promise<void> => {
    // The terminal as it is now: a resize between two statusline ticks is in
    // the next one.
    const hints = {
      ...detectClientHints(process.env, cwd, process.stderr),
      client: nodeClientHint("frames", bundle),
    };
    const outcome = await tryRenderViaDaemon(hook, renderArgs, cwd, hints);
    if (outcome.kind === "ok") return;
    say(describeFailure(outcome));
    if (outcome.kind === "transient") obtainDaemonKick();
  };

  const subscribe = (id: string): void => {
    follower?.close();
    follower = followFrames(socketPath(), id, lane, {
      frame: (resp) =>
        tell({ kind: "frame" }, () => emit(`${JSON.stringify(resp)}\n`)),
      off: (resp) =>
        tell({ kind: "off" }, () => emit(`${JSON.stringify(resp)}\n`)),
      fault: (reason, retryMs) =>
        tell({ kind: "fault", reason }, () =>
          say(`${reason}; reconnecting in ${retryMs}ms`),
        ),
      exit: (reason) => {
        say(reason);
        process.exit(1);
      },
      beforeReconnect: () =>
        lastHook === null ? Promise.resolve() : forward(lastHook),
    });
  };

  for await (const line of createInterface({ input: process.stdin })) {
    if (line.trim() === "") continue;
    let hook: ClaudeHookData;
    try {
      hook = JSON.parse(line) as ClaudeHookData;
    } catch (e) {
      say(`stdin line is not JSON: ${(e as Error).message}`);
      continue;
    }
    if (typeof hook.session_id !== "string" || hook.session_id === "") {
      say("stdin line carries no session_id");
      continue;
    }
    lastHook = hook;
    await forward(hook);
    if (hook.session_id !== sessionId) {
      sessionId = hook.session_id;
      subscribe(sessionId);
    }
  }
  process.exit(0);
}
