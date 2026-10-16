// [LAW:nothing-unseen] brandon-unfiled-3248.87p, measured on a REAL daemon:
// every render request writes one render event — the `render …` log line —
// whatever its outcome. A render that draws the bar, one that throws, and one
// the daemon refuses each leave an event naming its outcome, and a render that
// stops early carries the fields it reached under the same names and in the
// same order as one that finished, so the failing renders are described by the
// same fields as the rest.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { logPath } from "../src/daemon/paths";
import {
  hookData,
  killAndWait,
  render,
  renderRequest,
} from "./helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

// `drawn` draws a bar. `broken` chooses its style by a rule whose template
// fails when it is evaluated — inside renderDsl, after the payload is built —
// so the render throws partway through.
const CONFIGS = {
  drawn: `{ segments: { mark: { template: 'mark' } }, root: { h: ['mark'] } }`,
  broken: `{ globals: { style: '{{ fail "the rule broke" }}' }, segments: { mark: { template: 'mark' } }, root: { h: ['mark'] } }`,
};

type Event = {
  level: string;
  fields: ReadonlyArray<readonly [string, string]>;
};

// A log line's level and its `key=value` fields, in order. A value that could
// be misread as more than one field is a JSON string, read whole and unquoted.
function eventOf(line: string): Event {
  const [, level, rest] = line.match(/ \[(\w+)\] render (.*)$/)!;
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
function only(events: readonly Event[]): Event {
  const [event, ...rest] = events;
  if (event === undefined || rest.length > 0)
    throw new Error(`expected exactly one render event, got ${events.length}`);
  return event;
}

// A session id that would forge a field, and a second event, were it written
// into the line as it was sent.
const FORGING_SID = 'ev drawn outcome=threw\n2026-01-01 [error] render sid="x"';

describe("every render request writes one render event, whatever its outcome", () => {
  let sockPath: string;
  let env: NodeJS.ProcessEnv;
  let removeTmpDirs: () => void;
  let projectDir: string;
  let daemon: RunningDaemon | undefined;

  const configFlag = (name: keyof typeof CONFIGS): string[] => [
    "cc-candybar",
    "--config",
    path.join(projectDir, `${name}.json5`),
  ];
  const renderEvents = (): Event[] =>
    readFileSync(logPath(env), "utf8")
      .split("\n")
      .filter((l) => / \[\w+\] render /.test(l))
      .map(eventOf);
  const field = (event: Event, key: string): string | undefined =>
    event.fields.find(([k]) => k === key)?.[1];
  const eventsOf = (sid: string): Event[] =>
    renderEvents().filter((e) => field(e, "sid") === sid);

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-event-e2e");
    ({ sockPath, env, removeTmpDirs } = prepared);
    projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-render-event-e2e-"),
    );
    for (const [name, text] of Object.entries(CONFIGS))
      writeFileSync(path.join(projectDir, `${name}.json5`), text);
    daemon = await spawnDaemonWithEnv(prepared.env);
  });

  afterAll(async () => {
    if (daemon) await killAndWait(daemon);
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  });

  test("a drawn bar, a thrown render and a refused request each leave an event naming their outcome", async () => {
    const hints = { termCols: 120, termRows: 40 };
    await render(sockPath, FORGING_SID, projectDir, hints, configFlag("drawn"));
    await expect(
      render(sockPath, "ev-threw", projectDir, hints, configFlag("broken")),
    ).rejects.toThrow(/the rule broke.*RENDER_FAILED/);
    await expect(
      renderRequest(sockPath, {
        hookData: hookData("ev-refused", projectDir),
        args: [],
        cwd: "proj",
      }),
    ).rejects.toThrow(/BAD_REQUEST/);

    // A request the helper retried after a reply timeout is logged once per
    // attempt: every attempt ended the same way, and exactly one of them is
    // the reply the client read.
    const attempts = (sid: string, outcome: string, level: string): Event => {
      const events = eventsOf(sid);
      for (const event of events) {
        expect(event.level).toBe(level);
        expect(field(event, "outcome")).toBe(outcome);
      }
      return only(events.filter((e) => field(e, "timedOut") === "N"));
    };
    // The forging sid is read back whole, as one field of one event.
    const drawn = attempts(FORGING_SID, "ok", "info");
    expect(renderEvents().filter((e) => field(e, "sid") === "x")).toEqual([]);

    const thrown = attempts("ev-threw", "threw", "error");
    expect(thrown.level).toBe("error");
    expect(field(thrown, "outcome")).toBe("threw");
    expect(field(thrown, "error")).toContain("the rule broke");
    // What the render learned before it threw, as a finished render names it.
    expect(field(thrown, "termCols")).toBe("120");
    expect(field(thrown, "termRows")).toBe("40");
    expect(field(thrown, "refused")).toBe("-");
    // The fields it reached are the finished render's, in its order, up to the
    // stage that threw — never a field it did not reach, spelled as "none".
    const keys = (event: Event) =>
      event.fields
        .map(([k]) => k)
        .filter((k) => !["timedOut", "took", "outcome", "error"].includes(k));
    const reached = keys(thrown);
    expect(reached).toEqual(keys(drawn).slice(0, reached.length));
    expect(reached).toContain("prompts");
    expect(reached).not.toContain("effect");
    expect(reached).not.toContain("warn");
    // The event is the one record of the throw: the connection never saw it.
    expect(readFileSync(logPath(env), "utf8")).not.toContain("handler threw");

    // A refused request names its problems. The request was not trusted, so
    // nothing it said is recorded as a fact of the render — not even its sid.
    const refused = only(
      renderEvents().filter((e) => field(e, "outcome") === "bad-request"),
    );
    expect(refused.level).toBe("warn");
    expect(field(refused, "problems")).toBe(
      `request 'cwd' is not an absolute path: "proj"`,
    );
    expect(field(refused, "sid")).toBeUndefined();
  });
});
