import { logLines as linesOf } from "../../src/daemon/log";
import { logPath } from "../../src/daemon/paths";
import { until } from "./until";

// [LAW:no-ambient-temporal-coupling] The daemon writes its log off the event
// loop (src/daemon/log.ts), so a line a request logged can land just after the
// request is answered. A test reads the log once the lines it waits for are
// there, never once.
export function logLines(env: NodeJS.ProcessEnv): string[] {
  return linesOf(logPath(env));
}

// The whole log once `holds` is true of it: for a condition over the log
// entire. A wait on particular lines is loggedLines, whose failure names them.
export async function loggedWhen(
  env: NodeJS.ProcessEnv,
  holds: (lines: readonly string[]) => boolean,
  what: string,
): Promise<string[]> {
  let lines: string[] = [];
  await until(() => holds((lines = logLines(env))), what);
  return lines;
}

// The lines `pick` draws from the log, once `holds` is true of them. A wait
// that fails names the picked lines that did land, so a failure on a runner
// nobody can log into says which events were there. [LAW:no-silent-failure]
export async function loggedLines(
  env: NodeJS.ProcessEnv,
  pick: (lines: readonly string[]) => string[],
  holds: (picked: readonly string[]) => boolean,
  what: string,
): Promise<string[]> {
  let picked: string[] = [];
  try {
    await until(() => holds((picked = pick(logLines(env)))), what);
  } catch (e) {
    throw new Error(
      `${e instanceof Error ? e.message : String(e)}; the lines picked:\n${picked.join("\n")}`,
      { cause: e },
    );
  }
  return picked;
}

// A session's render events, every attempt in log order.
export const renderEventsOf = (
  lines: readonly string[],
  sessionId: string,
): string[] => lines.filter((l) => l.includes(`] render sid=${sessionId} `));

// [LAW:one-source-of-truth] A render event whose reply its client read: an
// attempt the client gave up on is logged too, so a count of a session's
// answers counts these, never every event.
export const answeredRender = (line: string): boolean =>
  line.includes(" timedOut=N ");

// A session's render events, every attempt in log order, once `count` replies
// its client read are among them: a request the client retried after a
// timeout is logged once per attempt, and the attempt it read is the one not
// timed out.
export async function renderLines(
  env: NodeJS.ProcessEnv,
  sessionId: string,
  count = 1,
): Promise<string[]> {
  return loggedLines(
    env,
    (lines) => renderEventsOf(lines, sessionId),
    (events) => events.filter(answeredRender).length >= count,
    `${count} answered render event(s) for ${sessionId}`,
  );
}
