import { failTest } from "./helpers/threw.js";
// [LAW:verifiable-goals] A click writes the layer its action names, by role,
// in the chain of the snapshot its renderer holds for the session's origin:
// a save names the project's file or the local one, and undo writes back to
// the layer its step wrote. The click proves its write against that held
// snapshot, never the disk, so a hand edit the watch has not reached yet is
// the host's per-setting guard's to judge: one to another setting lands with
// the click, and one to the setting the click writes refuses it, naming the
// setting.

import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { durableConfig, type DurableConfig } from "./helpers/durable-config";
import { DiscoveringCache, originOf } from "./helpers/config-host";
import {
  onLanded,
  testVerbContext,
  verbContextWith,
  CLICK_VERBS,
} from "./helpers/click";
import { answerRepo } from "./helpers/repo-approval";
import { bareGates } from "./helpers/gates";
import { encodeSegments } from "../src/click/wire";
import { type VerbContext } from "../src/renderer/verbs";
import { SessionState } from "../src/renderer/session-state";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { locations, stateDir } from "../src/daemon/paths";
import { memoryLimitBytes } from "../src/daemon/limits";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import { lastClickError } from "../src/daemon/foundations/click-error";
import {
  renderCacheBudget,
  SOURCES_NOTHING,
} from "../src/renderer/render-cache";
import type { RenderOrigin } from "../src/config-hint";
import { systemTimekeeper } from "../src/time";

const S1 = sessionIdOf("s1");
const USER = `{
  globals: { palette: "textual-dark" },
  actions: { pin: { persist: "palette", from: "themes" } },
}
`;
const PROJECT = `{
  // the project's own
  globals: { menuGlyph: "P" },
}
`;

let durable: DurableConfig;
let cleanups: Array<() => void>;
let local: string;
let origin: RenderOrigin;
beforeEach(() => {
  durable = durableConfig("cc-candybar-click-layers-");
  durable.write(USER);
  fs.writeFileSync(durable.projectPath, PROJECT);
  answerRepo(durable.projectDir, "approved", durable.host.env);
  local = path.join(durable.projectDir, ".cc-candybar.local.json5");
  origin = originOf(durable.projectDir, durable.projectDir);
  cleanups = [];
});
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
  durable.dispose();
});

// A session that rendered at the project, clicking over the snapshot the
// render cache holds for its origin; each landing hands the cache the
// origins it moved, as the host does.
function session(): {
  readonly ctx: VerbContext;
  readonly cache: DiscoveringCache;
} {
  const watchers = new WatcherRegistry({
    failed: failTest,
    clock: systemTimekeeper,
    logger: () => {},
  });
  cleanups.push(() => watchers.closeAll());
  const sessionState = new SessionState();
  const cache = new DiscoveringCache(
    {
      clock: systemTimekeeper,
      stateDir: stateDir(durable.host),
      locations: locations(durable.host),
      gates: bareGates(),
      sessionState,
      watchers,
      source: SOURCES_NOTHING,
    },
    { budgetBytes: () => renderCacheBudget(memoryLimitBytes({})) },
  );
  cleanups.push(() => cache.close());
  expect(cache.getOrCreate(origin).lastError).toBeNull();
  durable.seedOrigin(sessionState, S1);
  const ctx = verbContextWith(
    testVerbContext(
      sessionState,
      durable.historyFor(sessionState),
      undefined,
      durable.host,
    ),
    {
      configFor: (o) => cache.getOrCreate(o).state.config,
      snapshotFor: (o) => cache.snapshotFor(o),
    },
  );
  onLanded(ctx, () => cache.configs.again());
  return { ctx, cache };
}

const pin = (ctx: VerbContext, role: string, palette: string): void =>
  CLICK_VERBS.get("set-config")!(
    encodeSegments(["s1", role, "palette", palette]),
    ctx,
  );

const paletteIn = (file: string): unknown =>
  (
    JSON5.parse(fs.readFileSync(file, "utf8")) as {
      globals?: { palette?: unknown };
    }
  ).globals?.palette;

