// [LAW:verifiable-goals] The bar draws past a placement of a segment nothing
// declares, but a click never writes one: a write whose result drops a
// placement the file before it did not is refused and the file is untouched;
// a drop the file already held does not lock the bar's controls.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyLayoutOp, writeValues } from "../src/daemon/config-file-store";
import type { ConfigHome } from "../src/config/loader/discovery";

const store = {
  record: () => {},
  logger: { info: () => {}, warn: () => {}, error: () => {} },
} as unknown as Parameters<typeof applyLayoutOp>[0];

let dir: string;
const homeWith = (text: string): ConfigHome => {
  const file = path.join(dir, "config.json5");
  fs.writeFileSync(file, text);
  return { path: file, above: [], repo: null, cwd: null };
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-write-drops-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test("a click that would leave a new undeclared placement is refused, and the file is untouched", () => {
  const text = `{ segments: { a: { template: "a" } }, root: { h: ["a"] } }`;
  const home = homeWith(text);
  expect(() =>
    applyLayoutOp(store, home, "presets.default.root", {
      op: "insert",
      segment: "ghost",
      anchor: "a",
      relation: "after",
    }),
  ).toThrow(/refused: this click would leave[\s\S]*"ghost" does not match/);
  expect(fs.readFileSync(home.path, "utf8")).toBe(text);
});

test("a file that already drops a placement still takes a click", () => {
  const home = homeWith(
    `{ segments: { a: { template: "a" }, b: { template: "b" } }, root: { h: ["a", "gti"] } }`,
  );
  applyLayoutOp(store, home, "presets.default.root", {
    op: "insert",
    segment: "b",
    anchor: "a",
    relation: "after",
  });
  expect(fs.readFileSync(home.path, "utf8")).toContain('"b"');
});

test("a click that repairs a file that would not load is not blamed for the file's own drop", () => {
  const home = homeWith(
    `{ globals: { palette: "no-such-theme" }, segments: { a: { template: "a" } }, root: { h: ["a", "gti"] } }`,
  );
  writeValues(store, home, [["palette", "nord"]]);
  expect(fs.readFileSync(home.path, "utf8")).toContain("nord");
});
