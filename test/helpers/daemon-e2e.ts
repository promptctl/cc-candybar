// [LAW:one-source-of-truth] The one scaffolding every real-daemon e2e test shares.
// [LAW:behavior-not-structure] Find an affordance by the effect it carries, never by position, glyph, or a built URL.

import path from "node:path";

import { PROTOCOL_VERSION, type ClientHints } from "../../src/daemon/protocol";
import type { ClaudeHookData } from "../../src/utils/claude";
import { parseHandlerUrl } from "../../src/install/index";
import { effectsOf, type DecodedEffect } from "./click";
import { sendDaemonRequest, waitForExit } from "./daemon-wire";
import type { RunningDaemon } from "./spawn-isolated-daemon";

const REPLY_BUDGET_MS = 5000;

// [LAW:no-ambient-temporal-coupling] The daemon's 200ms per-request guard is classified `transient` by the real client — retry, not fail. A cold first render can exceed it on a loaded runner, and a test has no next tick to lean on.
const TIMEOUT_RETRY_BUDGET = 5;

export function hookData(sessionId: string, cwd: string): ClaudeHookData {
  return {
    hook_event_name: "Status",
    session_id: sessionId,
    transcript_path: path.join(cwd, "transcript.jsonl"),
    cwd,
    model: { id: "claude-opus-4-7", display_name: "Opus 4.7" },
    workspace: { current_dir: cwd, project_dir: cwd, added_dirs: [] },
  };
}

export async function render(
  sockPath: string,
  sessionId: string,
  cwd: string,
  hints: ClientHints = {},
  args: string[] = [],
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const resp = await sendDaemonRequest(
      sockPath,
      {
        v: PROTOCOL_VERSION,
        kind: "render",
        hookData: hookData(sessionId, cwd),
        args,
        cwd,
        ...hints,
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

// [LAW:no-ambient-temporal-coupling] A durable write lands through an fs WATCHER,
// so there is no happens-after signal to await; one post-click render would bet on watcher latency.
export async function renderUntil(
  sockPath: string,
  sessionId: string,
  projectDir: string,
  accepts: (rendered: string) => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  do {
    last = await render(sockPath, sessionId, projectDir);
    if (accepts(last)) return last;
  } while (Date.now() < deadline);
  throw new Error(
    `daemon never rendered ${what} within ${timeoutMs}ms; last render was:\n${last}`,
  );
}

// [LAW:single-enforcer] THE search over rendered affordances. A URL that fails to decode is not a candidate.
export function findUrl(
  urls: readonly string[],
  match: (effects: DecodedEffect[]) => boolean,
): string | undefined {
  return urls.find((u) => {
    try {
      return match(effectsOf(u));
    } catch {
      return false;
    }
  });
}

export function urlWriting(
  rendered: string,
  key: string,
  value: string,
): string {
  const url = findUrl(extractUrls(rendered), (effects) =>
    effects.some((e) => e.args[1] === key && e.args[2] === value),
  );
  if (url === undefined) {
    throw new Error(`no rendered affordance writes ${key}=${value}`);
  }
  return url;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;
export const stripAnsi = (s: string): string => s.replace(ANSI, "");

// SIGKILL is right for teardown but WRONG before a restart that expects durable state:
// it bypasses shutdown()'s sessionState.flush(). Pass "SIGTERM" for the graceful path.
export async function killAndWait(
  daemon: RunningDaemon,
  signal: NodeJS.Signals = "SIGKILL",
): Promise<void> {
  const exited = waitForExit(daemon.child);
  daemon.killTree(signal);
  await exited;
}
