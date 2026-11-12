import { logLines as linesOf } from "../../src/daemon/log";
import { hostOf } from "./host";
import { logPath } from "../../src/daemon/paths";
import { valueOf } from "../../src/utils/logfmt";
import { until } from "./until";

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

// [LAW:one-source-of-truth] A render event whose reply its client read: an
// attempt the client gave up on is logged too, so a count of a session's
// answers counts these, never every event.
export const answeredRender = (line: string): boolean =>
  line.includes(" timedOut=N ");

// Whether every value a render event drew pending is a plugin source a run
// superseded, as its `sourcesPending=` names them.
export function drewOnlySuperseded(event: string): boolean {
  const field = (name: string): string[] =>
    (new RegExp(` ${name}=(\\S+)`).exec(event)?.[1] ?? "-")
      .split(",")
      .filter((v) => v !== "-");
  const superseded = new Set(
    field("sourcesPending")
      .filter((v) => v.endsWith(":superseded"))
      .map((v) => v.slice(0, -":superseded".length)),
  );
  const pending = field("pending");
  return pending.length > 0 && pending.every((name) => superseded.has(name));
}

// An answered render that drew a source still pending. A source a run
// superseded is pending by design (no request waits on it), so it is not one.
export const drewAwaitedPending = (event: string): boolean =>
  !/ pending=-(?: |$)/.test(event) && !drewOnlySuperseded(event);

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
  const pending = (/ pending=(\S+)/.exec(event)?.[1] ?? "-")
    .split(",")
    .filter((v) => v !== "-");
  const owed = pending.map(
    (name) => UNWAITED.find((u) => u.name.test(name))?.lands,
  );
  return owed.length > 0 && owed.every((l) => l !== undefined)
    ? [...new Set(owed as string[])]
    : [];
}

// [LAW:one-source-of-truth] The answer `renderRequest` asks again after: one
// that drew a source pending because its wait ended at the deadline, or drew
// only values no request waits for. The retry loop decides with this and
// `renderLines` drops what it decided, so a render is read as the one event
// its client kept.
export const retriedRender = (event: string): boolean =>
  drewAwaitedPending(event) &&
  (/ ended=deadline(?: |$)/.test(event) || owedLandings(event).length > 0);

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
