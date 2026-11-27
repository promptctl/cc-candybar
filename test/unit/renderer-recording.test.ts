import { SAMPLE_REGION } from "../../scripts/lib/draw-fixtures/sample-region.js";
import { systemTimekeeper } from "../../scripts/lib/system-clock";
import { MAIN_RENDERER } from "../../src/daemon/foundations/renderer-name";
import {
  RendererRecording,
  RendererRecordings,
} from "../../src/daemon/renderer-recording";
import type { RecordingFile } from "../../src/daemon/recording-file";
import type {
  EventInput,
  RendererBoot,
  RendererOutput,
  Timed,
} from "../../src/renderer-interface/interface";
import { EMPTY_STORED_STATE } from "../../src/renderer-interface/stored-state";
import { encodeSessionCommit } from "../../src/daemon/session-delivery";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import type { Instant, Tick } from "../../src/utils/instant";

const boot: RendererBoot = {
  sessionRevision: 0,
  stored: EMPTY_STORED_STATE,
  locations: {
    home: "/home/u",
    configHome: "/config",
    dataHome: "/data",
    dataDirs: [],
  },
  region: SAMPLE_REGION,
  memoryLimitBytes: 1024,
};
const input: EventInput = {
  kind: "event",
  at: 0 as Instant,
  tick: 0 as Tick,
  event: { kind: "due" },
};
const output: Timed<RendererOutput> = {
  kind: "answered",
  subscriptions: {
    configs: [],
    configSelections: [],
    managedFolders: [],
    sources: {},
    lanes: {},
  },
  stored: [],
  frames: [],
  effects: [],
  record: [],
  wake: null,
  turnMs: 142,
};

function memoryFile() {
  const lines: string[] = [];
  const file = {
    append: jest.fn(async (line: string) => {
      lines.push(line);
    }),
    publish: jest.fn(async (): Promise<string | null> => null),
    discard: jest.fn(async () => {}),
  } satisfies RecordingFile;
  return { lines, file };
}

function recording() {
  const { lines, file } = memoryFile();
  const log = jest.fn();
  const capture = new RendererRecording(
    MAIN_RENDERER,
    "/captures/session",
    file,
    log,
  );
  expect(capture.claim()).toBe(capture);
  expect(capture.claim()).toBeUndefined();
  return { capture, lines, file, log };
}

test("each generation publishes its construction and completed inputs from send time", async () => {
  const { capture, lines, file } = recording();
  capture.constructed(boot, { kind: "built" });
  const queries: unknown[] = [];
  const submitted = {
    ...input,
    event: { kind: "due" as const, pendingClicks: [] },
  };
  const turn = capture.turn(submitted, async () => {
    // A caller can reuse its object as soon as the worker has it.
    submitted.tick = 99 as Tick;
    queries.push(input.event.kind);
    return output;
  });
  expect(await turn).toBe(output);
  expect(await capture.finish()).toMatch(/Saved 1 renderer turns/);
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    expect.objectContaining({
      kind: "boot",
      input: boot,
      result: { kind: "built" },
    }),
    {
      kind: "turn",
      input: { ...input, event: { kind: "due", pendingClicks: [] } },
      output: expect.not.objectContaining({ turnMs: expect.anything() }),
    },
    { kind: "end", turns: 1, sessionRevision: 0 },
  ]);
  expect(file.publish).toHaveBeenCalledTimes(1);
  expect(queries).toEqual(["due"]);
});

test("a change delivered while an input is in flight follows that turn on disk", async () => {
  const { capture, lines } = recording();
  capture.constructed(boot, { kind: "built" });
  const turn = capture.turn(input, async () => output);
  const commit = encodeSessionCommit({
    kind: "session-commit",
    at: input.at,
    tick: input.tick,
    revision: 1,
    writes: [
      {
        kind: "patch",
        store: "session-state",
        key: sessionIdOf("test"),
        changes: { padding: "4" },
      },
    ],
  });
  capture.observed(commit);
  await turn;
  await capture.finish();
  expect(lines.map((line) => JSON.parse(line).kind)).toEqual([
    "boot",
    "turn",
    "session-commit",
    "end",
  ]);
  expect(lines[2]).toBe(commit.line);
  expect(JSON.parse(lines[3]!)).toEqual({
    kind: "end",
    turns: 1,
    sessionRevision: 1,
  });
});

test("a failed write preserves a real renderer answer and stop reports why nothing was published", async () => {
  const { capture, file, log } = recording();
  file.append.mockRejectedValueOnce(new Error("recording disk full"));
  capture.constructed(boot, { kind: "built" });
  const result = await capture.turn(input, async () => output);
  expect(result).toBe(output);
  await expect(capture.finish()).rejects.toThrow("recording disk full");
  expect(file.discard).toHaveBeenCalledTimes(1);
  expect(file.publish).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(
    "warn",
    expect.stringContaining("outcome=failed"),
  );
});

