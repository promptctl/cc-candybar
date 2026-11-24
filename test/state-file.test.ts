// The policy for a stored JSON document (src/daemon/state-file.ts):
// absent is the empty value, anything else must read, and nothing is written
// over a file that does not: a write sets it aside beside itself first.
import { writeStatePlan } from "./helpers/state-file";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stateFile } from "../src/daemon/state-file";
import type { Asked } from "../src/utils/outcome";

const NAME = "numbers.json";

const numbers = (doc: unknown): Asked<readonly number[]> =>
  Array.isArray(doc) && doc.every((n) => typeof n === "number")
    ? { kind: "ok", value: doc }
    : { kind: "failed", reason: "is not a list of numbers" };

describe("a stored JSON document", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-state-file-"));
    file = path.join(dir, "state", NAME);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("absent is the empty value; an update is read back by the next reader, its directory made", () => {
    expect(stateFile([file], [], numbers).read()).toEqual({
      kind: "ok",
      value: [],
    });
    expect(
      writeStatePlan(stateFile([file], [], numbers).plan((ns) => [...ns, 1])),
    ).toEqual({ kind: "ok", value: [1] });
    // Another process — the CLI, a later daemon — reads the same document.
    expect(stateFile([file], [], numbers).read()).toEqual({
      kind: "ok",
      value: [1],
    });
  });

  test("an update that returns what it was given writes nothing", () => {
    const store = stateFile<readonly number[]>([file], [], numbers);
    writeStatePlan(store.plan(() => [1]));
    fs.utimesSync(file, 0, 0);
    expect(writeStatePlan(store.plan((ns) => ns))).toEqual({
      kind: "ok",
      value: [1],
    });
    expect(fs.statSync(file).mtimeMs).toBe(0);
  });

  test("text that does not read is a failure naming the file, never the empty value", () => {
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, "{");
    expect(stateFile([file], [], numbers).read()).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining(`${file} is not JSON: `),
    });
    fs.writeFileSync(file, '["x"]');
    expect(stateFile([file], [], numbers).read()).toEqual({
      kind: "failed",
      reason: `${file} is not a list of numbers`,
      file,
    });
  });

  test("a file that cannot be read for any reason but absence is a failure naming it", () => {
    fs.mkdirSync(file, { recursive: true });
    expect(stateFile([file], [], numbers).read()).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining(`${file}: not a file`),
    });
  });

  test("a write over a file that does not read sets it aside beside itself and starts from empty", () => {
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, "junk");
    const planned = stateFile([file], [], numbers).plan((ns) => [...ns, 1]);
    expect(writeStatePlan(planned)).toEqual({ kind: "ok", value: [1] });
    const aside = planned.kind === "ok" ? planned.value.setAside : null;
    expect(aside?.from).toBe(file);
    expect(aside?.to.startsWith(`${file}.unread-`)).toBe(true);
    expect(fs.readFileSync(aside!.to, "utf8")).toBe("junk");
    expect(stateFile([file], [], numbers).read()).toEqual({
      kind: "ok",
      value: [1],
    });
  });

  test("a write that fails throws: a fault, never the refusal a file that does not read is", () => {
    // The directory refuses the write, while the file itself is absent and so
    // reads.
    fs.mkdirSync(path.dirname(file));
    fs.chmodSync(path.dirname(file), 0o500);
    try {
      expect(() =>
        writeStatePlan(stateFile([file], [], numbers).plan((ns) => [...ns, 1])),
      ).toThrow(expect.objectContaining({ code: "EACCES" }));
    } finally {
      fs.chmodSync(path.dirname(file), 0o700);
    }
    expect(fs.readdirSync(path.dirname(file))).toEqual([]);
  });
});
