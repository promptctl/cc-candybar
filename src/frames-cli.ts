// `cc-candybar frames`: one session's bar, as the daemon pushes it, for
// whatever draws it faster than Claude Code reruns a statusline — a patched
// Claude Code, a mod, a renderer outside Claude Code (epic
// candybar-animation-wbxz). Each frame is one line on stdout: the JSON of the
// response a render request is answered with, `{"ok":true,"output":"…"}`, or
// why the bar could not be drawn.
//
// `--lane <band|statusline|pane>` names the animation lane this stream serves
// (src/config/lanes.ts). While the session's toggle for it is off the daemon
// refuses the stream with SWITCHED_OFF: that refusal is the stream's state, so
// it is written to stdout like a frame — once, until a frame replaces it — and
// the client asks again on its own (src/daemon/frame-follow.ts), so turning
// the toggle on resumes the stream. stderr carries only what went wrong.
//
// The session is named one of two ways, and that decides what stdin is:
//   --session <id>   stdin is not read; the frames are drawn from the data the
//                    session's own statusline client sends.
//   (otherwise)      stdin carries Claude Code's statusline JSON, one object a
//                    line, each forwarded to the daemon as a render request
//                    (this client is then that session's statusline client),
//                    and its `session_id` names the session — a new one after
//                    /clear moves the stream to it. stdin closing ends the
//                    stream.
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
export async function runFrames(
  argv: readonly string[],
  bundle: string,
): Promise<void> {
  // argv is the process's: [node, script, "frames", ...flags].
  const { values, tokens } = parseArgs({
    args: argv.slice(3),
    options: {
      session: { type: "string" },
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
  // [LAW:no-silent-failure] --config is a render arg, sent only with the data
  // this client forwards; under --session it forwards none.
  // [LAW:parse-dont-validate] The subscribe this client sends is well formed,
  // so a daemon that answers BAD_REQUEST is one that does not take subscribe.
  if (values.session === "") {
    say("--session needs a session id");
    process.exit(2);
  }
  const lane = parseLane(values.lane);
  if (lane === null) {
    say(`--lane needs one of ${LANE_NAMES.join(", ")}`);
    process.exit(2);
  }
  if (values.session !== undefined && values.config !== undefined) {
    say(
      "--config has no effect with --session: the session's own statusline client sends its config",
    );
    process.exit(2);
  }
  // [LAW:no-silent-failure] A reader that went away is the end of the stream,
  // not an error to keep writing into.
  process.stdout.on("error", () => process.exit(0));
  // A reader slower than the frames gets the newest one when it is ready for
  // it, as a subscriber of the daemon does.
  const emit = newestWins(process.stdout);

  let sessionId: string | null = values.session ?? null;
  let lastHook: ClaudeHookData | null = null;
  let follower: FrameFollower | null = null;
  // What was last written about a stream that is not flowing — the fault on
  // stderr, the lane-off refusal on stdout — so a state that persists is
  // written once, not on every retry. A frame clears both.
  let lastFault: string | null = null;
  let offShown = false;

  // The session's data, to the daemon. Its reply is the bar the stream
  // carries, so only a failure is said here.
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
      frame: (resp) => {
        lastFault = null;
        offShown = false;
        emit(`${JSON.stringify(resp)}\n`);
      },
      // The daemon answered: whatever outage came before is over, so the
      // next one is news even if it reads the same.
      off: (resp) => {
        lastFault = null;
        if (!offShown) emit(`${JSON.stringify(resp)}\n`);
        offShown = true;
      },
      fault: (reason, retryMs) => {
        if (reason !== lastFault)
          say(`${reason}; reconnecting in ${retryMs}ms`);
        lastFault = reason;
      },
      exit: (reason) => {
        say(reason);
        process.exit(1);
      },
      beforeReconnect: () =>
        lastHook === null ? Promise.resolve() : forward(lastHook),
    });
  };

  if (sessionId !== null) {
    subscribe(sessionId);
    return;
  }
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
