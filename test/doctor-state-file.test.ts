// The one policy every doctor state file holds (src/doctor/state-file.ts):
// absent is the empty value, anything else must read, and nothing is written
// over a file that does not.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stateFile } from "../src/doctor/state-file";
import type { Asked } from "../src/doctor/checks";

const numbers = (doc: unknown): Asked<readonly number[]> =>
  Array.isArray(doc) && doc.every((n) => typeof n === "number")
    ? { kind: "ok", value: doc }
    : { kind: "failed", reason: "is not a list of numbers" };

describe("a doctor state file", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-state-file-"));
    file = path.join(dir, "state", "numbers.json");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("absent is the empty value; an update is read back by the next reader, its directory made", () => {
    expect(stateFile(file, [], numbers).read()).toEqual({ kind: "ok", value: [] });
    expect(stateFile(file, [], numbers).update((ns) => [...ns, 1])).toEqual([1]);
    // Another process — the CLI, a later daemon — reads the same document.
    expect(stateFile(file, [], numbers).read()).toEqual({ kind: "ok", value: [1] });
  });

  test("an update that returns what it was given writes nothing", () => {
    const store = stateFile<readonly number[]>(file, [], numbers);
    store.update(() => [1]);
    fs.utimesSync(file, 0, 0);
    expect(store.update((ns) => ns)).toEqual([1]);
    expect(fs.statSync(file).mtimeMs).toBe(0);
  });

  test("text that does not read is a failure naming the file, never the empty value", () => {
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, "{");
    expect(stateFile(file, [], numbers).read()).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining(`${file} is not JSON: `),
    });
    fs.writeFileSync(file, '["x"]');
    expect(stateFile(file, [], numbers).read()).toEqual({
      kind: "failed",
      reason: `${file} is not a list of numbers`,
    });
  });

  test("a file that cannot be read for any reason but absence is a failure naming it", () => {
    fs.mkdirSync(file, { recursive: true });
    expect(stateFile(file, [], numbers).read()).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining(`${file}: EISDIR`),
    });
  });

  test("nothing is filed over a file that does not read", () => {
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, "junk");
    expect(() => stateFile(file, [], numbers).update((ns) => [...ns, 1])).toThrow(
      `doctor: nothing filed over a file that does not read: ${file} is not JSON`,
    );
    expect(fs.readFileSync(file, "utf8")).toBe("junk");
  });
});
