// [LAW:verifiable-goals] brandon-context-ceiling-xta.e3p: the `autocompact`
// segment and its controls, driven through the real loader, the real spine
// (registerDslConfig + renderDsl) and the real slash verb, with a fake Claude
// input edge standing in for the tmux pane. Each render's payload comes from
// the daemon's own projection (projectAutoCompact) of a settings read, so the
// cell is tested against what the daemon sends. Typing into a real pane is
// test/claude-input.test.ts's; the lane itself is
// test/render-payload-outcomes.test.ts's.

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
  autoCompactControls,
  readAutoCompactWindow,
  type AutoCompactWindow,
} from "../src/segments/autocompact";
import { projectAutoCompact } from "../src/daemon/render-payload";
import { ABSENT, failed, ok, type Outcome } from "../src/utils/outcome";
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
  read: Outcome<AutoCompactWindow>,
  contextWindow = 1_000_000,
) {
  const autocompact = projectAutoCompact(read, contextWindow);
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
    context: { totalTokens: 1, contextLeft: 99 },
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
    expect(runtime(ABSENT).text).not.toContain("⇲");
  });

  test("auto on a 1M model: steps down from the window, nothing above it, no ↺", () => {
    const rt = runtime(ok("auto"));
    expect(rt.text).toContain("⇲ auto −");
    expect(rt.text).not.toContain("+");
    expect(rt.lines).toEqual(["/autocompact 900000"]);
  });

  test("auto on a 200K model: steps down to 100K only", () => {
    const rt = runtime(ok("auto"), 200_000);
    expect(rt.lines).toEqual(["/autocompact 100000"]);
  });

  test("a set window: −, + and ↺ type the neighbouring windows and auto", () => {
    const rt = runtime(ok(400_000));
    expect(rt.text).toContain("⇲ 400.0K − + ↺");
    expect(rt.lines).toEqual([
      "/autocompact 300000",
      "/autocompact 500000",
      "/autocompact auto",
    ]);
  });

  test("a window typed off the 100K grid steps onto it, both ways", () => {
    expect(runtime(ok(450_000)).lines).toEqual([
      "/autocompact 400000",
      "/autocompact 500000",
      "/autocompact auto",
    ]);
  });

  test("the ends of the range: no − at 100K, no + at the model's window", () => {
    expect(runtime(ok(100_000)).lines).toEqual([
      "/autocompact 200000",
      "/autocompact auto",
    ]);
    expect(runtime(ok(200_000), 200_000).lines).toEqual([
      "/autocompact 100000",
      "/autocompact auto",
    ]);
  });

  // Claude Code caps a window above the model's context window to it, and the
  // setting is user-global, so a 1M model's window meets a 200K model: the
  // cell shows what applies, and − steps down from there.
  test("a window above the model's context window: the cap, and − steps from it", () => {
    const rt = runtime(ok(800_000), 200_000);
    expect(rt.text).toContain("⇲ 200.0K − ↺");
    expect(rt.lines).toEqual(["/autocompact 100000", "/autocompact auto"]);
  });

  test("an unreadable settings file is shown in the cell, with no controls", () => {
    const rt = runtime(failed("cannot read /x/settings.json: not a JSON object"));
    expect(rt.text).toContain("⇲ ⚠ cannot read /x/settings.json: not a JSON object");
    expect(rt.lines).toEqual([]);
  });

  test("a click types its line into the session", () => {
    const rt = runtime(ok(400_000));
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

describe("readAutoCompactWindow", () => {
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

  test("no settings file, a blank one, or no key: auto", () => {
    expect(readAutoCompactWindow(path.join(dir, "missing.json"))).toEqual(ok("auto"));
    expect(readAutoCompactWindow(settings(" \n"))).toEqual(ok("auto"));
    expect(readAutoCompactWindow(settings(`{ "model": "opus" }`))).toEqual(ok("auto"));
  });

  test("the window /autocompact wrote, on the grid or off it", () => {
    expect(readAutoCompactWindow(settings(`{ "autoCompactWindow": 400000 }`))).toEqual(
      ok(400_000),
    );
    expect(readAutoCompactWindow(settings(`{ "autoCompactWindow": 150000 }`))).toEqual(
      ok(150_000),
    );
  });

  test("an unparseable file fails, naming the file", () => {
    const bad = settings("{ not json");
    const r = readAutoCompactWindow(bad);
    expect(r.kind === "failed" && r.reason).toContain(`cannot read ${bad}`);
  });

  // A value /autocompact could not have written is a hand edit the bar will
  // not guess about — and one it cannot step from without naming an action
  // no config declares.
  test.each([["\"big\""], ["0"], ["-1"], ["99999"], ["1000001"], ["1500000"], ["150000.5"]])(
    "autoCompactWindow %s fails, naming the accepted range",
    (value) => {
      const r = readAutoCompactWindow(settings(`{ "autoCompactWindow": ${value} }`));
      expect(r.kind === "failed" && r.reason).toContain(
        `autoCompactWindow is ${value}, not a window /autocompact accepts (100000–1000000 tokens)`,
      );
    },
  );
});

describe("autoCompactControls / projectAutoCompact", () => {
  test("auto is window 0 and applies nothing the bar knows; it steps from the cap", () => {
    expect(autoCompactControls("auto", 200_000)).toEqual({
      window: 0,
      applied: 0,
      lower: 100_000,
      higher: 0,
    });
  });

  test("an unknown context window caps at the range's top", () => {
    expect(autoCompactControls(1_000_000, undefined)).toEqual({
      window: 1_000_000,
      applied: 1_000_000,
      lower: 900_000,
      higher: 0,
    });
  });

  test("every − and + lands on a declared window", () => {
    for (const w of [100_000, 150_000, 450_000, 1_000_000]) {
      for (const cap of [200_000, 500_000, 1_000_000, undefined]) {
        const c = autoCompactControls(w, cap);
        for (const target of [c.lower, c.higher].filter((t) => t > 0)) {
          expect(AUTOCOMPACT_WINDOWS).toContain(target);
        }
      }
    }
  });

  test("failed carries the reason; absent drops the family", () => {
    expect(projectAutoCompact(failed("nope"), 200_000)).toEqual({ error: "nope" });
    expect(projectAutoCompact(ABSENT, 200_000)).toBeUndefined();
  });
});
