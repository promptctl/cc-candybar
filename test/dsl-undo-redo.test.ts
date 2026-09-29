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
//   4. A click on undo/redo fires the REAL daemon handler, which steps the
//      SESSION's settings history (brandon-save-undo-bwi.jby) one click at a
//      time — a session pick, a `persist` overwrite, a `reset` delete, and a
//      `presets.<name>.root` structural edit through the SAME mechanism.
//   5. Undo at the bottom / redo at the top of the stack are loud
//      BAD_REQUESTs (surfaced as a transient click.error), never silent
//      no-ops.
//   6. A fresh change after an undo truncates the abandoned redo path.
//   7. History survives a restart (a fresh read of the same on-disk files).
//   8. The history is bounded (50 steps).
//   9. Undo refuses loudly when a target changed since the step — a hand
//      edit or another session's write — and never overwrites it.

import { ownLinks, ownValidators } from "./helpers/ambient-chrome";
import { chmodSync, writeFileSync } from "node:fs";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { ConfigError } from "../src/config/dsl-loader";
import { testVerbContext, effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import { VERBS } from "../src/daemon/verbs";
import {
  deriveActionValidators,
  registerStateValidator,
} from "../src/daemon/verbs/state-validators";
import { SettingsHistory } from "../src/daemon/settings-history";
import type { VerbContext } from "../src/daemon/verbs";
import {
  deriveConfigActionValidators,
  registerConfigValidator,
} from "../src/daemon/verbs/config-validators";
import { durableConfig, type DurableConfig } from "./helpers/durable-config";
import { linkUrls } from "./helpers/ansi";

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

function ownUrls(rendered: string): string[] {
  const urls = linkUrls(rendered);
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
    expect(ownValidators(config, deriveConfigActionValidators(config))).toEqual(
      [],
    );
  });
});

// ─── end-to-end: click → real daemon handler → the session's settings history ───

let durable: DurableConfig;

// [LAW:one-source-of-truth] The runtime parses `src` for the render AND
// writes the same text as the session's config file, so the tree a click
// edits is the tree the bar rendered — exactly the daemon's own situation.
// `shared` hands two sessions one SessionState and one history, as the daemon
// has.
function buildRuntime(
  src: string,
  sessionId = "s1",
  shared?: { sessionState: SessionState; history: SettingsHistory },
) {
  if (durable.text() === null) durable.write(src);
  const config = parseAndValidate("<test>", src, ALLOWED);
  const sessionState = shared?.sessionState ?? new SessionState();
  const history = shared?.history ?? durable.historyFor(sessionState);
  durable.seedOrigin(sessionState, sessionId);
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry);
  const render = (): string =>
    renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: sessionId, project_dir: "/tmp/proj" },
      opts(),
    );
  const disposers = [
    ...deriveActionValidators(config).map(({ key, spec }) =>
      registerStateValidator(key, spec),
    ),
    ...deriveConfigActionValidators(config).map(({ key, spec }) =>
      registerConfigValidator(key, spec),
    ),
  ];
  const ctx: VerbContext = {
    ...testVerbContext(sessionState, history),
    configFor: () => config,
  };
  // The whole URL through the verb table, exactly as the daemon's handleClick
  // does — one click, one journal, one step.
  const click = (url: string): void => {
    const { verb, value } = parseHandlerUrl(url);
    const handler = VERBS.get(verb);
    if (!handler) throw new Error(`no handler for verb "${verb}"`);
    handler(value, ctx);
  };
  const dispose = (): void => disposers.forEach((d) => d());
  return { config, store, render, click, dispose, ctx, sessionState, history };
}

const ACTION_ORDER = [
  "pinDracula",
  "pinNord",
  "forgetPalette",
  "removeDirectory",
  "pickTheme",
  "pickPadding",
  "back",
  "fwd",
  "keep",
] as const;

