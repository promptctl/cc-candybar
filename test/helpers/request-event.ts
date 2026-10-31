import { loggedLines } from "./daemon-log";

export type Event = {
  level: string;
  fields: ReadonlyArray<readonly [string, string]>;
};

// A request event's level and its `key=value` fields, in order. A value that
// could be misread as more than one field is a JSON string, read whole and
// unquoted.
export function eventOf(line: string): Event {
  const [, level, rest] = line.match(/ \[(\w+)\] (?:render|click) (.*)$/)!;
  const fields = [...rest!.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g)].map(
    ([, key, value]) =>
      [
        key!,
        value!.startsWith('"') ? (JSON.parse(value!) as string) : value!,
      ] as const,
  );
  return { level: level!, fields };
}

// The one event a case expects, or a failure naming how many there were.
export function only(events: readonly Event[]): Event {
  const [event, ...rest] = events;
  if (event === undefined || rest.length > 0)
    throw new Error(`expected exactly one render event, got ${events.length}`);
  return event;
}

export const field = (event: Event, key: string): string | undefined =>
  event.fields.find(([k]) => k === key)?.[1];

// A session's render event lines, picked so a wait that fails names them.
export const renderLinesOf = (sid: string, lines: readonly string[]): string[] =>
  lines.filter(
    (l) => / \[\w+\] render /.test(l) && field(eventOf(l), "sid") === sid,
  );

// A session's events once at least `count` have landed.
export const landedEvents = async (
  env: NodeJS.ProcessEnv,
  sid: string,
  count: number,
): Promise<Event[]> =>
  (
    await loggedLines(
      env,
      (lines) => renderLinesOf(sid, lines),
      (found) => found.length >= count,
      `${count} render event(s) for ${sid}`,
    )
  ).map(eventOf);
