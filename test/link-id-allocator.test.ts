// The home's link-id counter (src/daemon/link-id-allocator.ts): ids reserved
// on disk a block at a time, so a restarted renderer never reissues one, and a
// file that cannot be used is a fault every bar shows until it can be.

import fs from "node:fs";
import path from "node:path";
import {
  LINK_ID_BLOCK,
  linkIdAllocator,
  type LinkIdAllocator,
} from "../src/daemon/link-id-allocator";
import { heldClock, type HeldClock } from "./helpers/held-clock";
import { jestTmpDir } from "./helpers/jest-tmp";

const RETRY_MS = 1000;

let dir: string;
let file: string;
let clock: HeldClock;
let logs: string[];
const open: LinkIdAllocator[] = [];

beforeEach(() => {
  dir = jestTmpDir("state");
  file = path.join(dir, "link-ids");
  clock = heldClock(new Date("2026-11-06T12:00:00Z"));
  logs = [];
});

afterEach(() => {
  for (const ids of open.splice(0)) ids.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const allocator = (): LinkIdAllocator => {
  const ids = linkIdAllocator({
    file,
    clock,
    retryMs: RETRY_MS,
    log: (level, line) => logs.push(`${level} ${line}`),
  });
  open.push(ids);
  return ids;
};

const mint = (ids: LinkIdAllocator, n: number): Array<number | null> =>
  Array.from({ length: n }, () => ids.next());

test("a daemon that mints nothing touches no disk", () => {
  allocator();
  expect(fs.existsSync(file)).toBe(false);
});

test("ids count from 0 in a new home, and the file holds the end of the block reserved before any of them is issued", () => {
  const ids = allocator();
  expect(mint(ids, 3)).toEqual([0, 1, 2]);
  expect(fs.readFileSync(file, "utf8")).toBe(`${LINK_ID_BLOCK}\n`);
  expect(ids.stats()).toEqual({
    minted: 3,
    reused: 0,
    evicted: 0,
    reservations: 1,
    faults: 0,
  });
});

test("a block used up reserves the next, one write a block", () => {
  const ids = allocator();
  const issued = mint(ids, LINK_ID_BLOCK + 1);
  expect(issued.at(-1)).toBe(LINK_ID_BLOCK);
  expect(ids.stats().reservations).toBe(2);
  expect(fs.readFileSync(file, "utf8")).toBe(`${2 * LINK_ID_BLOCK}\n`);
});

test("a restarted renderer's first id is past every id the last one issued", () => {
  const before = allocator();
  const old = mint(before, 5) as number[];
  before.close();
  const after = allocator();
  expect(after.next()).toBeGreaterThan(Math.max(...old));
});

test("a file that holds no count is a fault naming it and its remedy, issues no id, and is never written over", () => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, "garbage");
  const ids = allocator();
  expect(ids.next()).toBeNull();
  expect(ids.error()).toContain(file);
  expect(ids.error()).toContain("remove it and a new one is made");
  expect(fs.readFileSync(file, "utf8")).toBe("garbage");
  expect(logs.filter((l) => l.startsWith("error"))).toHaveLength(1);
});

test("while faulted, mints touch no disk: one attempt a retry period, however many are asked for", () => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, "garbage");
  const ids = allocator();
  mint(ids, 50);
  expect(ids.stats().faults).toBe(1);
  clock.advance(RETRY_MS);
  mint(ids, 50);
  expect(ids.stats().faults).toBe(2);
  clock.advance(RETRY_MS * 3);
  expect(ids.stats().faults).toBe(5);
  // The reason did not change, so it was logged once.
  expect(logs.filter((l) => l.startsWith("error"))).toHaveLength(1);
});

test("with nothing minting, a fault whose cause is gone clears within one retry period, and the next mint is from the new block", () => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, "garbage");
  const ids = allocator();
  expect(ids.next()).toBeNull();
  fs.rmSync(file);
  clock.advance(RETRY_MS);
  expect(ids.error()).toBeNull();
  expect(ids.next()).toBe(0);
  expect(ids.stats().reservations).toBe(1);
});

test("a state directory that cannot be made is a fault, and once it can be the block lands with nothing of the writer's left beside it", () => {
  // The state directory is a file, so nothing can be made beneath it.
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.writeFileSync(dir, "");
  const ids = allocator();
  expect(ids.next()).toBeNull();
  expect(ids.error()).toMatch(/^link ids: /);
  fs.rmSync(dir);
  fs.mkdirSync(dir);
  clock.advance(RETRY_MS);
  expect(ids.error()).toBeNull();
  expect(fs.readdirSync(dir)).toEqual(["link-ids"]);
});

test("closed, a faulted counter leaves no timer armed", () => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, "garbage");
  const ids = allocator();
  ids.next();
  ids.close();
  clock.advance(RETRY_MS * 5);
  expect(ids.stats().faults).toBe(1);
});

// After its daemon's close the file may be the next daemon's.
test("closed, a counter issues no id and writes nothing, its block spent or not", () => {
  const ids = allocator();
  mint(ids, LINK_ID_BLOCK);
  const held = fs.readFileSync(file, "utf8");
  ids.close();
  expect(ids.next()).toBeNull();
  expect(ids.error()).toBeNull();
  expect(fs.readFileSync(file, "utf8")).toBe(held);
  expect(ids.stats().reservations).toBe(1);
});

test("a count too near the last one for another block is a fault, and the file is left as it was", () => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${10 ** 15 - LINK_ID_BLOCK}\n`);
  const ids = allocator();
  expect(ids.next()).toBeNull();
  expect(ids.error()).toMatch(/too near the last count .*remove it/);
  expect(fs.readFileSync(file, "utf8")).toBe(`${10 ** 15 - LINK_ID_BLOCK}\n`);
});
