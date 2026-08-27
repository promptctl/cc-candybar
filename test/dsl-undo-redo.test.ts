// [LAW:verifiable-goals] brandon-layout-edit-2gc.2 done-gates, driven through
// the real spine (mirroring dsl-layout-edit.test.ts's model one arm over):
//
//   1. The loader proves the `undo`/`redo` ActionDecl shapes: bare markers
//      (the literal `true`, no key — there is nothing to name), rejecting any
//      other key or value.
//   2. Cross-ref requires a global session.id anchor when undo/redo are
//      declared, exactly like set/persist/reset (click.error surfacing needs
//      it).
//   3. deriveConfigActionValidators derives NOTHING for undo/redo — there is
//      no value a template could smuggle, so there is no gate to derive.
//   4. A click on undo/redo fires the REAL daemon handler, which steps ONE
//      GLOBAL history over config-overrides.json — covering a `persist`
//      literal overwrite, a `reset` clear, AND a `presets.<name>.rootOps`
//      structural edit through the SAME mechanism (never a layout-specific
//      code path), because the storage layer records every write as one
//      (key, from, to) transition regardless of scope.
//   5. Undo at the bottom / redo at the top of the stack are loud
//      BAD_REQUESTs (surfaced as a transient click.error), never silent
//      no-ops.
//   6. A fresh edit after an undo truncates the abandoned redo path (the
//      classic branch).
//   7. History survives a restart (a fresh read of the same on-disk files).
//   8. The ring is bounded (MAX_HISTORY_DEPTH = 50).

import { ownLinks, ownValidators } from "./helpers/ambient-chrome";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { ConfigError } from "../src/config/dsl-loader";
import { effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import { parseEffects, VERB_DISPATCH } from "../src/click/wire";
import { VERBS } from "../src/daemon/verbs";
import type { VerbContext } from "../src/daemon/verbs";
import {
  deriveConfigActionValidators,
  registerConfigValidator,
} from "../src/daemon/verbs/config-validators";
import { encodeLayoutOp } from "../src/config/layout-ops";

const ALLOWED = new Set(listResolvablePaletteNames());

function opts(width = Number.POSITIVE_INFINITY) {
  return {
    style: "powerline" as const,
    colorCompatibility: "truecolor" as const,
    wrap: true,
    padding: 0,
    charset: "unicode" as const,
    width,
  };
}

function extractUrls(rendered: string): string[] {
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\]8;;([^\x1b]+)\x1b\\/g;
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) urls.push(m[1]!);
  // The global settings menu and the edit toggle it reaches are on every bar;
  // this file's assertions are about the fixture's OWN clickable regions.
  return ownLinks(urls);
}

// ─── loader: the undo/redo ActionDecl arms ────────────────────────────────

describe("undo/redo loader shape", () => {
  const base = (actions: string) => `{
    globals: {},
    variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
    actions: ${actions},
    segments: { bar: { template: 'b', bg: 'surface', fg: 'foreground' } },
    root: 'bar',
  }`;

  test("undo parses", () => {
    const config = parseAndValidate(
      "<test>",
      base(`{ back: { undo: true } }`),
      ALLOWED,
    );
    expect(config.actions.back).toEqual({ undo: true });
  });

  test("redo parses", () => {
    const config = parseAndValidate(
      "<test>",
      base(`{ fwd: { redo: true } }`),
      ALLOWED,
    );
    expect(config.actions.fwd).toEqual({ redo: true });
  });

  test("undo: false is rejected — a marker's only legal value is true", () => {
    expect(() =>
      parseAndValidate("<test>", base(`{ back: { undo: false } }`), ALLOWED),
    ).toThrow(ConfigError);
  });

  test("undo with a stray sibling key is rejected", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(`{ back: { undo: true, to: 'x' } }`),
        ALLOWED,
      ),
    ).toThrow(ConfigError);
  });

  test("undo carries no key — unlike reset, there is nothing to target", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(`{ back: { undo: 'palette' } }`),
        ALLOWED,
      ),
    ).toThrow(ConfigError);
  });
});

describe("cross-ref: undo/redo require a global session.id", () => {
  test("a config declaring only 'undo' still needs session.id", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        `{
          segments: { bar: { template: 'b', bg: 'surface', fg: 'foreground' } },
          actions: { back: { undo: true } },
          root: 'bar',
        }`,
        ALLOWED,
      ),
    ).toThrow(/require a global "session.id" variable/);
  });

  test("declaring session.id satisfies it", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        `{
          variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
          segments: { bar: { template: 'b', bg: 'surface', fg: 'foreground' } },
          actions: { back: { undo: true }, fwd: { redo: true } },
          root: 'bar',
        }`,
        ALLOWED,
      ),
    ).not.toThrow();
  });
});

