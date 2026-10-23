// The heap tools' snapshot parser reads a file too large to be one string
// byte by byte (brandon-unfiled-3248.8ro6), so a truncated or foreign file is
// its own to refuse: a post-mortem the SIGKILL backstop cut short must fail
// loudly, never hang the tool or print a smaller heap.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(__dirname, "..", "scripts", "heap-analyze.mjs");

// One `Foo` object with no edges, laid out as V8 writes it: each node's row
// ends with a newline straight after its last digit.
const HEADER =
  '{"snapshot":{"meta":{"node_fields":["type","name","id","self_size","edge_count","trace_node_id","detachedness"],' +
  '"node_types":[["hidden","object"],"string","number","number","number","number","number"],' +
  '"edge_fields":["type","name_or_index","to_node"],"edge_types":[["property"],"string_or_number","node"]},' +
  '"node_count":1,"edge_count":0},\n';
const WHOLE = `${HEADER}"nodes":[1,0,1,48,0,0,0\n],\n"edges":[],\n"strings":["Foo"]}`;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "heap-analyze-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function analyze(text: string) {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.heapsnapshot`);
  writeFileSync(path, text);
  return spawnSync(process.execPath, [SCRIPT, path, "--json"], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

function histogram(text: string) {
  const run = analyze(text);
  expect(run.stderr).toBe("");
  return JSON.parse(run.stdout).histogram;
}

test("a whole snapshot reads its one node", () => {
  expect(histogram(WHOLE)).toEqual([
    { label: "object / Foo", count: 1, selfSize: 48 },
  ]);
});

// A node's self_size is a size_t: a 4 GiB backing store is one node.
test("a self size past 2^32 reads as itself", () => {
  expect(histogram(WHOLE.replace("48", "4294967296"))).toEqual([
    { label: "object / Foo", count: 1, selfSize: 4294967296 },
  ]);
});

test.each([
  [
    "cut inside a string",
    WHOLE.slice(0, WHOLE.indexOf("Foo") + 2),
    /not a list of strings/,
  ],
  [
    "cut between strings",
    `${HEADER}"nodes":[1,0,1,48,0,0,0\n],\n"edges":[],\n"strings":["Foo",`,
    /not a list of strings/,
  ],
  [
    "a value past 2^53",
    WHOLE.replace("48", "9007199254740993"),
    /not a list of unsigned integers up to/,
  ],
  [
    "a negative value",
    WHOLE.replace("48", "-48"),
    /not a list of unsigned integers up to/,
  ],
  [
    "two numbers joined by whitespace",
    WHOLE.replace("48", "4 8"),
    /not a list of unsigned integers up to/,
  ],
  [
    "fewer values than the header counts",
    WHOLE.replace("48,", ""),
    /counts 7 values, the array holds 6/,
  ],
  [
    "more values than the header counts",
    WHOLE.replace("0,0,0\n]", "0,0,0,9\n]"),
    /counts 7 values, the array holds 8/,
  ],
  [
    "an empty element",
    WHOLE.replace('"edges":[]', '"edges":[,,]'),
    /not a list of unsigned/,
  ],
  [
    "a trailing comma",
    WHOLE.replace("0,0,0\n]", "0,0,0,\n]"),
    /not a list of unsigned/,
  ],
  [
    "two strings with no comma between them",
    WHOLE.replace('["Foo"]', '["Foo""Bar"]'),
    /not a list of strings/,
  ],
])("%s is refused", (_case, text, message) => {
  const run = analyze(text);
  // A hang is a timeout (status null), not a refusal.
  expect(run.error).toBeUndefined();
  expect(run.status).toBe(1);
  expect(run.stderr).toMatch(message);
});
