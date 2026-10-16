// [LAW:behavior-not-structure] lit's plugin (examples/plugins/lit), installed
// the way lit installs it, over the file lit writes: the bar shows the ticket
// a checkout is working on from `.lit/statusline.json` alone, in the shape
// lit's docs/statusline.md gives it. brandon-plugins-ktag.d6f.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkConfig, type CheckOutcome } from "../src/check";
import { stripAnsi } from "./helpers/daemon-e2e";

const DEFINITION = path.join(__dirname, "..", "examples", "plugins", "lit", "plugin.json5");

let dir: string;
let saved: string | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-lit-plugin-"));
  saved = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(dir, "data");
  const installed = path.join(dir, "data", "cc-candybar", "plugins", "lit");
  fs.mkdirSync(installed, { recursive: true });
  fs.copyFileSync(DEFINITION, path.join(installed, "plugin.json5"));
  fs.mkdirSync(path.join(dir, "repo", ".git"), { recursive: true });
});
afterEach(() => {
  process.env.XDG_DATA_HOME = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

const ticket = (id: string, title = `${id} title`) => ({ ticket: { id, title }, recorded_at: "2026-10-15T13:59:25Z" });

// What lit last wrote in the checkout, or nothing at all.
function litWrote(file: unknown): void {
  if (file === undefined) return;
  fs.mkdirSync(path.join(dir, "repo", ".lit"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "repo", ".lit", "statusline.json"),
    typeof file === "string" ? file : JSON.stringify(file),
  );
}

async function bar(placements = `"plugins.lit.ticket", "plugins.lit.next"`): Promise<CheckOutcome> {
  const config = path.join(dir, "config.json5");
  fs.writeFileSync(config, `{ root: { h: ["directory", ${placements}] } }`);
  return checkConfig(config, path.join(dir, "repo"));
}

function rendered(o: CheckOutcome): string {
  if (o.kind !== "clean") throw new Error(`expected clean, got ${JSON.stringify(o)}`);
  return stripAnsi(o.rendered);
}

function fatal(o: CheckOutcome): string {
  if (o.kind !== "fatal") throw new Error(`expected fatal, got ${JSON.stringify(o)}`);
  return o.message;
}

test("the working ticket shows, and next only when it names another", async () => {
  litWrote({ schema_version: 1, working_on: ticket("w-9"), next: ticket("w-9") });
  const same = rendered(await bar());
  expect(same).toContain("🎫 w-9");
  expect(same).not.toContain("next");

  litWrote({ schema_version: 1, working_on: ticket("w-9"), next: ticket("a-1") });
  expect(rendered(await bar())).toMatch(/🎫 w-9.*next a-1/);
});

test("with nothing worked, next shows lit's pick, or that nothing is ready", async () => {
  litWrote({ schema_version: 1, working_on: null, next: ticket("a-1") });
  const picked = rendered(await bar());
  expect(picked).toContain("next a-1");
  expect(picked).not.toContain("🎫");

  litWrote({ schema_version: 1, working_on: null, next: { ticket: null, recorded_at: "2026-10-15T13:59:25Z" } });
  expect(rendered(await bar())).toContain("next nothing ready");
});

test.each([
  ["no file yet", undefined],
  ["nothing recorded", { schema_version: 1, working_on: null, next: null }],
])("%s draws neither cell", async (_, file) => {
  litWrote(file);
  const out = rendered(await bar());
  expect(out).not.toContain("🎫");
  expect(out).not.toContain("next");
});

test("a placement's title setting adds the title, cut to its width", async () => {
  litWrote({
    schema_version: 1,
    working_on: ticket("w-9", "Refresh tokens survive a clock skew across every region"),
    next: null,
  });
  expect(rendered(await bar(`{ seg: "plugins.lit.ticket", settings: { title: 20 } }`))).toContain(
    "🎫 w-9 Refresh tokens su...",
  );
});

test("a worktree's ticket is the worktree's own file", async () => {
  litWrote({ schema_version: 1, working_on: ticket("main-1"), next: null });
  const wt = path.join(dir, "repo", ".claude", "worktrees", "w");
  fs.mkdirSync(path.join(wt, ".lit"), { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), "gitdir: ../../../.git/worktrees/w\n");
  fs.writeFileSync(
    path.join(wt, ".lit", "statusline.json"),
    JSON.stringify({ schema_version: 1, working_on: ticket("wt-2"), next: null }),
  );
  const config = path.join(dir, "config.json5");
  fs.writeFileSync(config, `{ root: { h: ["directory", "plugins.lit.ticket"] } }`);
  expect(rendered(await checkConfig(config, wt))).toContain("🎫 wt-2");
});

// The stage over the git facts a test names, each pinned by a literal over the
// bundled input of that name; the rest are a clean, synced, PR-less checkout.
async function stage(git: Record<string, string | number> = {}): Promise<string> {
  const facts = { status: "clean", operation: "", ahead: 0, behind: 0, prState: "", ...git };
  const variables = Object.entries(facts)
    .map(([k, v]) => `"git.${k}": { kind: "literal", value: ${JSON.stringify(v)} }`)
    .join(", ");
  const config = path.join(dir, "config.json5");
  fs.writeFileSync(config, `{ variables: { ${variables} }, root: { h: ["directory", "plugins.lit.stage"] } }`);
  return rendered(await checkConfig(config, path.join(dir, "repo")));
}

describe("the work-loop stage", () => {
  const idle = { schema_version: 1, working_on: null, next: null };
  const working = { schema_version: 1, working_on: ticket("w-9"), next: ticket("w-9") };

  test.each([
    ["anything to commit", { status: "dirty" }],
    ["conflicts", { status: "conflicts" }],
    ["an operation in progress", { operation: "rebase" }],
    ["commits to push", { ahead: 1 }],
    ["commits to pull", { behind: 2 }],
  ])("no ticket worked and %s is cleanup", async (_, git) => {
    litWrote(idle);
    expect(await stage(git)).toContain("↻ 1/5 cleanup");
  });

  test("no ticket worked in a clean, synced checkout is pick — lit's pick or not", async () => {
    litWrote(idle);
    expect(await stage()).toContain("↻ 2/5 pick");
    litWrote({ ...idle, next: ticket("a-1") });
    expect(await stage()).toContain("↻ 2/5 pick");
  });

  test.each([
    ["no PR yet", "", "↻ 3/5 work"],
    ["a closed PR", "closed", "↻ 3/5 work"],
    ["an open PR", "open", "↻ 4/5 review"],
    ["a merged PR", "merged", "↻ 5/5 downstream"],
  ])("a worked ticket with %s", async (_, prState, shown) => {
    litWrote(working);
    expect(await stage({ prState, status: "dirty" })).toContain(shown);
  });

  test("no file yet draws no stage", async () => {
    expect(await stage()).not.toContain("↻");
  });

  test("the stage reads the git payload's own fields", async () => {
    // check's payload: dirty, ahead and behind, no PR.
    litWrote(idle);
    expect(rendered(await bar(`"plugins.lit.stage"`))).toContain("↻ 1/5 cleanup");
    litWrote(working);
    expect(rendered(await bar(`"plugins.lit.stage"`))).toContain("↻ 3/5 work");
  });
});

// [LAW:no-silent-failure] A file this definition was not written for is ⚠,
// never a guess at what its fields mean.
test("an unknown schema_version is a render error naming it", async () => {
  litWrote({ schema_version: 2, working_on: ticket("w-9"), next: null });
  expect(fatal(await bar())).toContain("lit statusline.json is schema_version 2; this plugin reads 1");
});
