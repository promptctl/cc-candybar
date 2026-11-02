import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The refusals that are not a module's route: the globals, and reads of what the
// checkout does not own. Each must fail at its call, and
// test/integration/unit-refusal reads which did and what each said. The module
// routes are routes.fixture.ts, one case per row of the table.

test("asks the network with fetch", async () => {
  await fetch("http://127.0.0.1:1");
});

test("opens a WebSocket", () => {
  new WebSocket("ws://127.0.0.1:1");
});

test("waits on a real timer", () => {
  setTimeout(() => undefined, 1);
});

test("repeats on a real timer", () => {
  setInterval(() => undefined, 1);
});

test("defers to the real event loop", () => {
  setImmediate(() => undefined);
});

test("reads the wall clock with Date.now", () => {
  Date.now();
});

test("reads the wall clock with new Date", () => {
  new Date();
});

test("reads the wall clock with Date called as a function", () => {
  Date();
});

test("reads the wall clock with performance.now", () => {
  performance.now();
});

test("reads the process clock with hrtime", () => {
  process.hrtime();
});

test("reads the process clock with hrtime.bigint", () => {
  process.hrtime.bigint();
});

test("reads process uptime", () => {
  process.uptime();
});

test("starts an abort timeout", () => {
  AbortSignal.timeout(1);
});

test("reads outside the package", () => {
  fs.readFileSync(path.join(os.tmpdir(), "unit-refusal-fixture"));
});

test("reads what git ignores", () => {
  fs.readFileSync(path.join(__dirname, "..", "..", "..", "test-records", "unit.jsonl"));
});

test("reads inside .git", () => {
  fs.readFileSync(path.join(__dirname, "..", "..", "..", ".git"));
});
