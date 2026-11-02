import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { FS_DESCRIPTOR_OPS } from "../helpers/unit-refusal";
import { MODULES, routesIn } from "../helpers/unit-refusal-routes";

// The unit config run over fixtures that each reach for something a unit test may
// not. A refusal unplugged from jest.unit.config.js (through the real config,
// which the fixtures use) turns the fixture that only it fails green, and its
// case here red. Real jest child processes: nothing else shows the project
// refuses what it names, at the call and with the test named.

const ROOT = resolve(__dirname, "../..");
const JEST = join(ROOT, "node_modules", "jest", "bin", "jest.js");

interface Case {
  title: string;
  status: string;
  failureMessages: string[];
}

let cases: Record<string, Case>;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "unit-refusal-"));
  const json = join(dir, "result.json");
  const output = await new Promise<string>((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      [JEST, "--config", "jest.unit-fixtures.config.js", "--json", `--outputFile=${json}`],
      { cwd: ROOT },
    );
    let text = "";
    child.stdout.on("data", (chunk) => (text += chunk));
    child.stderr.on("data", (chunk) => (text += chunk));
    child.on("error", reject);
    child.on("close", () => resolveRun(text));
  });
  try {
    const result = JSON.parse(readFileSync(json, "utf8")) as {
      testResults: { assertionResults: Case[] }[];
    };
    cases = Object.fromEntries(result.testResults.flatMap((file) => file.assertionResults).map((c) => [c.title, c]));
  } catch (error) {
    throw new Error(`jest wrote no result over the fixtures:\n${output}\n${error}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

const message = (title: string) => (cases[title]?.failureMessages ?? []).join("\n");

// Every route in the table has a case, cut from the same table, and each fails
// at its call. A descriptor operation passes by design: its open was judged.
const routes = MODULES.flatMap(([surface, name, guarding]) =>
  routesIn(name, jest.requireActual(name), guarding)
    .filter((route) => !FS_DESCRIPTOR_OPS.has(route.path.at(-1) ?? ""))
    .map((route) => [surface, route.call] as const),
);

// A row removed from the table takes its guard and its case with it, so the set
// of modules is pinned here: dropping a surface is a change to two places, as
// raising HELPER_START_CEILING is.
test("the table refuses every module that reaches the machine", () => {
  expect(MODULES.map(([, name]) => name).sort()).toEqual(
    [
      "child_process", "cluster", "dgram", "dns", "dns/promises", "fs", "fs/promises", "http", "http2",
      "https", "net", "os", "timers", "timers/promises", "tls", "worker_threads",
    ].sort(),
  );
});

test.each(routes)("a unit test that reaches the %s with %s fails at the call", (surface, call) => {
  expect(cases[call]?.status).toBe("failed");
  expect(message(call)).toContain(`reached the ${surface}: ${call}(`);
  expect(message(call)).toContain(`in test "${call}"`);
});

// The globals, and the reads of what the checkout does not own.
test.each([
  ["asks the network with fetch", "network", "fetch("],
  ["opens a WebSocket", "network", "new WebSocket("],
  ["waits on a real timer", "clock", "setTimeout("],
  ["repeats on a real timer", "clock", "setInterval("],
  ["defers to the real event loop", "clock", "setImmediate("],
  ["reads the wall clock with Date.now", "clock", "Date.now("],
  ["reads the wall clock with new Date", "clock", "new Date("],
  ["reads the wall clock with Date called as a function", "clock", "Date("],
  ["reads the wall clock with performance.now", "clock", "performance.now("],
  ["reads the process clock with hrtime", "clock", "process.hrtime("],
  ["reads the process clock with hrtime.bigint", "clock", "process.hrtime.bigint("],
  ["reads process uptime", "clock", "process.uptime("],
  ["starts an abort timeout", "clock", "AbortSignal.timeout("],
  ["reads outside the package", "filesystem", "fs.readFileSync("],
  ["reads what git ignores", "filesystem", "fs.readFileSync("],
  ["reads inside .git", "filesystem", "fs.readFileSync("],
  ["waits on a real timer after fake time ended", "clock", "setTimeout("],
  ["reads the wall clock after fake time ended", "clock", "Date.now("],
])("a unit test that %s fails at the call", (title, surface, call) => {
  expect(cases[title]?.status).toBe("failed");
  expect(message(title)).toContain(`reached the ${surface}: ${call}`);
  expect(message(title)).toContain(`in test "${title}"`);
});

test("code under test that catches a refusal still fails the test", () => {
  const title = "code under test swallows the refused write";
  expect(cases[title]?.status).toBe("failed");
  expect(message(title)).toContain("refused in this test");
});

test.each([
  "reads a file the package holds",
  "builds a date from a value",
  "waits on a fake timer",
])("a unit test that %s passes", (title) => {
  expect(cases[title]?.status).toBe("passed");
});
