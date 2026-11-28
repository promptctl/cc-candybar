import { oversizedRendererHistory, oversizedSession } from "../helpers/oversized-renderer-history";
import wire24 from "../fixtures/renderer-wire-24.json";
import { SAMPLE_REGION } from "../../scripts/lib/draw-fixtures/sample-region.js";
import type { Effect, Event, EventInput, RendererBoot, RequestId } from "../../src/renderer-interface/interface";
import { contextOf, snapshotOf, worldStateOf } from "../helpers/main-renderer";
import { RECORDING_VERSION, type RecordingEntry } from "../../src/renderer-interface/recording";
import { EMPTY_STORED_STATE } from "../../src/renderer-interface/stored-state";
import { RENDERER_WIRE_VERSION } from "../../src/renderer-interface/wire";
import { mainRendererOf } from "../../src/renderer/main";
import { replayRecording } from "../../src/renderer/replay";
import type { Instant, Tick } from "../../src/utils/instant";

const settings: RendererBoot = {
  sessionRevision: 0,
  stored: EMPTY_STORED_STATE,
  locations: { home: "/offline", configHome: "/offline/config", dataHome: "/offline/data", dataDirs: [] },
  region: SAMPLE_REGION,
  memoryLimitBytes: 1024 * 1024 * 1024,
};
const boot = {
  kind: "boot", version: RECORDING_VERSION, wireVersion: RENDERER_WIRE_VERSION,
  input: settings, result: { kind: "built" },
} as const satisfies RecordingEntry;
const oldEnd = { kind: "end", turns: 0 } as const;
const end = { ...oldEnd, sessionRevision: 0 } as const satisfies RecordingEntry;
const linesOf = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry));

test("the final revision verifies changes received between turns, including the last change", async () => {
  const checkpoint = { ...boot, input: { ...settings, sessionRevision: 40 } };
  const change = {
    kind: "session-commit",
    at: 15,
    tick: 1,
    revision: 41,
    writes: [
      {
        kind: "patch",
        store: "session-state",
        key: "sample",
        changes: { padding: "4" },
      },
    ],
  };
  const deletion = {
    ...change,
    revision: 42,
    writes: [
      {
        kind: "patch",
        store: "session-state",
        key: "sample",
        changes: { padding: null },
      },
    ],
  };
  const footer = { ...end, sessionRevision: 42 };
  const action = jest.fn();
  await expect(
    replayRecording(linesOf(checkpoint, change, deletion, footer), action),
  ).resolves.toEqual({ turns: 0 });
  expect(action).not.toHaveBeenCalled();
  await expect(
    replayRecording(linesOf(checkpoint, deletion, footer)),
  ).rejects.toThrow("out-of-order session commit");
  await expect(
    replayRecording(linesOf(checkpoint, change, footer)),
  ).rejects.toThrow("wrong terminal session revision");
  await expect(
    replayRecording(linesOf(checkpoint, change, deletion, oldEnd)),
  ).rejects.toThrow("invalid end fields");
});

async function recordedStats() {
  const built = mainRendererOf(settings);
  if (built.kind === "refused") throw new Error("fixture renderer refused construction");
  const input: EventInput = {
    kind: "event", event: { kind: "stats" }, at: 1 as Instant, tick: 0 as Tick,
  };
  const output = await built.renderer.answer(input);
  return { kind: "turn", input, output } as const satisfies RecordingEntry;
}

test("replay accepts key order variations and complete empty or asynchronous recordings", async () => {
  expect(await replayRecording(linesOf(boot, end))).toEqual({ turns: 0 });
  const stats = await recordedStats();
  const reordered = Object.fromEntries(Object.entries(stats.output).reverse());
  async function* recording() {
    yield* linesOf(boot, { output: reordered, input: stats.input, kind: "turn" }, { ...end, turns: 1 });
  }
  const inspected = jest.fn();
  expect(await replayRecording(recording(), inspected)).toEqual({ turns: 1 });
  expect(inspected).toHaveBeenCalledTimes(1);
  expect(inspected).toHaveBeenCalledWith(stats.input, stats.output);
});

