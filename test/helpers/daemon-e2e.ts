// [LAW:one-source-of-truth] The scaffolding every real-daemon end-to-end test
// needs: drive a render over the socket, find an affordance in the rendered
// bytes by WHAT IT DOES, dispatch it through the real click wire, and stop the
// daemon. Each e2e file used to carry its own copy, which meant the documented
// transient-retry contract below was restated once per file and could drift
// from the daemon's actual timeout behaviour in any one of them.
//
// [LAW:behavior-not-structure] `urlWriting` deliberately searches for the
// affordance by the effect it carries rather than by position, glyph, or
// constructed URL — so a test keeps passing when the bar is restyled and fails
// when the click stops doing what it claimed.

import path from "node:path";

import { PROTOCOL_VERSION } from "../../src/daemon/protocol";
import { parseHandlerUrl } from "../../src/install/index";
import { effectsOf } from "./click";
import { sendDaemonRequest, waitForExit } from "./daemon-wire";
import type { RunningDaemon } from "./spawn-isolated-daemon";

const REPLY_BUDGET_MS = 5000;

// [LAW:no-ambient-temporal-coupling] `TIMEOUT` (server.ts's REQUEST_TIMEOUT_MS
// — a real 200ms per-request guard protecting the daemon from one slow request
// blocking every other connection) is classified `transient` by the real client
// (client-transport.ts's interpretResponse): the daemon is up, just slow for
// this one request, and the documented recovery is retry, not fail. A cold
// first render for a brand-new (projectDir, cwd) — first git subprocess spawn,
// first config parse + template compile — can genuinely exceed 200ms on a
// loaded CI runner even though it's fast on a warm local machine. A real client
// shows a blank line and lets the next natural render tick retry; a test has no
// "next tick" to lean on, so it retries inline, bounded, matching the
// documented transient contract rather than treating an expected-occasionally
// condition as a hard failure.
const TIMEOUT_RETRY_BUDGET = 5;

// One status-line render, as Claude Code would ask for it.
export async function render(
  sockPath: string,
  sessionId: string,
  cwd: string,
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const resp = await sendDaemonRequest(
      sockPath,
      {
        v: PROTOCOL_VERSION,
        kind: "render",
        hookData: {
          hook_event_name: "Status",
          session_id: sessionId,
          transcript_path: path.join(cwd, "transcript.jsonl"),
          cwd,
          model: { id: "claude-opus-4-7", display_name: "Opus 4.7" },
          workspace: { current_dir: cwd, project_dir: cwd, added_dirs: [] },
        },
        args: [],
        cwd,
      },
      REPLY_BUDGET_MS,
    );
    if (!resp.ok) {
      if (resp.code === "TIMEOUT" && attempt < TIMEOUT_RETRY_BUDGET) continue;
      throw new Error(`render failed: ${resp.error} (${resp.code})`);
    }
    if (!("output" in resp)) {
      throw new Error(
        `render response carried no output: ${JSON.stringify(resp)}`,
      );
    }
    return resp.output;
  }
}

// A click, decoded the same way `cc-candybar url-handle` decodes it, then sent
// as the wire request the URL handler app sends.
export async function click(sockPath: string, url: string): Promise<void> {
  const { verb, value } = parseHandlerUrl(url);
  const resp = await sendDaemonRequest(
    sockPath,
    { v: PROTOCOL_VERSION, kind: "click", verb, value },
    REPLY_BUDGET_MS,
  );
  if (!resp.ok) {
    throw new Error(`click failed: ${resp.error} (${resp.code})`);
  }
}

export function extractUrls(rendered: string): string[] {
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\]8;;([^\x1b]+)\x1b\\/g;
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) urls.push(m[1]!);
  return urls;
}

// The affordance that writes `value` to `key`, as the user's own click would
// find it: by what it does, from the rendered bytes — never constructed.
export function urlWriting(
  rendered: string,
  key: string,
  value: string,
): string {
  const url = extractUrls(rendered).find((u) => {
    try {
      return effectsOf(u).some((e) => e.args[1] === key && e.args[2] === value);
    } catch {
      return false;
    }
  });
  if (url === undefined) {
    throw new Error(`no rendered affordance writes ${key}=${value}`);
  }
  return url;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;
export const stripAnsi = (s: string): string => s.replace(ANSI, "");

// Stop the daemon and wait for it to be gone.
//
// The default is SIGKILL, which is right for teardown — a test that is done
// does not care how the daemon dies, and SIGKILL cannot hang. It is the WRONG
// signal for a test that restarts the daemon and expects durable state to come
// back: SIGKILL bypasses server.ts's `shutdown()` funnel, and with it the
// `sessionState.flush()` that lands writes still inside FileSessionStorage's
// 500ms debounce. Pass "SIGTERM" to exercise the graceful path a real restart
// takes (a signal, the RSS backstop, or the parent watchdog — all three go
// through that one funnel).
export async function killAndWait(
  daemon: RunningDaemon,
  signal: NodeJS.Signals = "SIGKILL",
): Promise<void> {
  const exited = waitForExit(daemon.child);
  daemon.killTree(signal);
  await exited;
}
