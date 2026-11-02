import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

// [LAW:verifiable-goals] Each test file runs under exactly one tier's config.
// The configs select and ignore by directory (test/helpers/tiers.cjs), and four
// hand-written selections agreeing is what keeps a file from running twice, or
// under none, so this reads what each config lists with jest's own --listTests.

import { PROCESS_TIER_DIR, UNIT_DIR } from "../helpers/tiers.cjs";

const ROOT = resolve(__dirname, "../..");
const JEST = join(ROOT, "node_modules", "jest", "bin", "jest.js");
const TIERS = ["unit", "worker", "process", "e2e"] as const;

function testFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFilesUnder(path);
    return entry.name.endsWith(".test.ts") ? [relative(ROOT, path)] : [];
  });
}

type Tier = (typeof TIERS)[number];

async function listed(tier: Tier): Promise<string[]> {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [JEST, "--config", `jest.${tier}.config.js`, "--listTests"],
    { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 },
  ).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
  return stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((file) => relative(ROOT, file));
}

async function listAll(): Promise<Record<Tier, string[]>> {
  const lists = await Promise.all(TIERS.map(listed));
  return Object.fromEntries(TIERS.map((tier, at) => [tier, lists[at]])) as Record<Tier, string[]>;
}

test("every test file is selected by exactly one tier", async () => {
  const lists = await listAll();
  const tiersOf = new Map<string, string[]>();
  for (const tier of TIERS) {
    for (const file of lists[tier]) tiersOf.set(file, [...(tiersOf.get(file) ?? []), tier]);
  }

  const onDisk = testFilesUnder(join(ROOT, "test"));
  const unrun = onDisk.filter((file) => !tiersOf.has(file));
  const twice = [...tiersOf].filter(([, tiers]) => tiers.length !== 1).map(([file, tiers]) => `${file}: ${tiers}`);
  const vanished = [...tiersOf.keys()].filter((file) => !onDisk.includes(file));

  expect({ unrun, twice, vanished }).toEqual({ unrun: [], twice: [], vanished: [] });
}, 120_000);

// A tier that is selected and never run proves nothing: each has a script, the
// whole-suite script runs the three that need no sign-off, and CI runs and
// reports each.
test("every tier is run by its script, by pnpm test and by CI", () => {
  const scripts = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> })
    .scripts;
  const workflow = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const recorded = ["unit", "worker", "process"];

  for (const tier of TIERS) {
    expect(scripts[`test:${tier}`]).toContain(`jest.${tier}.config.js`);
    expect(workflow).toContain(`pnpm test:${tier}`);
  }
  for (const tier of recorded) expect(scripts.test).toContain(`test:${tier}`);
  expect(workflow).toContain(`--runs ${recorded.join(",")}`);
});

test("the unit and process tiers hold their directory and the worker tier holds neither", async () => {
  const lists = await listAll();
  const within = (dir: string) => (file: string) => file.startsWith(`${dir}/`);
  expect(lists.unit.length).toBeGreaterThan(0);
  expect(lists.unit.every(within(UNIT_DIR))).toBe(true);
  expect(lists.process.length).toBeGreaterThan(0);
  expect(lists.process.every(within(PROCESS_TIER_DIR))).toBe(true);
  expect(lists.worker.some((file) => within(UNIT_DIR)(file) || within(PROCESS_TIER_DIR)(file))).toBe(false);
}, 120_000);