test("replay refuses changed input or output and keeps private values and keys out of errors", async () => {
  const stats = await recordedStats();
  const inspected = jest.fn();
  const tail = { ...end, turns: 1 };
  const changedInput = { ...stats.input, event: { kind: "debug", what: "config" } };
  await expect(replayRecording(linesOf(boot, { ...stats, input: changedInput }, tail), inspected))
    .rejects.toThrow("recording turn 1 differs at output.reply.kind");
  const changedOutput = { ...stats.output, record: [["private-key", "PRIVATE_VALUE"]] };
  await expect(replayRecording(linesOf(boot, { ...stats, output: changedOutput }, tail), inspected))
    .rejects.toThrow(/^recording turn 1 differs at output\.record\[0\]$/);
  const extra = { ...stats.output, subscriptions: { ...stats.output.subscriptions, PRIVATE_KEY: "PRIVATE_VALUE" } };
  await expect(replayRecording(linesOf(boot, { ...stats, output: extra }, tail), inspected))
    .rejects.toThrow(/^recording turn 1 differs at output\.subscriptions\[field \d+\]$/);
  expect(inspected).not.toHaveBeenCalled();
});

test.each([
  { lines: [], problem: "recording has no boot entry" },
  { lines: linesOf(end), problem: "recording line 1 must be a boot entry" },
  { lines: linesOf(boot), problem: "recording has no terminal entry" },
  { lines: linesOf(boot, { ...end, turns: 1 }), problem: "recording line 2 has the wrong terminal turn count" },
  { lines: linesOf(boot, end, end), problem: "recording line 3 follows the terminal entry" },
  { lines: linesOf({ ...boot, version: 80 }, end), problem: "recording line 1 needs format version" },
  { lines: linesOf({ ...boot, wireVersion: -1 }, end), problem: "recording line 1 needs renderer wire version" },
  { lines: linesOf({ ...boot, input: { ...settings, memoryLimitBytes: -1 } }, end), problem: "invalid renderer boot input" },
  { lines: linesOf({ ...boot, result: { kind: "refused", failure: { kind: "threw", message: "PRIVATE", detail: "PRIVATE" } } }, end), problem: "recording boot differs at result.failure" },
  { lines: linesOf(boot, { kind: "turn", input: { kind: "event", at: 1, tick: 0, event: { kind: "not-a-turn" } }, output: {} }, end), problem: "invalid renderer event" },
  { lines: linesOf(boot, { kind: "turn", input: { kind: "event", at: 1, tick: 0, event: { kind: "click" } }, output: {} }, end), problem: "invalid renderer event" },
  { lines: linesOf(boot, { ...end, private: true }), problem: "recording line 2 has invalid end fields" },
  { lines: [...linesOf(boot), '{"kind":"end","turns":'], problem: "recording line 2 is not JSON" },
])("rejects $problem", async ({ lines, problem }) => {
  await expect(replayRecording(lines)).rejects.toThrow(problem);
});

test("historical wire 22 recordings replay until an insertion needs its missing seed", async () => {
  const historical = { ...boot, wireVersion: 22, input: { ...settings, region: { locale: "en-US", timeZone: "UTC" } } };
  const stats = await recordedStats();
  await expect(replayRecording(linesOf(historical, stats, { ...oldEnd, turns: 1 }))).resolves.toEqual({ turns: 1 });
  const input = { ...stats.input, event: { kind: "click", context: null, click: {
    scope: "session", session: "session", verb: "apply-layout-op", steps: [
      { kind: "session", verb: "apply-layout-op", args: ["user", "presets.default.root", "insert:added:anchor:after"] },
    ],
  } } };
  // This insertion fails at the session/config gate, before an ID is minted.
  const live = mainRendererOf(settings);
  if (live.kind !== "built") throw new Error("renderer refused construction");
  const actual = await live.renderer.answer({ ...input, event: { ...input.event, placementSeed: "new" } } as EventInput);
  expect(actual.kind).toBe("threw");
  const stored = [{ kind: "put", store: "session-state", key: "session", value: {
    "candybar.clickError": JSON.stringify({
      text: "apply-layout-op: session session has not rendered yet — no config to act on",
      at: 1, revision: 1, answered: false,
    }),
  } }];
  await expect(replayRecording(linesOf(historical, { ...stats, input, output: { ...actual, stored } }, { ...oldEnd, turns: 1 }))).resolves.toEqual({ turns: 1 });
  for (const placementSeed of [undefined, "", 42])
    await expect(replayRecording(linesOf(boot, { ...stats, input: { ...input, event: { ...input.event, placementSeed } } }, { ...end, turns: 1 }))).rejects.toThrow("invalid click placement seed");
  await expect(replayRecording(linesOf(historical, {...stats, input}, { ...oldEnd, turns: 1 })))
    .rejects.toThrow("this historical insertion had no recorded placement seed");
});

