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

// A session's render events, every attempt in log order, once `count` replies
// its client read are among them: a request the client retried after a
// timeout is logged once per attempt, and the attempt it read is the one not
// timed out.
export async function renderLines(
  env: NodeJS.ProcessEnv,
  sessionId: string,
  count = 1,
): Promise<string[]> {
  const of = (lines: readonly string[]) =>
    lines.filter((l) => l.includes(`render sid=${sessionId} `));
  const read = (lines: readonly string[]) =>
    of(lines).filter((l) => l.includes(" timedOut=N "));
  try {
    return of(
      await loggedWhen(
        env,
        (lines) => read(lines).length >= count,
        `${count} answered render event(s) for ${sessionId}`,
      ),
    );
  } catch (e) {
    // [LAW:no-silent-failure] The wait names what it counted, so a failure
    // on a runner nobody can log into says which events were there.
    throw new Error(
      `${e instanceof Error ? e.message : String(e)}; its events:\n${of(logLines(env)).join("\n")}`,
    );
  }
}