test("a write naming the project layer lands in the project's file, keeping its bytes, and leaves the user's", () => {
  const { ctx } = session();
  pin(ctx, "project", "nord");
  expect(paletteIn(durable.projectPath)).toBe("nord");
  expect(fs.readFileSync(durable.projectPath, "utf8")).toContain(
    "// the project's own",
  );
  expect(durable.text()).toBe(USER);
});

test("a write naming the local layer creates the local file beside the project's", () => {
  const { ctx } = session();
  expect(fs.existsSync(local)).toBe(false);
  pin(ctx, "local", "dracula");
  expect(paletteIn(local)).toBe("dracula");
  expect(fs.readFileSync(durable.projectPath, "utf8")).toBe(PROJECT);
  expect(durable.text()).toBe(USER);
});

test("undo writes back to the layer its step wrote", async () => {
  const { ctx } = session();
  pin(ctx, "project", "nord");
  await CLICK_VERBS.get("undo")!("s1", ctx);
  expect(fs.readFileSync(durable.projectPath, "utf8")).toBe(PROJECT);
  expect(durable.text()).toBe(USER);
});

test("a hand edit the watch has not reached, to another setting, lands with the click", () => {
  const { ctx, cache } = session();
  const edited = PROJECT.replace(`menuGlyph: "P"`, `menuGlyph: "Q"`);
  fs.writeFileSync(durable.projectPath, edited);
  // The click proves against what the renderer holds: the file before the edit.
  const held = cache
    .snapshotFor(origin)
    .chain.find((l) => l.role === "project")!;
  expect(held.content).toEqual({ kind: "text", text: PROJECT });
  pin(ctx, "project", "nord");
  const landed = fs.readFileSync(durable.projectPath, "utf8");
  expect(landed).toContain(`menuGlyph: "Q"`);
  expect(paletteIn(durable.projectPath)).toBe("nord");
  expect(lastClickError(ctx.sessionState, S1)).toBeNull();
});

test("a hand edit the watch has not reached, to the setting the click writes, refuses the click naming it", () => {
  const { ctx } = session();
  pin(ctx, "project", "nord");
  const edited = fs
    .readFileSync(durable.projectPath, "utf8")
    .replace(`"nord"`, `"gruvbox"`);
  fs.writeFileSync(durable.projectPath, edited);
  pin(ctx, "project", "dracula");
  expect(fs.readFileSync(durable.projectPath, "utf8")).toBe(edited);
  expect(lastClickError(ctx.sessionState, S1)?.text).toMatch(
    new RegExp(
      `globals\\.palette in ${durable.projectPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} changed since it was read \\(it was "nord", it is "gruvbox"\\)`,
    ),
  );
});

test("a write naming a layer the origin's chain has no place for is refused, and nothing is written", () => {
  answerRepo(durable.projectDir, "declined", durable.host.env);
  const { ctx } = session();
  expect(() => pin(ctx, "project", "nord")).toThrow(
    "the project layer is not writable: the project layer is the project's, and this session has no approved project",
  );
  expect(fs.readFileSync(durable.projectPath, "utf8")).toBe(PROJECT);
  expect(durable.text()).toBe(USER);
});

test("a write for a session whose origin's snapshot is not held is refused loudly, naming the origin", () => {
  const { ctx: rendered, cache } = session();
  // The session now records an origin no output named, and its gate is the
  // one it was drawn with: only the snapshot is missing.
  const ctx = verbContextWith(rendered, {
    configFor: () => cache.getOrCreate(origin).state.config,
  });
  const named = path.join(durable.projectDir, "named.json5");
  durable.seedOrigin(ctx.sessionState, S1, named);
  expect(() => pin(ctx, "user", "nord")).toThrow(
    `no config is held for origin projectDir=${durable.projectDir}`,
  );
  expect(fs.existsSync(named)).toBe(false);
  expect(durable.text()).toBe(USER);
});