test.each([22, 23])("wire %d requires reconstructible number data", async wireVersion => {
  const recording = (locale: string) => linesOf({ ...boot, wireVersion, input: {
    ...settings, region: { locale, timeZone: "UTC" },
  } }, oldEnd);
  await expect(replayRecording(recording("en-US"))).resolves.toEqual({ turns: 0 });
  await expect(replayRecording(recording("zz-ZZ"))).rejects.toThrow("invalid renderer boot input");
});

// Captured from the published 1.245.1 renderer. One click changes a pick
// beside an untouched pick. A second writes a file, receives its completion,
// records a durable undo step, and the next request draws the applied config.
test("wire 24 verifies a complete pick record, a file change and the following draw", async () => {
  const lines = linesOf(...wire24);
  await expect(replayRecording(lines)).resolves.toEqual({ turns: 8 });
  const alter = (turn: number, from: string, to: string) => {
    expect(lines[turn]).toContain(from);
    return lines.with(turn, lines[turn]!.replace(from, to));
  };
  await expect(replayRecording(alter(2, '"endcaps":"round"', '"endcaps":"wrong"')))
    .rejects.toThrow("recording turn 2 differs at output.stored[0].value");
  await expect(replayRecording(alter(5, '"role":"user"', '"role":"project"')))
    .rejects.toThrow("recording turn 5 differs at output.stored[0].value");
  await expect(replayRecording(alter(7, '"text":"space"', '"text":"wrong"')))
    .rejects.toThrow("recording turn 7 differs at output.effects");
});

// The same inputs through the released pre-integer-table renderer produced
// these two compile digests. Every other recorded output field was identical.
test.each([22, 23])("wire %d reproduces the cache identity of both captured configs", async wireVersion => {
  const [first, ...rest] = wire24;
  if (first?.kind !== "boot" || first.input?.region === undefined) throw new Error("expected wire 24 boot");
  const {locale, timeZone} = first.input.region;
  const lines = linesOf({
    ...first, wireVersion, input: {...first.input, region: {locale, timeZone}},
  }, ...rest).map(line => line.replaceAll("9dc55f2ce0a7", "86b51f35df7a").replaceAll("31e5b55ad197", "06621d1d8302"));
  await expect(replayRecording(lines)).resolves.toEqual({turns: 8});
  const altered = lines.with(2, lines[2]!.replace("86b51f35df7a", "000000000000"));
  await expect(replayRecording(altered)).rejects.toThrow("recording turn 2 differs at output.diagnostics");
});

test("wire 25 compares sparse picks alongside the full recorded undo history", async () => {
  const lines = linesOf(...wire24);
  const bootEntry = JSON.parse(lines[0]!);
  const turn = JSON.parse(lines[2]!);
  expect(turn.output.stored[0]).toEqual({kind: "put", store: "session-state", key: "peer-replay", value: {padding: "2", endcaps: "round"}});
  turn.output.stored[0] = {kind: "patch", store: "session-state", key: "peer-replay", changes: {padding: "2"}};
  lines[0] = JSON.stringify({...bootEntry, wireVersion: 25});
  lines[2] = JSON.stringify(turn);
  await expect(replayRecording(lines)).resolves.toEqual({turns: 8});
  const altered = lines.with(5, lines[5]!.replace('"role":"user"', '"role":"project"'));
  await expect(replayRecording(altered)).rejects.toThrow("recording turn 5 differs at output.stored[0].value");
});

