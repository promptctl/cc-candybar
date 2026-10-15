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

// [LAW:no-silent-failure] A file this definition was not written for is ⚠,
// never a guess at what its fields mean.
test("an unknown schema_version is a render error naming it", async () => {
  litWrote({ schema_version: 2, working_on: ticket("w-9"), next: null });
  expect(fatal(await bar())).toContain("lit statusline.json is schema_version 2; this plugin reads 1");
});
