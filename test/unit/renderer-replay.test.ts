import wire24 from "../fixtures/renderer-wire-24.json";
import { SAMPLE_REGION } from "../../scripts/lib/draw-fixtures/sample-region.js";
import type { EventInput, RendererBoot } from "../../src/renderer-interface/interface";
import { RECORDING_VERSION, type RecordingEntry } from "../../src/renderer-interface/recording";
import { EMPTY_STORED_STATE } from "../../src/renderer-interface/stored-state";
import { RENDERER_WIRE_VERSION } from "../../src/renderer-interface/wire";
import { mainRendererOf } from "../../src/renderer/main";
import { replayRecording } from "../../src/renderer/replay";
import type { Instant, Tick } from "../../src/utils/instant";

const settings: RendererBoot = {
  stored: EMPTY_STORED_STATE,
  locations: { home: "/offline", configHome: "/offline/config", dataHome: "/offline/data", dataDirs: [] },
  region: SAMPLE_REGION,
  memoryLimitBytes: 1024 * 1024 * 1024,
};
const boot = {
  kind: "boot", version: RECORDING_VERSION, wireVersion: RENDERER_WIRE_VERSION,
  input: settings, result: { kind: "built" },
} as const satisfies RecordingEntry;
const end = { kind: "end", turns: 0 } as const satisfies RecordingEntry;
const linesOf = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry));

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
  await expect(replayRecording(linesOf(historical, stats, { ...end, turns: 1 }))).resolves.toEqual({ turns: 1 });
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
  await expect(replayRecording(linesOf(historical, { ...stats, input, output: { ...actual, stored } }, { ...end, turns: 1 }))).resolves.toEqual({ turns: 1 });
  for (const placementSeed of [undefined, "", 42])
    await expect(replayRecording(linesOf(boot, { ...stats, input: { ...input, event: { ...input.event, placementSeed } } }, { ...end, turns: 1 }))).rejects.toThrow("invalid click placement seed");
  await expect(replayRecording(linesOf(historical, {...stats, input}, { ...end, turns: 1 })))
    .rejects.toThrow("this historical insertion had no recorded placement seed");
});

test.each([22, 23])("wire %d requires reconstructible number data", async wireVersion => {
  const recording = (locale: string) => linesOf({ ...boot, wireVersion, input: {
    ...settings, region: { locale, timeZone: "UTC" },
  } }, end);
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
