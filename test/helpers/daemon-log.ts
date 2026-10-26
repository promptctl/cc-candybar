import { readFileSync } from "node:fs";

import { logPath } from "../../src/daemon/paths";
import { until } from "./until";

// [LAW:no-ambient-temporal-coupling] The daemon writes its log off the event
// loop (src/daemon/log.ts), so a line a request logged can land just after the
// request is answered. A test reads the log once the lines it waits for are
// there, never once.
export function logLines(env: NodeJS.ProcessEnv): string[] {
  return readFileSync(logPath(env), "utf8").split("\n");
}

// The log's lines once `holds` is true of them.
export async function loggedWhen(
  env: NodeJS.ProcessEnv,
  holds: (lines: readonly string[]) => boolean,
  what: string,
): Promise<string[]> {
  let lines: string[] = [];
  await until(() => holds((lines = logLines(env))), what);
  return lines;
}

// The render events of the replies a session's client read, once there are
// `count`: a request the client retried after a timeout is logged once per
// attempt, and the attempt it read is the one not timed out.
export async function renderLines(
  env: NodeJS.ProcessEnv,
  sessionId: string,
  count = 1,
): Promise<string[]> {
  const read = (lines: readonly string[]) =>
    lines.filter(
      (l) => l.includes(`render sid=${sessionId} `) && l.includes(" timedOut=N "),
    );
  return read(
    await loggedWhen(
      env,
      (lines) => read(lines).length >= count,
      `${count} answered render event(s) for ${sessionId}`,
    ),
  );
}