const SRC = `{
  globals: {},
  variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
  actions: {
    pinDracula: { persist: 'palette', to: 'dracula' },
    pinNord: { persist: 'palette', to: 'nord' },
    forgetPalette: { reset: 'palette' },
    removeDirectory: { persist: 'presets.default.root', removeSegment: 'directory' },
    pickTheme: { set: 'theme', to: 'nord' },
    pickPadding: { set: 'padding', to: '3' },
    back: { undo: true },
    fwd: { redo: true },
    keep: { save: true },
  },
  segments: {
    directory: { template: 'd', bg: 'surface', fg: 'foreground' },
    git: { template: 'g', bg: 'surface', fg: 'foreground' },
    bar: {
      template: '${ACTION_ORDER.map((a) => `{{ action "${a}" "${a}" }}`).join(" ")}',
      bg: 'surface', fg: 'foreground',
    },
  },
  root: { v: [ { h: ['directory', 'git'] }, 'bar' ] },
  presets: {},
}`;

type Runtime = ReturnType<typeof buildRuntime>;

function press(runtime: Runtime, action: (typeof ACTION_ORDER)[number]): void {
  runtime.click(ownUrls(runtime.render())[ACTION_ORDER.indexOf(action)]!);
}

describe("undo/redo click → the session's settings history", () => {
  beforeEach(() => {
    durable = durableConfig("cc-candybar-undoredo-");
  });
  afterEach(() => {
    durable.dispose();
  });

  const globals = (): Record<string, unknown> =>
    (durable.parsed().globals ?? {}) as Record<string, unknown>;

  test("a persist write is one step; undo restores the prior text byte-for-byte, redo re-applies it", () => {
    const runtime = buildRuntime(SRC);
    const original = durable.text()!;
    press(runtime, "pinDracula");
    expect(globals().palette).toBe("dracula");
    const written = durable.text()!;
    expect(durable.history().past).toEqual([durable.fileStep(original, written)]);

    press(runtime, "back");
    expect(durable.text()).toBe(original);
    expect(durable.history()).toEqual({
      past: [],
      future: [durable.fileStep(original, written)],
    });

    press(runtime, "fwd");
    expect(durable.text()).toBe(written);
    expect(durable.history()).toEqual({
      past: [durable.fileStep(original, written)],
      future: [],
    });
    runtime.dispose();
  });

  // brandon-save-undo-bwi.jby's acceptance: one history steps a mix of
  // session picks and file writes, each back to exactly the state before it.
  test("undo and redo step a mix of session picks and file writes, in order", () => {
    const runtime = buildRuntime(SRC);
    const theme = (): string | null => runtime.sessionState.get("s1", "theme");
    const padding = (): string | null =>
      runtime.sessionState.get("s1", "padding");
    const original = durable.text()!;

    press(runtime, "pickTheme"); // session
    press(runtime, "pinDracula"); // file
    const pinned = durable.text()!;
    press(runtime, "pickPadding"); // session
    expect([theme(), padding(), globals().palette]).toEqual(["nord", "3", "dracula"]);
    expect(runtime.history.depth("s1")).toEqual({ undo: 3, redo: 0 });

    press(runtime, "back");
    expect([theme(), padding(), durable.text()]).toEqual(["nord", null, pinned]);
    press(runtime, "back");
    expect([theme(), padding(), durable.text()]).toEqual(["nord", null, original]);
    press(runtime, "back");
    expect([theme(), padding(), durable.text()]).toEqual([null, null, original]);
    expect(runtime.history.depth("s1")).toEqual({ undo: 0, redo: 3 });

    press(runtime, "fwd");
    expect([theme(), padding(), durable.text()]).toEqual(["nord", null, original]);
    press(runtime, "fwd");
    expect([theme(), padding(), durable.text()]).toEqual(["nord", null, pinned]);
    press(runtime, "fwd");
    expect([theme(), padding(), durable.text()]).toEqual(["nord", "3", pinned]);
    expect(runtime.history.depth("s1")).toEqual({ undo: 3, redo: 0 });
    runtime.dispose();
  });

  test("undo restores a session pick's PRIOR value, not just absence", () => {
    const src = SRC.replace(
      "pickPadding: { set: 'padding', to: '3' },",
      "pickPadding: { set: 'padding', to: '3' }, pickPadding2: { set: 'padding', to: '5' },",
    );
    const runtime = buildRuntime(src);
    runtime.sessionState.set("s1", "padding", "2");
    press(runtime, "pickPadding");
    expect(runtime.sessionState.get("s1", "padding")).toBe("3");
    press(runtime, "back");
    expect(runtime.sessionState.get("s1", "padding")).toBe("2");
    runtime.dispose();
  });

  test("opening a menu or paging is not a settings change — it never becomes a step", () => {
    const src = SRC.replace(
      "back: { undo: true },",
      "back: { undo: true }, openMenu: { set: 'menus.x', to: 'open' },",
    ).replace('"pickTheme"', '"openMenu"');
    const runtime = buildRuntime(src);
    press(runtime, "pickTheme"); // the slot now renders openMenu
    expect(runtime.sessionState.get("s1", "menus.x")).toBe("open");
    expect(runtime.history.depth("s1")).toEqual({ undo: 0, redo: 0 });
    runtime.dispose();
  });

  test("a click that changes nothing records no step", () => {
    const runtime = buildRuntime(SRC);
    press(runtime, "pinDracula");
    press(runtime, "pinDracula"); // already dracula — the file does not change
    press(runtime, "pickTheme");
    press(runtime, "pickTheme"); // already nord
    expect(durable.history().past).toHaveLength(2);
    runtime.dispose();
  });

  test("reset (a delete) is undoable too — one history over every write shape", () => {
    const runtime = buildRuntime(SRC);
    const original = durable.text()!;
    press(runtime, "pinDracula");
    const pinned = durable.text()!;
    press(runtime, "forgetPalette");
    expect(globals().palette).toBeUndefined();
    expect(durable.history().past).toEqual([
      durable.fileStep(original, pinned),
      durable.fileStep(pinned, durable.text()!),
    ]);

    press(runtime, "back"); // undo the reset
    expect(durable.text()).toBe(pinned);
    expect(globals().palette).toBe("dracula");
    runtime.dispose();
  });

  test("a structural (root) edit undoes through the SAME mechanism — no layout-specific code", () => {
    const runtime = buildRuntime(SRC);
    const original = durable.text()!;
    press(runtime, "removeDirectory");
    expect(durable.parsed().root).toEqual({ v: [{ h: ["git"] }, "bar"] });

    press(runtime, "back");
    expect(durable.text()).toBe(original);
    runtime.dispose();
  });

  test("a save is one step: undoing it restores the file and leaves the picks as drafts", () => {
    const runtime = buildRuntime(SRC);
    press(runtime, "pickTheme");
    press(runtime, "pickPadding");
    const original = durable.text()!;
    press(runtime, "keep");
    expect(globals()).toMatchObject({ palette: "nord", padding: 3 });
    // The picks stay: the reloaded file resolves to them, so they are no
    // longer drafts, and nothing about the session changed.
    expect(runtime.sessionState.get("s1", "theme")).toBe("nord");
    expect(runtime.sessionState.get("s1", "padding")).toBe("3");
    expect(durable.history().past).toHaveLength(3);

    press(runtime, "back");
    expect(durable.text()).toBe(original);
    expect(runtime.sessionState.get("s1", "theme")).toBe("nord");
    expect(runtime.sessionState.get("s1", "padding")).toBe("3");

    press(runtime, "fwd");
    expect(globals()).toMatchObject({ palette: "nord", padding: 3 });
    runtime.dispose();
  });

  test("undo refuses loudly when the file was hand-edited since, and drops that file's steps so the rest stay steppable", () => {
    const runtime = buildRuntime(SRC);
    press(runtime, "pickTheme");
    press(runtime, "pinDracula");
    const written = durable.text()!;
    const handEdited = written.replace(/dracula/, "gruvbox");
    expect(handEdited).not.toBe(written);
    writeFileSync(durable.configPath, handEdited);

    expect(() => press(runtime, "back")).toThrow(/changed since that edit/);
    // Nothing was overwritten, and the file step is gone: every change this
    // session made to that file chains through the state the hand edit replaced.
    expect(durable.text()).toBe(handEdited);
    expect(runtime.history.depth("s1")).toEqual({ undo: 1, redo: 0 });

    press(runtime, "back"); // the session pick is still undoable
    expect(runtime.sessionState.get("s1", "theme")).toBeNull();
    expect(durable.text()).toBe(handEdited);
    runtime.dispose();
  });

  // The decision the ticket asked for: a session's history is its OWN clicks.
  // Another session's write to the same file is not a step here, and it makes
  // this session's earlier steps on that file unreachable — refused loudly,
  // never overwritten.
  test("another session's write to the same file is never undone from here, and makes this session's earlier file steps refuse", () => {
    const sessionState = new SessionState();
    const history = durable.historyFor(sessionState);
    const a = buildRuntime(SRC, "a", { sessionState, history });
    const b = buildRuntime(SRC, "b", { sessionState, history });
    press(a, "pinDracula");
    press(b, "removeDirectory");
    const afterB = durable.text()!;
    expect(history.depth("a")).toEqual({ undo: 1, redo: 0 });
    expect(history.depth("b")).toEqual({ undo: 1, redo: 0 });

    expect(() => press(a, "back")).toThrow(/changed since that edit/);
    expect(durable.text()).toBe(afterB);
    expect(history.depth("a")).toEqual({ undo: 0, redo: 0 });

    press(b, "back"); // b's own step is intact
    expect(durable.parsed().root).toEqual({ v: [{ h: ["directory", "git"] }, "bar"] });
    expect(globals().palette).toBe("dracula");
    a.dispose();
    b.dispose();
  });

  test("undo at the bottom of the stack is a loud no-op, never silent", () => {
    const runtime = buildRuntime(SRC);
    expect(() => press(runtime, "back")).toThrow(/nothing to undo/);
    runtime.dispose();
  });

  test("redo at the top of the stack is a loud no-op, never silent", () => {
    const runtime = buildRuntime(SRC);
    expect(() => press(runtime, "fwd")).toThrow(/nothing to redo/);
    runtime.dispose();
  });

  test("a fresh change after an undo truncates the abandoned redo path", () => {
    const runtime = buildRuntime(SRC);
    press(runtime, "pinDracula");
    press(runtime, "back");
    expect(durable.history().future).toHaveLength(1);

    press(runtime, "pickTheme"); // a fresh change — of any kind — abandons the redo
    expect(durable.history().future).toEqual([]);
    expect(() => press(runtime, "fwd")).toThrow(/nothing to redo/);
    runtime.dispose();
  });

  test("history survives a restart — a fresh read of the same on-disk files", () => {
    const runtime = buildRuntime(SRC);
    press(runtime, "pinDracula");
    press(runtime, "back");
    runtime.dispose();

    // "Restart": a brand-new runtime and history, same XDG_STATE_HOME,
    // nothing carried over in memory.
    const restarted = buildRuntime(SRC);
    expect(() => press(restarted, "back")).toThrow(/nothing to undo/);
    press(restarted, "fwd"); // redo survived the "restart"
    expect(globals().palette).toBe("dracula");
    restarted.dispose();
  });

  test("the history is bounded — the oldest step drops once 50 are exceeded", () => {
    const runtime = buildRuntime(SRC);
    for (let i = 0; i < 51; i++) {
      press(runtime, i % 2 === 0 ? "pinDracula" : "pinNord");
    }
    expect(durable.history().past).toHaveLength(50);
    expect(durable.history().future).toEqual([]);
    runtime.dispose();
  });
});

