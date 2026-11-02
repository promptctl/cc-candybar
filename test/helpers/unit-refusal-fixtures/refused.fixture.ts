import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// One test per surface the unit project refuses. Each must fail at its call,
// and test/integration/unit-refusal reads which did and what each said.

test("writes a file", () => {
  fs.writeFileSync(path.join(os.tmpdir(), "unit-refusal-fixture"), "x");
});

test("watches a directory", () => {
  fs.watch(os.tmpdir());
});

test("reads outside the package", () => {
  fs.readFileSync(path.join(os.tmpdir(), "unit-refusal-fixture"));
});

test("listens on a socket", () => {
  net.createServer();
});

test("asks the network with fetch", async () => {
  await fetch("http://127.0.0.1:1");
});

test("asks the network with http", () => {
  http.get("http://127.0.0.1:1");
});

test("spawns a child process", () => {
  spawnSync("true");
});

test("reads the wall clock with Date.now", () => {
  Date.now();
});

test("reads the wall clock with new Date", () => {
  new Date();
});

test("reads the wall clock with performance.now", () => {
  performance.now();
});

test("waits on a real timer", () => {
  setTimeout(() => undefined, 1);
});

test("reads what a run left in the checkout", () => {
  fs.readFileSync(path.join(__dirname, "..", "..", "..", "test-records", "unit.jsonl"));
});

test("sleeps on timers/promises", async () => {
  await sleep(1);
});

test("constructs a socket", () => {
  new net.Socket();
});

test("constructs an http request", () => {
  new http.ClientRequest("http://127.0.0.1:1");
});

test("constructs a dns resolver", () => {
  new dns.Resolver();
});

test("constructs a file read stream", () => {
  const ReadStream = fs.ReadStream as unknown as new (file: string) => unknown;
  new ReadStream(path.join(os.tmpdir(), "unit-refusal-fixture"));
});

test("starts an abort timeout", () => {
  AbortSignal.timeout(1);
});

test("reads process uptime", () => {
  process.uptime();
});