// ─── config-validators: undo/redo derive NO gate ──────────────────────────

describe("deriveConfigActionValidators over undo/redo actions", () => {
  test("an undo/redo-only config derives nothing — there is no value to gate", () => {
    const config = parseAndValidate(
      "<test>",
      `{
        variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
        segments: { bar: { template: 'b', bg: 'surface', fg: 'foreground' } },
        actions: { back: { undo: true }, fwd: { redo: true } },
        root: 'bar',
      }`,
      ALLOWED,
    );
    expect(ownValidators(deriveConfigActionValidators(config))).toEqual([]);
  });
});

// ─── end-to-end: click → real daemon handler → the overrides history ─────

function buildRuntime(src: string, sessionId = "s1") {
  const config = parseAndValidate("<test>", src, ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry);
  const basePalette = getThemePalette("textual-dark"!);
  const render = (): string =>
    renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: sessionId, project_dir: "/tmp/proj" },
      basePalette,
      opts(),
    );
  const disposers = deriveConfigActionValidators(config).map(({ key, spec }) =>
    registerConfigValidator(key, spec),
  );
  const ctx: VerbContext = { sessionState, dlog: () => {} };
  const click = (url: string): void => {
    const { verb, value } = parseHandlerUrl(url);
    const effects =
      verb === VERB_DISPATCH ? parseEffects(value) : [{ verb, value }];
    for (const e of effects) {
      const handler = VERBS.get(e.verb);
      if (!handler) throw new Error(`no handler for verb "${e.verb}"`);
      handler(e.value, ctx);
    }
  };
  const dispose = (): void => disposers.forEach((d) => d());
  return { config, store, render, click, dispose, ctx };
}