describe("settings history: a step lands whole, and records only what landed", () => {
  beforeEach(() => {
    durable = durableConfig("cc-candybar-undoredo-atomic-");
  });
  afterEach(() => {
    chmodSync(durable.projectDir, 0o700);
    durable.dispose();
  });

  test("an undo whose file write fails puts back the session change it already made", () => {
    const sessionState = new SessionState();
    const history = durable.historyFor(sessionState);
    const file = durable.configPath;
    const journal = history.begin();
    journal.sessionState.set("s1", "theme", "nord"); // recorded first
    writeFileSync(file, "{ after: 1 }");
    journal.file("s1", file, "{ before: 1 }", "{ after: 1 }");
    journal.commit();

    chmodSync(durable.projectDir, 0o500); // the file write cannot land
    expect(() => history.undo("s1")).toThrow(/config write failed/);
    expect(sessionState.get("s1", "theme")).toBe("nord");
    expect(durable.text()).toBe("{ after: 1 }");
    expect(history.depth("s1")).toEqual({ undo: 1, redo: 0 });

    chmodSync(durable.projectDir, 0o700); // and once it can, the step is intact
    history.undo("s1");
    expect(sessionState.get("s1", "theme")).toBeNull();
    expect(durable.text()).toBe("{ before: 1 }");
  });

  test("a session write that throws records no step", () => {
    const inner = new SessionState();
    const throwing = {
      get: (sid: string, key: string) => inner.get(sid, key),
      set: () => {
        throw new Error("store refused");
      },
      setBatch: () => {
        throw new Error("store refused");
      },
      clear: (sid: string, key: string) => inner.clear(sid, key),
    };
    const history = new SettingsHistory(throwing, () => {});
    const journal = history.begin();
    expect(() => journal.sessionState.set("s1", "theme", "nord")).toThrow(
      /store refused/,
    );
    journal.commit();
    expect(history.depth("s1")).toEqual({ undo: 0, redo: 0 });
  });

  test("an undo in the same click as a change undoes that change, as two clicks would", () => {
    const src = SRC.replace(
      "back: { undo: true },",
      "back: { undo: true }, pickThenUndo: { do: ['pickTheme', 'back'] },",
    ).replace('"pickPadding"', '"pickThenUndo"');
    const runtime = buildRuntime(src);
    runtime.sessionState.set("s1", "theme", "gruvbox");
    press(runtime, "pickPadding"); // the slot now renders pickThenUndo
    expect(runtime.sessionState.get("s1", "theme")).toBe("gruvbox");
    expect(runtime.history.depth("s1")).toEqual({ undo: 0, redo: 1 });
    press(runtime, "fwd");
    expect(runtime.sessionState.get("s1", "theme")).toBe("nord");
    runtime.dispose();
  });

  test("history is bounded by bytes: the session that changed least recently goes first", () => {
    const history = new SettingsHistory(new SessionState(), () => {});
    const big = (c: string): string => c.repeat(2 * 1024 * 1024);
    const step = (sid: string, file: string, from: string, to: string): void => {
      const journal = history.begin();
      journal.file(sid, file, big(from), big(to));
      journal.commit();
    };
    step("old", "/a", "a", "b"); // 4 MB
    step("new", "/b", "c", "d"); // 4 MB — 8 MB total, at the bound
    expect(history.depth("old")).toEqual({ undo: 1, redo: 0 });
    step("new", "/b", "d", "e"); // 12 MB — over it
    expect(history.depth("old")).toEqual({ undo: 0, redo: 0 });
    expect(history.depth("new")).toEqual({ undo: 2, redo: 0 });
    step("new", "/b", "e", "f"); // a lone session over it loses its oldest step
    expect(history.depth("new")).toEqual({ undo: 2, redo: 0 });
  });
});

