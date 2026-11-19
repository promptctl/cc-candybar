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
