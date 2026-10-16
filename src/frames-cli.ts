// `cc-candybar frames`: one session's bar, as the daemon pushes it, for
// whatever draws it faster than Claude Code reruns a statusline — a patched
// Claude Code, a mod, a renderer outside Claude Code (epic
// candybar-animation-wbxz). Each frame is one line on stdout: the JSON of the
// response a render request is answered with, `{"ok":true,"output":"…"}`, or
// why the bar could not be drawn.
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
import { openFrameStream, type FrameStream } from "./daemon/client-frames";
import { describeFailure } from "./daemon/client-transport";
import { obtainDaemonKick } from "./daemon/acquire";
import { socketPath } from "./daemon/paths";
import { detectClientHints } from "./client-hints";

const RECONNECT_FIRST_MS = 250;
const RECONNECT_MAX_MS = 2000;

export async function runFrames(argv: readonly string[]): Promise<void> {
  // argv is the process's: [node, script, "frames", ...flags].
  const { values, tokens } = parseArgs({
    args: argv.slice(3),
    options: { session: { type: "string" }, config: { type: "string" } },
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
  const hints = detectClientHints(process.env, cwd, process.stderr);
  const say = (line: string): void => {
    process.stderr.write(`cc-candybar frames: ${line}\n`);
  };
  // [LAW:no-silent-failure] A reader that went away is the end of the stream,
  // not an error to keep writing into.
  process.stdout.on("error", () => process.exit(0));

  let sessionId: string | null = values.session ?? null;
  let lastHook: ClaudeHookData | null = null;
  let stream: FrameStream | null = null;
  let retryMs = RECONNECT_FIRST_MS;

  // The session's data, to the daemon. Its reply is the bar the stream
  // carries, so only a failure is said here.
  const forward = async (hook: ClaudeHookData): Promise<void> => {
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
      (resp) => {
        retryMs = RECONNECT_FIRST_MS;
        process.stdout.write(`${JSON.stringify(resp)}\n`);
      },
      (end) => {
        if (end.kind === "closed-here") return;
        say(
          end.kind === "failed"
            ? `stream failed (${end.error.message}); reconnecting in ${retryMs}ms`
            : `daemon closed the stream; reconnecting in ${retryMs}ms`,
        );
        if (end.kind === "failed") obtainDaemonKick();
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
    lastHook = hook;
    await forward(hook);
    if (hook.session_id !== sessionId) {
      sessionId = hook.session_id;
      subscribe(sessionId);
    }
  }
  process.exit(0);
}
