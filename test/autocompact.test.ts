// [LAW:verifiable-goals] brandon-context-ceiling-xta.e3p: the `autocompact`
// segment and its controls, driven through the real loader, the real spine
// (registerDslConfig + renderDsl) and the real slash verb, with a fake Claude
// input edge standing in for the tmux pane — plus the settings read and the
// payload projection. Typing into a real pane is test/claude-input.test.ts's.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { testVerbContext, effectsOf, clickUrl } from "./helpers/click";
import { VERB_SLASH } from "../src/click/wire";
import {
  SESSION_CLIENT_HINTS_KEY,
  SESSION_RENDER_ORIGIN_KEY,
  encodeRenderOrigin,
} from "../src/daemon/verbs";
import type { ClaudeInputEdge } from "../src/claude-input/edge";
import {
  AUTOCOMPACT_WINDOWS,
  readAutoCompactWindow,
} from "../src/segments/autocompact";
import { projectAutoCompact } from "../src/daemon/render-payload";
import { ABSENT, failed, ok } from "../src/utils/outcome";
import { linkUrls, stripAnsi } from "./helpers/ansi";

const ALLOWED = new Set(listResolvablePaletteNames());
const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};
const HINT = { socket: "/tmp/tmux.sock", pane: "%7", truecolor: null };

function runtime(
  autocompact: Record<string, unknown> | undefined,
  windowSize = 1_000_000,
) {
  const config = parseAndValidate(
    "<user>",
    `{ globals: {}, root: { h: ['autocompact'] } }`,
    ALLOWED,
    DEFAULT_DSL_CONFIG,
  );
  const sessionState = new SessionState();
  sessionState.set(
    "s1",
    SESSION_RENDER_ORIGIN_KEY,
    encodeRenderOrigin({ projectDir: "/tmp/proj", cwd: "/tmp/proj", configFile: null }),
  );
  sessionState.set("s1", SESSION_CLIENT_HINTS_KEY, JSON.stringify({ tmux: HINT }));
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { cwd: "/tmp/proj" });
  const payload = {
    session_id: "s1",
    context: { totalTokens: 1, contextLeft: 99, windowSize },
    ...(autocompact !== undefined && { autocompact }),
  };
  const raw = renderDsl(config, compiled, store, registry, payload, OPTS);
  const typed: string[] = [];
  const claudeInput: ClaudeInputEdge = {
    read: () => ({ inMode: false, screen: ["─".repeat(30), "❯ ", "─".repeat(30)] }),
    type: (_hint, line) => {
      typed.push(line);
      return { kind: "typed" };
    },
  };
  const ctx = { ...testVerbContext(sessionState, undefined, config), claudeInput };
  const urls = linkUrls(raw).filter((u) =>
    effectsOf(u).some((e) => e.verb === VERB_SLASH),
  );
  // What each control types, in the order the cell draws them.
  const lines = urls.map((u) => effectsOf(u)[0]!.args[1]);
  return { text: stripAnsi(raw), urls, lines, ctx, typed };
}

describe("the autocompact segment", () => {
  test("not read: no cell", () => {
    expect(runtime(undefined).text).not.toContain("⇲");
  });

  test("auto on a 1M model: steps down from the window, nothing above it, no ↺", () => {
    const rt = runtime({ window: 0 });
    expect(rt.text).toContain("⇲ auto −");
    expect(rt.text).not.toContain("+");
    expect(rt.lines).toEqual(["/autocompact 900000"]);
  });

  test("auto on a 200K model: steps down to 100K only", () => {
    const rt = runtime({ window: 0 }, 200_000);
    expect(rt.lines).toEqual(["/autocompact 100000"]);
  });

  test("a set window: −, + and ↺ type the neighbouring windows and auto", () => {
    const rt = runtime({ window: 400_000 });
    expect(rt.text).toContain("⇲ 400.0K − + ↺");
    expect(rt.lines).toEqual([
      "/autocompact 300000",
      "/autocompact 500000",
      "/autocompact auto",
    ]);
  });

  test("a window typed off the 100K grid steps onto it, both ways", () => {
    expect(runtime({ window: 450_000 }).lines).toEqual([
      "/autocompact 400000",
      "/autocompact 500000",
      "/autocompact auto",
    ]);
  });

  test("the ends of the range: no − at 100K, no + at the model's window", () => {
    expect(runtime({ window: 100_000 }).lines).toEqual([
      "/autocompact 200000",
      "/autocompact auto",
    ]);
    expect(runtime({ window: 200_000 }, 200_000).lines).toEqual([
      "/autocompact 100000",
      "/autocompact auto",
    ]);
  });

  test("an unreadable settings file is shown in the cell, with no controls", () => {
    const rt = runtime({ error: "cannot read /x/settings.json: not a JSON object" });
    expect(rt.text).toContain("⇲ ⚠ cannot read /x/settings.json: not a JSON object");
    expect(rt.lines).toEqual([]);
  });

  test("a click types its line into the session", () => {
    const rt = runtime({ window: 400_000 });
    clickUrl(rt.urls[1]!, rt.ctx);
    expect(rt.typed).toEqual(["/autocompact 500000"]);
  });

  test("every offered window is a declared line: auto, then 100K to 1M", () => {
    const declared = Object.entries(DEFAULT_DSL_CONFIG.actions)
      .filter(([name]) => name.startsWith("autocompact."))
      .map(([, a]) => ("slash" in a ? a.slash : undefined));
    expect(declared).toEqual([
      "/autocompact auto",
      ...AUTOCOMPACT_WINDOWS.map((w) => `/autocompact ${w}`),
    ]);
    expect(AUTOCOMPACT_WINDOWS[0]).toBe(100_000);
    expect(AUTOCOMPACT_WINDOWS.at(-1)).toBe(1_000_000);
  });
});

describe("readAutoCompactWindow / projectAutoCompact", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-autocompact-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = (text: string): string => {
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, text);
    return file;
  };

  test("no settings file, or no key: auto", async () => {
    expect(await readAutoCompactWindow(path.join(dir, "missing.json"))).toEqual(ok("auto"));
    expect(await readAutoCompactWindow(settings(`{ "model": "opus" }`))).toEqual(ok("auto"));
  });

  test("the window /autocompact wrote", async () => {
    expect(
      await readAutoCompactWindow(settings(`{ "autoCompactWindow": 400000 }`)),
    ).toEqual(ok(400_000));
  });

  test("an unparseable file or a non-number fails, naming the file", async () => {
    const bad = settings("{ not json");
    const r1 = await readAutoCompactWindow(bad);
    expect(r1.kind === "failed" && r1.reason).toContain(bad);
    const r2 = await readAutoCompactWindow(settings(`{ "autoCompactWindow": "big" }`));
    expect(r2.kind === "failed" && r2.reason).toMatch(/autoCompactWindow is "big"/);
  });

  test("the payload: auto is 0, failed carries the reason, absent drops the family", () => {
    expect(projectAutoCompact(ok("auto"))).toEqual({ window: 0 });
    expect(projectAutoCompact(ok(300_000))).toEqual({ window: 300_000 });
    expect(projectAutoCompact(failed("nope"))).toEqual({ error: "nope" });
    expect(projectAutoCompact(ABSENT)).toBeUndefined();
  });
});