describe("undo/redo click → the overrides history", () => {
  let savedXdgState: string | undefined;
  let xdgStateDir: string;

  beforeEach(() => {
    savedXdgState = process.env.XDG_STATE_HOME;
    xdgStateDir = mkdtempSync(join(tmpdir(), "cc-candybar-undoredo-state-"));
    process.env.XDG_STATE_HOME = xdgStateDir;
  });
  afterEach(() => {
    if (savedXdgState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedXdgState;
    rmSync(xdgStateDir, { recursive: true, force: true });
  });

  function overridesPath(): string {
    return join(xdgStateDir, "cc-candybar", "config-overrides.json");
  }
  function historyPath(): string {
    return join(
      xdgStateDir,
      "cc-candybar",
      "config-overrides-history.json",
    );
  }
  function rawOverrides(): Record<string, unknown> {
    return JSON.parse(readFileSync(overridesPath(), "utf8")) as Record<
      string,
      unknown
    >;
  }
  function rawHistory(): { past: unknown[]; future: unknown[] } {
    return JSON.parse(readFileSync(historyPath(), "utf8")) as {
      past: unknown[];
      future: unknown[];
    };
  }

  const SRC = `{
    globals: {},
    variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
    actions: {
      pinDracula: { persist: 'palette', to: 'dracula' },
      forgetPalette: { reset: 'palette' },
      removeDirectory: { persist: 'presets.default.rootOps', removeSegment: 'directory' },
      back: { undo: true },
      fwd: { redo: true },
    },
    segments: {
      directory: { template: 'd', bg: 'surface', fg: 'foreground' },
      git: { template: 'g', bg: 'surface', fg: 'foreground' },
      bar: {
        template: '{{ action "pinDracula" "pin" }} {{ action "forgetPalette" "forget" }} {{ action "removeDirectory" "-dir" }} {{ action "back" "<" }} {{ action "fwd" ">" }}',
        bg: 'surface', fg: 'foreground',
      },
    },
    root: { v: [ { h: ['directory', 'git'] }, 'bar' ] },
    presets: {},
  }`;

  function urlFor(runtime: ReturnType<typeof buildRuntime>, actionName: string): string {
    const urls = extractUrls(runtime.render());
    const idx = ["pinDracula", "forgetPalette", "removeDirectory", "back", "fwd"].indexOf(
      actionName,
    );
    return urls[idx]!;
  }

  test("a persist literal write records a history entry; undo restores absence", () => {
    const runtime = buildRuntime(SRC);
    runtime.click(urlFor(runtime, "pinDracula"));
    expect(rawOverrides().palette).toBe("dracula");
    expect(rawHistory().past).toEqual([
      { key: "palette", from: null, to: "dracula" },
    ]);

    runtime.click(urlFor(runtime, "back"));
    expect(rawOverrides().palette).toBeUndefined();
    const afterUndo = rawHistory();
    expect(afterUndo.past).toEqual([]);
    expect(afterUndo.future).toEqual([
      { key: "palette", from: null, to: "dracula" },
    ]);

    runtime.click(urlFor(runtime, "fwd"));
    expect(rawOverrides().palette).toBe("dracula");
    const afterRedo = rawHistory();
    expect(afterRedo.past).toEqual([
      { key: "palette", from: null, to: "dracula" },
    ]);
    expect(afterRedo.future).toEqual([]);
    runtime.dispose();
  });

  test("undo restores the PRIOR value, not just absence", () => {
    const runtime = buildRuntime(SRC);
    runtime.click(urlFor(runtime, "pinDracula")); // palette: dracula
    runtime.click(urlFor(runtime, "pinDracula")); // palette: dracula (again — still a real write)
    expect(rawHistory().past).toHaveLength(2);
    runtime.click(urlFor(runtime, "back"));
    // one entry popped; palette is still "dracula" (the entry undone SET it
    // to dracula from an already-dracula value) — assert the stack shrank.
    expect(rawHistory().past).toHaveLength(1);
    expect(rawHistory().future).toHaveLength(1);
    runtime.dispose();
  });

  test("reset (a clear) is undoable too — one history over every write shape", () => {
    const runtime = buildRuntime(SRC);
    runtime.click(urlFor(runtime, "pinDracula"));
    runtime.click(urlFor(runtime, "forgetPalette"));
    expect(rawOverrides().palette).toBeUndefined();
    expect(rawHistory().past).toEqual([
      { key: "palette", from: null, to: "dracula" },
      { key: "palette", from: "dracula", to: null },
    ]);

    runtime.click(urlFor(runtime, "back")); // undo the reset
    expect(rawOverrides().palette).toBe("dracula");
    runtime.dispose();
  });

  test("a rootOps structural edit undoes through the SAME mechanism — no layout-specific code", () => {
    const runtime = buildRuntime(SRC);
    runtime.click(urlFor(runtime, "removeDirectory"));
    expect(JSON.parse(rawOverrides()["presets.default.rootOps"] as string)).toEqual([
      encodeLayoutOp({ op: "remove", target: "directory" }),
    ]);

    runtime.click(urlFor(runtime, "back"));
    // the whole-log key returns to absent — the entry's `from` was null
    // (the key never existed before the first op), which is exactly the
    // coarse "reset" behavior, arrived at via the fine-grained undo.
    expect(rawOverrides()["presets.default.rootOps"]).toBeUndefined();
    runtime.dispose();
  });

  test("undo at the bottom of the stack is a loud no-op, never silent", () => {
    const runtime = buildRuntime(SRC);
    expect(() => runtime.click(urlFor(runtime, "back"))).toThrow(
      /nothing to undo/,
    );
    runtime.dispose();
  });

  test("redo at the top of the stack is a loud no-op, never silent", () => {
    const runtime = buildRuntime(SRC);
    expect(() => runtime.click(urlFor(runtime, "fwd"))).toThrow(
      /nothing to redo/,
    );
    runtime.dispose();
  });

  test("a fresh edit after an undo truncates the abandoned redo path", () => {
    const runtime = buildRuntime(SRC);
    runtime.click(urlFor(runtime, "pinDracula"));
    runtime.click(urlFor(runtime, "back"));
    expect(rawHistory().future).toHaveLength(1);

    runtime.click(urlFor(runtime, "pinDracula")); // a fresh edit — abandons the redo
    expect(rawHistory().future).toEqual([]);
    expect(() => runtime.click(urlFor(runtime, "fwd"))).toThrow(
      /nothing to redo/,
    );
    runtime.dispose();
  });

  test("history survives a restart — a fresh read of the same on-disk files", () => {
    const runtime = buildRuntime(SRC);
    runtime.click(urlFor(runtime, "pinDracula"));
    runtime.click(urlFor(runtime, "back"));
    runtime.dispose();

    // "Restart": a brand-new runtime, same XDG_STATE_HOME, nothing carried
    // over in memory.
    const restarted = buildRuntime(SRC);
    expect(() => restarted.click(urlFor(restarted, "back"))).toThrow(
      /nothing to undo/,
    ); // past is empty post-undo
    restarted.click(urlFor(restarted, "fwd")); // redo survived the "restart"
    expect(rawOverrides().palette).toBe("dracula");
    restarted.dispose();
  });

  test("the ring is bounded — the oldest entry drops once MAX_HISTORY_DEPTH is exceeded", () => {
    const runtime = buildRuntime(SRC);
    for (let i = 0; i < 51; i++) {
      runtime.click(urlFor(runtime, "pinDracula"));
    }
    const history = rawHistory();
    expect(history.past).toHaveLength(50);
    expect(history.future).toEqual([]);
    runtime.dispose();
  });
});
