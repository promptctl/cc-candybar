// [LAW:behavior-not-structure] The shared incremental fold's own contract
// (brandon-activity-ue7), which two providers now depend on: the metrics message
// count and the activity record. Both of its subtle policies are here because
// neither is exercised by an ordinary session — the `reset` arm fires only when a
// /compact rewrites a transcript, and retention only shows itself when the file
// a fold was built from goes away.

import {
  mkdtempSync,
  writeFileSync,
  appendFileSync,
  statSync,
  utimesSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TranscriptFold } from "../src/utils/transcript-fold";
import { clearParseCache, type ParsedEntry } from "../src/utils/claude";

let dir: string;
let tick = 0;

const line = (text: string): string =>
  JSON.stringify({
    timestamp: new Date(1_700_000_000_000 + tick++ * 1000).toISOString(),
    type: "user",
    message: { role: "user", content: text },
  });

// Every fold here counts entries: the smallest projection that makes "how much
// was folded, and from where" visible without reading any internal state.
const counting = (max?: number) =>
  new TranscriptFold<number>(0, (n: number, _e: ParsedEntry) => n + 1, max);

// The fold reads only when the mtime moved, so a test that rewrites a file in the
// same millisecond must say so explicitly.
function moveMtime(path: string): void {
  const future = new Date(Date.now() + 10_000 + tick * 1000);
  utimesSync(path, future, future);
}

function write(path: string, ...lines: string[]): void {
  writeFileSync(path, lines.join("\n") + "\n");
  moveMtime(path);
}

const valueOf = async (
  fold: TranscriptFold<number>,
  id: string,
  path: string,
) => {
  const out = await fold.read(id, path);
  if (out.kind !== "ok") throw new Error(`expected ok, got ${out.reason}`);
  return out.value;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fold-"));
  tick = 0;
  clearParseCache();
});

test("only the appended bytes are folded onto the prior value", async () => {
  const path = join(dir, "a.jsonl");
  write(path, line("one"), line("two"));
  const fold = counting();
  expect(await valueOf(fold, "s", path)).toBe(2);

  appendFileSync(path, line("three") + "\n");
  moveMtime(path);
  expect(await valueOf(fold, "s", path)).toBe(3);
});

// [LAW:one-source-of-truth] The arm the module's comment calls the one that
// drifts first: the prior fold is no longer a PREFIX of this file, so splicing
// the new bytes onto it would count a transcript that no longer exists.
test("a rewrite that shrinks the file re-folds from zero, not onto the prior value", async () => {
  const path = join(dir, "b.jsonl");
  write(path, line("one"), line("two"), line("three"), line("four"));
  const fold = counting();
  expect(await valueOf(fold, "s", path)).toBe(4);

  // What a /compact leaves behind: a much shorter file at the same path.
  write(path, line("summary"));
  expect(await valueOf(fold, "s", path)).toBe(1);
});

test("an unchanged mtime is not re-read, and the prior value stands", async () => {
  const path = join(dir, "c.jsonl");
  write(path, line("one"));
  const fold = counting();
  expect(await valueOf(fold, "s", path)).toBe(1);
  // The mtime IS the freshness signal, so grow the file and put the timestamp
  // back where the fold last saw it: the fast path must answer from the prior
  // value. (A fold that re-read here would splice the new line onto a value that
  // already had it — the double-count the cursor+mtime pair exists to prevent.)
  const before = statSync(path).mtime;
  appendFileSync(path, line("two") + "\n");
  utimesSync(path, before, before);
  expect(await valueOf(fold, "s", path)).toBe(1);
});

test("a session with no transcript is a real zero, never a failure", async () => {
  expect(await valueOf(counting(), "s", join(dir, "missing.jsonl"))).toBe(0);
});

// Retention is observable: the `absent` arm hands back what the session had, so a
// fold that is still retained survives its file going away and an evicted one
// starts from empty. That is what makes the READ-recency re-ordering testable —
// without it, touching an old session through the fast path would not save it.
test("the fast path re-orders for eviction, so a read keeps a session alive", async () => {
  const paths = ["x", "y", "z"].map((n) => join(dir, `${n}.jsonl`));
  for (const p of paths) write(p, line("one"), line("two"));
  const fold = counting(2);

  expect(await valueOf(fold, "x", paths[0]!)).toBe(2);
  expect(await valueOf(fold, "y", paths[1]!)).toBe(2);
  // A fast-path hit on the OLDEST session — no bytes read, but it must count as
  // use, or the next insert evicts the session that was just asked about.
  expect(await valueOf(fold, "x", paths[0]!)).toBe(2);
  expect(await valueOf(fold, "z", paths[2]!)).toBe(2);

  // `y` was the least recently used, so it went; `x` stayed.
  rmSync(paths[0]!);
  rmSync(paths[1]!);
  expect(await valueOf(fold, "x", paths[0]!)).toBe(2);
  expect(await valueOf(fold, "y", paths[1]!)).toBe(0);
});
