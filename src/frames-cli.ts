// `cc-candybar frames`: one session's bar, as the daemon pushes it, for
// whatever draws it faster than Claude Code reruns a statusline — a patched
// Claude Code, a mod, a renderer outside Claude Code (epic
// candybar-animation-wbxz). Each frame is one line on stdout: the JSON of the
// response a render request is answered with, `{"ok":true,"output":"…"}`, or
// why the bar could not be drawn.
//
// `--lane <band|statusline|pane>` names the animation lane this stream serves
// (src/config/lanes.ts). While the session's toggle for it is off the daemon
// refuses the stream; this client says so once on stderr and asks again on its
// backoff, so turning the toggle on resumes the stream.
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
import {
  openFrameStream,
  type FrameStream,
  type StreamEnd,
} from "./daemon/client-frames";
import { describeFailure } from "./daemon/client-transport";
import { obtainDaemonKick } from "./daemon/acquire";
import { socketPath } from "./daemon/paths";
import { PROTOCOL_VERSION } from "./daemon/protocol";
import { detectClientHints } from "./client-hints";
import { nodeClientHint } from "./client-hint";
import { newestWins } from "./utils/newest-wins";
import { LANE_NAMES, parseLane } from "./config/lanes";

const RECONNECT_FIRST_MS = 250;
const RECONNECT_MAX_MS = 2000;

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
  let stream: FrameStream | null = null;
  let retryMs = RECONNECT_FIRST_MS;
  // The refusal last said, so a lane that stays off is said once, not on
  // every retry.
  let lastSaid: string | null = null;

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
    stream?.close();
    stream = openFrameStream(
      socketPath(),
      id,
      lane,
      (resp) => {
        // A drawn bar is a stream that works: the next failure starts the
        // backoff over.
        if (resp.ok) retryMs = RECONNECT_FIRST_MS;
        lastSaid = null;
        emit(`${JSON.stringify(resp)}\n`);
      },
      (end) => {
        if (end.kind === "closed-here") return;
        const next = afterStreamEnd(end);
        if (next.kind === "exit") {
          say(next.reason);
          process.exit(1);
        }
        if (next.reason !== lastSaid)
          say(`${next.reason}; reconnecting in ${retryMs}ms`);
        lastSaid = next.reason;
        if (next.kick) obtainDaemonKick();
        const wait = retryMs;
        retryMs = Math.min(RECONNECT_MAX_MS, retryMs * 2);
        setTimeout(() => {
          void (lastHook === null ? Promise.resolve() : forward(lastHook)).then(
            () => {
              if (sessionId === id) subscribe(id);
            },
          );
        }, wait);
      },
    );
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

// [LAW:effects-at-boundaries] What a stream the daemon ended calls for: a
// reconnect — kicking a daemon into existence when none answered, or when the
// one that answered speaks an older protocol (it exits on that answer so a
// respawn runs the newer build) — or, when the daemon speaks a newer protocol
// than this client, which it will do however often it is asked, the end of
// this client. A BAD_REQUEST is from a daemon too old to take subscribe (this
// client's own subscribe is well formed); it restarts itself on the new build.
export type AfterEnd =
  | {
      readonly kind: "reconnect";
      readonly reason: string;
      readonly kick: boolean;
    }
  | { readonly kind: "exit"; readonly reason: string };

export function afterStreamEnd(
  end: Exclude<StreamEnd, { kind: "closed-here" }>,
): AfterEnd {
  switch (end.kind) {
    case "failed":
      return {
        kind: "reconnect",
        reason: `stream failed (${end.error.message})`,
        kick: true,
      };
    case "closed-there":
      return {
        kind: "reconnect",
        reason: "daemon closed the stream",
        kick: false,
      };
    case "refused":
      // The lane's toggle is off: the same subscribe succeeds once it is on.
      if (end.resp.code === "SWITCHED_OFF")
        return { kind: "reconnect", reason: end.resp.error, kick: false };
      if (end.resp.code === "TIMEOUT")
        return {
          kind: "reconnect",
          reason: `the daemon was too busy to open the stream (${end.resp.error})`,
          kick: false,
        };
      if (end.resp.code === "BAD_REQUEST")
        return {
          kind: "reconnect",
          reason: `the daemon does not take subscribe (${end.resp.error}); it restarts on the new build`,
          kick: false,
        };
      if (
        end.resp.code === "VERSION_MISMATCH" &&
        end.resp.daemonV !== undefined &&
        end.resp.daemonV < PROTOCOL_VERSION
      )
        return {
          kind: "reconnect",
          reason: `the daemon is older than this client (${end.resp.error})`,
          kick: true,
        };
      return {
        kind: "exit",
        reason: `the daemon refused the stream: ${end.resp.code}: ${end.resp.error}`,
      };
  }
}
