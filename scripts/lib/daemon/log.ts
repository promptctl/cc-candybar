import { logLines as linesOf } from "../../../src/daemon/log";
import { hostOf } from "../host";
import { logPath } from "../../../src/daemon/paths";
import { fieldsOf, valueOf } from "../../../src/utils/logfmt";
import { until } from "../until";
import type { RequestId } from "../../../src/renderer-interface/interface";

// [LAW:no-ambient-temporal-coupling] The daemon writes its log off the event
// loop (src/daemon/log.ts), so a line a request logged can land just after the
// request is answered. A test reads the log once the lines it waits for are
// there, never once.
export function logLines(env: NodeJS.ProcessEnv): string[] {
  return linesOf(logPath(hostOf(env)));
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
): string[] =>
  lines.filter((l) => l.includes(`] render sid=${valueOf(sessionId)} `));

// The click event a request's id names, which a TIMEOUT carries back, among the
// lines from `from` on: ids restart with each daemon, and a log outlives it.
export const clickEventOf = (
  lines: readonly string[],
  from: number,
  request: RequestId,
): string | undefined =>
  lines
    .slice(from)
    .find(
      (l) =>
        l.includes("] click ") && fieldsOf(l).get("req") === String(request),
    );

// [LAW:one-source-of-truth] Count the session's render answers. A backstop
// or an abandoned draw can log an attempt that only produced a timeout.
export const answeredRender = (line: string): boolean => {
  const fields = fieldsOf(line);
  return (
    fields.get("timedOut") === "N" && fields.get("outcome") !== "abandoned"
  );
};

// The names a render event lists under `name`, none for `-`.
const listedBy = (event: string, name: string): string[] =>
  (fieldsOf(event).get(name) ?? "-").split(",").filter((v) => v !== "-");

// What the request waited for and its last draw still owed (`owed=`): the
// draw's own statement, the one thing the host's wait reads.
export const owedBy = (event: string): string[] => listedBy(event, "owed");

// The values no request waits for: each draws pending on a first bar and lands
// through its owner's refresh, which that owner logs as `<source> refresh`.
const UNWAITED: ReadonlyArray<{
  readonly name: RegExp;
  readonly lands: string;
}> = [
  { name: /^git\.pr[A-Z]/, lands: "] pr refresh " },
  { name: /^today\./, lands: "] today refresh " },
];

// The log lines that land the values a render drew pending, when every one of
// them is a value no request waits for; none otherwise, since a render that
// drew any other value pending is the one the deadline or a bug explains.
export function owedLandings(event: string): readonly string[] {
  const pending = listedBy(event, "pending");
  const owed = pending.map(
    (name) => UNWAITED.find((u) => u.name.test(name))?.lands,
  );
  return owed.length > 0 && owed.every((l) => l !== undefined)
    ? [...new Set(owed as string[])]
    : [];
}

// An answered render whose values are still on their way: its draw owed a
// source, or drew only values no request waits for, pending. A value a run
// superseded is pending by design and owed to no one, so it is neither.
export const drewAwaitedPending = (event: string): boolean =>
  owedBy(event).length > 0 || owedLandings(event).length > 0;

// [LAW:one-source-of-truth] The answer `renderRequest` asks again after: one
// whose wait ended at the deadline with a source still owed, or that drew only
// values no request waits for. The retry loop decides with this and
// `renderLines` drops what it decided, so a render is read as the one event
// its client kept.
export const retriedRender = (event: string): boolean =>
  (owedBy(event).length > 0 && fieldsOf(event).get("ended") === "deadline") ||
  (owedBy(event).length === 0 && owedLandings(event).length > 0);

// A session's render events, one per render its client kept, in log order.
// A request the client retried is logged once per attempt: after a timeout
// the attempt it read is the one not timed out, and after an answer that drew
// a source pending the attempt it kept is the last one.
export const keptRenders = (
  lines: readonly string[],
  sessionId: string,
): string[] =>
  renderEventsOf(lines, sessionId).filter(
    (l) => answeredRender(l) && !retriedRender(l),
  );

// A session's kept render events, once `count` of them are there.
export async function renderLines(
  env: NodeJS.ProcessEnv,
  sessionId: string,
  count = 1,
): Promise<string[]> {
  return loggedLines(
    env,
    (lines) => keptRenders(lines, sessionId),
    (events) => events.length >= count,
    `${count} kept render event(s) for ${sessionId}`,
  );
}