test("a refused construction can be replayed, while an interrupted live input cannot be published", async () => {
  const refused = recording();
  refused.capture.constructed(boot, {
    kind: "refused",
    failure: { kind: "threw", message: "bad profile", detail: "bad profile" },
  });
  refused.capture.interrupted();
  await expect(refused.capture.finish()).resolves.toMatch(
    /Saved 0 renderer turns/,
  );
  const interrupted = recording();
  interrupted.capture.constructed(boot, { kind: "built" });
  await expect(
    interrupted.capture.turn(input, async () => {
      throw new Error("pipe closed");
    }),
  ).rejects.toThrow("pipe closed");
  await expect(interrupted.capture.finish()).rejects.toThrow(
    "no semantic answer",
  );
  expect(interrupted.file.publish).not.toHaveBeenCalled();
});

test("opening a recording resolves the renderer that bound during the file open and serializes retry and stop", async () => {
  const { file } = memoryFile();
  let open!: (dest: RecordingFile) => void;
  const pending = new Promise<RecordingFile>((resolve) => {
    open = resolve;
  });
  const registry = new RendererRecordings(
    () => pending,
    () => {},
    systemTimekeeper.detach,
  );
  let bound = false;
  const replace = jest.fn(async () => {
    registry.generation(MAIN_RENDERER)!.constructed(boot, { kind: "built" });
  });
  const boundary = <T>(
    _name: typeof MAIN_RENDERER,
    operation: (reset?: () => Promise<void>) => Promise<T>,
  ) => operation(bound ? replace : undefined);
  const command = {
    action: "start",
    renderer: MAIN_RENDERER,
    file: "/captures/foo",
  } as const;
  const start = registry.request(command, boundary);
  const again = registry.request(command, boundary);
  bound = true;
  open(file);
  await expect(start).resolves.toContain("fresh generation");
  await expect(again).resolves.toContain("already requested");
  expect(replace).toHaveBeenCalledTimes(1);
  await expect(
    registry.request({ action: "stop", renderer: MAIN_RENDERER }, boundary),
  ).resolves.toContain("Saved 0");
  expect(file.publish).toHaveBeenCalledTimes(1);
});

test("live turns and sealing a renderer never wait for the capture disk", async () => {
  const { file } = memoryFile();
  let release!: () => void;
  file.append.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const registry = new RendererRecordings(
    async () => file,
    () => {},
    systemTimekeeper.detach,
  );
  let capture!: RendererRecording;
  let occupied = false;
  const boundary = async <T>(
    _name: typeof MAIN_RENDERER,
    operation: (restart?: () => Promise<void>) => Promise<T>,
  ) => {
    occupied = true;
    try {
      return await operation(async () => {
        capture = registry.generation(MAIN_RENDERER)!;
        capture.constructed(boot, { kind: "built" });
      });
    } finally {
      occupied = false;
    }
  };
  await registry.request(
    { action: "start", renderer: MAIN_RENDERER, file: "/capture" },
    boundary,
  );
  expect(await capture.turn(input, async () => output)).toBe(output);
  expect(await capture.turn(input, async () => output)).toBe(output);
  const stopped = registry.request(
    { action: "stop", renderer: MAIN_RENDERER },
    boundary,
  );
  await Promise.resolve();
  expect(occupied).toBe(false);
  expect(capture.active).toBe(false);
  expect(file.publish).not.toHaveBeenCalled();
  capture.interrupted(); // The worker no longer owns the sealed prefix.
  release();
  await expect(stopped).resolves.toContain("Saved 2");
});

test("a stalled destination cannot accumulate an unbounded live trace", async () => {
  const { capture, file } = recording();
  let release!: () => void;
  file.append.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  capture.constructed(boot, { kind: "built" });
  const large: Timed<RendererOutput> = {
    ...output,
    diagnostics: [{ level: "info", line: "x".repeat(2 * 1024 * 1024) }],
  };
  for (let i = 0; i < 5 && capture.active; i++)
    expect(await capture.turn(input, async () => large)).toBe(large);
  expect(capture.active).toBe(false);
  release();
  await expect(capture.finish()).rejects.toThrow("could not keep up");
  expect(file.publish).not.toHaveBeenCalled();
});

test("shutdown while opening an unbound capture discards its private staging file", async () => {
  const { file } = memoryFile();
  let open!: (dest: RecordingFile) => void;
  const pending = new Promise<RecordingFile>((resolve) => {
    open = resolve;
  });
  const registry = new RendererRecordings(
    () => pending,
    () => {},
    systemTimekeeper.detach,
  );
  const start = registry.request(
    { action: "start", renderer: MAIN_RENDERER, file: "/captures/foo" },
    (_name, op) => op(),
  );
  const closed = registry.close();
  open(file);
  await expect(start).rejects.toThrow("daemon is closing");
  await closed;
  expect(file.publish).not.toHaveBeenCalled();
  expect(file.discard).toHaveBeenCalledTimes(1);
});
