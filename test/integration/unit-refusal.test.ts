import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

// Each surface a unit test may not reach fails at the call, naming it and the test.
test.each([
  ["writes a file", "filesystem", "fs.writeFileSync("],
  ["watches a directory", "filesystem", "fs.watch("],
  ["reads outside the package", "filesystem", "fs.readFileSync("],
  ["listens on a socket", "socket", "net.createServer("],
  ["asks the network with fetch", "network", "fetch("],
  ["asks the network with http", "network", "http.get("],
  ["spawns a child process", "child process", "child_process.spawnSync("],
  ["reads the wall clock with Date.now", "clock", "Date.now("],
  ["reads the wall clock with new Date", "clock", "new Date("],
  ["reads the wall clock with performance.now", "clock", "performance.now("],
  ["waits on a real timer", "clock", "setTimeout("],
  ["reads what a run left in the checkout", "filesystem", "fs.readFileSync("],
  ["sleeps on timers/promises", "clock", "timers/promises.setTimeout("],
  ["constructs a socket", "socket", "new net.Socket("],
  ["constructs an http request", "network", "new http.ClientRequest("],
  ["constructs a dns resolver", "network", "new dns.Resolver("],
  ["constructs a file read stream", "filesystem", "new fs.ReadStream("],
  ["starts an abort timeout", "clock", "AbortSignal.timeout("],
  ["reads process uptime", "clock", "process.uptime("],
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