describe("settings history: the step and its record land together", () => {
  // A store whose save refuses while `refusing` is set.
  function refusingHistory() {
    const sessionState = new SessionState();
    const gate = { refusing: false };
    const history = new SettingsHistory(sessionState, () => {}, {
      load: () => ({}),
      save: () => {
        if (gate.refusing) throw new Error("history save refused");
      },
    });
    return { sessionState, gate, history };
  }

  test("an undo whose history save fails puts its writes back", () => {
    const { sessionState, gate, history } = refusingHistory();
    const journal = history.begin();
    journal.sessionState.set("s1", "theme", "nord");
    journal.commit();

    gate.refusing = true;
    expect(() => history.undo("s1")).toThrow(/history save refused/);
    expect(sessionState.get("s1", "theme")).toBe("nord");
    expect(history.depth("s1")).toEqual({ undo: 1, redo: 0 });

    gate.refusing = false;
    history.undo("s1");
    expect(sessionState.get("s1", "theme")).toBeNull();
  });

  test("a commit whose save fails reports it once and never records the step later", () => {
    const { gate, history } = refusingHistory();
    const journal = history.begin();
    journal.sessionState.set("s1", "theme", "nord");
    gate.refusing = true;
    expect(() => journal.commit()).toThrow(/history save refused/);
    gate.refusing = false;
    journal.commit();
    expect(history.depth("s1")).toEqual({ undo: 0, redo: 0 });
  });
});
