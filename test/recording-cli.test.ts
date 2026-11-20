import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recordPlan, replayPlan } from "../src/recording-cli";
import type {
  EffectId,
  EventInput,
  RendererOutput,
  RequestId,
} from "../src/renderer-interface/interface";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import type { WireFrame } from "../src/render/frame";
import { systemTimekeeper } from "./helpers/system-clock";
import type { Instant, Tick } from "../src/utils/instant";
import { hostOf } from "./helpers/host";

const session = sessionIdOf("recording-fixture");
const frame = (text: string): WireFrame => ({
  depth: "truecolor",
  motion: "still",
  nextChange: null,
  pending: [],
  rows: [{ kind: "diagnostic", runs: [{ text }] }],
});

const present = frame("request");
const pane = frame("pane");
const handoff = frame("handoff");
const input: EventInput = {
  kind: "event",
  event: { kind: "due" },
  at: 0 as Instant,
  tick: 0 as Tick,
};
const output: RendererOutput = {
  kind: "answered",
  wake: null,
  stored: [],
  record: [],
  subscriptions: {
    sources: {},
    lanes: {},
    configs: [],
    managedFolders: [],
    configSelections: [],
  },
  effects: [
    {
      kind: "present",
      id: 1 as EffectId,
      request: 1 as RequestId,
      session,
      surface: "statusline",
      frame: present,
    },
  ],
  frames: [
    {
      session,
      frame: { kind: "drawn", receipt: 2 as EffectId, bar: pane, handoff },
    },
    { session, frame: { kind: "failed", message: "no draw" } },
  ],
};

// The test's replay port emits a verified prefix. Only a terminal marker
// will make that prefix a successful recording at the CLI boundary.
const replay: Parameters<typeof replayPlan>[1] = async (lines, onTurn) => {
  let complete = false;
  for await (const line of lines) {
    if (line === "turn") onTurn?.(input, output);
    else if (line === "end") complete = true;
  }
  if (!complete) throw new Error("recording has no terminal entry");
  return { turns: 1 };
};

async function fixture<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ccb-recording-cli-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("replay delivers the verified frames and summary on separate streams", () =>
  fixture(async (dir) => {
    const file = path.join(dir, "finished.jsonl");
    await writeFile(file, "turn\r\nend\n");
    const summary = "Verified 1 renderer turn.\n";
    expect(await replayPlan([file], replay)).toEqual({
      stdout: summary,
      stderr: "",
      code: 0,
    });
    const plan = await replayPlan([file, "--frames"], replay);
    expect(plan.code).toBe(0);
    expect(plan.stderr).toBe(summary);
    expect(
      plan.stdout
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { session, surface: "statusline", frame: present },
      { session, surface: "pane", frame: pane },
      { session, surface: "statusline", frame: handoff },
    ]);
  }));

test("an incomplete or unreadable recording sends no frames", () =>
  fixture(async (dir) => {
    const file = path.join(dir, "missing-terminal.jsonl");
    await writeFile(file, "turn\n");
    expect(await replayPlan([file, "--frames"], replay)).toEqual({
      stdout: "",
      stderr: "cc-candybar replay: recording has no terminal entry\n",
      code: 1,
    });
    const missing = await replayPlan([path.join(dir, "absent")], replay);
    expect(missing).toMatchObject({
      stdout: "",
      stderr: expect.stringContaining("ENOENT"),
      code: 1,
    });
  }));

test("frame export caps UTF-8 bytes and discards an accepted prefix", () =>
  fixture(async (dir) => {
    const file = path.join(dir, "many-frame-bytes.jsonl");
    await writeFile(file, "turn\nend\n");
    const manyBytes: typeof replay = async (lines, onTurn) => {
      for await (const line of lines) {
        if (line !== "turn" || onTurn === undefined) continue;
        onTurn(input, output);
        onTurn(input, {
          ...output,
          effects: [],
          frames: [
            {
              session,
              frame: {
                kind: "drawn",
                receipt: 3 as EffectId,
                bar: frame("é".repeat(16 * 1024 * 1024)),
                handoff: null,
              },
            },
          ],
        });
      }
      return { turns: 2 };
    };
    expect(await replayPlan([file, "--frames"], manyBytes)).toMatchObject({
      stdout: "",
      stderr: expect.stringContaining("frame output exceeds 32 MiB"),
      code: 1,
    });
    expect(await replayPlan([file], manyBytes)).toEqual({
      stdout: "Verified 2 renderer turns.\n",
      stderr: "",
      code: 0,
    });
  }));

test("the record CLI refuses invalid arguments and uses only the running socket", () =>
  fixture(async (dir) => {
    const world = {
      host: hostOf({ CC_CANDYBAR_SOCKET: path.join(dir, "unavailable.sock") }),
      clock: systemTimekeeper,
    };
    expect(await recordPlan(world, dir, ["start"])).toMatchObject({
      stdout: "",
      stderr: expect.stringContaining("Usage: cc-candybar record start"),
      code: 2,
    });
    expect(
      await recordPlan(world, dir, ["stop", "--renderer", "../other"]),
    ).toMatchObject({
      stdout: "",
      stderr: expect.stringContaining("is no renderer name"),
      code: 2,
    });
    expect(await recordPlan(world, dir, ["stop"])).toMatchObject({
      stdout: "",
      stderr: expect.stringContaining("daemon unavailable"),
      code: 1,
    });
  }));
