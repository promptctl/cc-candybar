// [LAW:verifiable-goals] Undo/redo driven through the real spine: the loader's
// bare-marker arms, no derived gate, and the daemon's per-config-file history.

import { ownLinks, ownValidators } from "./helpers/ambient-chrome";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { undoEdit, writeValue } from "../src/daemon/config-file-store";
import { getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { ConfigError } from "../src/config/dsl-loader";
import { testVerbContext, effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import { parseEffects, VERB_DISPATCH } from "../src/click/wire";
import { VERBS } from "../src/daemon/verbs";
import type { VerbContext } from "../src/daemon/verbs";
import {
  deriveConfigActionValidators,
  registerConfigValidator,
} from "../src/daemon/verbs/config-validators";
import { durableConfig, type DurableConfig } from "./helpers/durable-config";

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
  // Assertions here are about the fixture's OWN clickable regions.
  return ownLinks(urls);
}

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
    expect(ownValidators(config, deriveConfigActionValidators(config))).toEqual(
      [],
    );
  });
});

let durable: DurableConfig;

// [LAW:one-source-of-truth] The runtime parses `src` for the render AND writes
// the same text as the config file, so a click edits the tree the bar rendered.
function buildRuntime(src: string, sessionId = "s1") {
  if (durable.text() === null) durable.write(src);
  const config = parseAndValidate("<test>", src, ALLOWED);
  const sessionState = new SessionState();
  durable.seedOrigin(sessionState, sessionId);
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
  const ctx: VerbContext = testVerbContext(sessionState);
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

describe("undo/redo click → the config-file history", () => {
  beforeEach(() => {
    durable = durableConfig("cc-candybar-undoredo-");
  });
  afterEach(() => {
    durable.dispose();
  });

  const globals = (): Record<string, unknown> =>
    (durable.parsed().globals ?? {}) as Record<string, unknown>;

  const SRC = `{
    globals: {},
    variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
    actions: {
      pinDracula: { persist: 'palette', to: 'dracula' },
      forgetPalette: { reset: 'palette' },
      removeDirectory: { persist: 'presets.default.root', removeSegment: 'directory' },
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

  function urlFor(
    runtime: ReturnType<typeof buildRuntime>,
    actionName: string,
  ): string {
    const urls = extractUrls(runtime.render());
    const idx = [
      "pinDracula",
      "forgetPalette",
      "removeDirectory",
      "back",
      "fwd",
    ].indexOf(actionName);
    return urls[idx]!;
  }

  test("a persist literal write records a history entry; undo restores the prior text byte-for-byte", () => {
    const runtime = buildRuntime(SRC);
    const original = durable.text()!;
    runtime.click(urlFor(runtime, "pinDracula"));
    expect(globals().palette).toBe("dracula");
    const written = durable.text()!;
    expect(durable.history().past).toEqual([
      { before: original, after: written },
    ]);

    runtime.click(urlFor(runtime, "back"));
    expect(durable.text()).toBe(original);
    const afterUndo = durable.history();
    expect(afterUndo.past).toEqual([]);
    expect(afterUndo.future).toEqual([
      { before: original, after: written },
    ]);

    runtime.click(urlFor(runtime, "fwd"));
    expect(durable.text()).toBe(written);
    const afterRedo = durable.history();
    expect(afterRedo.past).toEqual([
      { before: original, after: written },
    ]);
    expect(afterRedo.future).toEqual([]);
    runtime.dispose();
  });

  test("undo restores the PRIOR value, not just absence", () => {
    const runtime = buildRuntime(SRC);
    runtime.click(urlFor(runtime, "pinDracula"));
    runtime.click(urlFor(runtime, "pinDracula"));
    expect(durable.history().past).toHaveLength(2);
    runtime.click(urlFor(runtime, "back"));
    expect(globals().palette).toBe("dracula");
    expect(durable.history().past).toHaveLength(1);
    expect(durable.history().future).toHaveLength(1);
    runtime.dispose();
  });

  test("reset (a delete) is undoable too — one history over every write shape", () => {
    const runtime = buildRuntime(SRC);
    const original = durable.text()!;
    runtime.click(urlFor(runtime, "pinDracula"));
    const pinned = durable.text()!;
    runtime.click(urlFor(runtime, "forgetPalette"));
    expect(globals().palette).toBeUndefined();
    expect(durable.history().past).toEqual([
      { before: original, after: pinned },
      { before: pinned, after: durable.text() },
    ]);

    runtime.click(urlFor(runtime, "back"));
    expect(durable.text()).toBe(pinned);
    expect(globals().palette).toBe("dracula");
    runtime.dispose();
  });

  test("a structural (root) edit undoes through the SAME mechanism — no layout-specific code", () => {
    const runtime = buildRuntime(SRC);
    const original = durable.text()!;
    runtime.click(urlFor(runtime, "removeDirectory"));
    expect(durable.parsed().root).toEqual({ v: [{ h: ["git"] }, "bar"] });

    runtime.click(urlFor(runtime, "back"));
    // The whole file returns to its prior bytes, comments and all.
    expect(durable.text()).toBe(original);
    runtime.dispose();
  });

  test("undo refuses loudly when the file was hand-edited since the entry", () => {
    const runtime = buildRuntime(SRC);
    runtime.click(urlFor(runtime, "pinDracula"));
    const written = durable.text()!;
    const handEdited = written.replace("'dracula'", "'nord'").replace('"dracula"', '"nord"');
    expect(handEdited).not.toBe(written);
    writeFileSync(durable.configPath, handEdited);

    expect(() => runtime.click(urlFor(runtime, "back"))).toThrow(
      /has changed since that edit/,
    );
    // Nothing was overwritten, and the entry is still there to undo.
    expect(durable.text()).toBe(handEdited);
    expect(durable.history().past).toHaveLength(1);
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
    expect(durable.history().future).toHaveLength(1);

    runtime.click(urlFor(runtime, "pinDracula"));
    expect(durable.history().future).toEqual([]);
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

    // "Restart": a brand-new runtime, same XDG_STATE_HOME, nothing in memory.
    const restarted = buildRuntime(SRC);
    expect(() => restarted.click(urlFor(restarted, "back"))).toThrow(
      /nothing to undo/,
    );
    restarted.click(urlFor(restarted, "fwd"));
    expect(globals().palette).toBe("dracula");
    restarted.dispose();
  });

  // [LAW:types-are-the-program] A snapshot lives under its file's key, so an
  // undo from project A cannot reach a write made to project B.
  test("history is one stack per file — undo of A leaves B's file and B's stack untouched", () => {
    const store = { historyPath: durable.historyPath, logger: () => {} };
    const fileA = durable.configPath;
    const fileB = join(durable.projectDir, "other-project.json5");
    writeFileSync(fileB, "{ globals: { palette: 'nord' } }\n");
    const originalA = durable.text()!;
    const originalB = readFileSync(fileB, "utf8");

    writeValue(store, fileA, "palette", "dracula");
    writeValue(store, fileB, "palette", "dracula");
    const editedB = readFileSync(fileB, "utf8");

    expect(undoEdit(store, fileA)).toEqual({
      before: originalA,
      after: durable.history(fileA).future[0]!.after,
    });
    expect(durable.text()).toBe(originalA);
    expect(readFileSync(fileB, "utf8")).toBe(editedB);
    expect(durable.history(fileB).past).toHaveLength(1);
    expect(durable.history(fileB).future).toEqual([]);

    writeValue(store, fileA, "palette", "nord");
    expect(durable.history(fileA).future).toEqual([]);
    expect(undoEdit(store, fileB)).toEqual({ before: originalB, after: editedB });
    expect(readFileSync(fileB, "utf8")).toBe(originalB);
  });

  test("the ring is bounded — the oldest entry drops once MAX_HISTORY_DEPTH is exceeded", () => {
    const runtime = buildRuntime(SRC);
    for (let i = 0; i < 51; i++) {
      runtime.click(urlFor(runtime, "pinDracula"));
    }
    const history = durable.history();
    expect(history.past).toHaveLength(50);
    expect(history.future).toEqual([]);
    runtime.dispose();
  });
});