test("wire 28 reproduces its renderer-owned startup trim before the first input", async () => {
  const result = {
    kind: "built",
    diagnostics: [
      {
        level: "info",
        line: `settings-history: trimmed an old step for session ${oversizedSession}`,
      },
    ],
  };
  const checkpoint = {
    ...boot,
    wireVersion: 28,
    input: { ...settings, stored: oversizedRendererHistory() },
    result,
  };
  await expect(replayRecording(linesOf(checkpoint, end))).resolves.toEqual({
    turns: 0,
  });
  await expect(
    replayRecording(linesOf({ ...checkpoint, result: { kind: "built" } }, end)),
  ).rejects.toThrow("recording boot differs at result.diagnostics");
});

// [LAW:verifiable-goals] Before wire 37 a recording keyed its presentation by
// drawer and held one pointer per session. Replay reads its requests as the
// statusline's, so a recording of request draws still verifies, and refuses
// one whose outputs carry feed frames, drawn once for every lane.
describe("a recording from before each lane drew its own frame", () => {
  const context = contextOf("legacy-surfaces");
  const session = context.hookData.session_id;
  const events: Event[] = [
    {
      kind: "start",
      sessions: [{ context, worldState: worldStateOf(session) }],
      viewers: {},
      configs: [
        {
          origin: context.requested,
          config: snapshotOf('{segments:{a:{template:"a legacy mark"}},root:{h:["a"]}}'),
        },
      ],
    },
    { kind: "request", context, id: 1 as RequestId },
    {
      kind: "viewers",
      viewers: {
        [session]: {
          lanes: { pane: { subscribers: 1, drawing: true, pointer: null } },
          shown: true,
          joined: 1,
        },
      },
    },
  ];
  // Each event's turn, as this wire records it.
  async function turns() {
    const built = mainRendererOf(settings);
    if (built.kind === "refused") throw new Error("fixture renderer refused construction");
    const recorded = [];
    for (const [order, event] of events.entries()) {
      // The host's presentation turn, so the request's draw proposes one.
      const input: EventInput = {
        kind: "event", event, at: 1 as Instant, tick: 0 as Tick,
        presentation: { order: order + 1, sessions: [] },
      };
      const json = JSON.stringify(input);
      const output = await built.renderer.answer(JSON.parse(json));
      recorded.push({ kind: "turn", input: JSON.parse(json), output: JSON.parse(JSON.stringify(output)) });
    }
    return recorded;
  }
  // The same turns as wire 36 recorded them: the request's drawn effects held
  // in the session's motion, the lanes it handed the bar to, and the
  // session's one pointer.
  function legacy(recorded: Awaited<ReturnType<typeof turns>>) {
    const [start, request, viewers] = structuredClone(recorded);
    const { record } = request!.output;
    record.splice(record.findIndex(([key]: [string]) => key === "owed"), 0, ["handoff", "-"]);
    const present = request!.output.effects.find((effect: Effect) => effect.kind === "present");
    const { surface, motion } = present.proposal;
    const { effects, ...value } = surface.value;
    present.proposal = {
      ...present.proposal,
      surface: { ...surface, value },
      motion: { ...motion, value: { ...motion.value, ...effects } },
    };
    const watched = viewers!.input.event.viewers[session];
    delete watched.lanes.pane.pointer;
    watched.pointer = null;
    return [start!, request!, viewers!];
  }
  const replayed = (wireVersion: number, recorded: readonly unknown[]) =>
    replayRecording(linesOf({ ...boot, wireVersion }, ...recorded, { ...end, turns: recorded.length }));

  test("replays its request's draw as the statusline's and its session pointer as no lane's", async () => {
    const recorded = await turns();
    expect(recorded[1]!.output.effects.some((effect: Effect) => effect.kind === "present")).toBe(true);
    await expect(replayed(36, legacy(recorded))).resolves.toEqual({ turns: 3 });
    await expect(replayed(36, recorded)).rejects.toThrow("recording turn 2 differs at output.effects");
  });

  test("refuses outputs that carry feed frames", async () => {
    const recorded = legacy(await turns());
    const due = { kind: "turn", input: { kind: "event", at: 1, tick: 0, event: { kind: "due" } }, output: { ...recorded[1]!.output, effects: [], frames: [{}] } };
    await expect(replayed(36, [...recorded, due])).rejects.toThrow(
      "recording line 5 carries feed frames from wire 36",
    );
  });
});
