// [LAW:behavior-not-structure] The host's interpreter of a `change`: it lands
// the change on the file as the file stands, keeping every byte it does not
// touch; it refuses a change whose setting moved, naming the setting and the
// file and writing nothing; and a file it cannot write is its outcome, never
// a throw.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { diffChanges } from "../src/config/config-changes";
import type { SessionId } from "../src/daemon/foundations/session-id";
import { performChange } from "../src/daemon/effect-interpreter";
import type { EffectId } from "../src/renderer-interface/interface";

const BEFORE = `// mine
{
  globals: { padding: 1, palette: "nord" }, // keep this
}
`;
const AFTER = BEFORE.replace("padding: 1", "padding: 2");

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-interpreter-"));
  file = path.join(dir, "config.json5");
});
afterEach(() => {
  fs.chmodSync(dir, 0o700);
  fs.rmSync(dir, { recursive: true, force: true });
});

const change = (before: string | null, after: string | null) => ({
  kind: "change" as const,
  id: 1 as EffectId,
  session: "s" as SessionId,
  target: { kind: "layer" as const, path: file },
  changes: diffChanges(before, after),
});

test("a change lands on the file as it stands, keeping a hand edit elsewhere", () => {
  const edited = BEFORE.replace('"nord"', '"dracula"');
  fs.writeFileSync(file, edited);
  expect(performChange(change(BEFORE, AFTER))).toEqual({ kind: "ok" });
  expect(fs.readFileSync(file, "utf8")).toBe(edited.replace("padding: 1", "padding: 2"));
});

test("a setting changed since it was read refuses the change by name, writing nothing", () => {
  const moved = BEFORE.replace("padding: 1", "padding: 7");
  fs.writeFileSync(file, moved);
  const outcome = performChange(change(BEFORE, AFTER));
  expect(outcome).toEqual({
    kind: "failed",
    reason: `globals.padding in ${file} changed since it was read (it was 1, it is 7) — nothing was written`,
  });
  expect(fs.readFileSync(file, "utf8")).toBe(moved);
});

test("a first write creates the file, and its undo deletes it", () => {
  expect(performChange(change(null, BEFORE))).toEqual({ kind: "ok" });
  expect(fs.readFileSync(file, "utf8")).toBe(BEFORE);
  expect(performChange(change(BEFORE, null))).toEqual({ kind: "ok" });
  expect(fs.existsSync(file)).toBe(false);
});

test("a file it cannot write is a failed outcome naming the file", () => {
  fs.writeFileSync(file, BEFORE);
  fs.chmodSync(dir, 0o500);
  const outcome = performChange(change(BEFORE, AFTER));
  expect(outcome).toMatchObject({ kind: "failed" });
  expect(outcome.kind === "failed" && outcome.reason).toMatch(
    new RegExp(`^config write failed \\(${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`),
  );
  fs.chmodSync(dir, 0o700);
  expect(fs.readFileSync(file, "utf8")).toBe(BEFORE);
});
