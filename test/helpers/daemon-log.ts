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

// A session's render events once it has at least `count`: a request a client
// retried is logged once per attempt, so a test asks for what it sent.
export async function renderLines(
  env: NodeJS.ProcessEnv,
  sessionId: string,
  count = 1,
): Promise<string[]> {
  const of = (lines: readonly string[]) =>
    lines.filter((l) => l.includes(`render sid=${sessionId} `));
  return of(
    await loggedWhen(
      env,
      (lines) => of(lines).length >= count,
      `${count} render event(s) for ${sessionId}`,
    ),
  );
}
