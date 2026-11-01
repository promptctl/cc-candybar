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

import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { ownLinks, ownValidators } from "./helpers/ambient-chrome";
import { chmodSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import type { DslConfig } from "../src/config/dsl-types";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { ConfigError } from "../src/config/dsl-loader";
import { testVerbContext, effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import { VERBS } from "../src/daemon/verbs";
import { SettingsHistory } from "../src/daemon/settings-history";
import type { VerbContext } from "../src/daemon/verbs";
import { deriveConfigActionValidators } from "../src/daemon/verbs/config-validators";
import { durableConfig, type DurableConfig } from "./helpers/durable-config";
import { linkUrls } from "./helpers/ansi";
import { instantOf } from "../src/utils/instant";

const ALLOWED = new Set(listResolvablePaletteNames());

function opts(width = Number.POSITIVE_INFINITY) {
  return {
    endcaps: "powerline" as const,
    colorCompatibility: "truecolor" as const,
    wrap: true,
    padding: 0,
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
  const registry = new SourceRegistry(processLauncher, store, "", sessionState);
  const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: process.cwd() });
  const render = (): string =>
    renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: sessionId, project_dir: "/tmp/proj" },
      instantOf(new Date()),
      opts(),
    );
  // The config a click is gated by and a save compares against, re-read from
  // the file on a reload.
  let current: DslConfig = config;
  const ctx: VerbContext = {
    ...testVerbContext(sessionState, history),
    configFor: () => current,
    reloadConfig: () => {
      current = parseAndValidate("<test>", durable.text()!, ALLOWED);
    },
  };
  // The whole URL through the verb table, exactly as the daemon's handleClick
  // does — one click, one journal, one step.
  const click = async (url: string): Promise<void> => {
    const { verb, value } = parseHandlerUrl(url);
    const handler = VERBS.get(verb);
    if (!handler) throw new Error(`no handler for verb "${verb}"`);
    await handler(value, ctx);
  };
  return { config, store, render, click, ctx, sessionState, history };
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

async function press(runtime: Runtime, action: (typeof ACTION_ORDER)[number]): Promise<void> {
  await runtime.click(ownUrls(runtime.render())[ACTION_ORDER.indexOf(action)]!);
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

  test("a persist write is one step; undo restores the prior text byte-for-byte, redo re-applies it", async () => {
    const runtime = buildRuntime(SRC);
    const original = durable.text()!;
    await press(runtime, "pinDracula");
    expect(globals().palette).toBe("dracula");
    const written = durable.text()!;
    expect(durable.history().past).toEqual([durable.fileStep(original, written)]);

    await press(runtime, "back");
    expect(durable.text()).toBe(original);
    expect(durable.history()).toEqual({
      past: [],
      future: [durable.fileStep(original, written)],
    });

    await press(runtime, "fwd");
    expect(durable.text()).toBe(written);
    expect(durable.history()).toEqual({
      past: [durable.fileStep(original, written)],
      future: [],
    });
  });

  // brandon-save-undo-bwi.jby's acceptance: one history steps a mix of
  // session picks and file writes, each back to exactly the state before it.
  test("undo and redo step a mix of session picks and file writes, in order", async () => {
    const runtime = buildRuntime(SRC);
    const theme = (): string | null => runtime.sessionState.get("s1", "theme");
    const padding = (): string | null =>
      runtime.sessionState.get("s1", "padding");
    const original = durable.text()!;

    await press(runtime, "pickTheme"); // session
    await press(runtime, "pinDracula"); // file
    const pinned = durable.text()!;
    await press(runtime, "pickPadding"); // session
    expect([theme(), padding(), globals().palette]).toEqual(["nord", "3", "dracula"]);
    expect(runtime.history.depth("s1")).toEqual({ undo: 3, redo: 0, sinceEdit: 0 });

    await press(runtime, "back");
    expect([theme(), padding(), durable.text()]).toEqual(["nord", null, pinned]);
    await press(runtime, "back");
    expect([theme(), padding(), durable.text()]).toEqual(["nord", null, original]);
    await press(runtime, "back");
    expect([theme(), padding(), durable.text()]).toEqual([null, null, original]);
    expect(runtime.history.depth("s1")).toEqual({ undo: 0, redo: 3, sinceEdit: 0 });

    await press(runtime, "fwd");
    expect([theme(), padding(), durable.text()]).toEqual(["nord", null, original]);
    await press(runtime, "fwd");
    expect([theme(), padding(), durable.text()]).toEqual(["nord", null, pinned]);
    await press(runtime, "fwd");
    expect([theme(), padding(), durable.text()]).toEqual(["nord", "3", pinned]);
    expect(runtime.history.depth("s1")).toEqual({ undo: 3, redo: 0, sinceEdit: 0 });
  });

  test("undo restores a session pick's PRIOR value, not just absence", async () => {
    const src = SRC.replace(
      "pickPadding: { set: 'padding', to: '3' },",
      "pickPadding: { set: 'padding', to: '3' }, pickPadding2: { set: 'padding', to: '5' },",
    );
    const runtime = buildRuntime(src);
    runtime.sessionState.set("s1", "padding", "2");
    await press(runtime, "pickPadding");
    expect(runtime.sessionState.get("s1", "padding")).toBe("3");
    await press(runtime, "back");
    expect(runtime.sessionState.get("s1", "padding")).toBe("2");
  });

  test("opening a menu or paging is not a settings change — it never becomes a step", async () => {
    const src = SRC.replace(
      "back: { undo: true },",
      "back: { undo: true }, openMenu: { set: 'menus.x', to: 'open' },",
    ).replace('"pickTheme"', '"openMenu"');
    const runtime = buildRuntime(src);
    await press(runtime, "pickTheme"); // the slot now renders openMenu
    expect(runtime.sessionState.get("s1", "menus.x")).toBe("open");
    expect(runtime.history.depth("s1")).toEqual({ undo: 0, redo: 0, sinceEdit: 0 });
  });

  test("a click that changes nothing records no step", async () => {
    const runtime = buildRuntime(SRC);
    await press(runtime, "pinDracula");
    await press(runtime, "pinDracula"); // already dracula — the file does not change
    await press(runtime, "pickTheme");
    await press(runtime, "pickTheme"); // already nord
    expect(durable.history().past).toHaveLength(2);
  });

  test("reset (a delete) is undoable too — one history over every write shape", async () => {
    const runtime = buildRuntime(SRC);
    const original = durable.text()!;
    await press(runtime, "pinDracula");
    const pinned = durable.text()!;
    await press(runtime, "forgetPalette");
    expect(globals().palette).toBeUndefined();
    expect(durable.history().past).toEqual([
      durable.fileStep(original, pinned),
      durable.fileStep(pinned, durable.text()!),
    ]);

    await press(runtime, "back"); // undo the reset
    expect(durable.text()).toBe(pinned);
    expect(globals().palette).toBe("dracula");
  });

  test("a structural (root) edit undoes through the SAME mechanism — no layout-specific code", async () => {
    const runtime = buildRuntime(SRC);
    const original = durable.text()!;
    await press(runtime, "removeDirectory");
    expect(durable.parsed().root).toEqual({ v: [{ h: ["git"] }, "bar"] });

    await press(runtime, "back");
    expect(durable.text()).toBe(original);
  });

  test("a save and the session picks it releases are one step, undone together", async () => {
    const runtime = buildRuntime(SRC);
    await press(runtime, "pickTheme");
    await press(runtime, "pickPadding");
    const original = durable.text()!;
    await press(runtime, "keep");
    expect(globals()).toMatchObject({ palette: "nord", padding: 3 });
    expect(runtime.sessionState.get("s1", "theme")).toBeNull(); // released
    expect(runtime.sessionState.get("s1", "padding")).toBeNull();
    expect(durable.history().past).toHaveLength(3);

    await press(runtime, "back");
    expect(durable.text()).toBe(original);
    expect(runtime.sessionState.get("s1", "theme")).toBe("nord");
    expect(runtime.sessionState.get("s1", "padding")).toBe("3");

    await press(runtime, "fwd");
    expect(globals()).toMatchObject({ palette: "nord", padding: 3 });
    expect(runtime.sessionState.get("s1", "theme")).toBeNull();
  });

  test("undo refuses loudly when the file was hand-edited since, and drops that file's steps so the rest stay steppable", async () => {
    const runtime = buildRuntime(SRC);
    await press(runtime, "pickTheme");
    await press(runtime, "pinDracula");
    const written = durable.text()!;
    const handEdited = written.replace(/dracula/, "gruvbox");
    expect(handEdited).not.toBe(written);
    writeFileSync(durable.configPath, handEdited);

    await expect(press(runtime, "back")).rejects.toThrow(/changed since that edit/);
    // Nothing was overwritten, and the file step is gone: every change this
    // session made to that file chains through the state the hand edit replaced.
    expect(durable.text()).toBe(handEdited);
    expect(runtime.history.depth("s1")).toEqual({ undo: 1, redo: 0, sinceEdit: 0 });

    await press(runtime, "back"); // the session pick is still undoable
    expect(runtime.sessionState.get("s1", "theme")).toBeNull();
    expect(durable.text()).toBe(handEdited);
  });

  // The decision the ticket asked for: a session's history is its OWN clicks.
  // Another session's write to the same file is not a step here, and it makes
  // this session's earlier steps on that file unreachable — refused loudly,
  // never overwritten.
  test("another session's write to the same file is never undone from here, and makes this session's earlier file steps refuse", async () => {
    const sessionState = new SessionState();
    const history = durable.historyFor(sessionState);
    const a = buildRuntime(SRC, "a", { sessionState, history });
    const b = buildRuntime(SRC, "b", { sessionState, history });
    await press(a, "pinDracula");
    await press(b, "removeDirectory");
    const afterB = durable.text()!;
    expect(history.depth("a")).toEqual({ undo: 1, redo: 0, sinceEdit: 0 });
    expect(history.depth("b")).toEqual({ undo: 1, redo: 0, sinceEdit: 0 });

    await expect(press(a, "back")).rejects.toThrow(/changed since that edit/);
    expect(durable.text()).toBe(afterB);
    expect(history.depth("a")).toEqual({ undo: 0, redo: 0, sinceEdit: 0 });

    await press(b, "back"); // b's own step is intact
    expect(durable.parsed().root).toEqual({ v: [{ h: ["directory", "git"] }, "bar"] });
    expect(globals().palette).toBe("dracula");
  });

  test("undo at the bottom of the stack is a loud no-op, never silent", async () => {
    const runtime = buildRuntime(SRC);
    await expect(press(runtime, "back")).rejects.toThrow(/nothing to undo/);
  });

  test("redo at the top of the stack is a loud no-op, never silent", async () => {
    const runtime = buildRuntime(SRC);
    await expect(press(runtime, "fwd")).rejects.toThrow(/nothing to redo/);
  });

  test("a fresh change after an undo truncates the abandoned redo path", async () => {
    const runtime = buildRuntime(SRC);
    await press(runtime, "pinDracula");
    await press(runtime, "back");
    expect(durable.history().future).toHaveLength(1);

    await press(runtime, "pickTheme"); // a fresh change — of any kind — abandons the redo
    expect(durable.history().future).toEqual([]);
    await expect(press(runtime, "fwd")).rejects.toThrow(/nothing to redo/);
  });

  test("history survives a restart — a fresh read of the same on-disk files", async () => {
    const runtime = buildRuntime(SRC);
    await press(runtime, "pinDracula");
    await press(runtime, "back");

    // "Restart": a brand-new runtime and history, same XDG_STATE_HOME,
    // nothing carried over in memory.
    const restarted = buildRuntime(SRC);
    await expect(press(restarted, "back")).rejects.toThrow(/nothing to undo/);
    await press(restarted, "fwd"); // redo survived the "restart"
    expect(globals().palette).toBe("dracula");
  });

  test("the history is bounded — the oldest step drops once 50 are exceeded", async () => {
    const runtime = buildRuntime(SRC);
    for (let i = 0; i < 51; i++) {
      await press(runtime, i % 2 === 0 ? "pinDracula" : "pinNord");
    }
    expect(durable.history().past).toHaveLength(50);
    expect(durable.history().future).toEqual([]);
  });
});

describe("settings history: a step lands whole, and records only what landed", () => {
  beforeEach(() => {
    durable = durableConfig("cc-candybar-undoredo-atomic-");
  });
  afterEach(() => {
    chmodSync(dirname(durable.configPath), 0o700);
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

    chmodSync(dirname(durable.configPath), 0o500); // the file write cannot land
    expect(() => history.undo("s1")).toThrow(/config write failed/);
    expect(sessionState.get("s1", "theme")).toBe("nord");
    expect(durable.text()).toBe("{ after: 1 }");
    expect(history.depth("s1")).toEqual({ undo: 1, redo: 0, sinceEdit: 0 });

    chmodSync(dirname(durable.configPath), 0o700); // and once it can, the step is intact
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
      revision: (sid: string) => inner.revision(sid),
    };
    const history = new SettingsHistory(throwing, () => {});
    const journal = history.begin();
    expect(() => journal.sessionState.set("s1", "theme", "nord")).toThrow(
      /store refused/,
    );
    journal.commit();
    expect(history.depth("s1")).toEqual({ undo: 0, redo: 0, sinceEdit: 0 });
  });

  test("an undo in the same click as a change undoes that change, as two clicks would", async () => {
    const src = SRC.replace(
      "back: { undo: true },",
      "back: { undo: true }, pickThenUndo: { do: ['pickTheme', 'back'] },",
    ).replace('"pickPadding"', '"pickThenUndo"');
    const runtime = buildRuntime(src);
    runtime.sessionState.set("s1", "theme", "gruvbox");
    await press(runtime, "pickPadding"); // the slot now renders pickThenUndo
    expect(runtime.sessionState.get("s1", "theme")).toBe("gruvbox");
    expect(runtime.history.depth("s1")).toEqual({ undo: 0, redo: 1, sinceEdit: 0 });
    await press(runtime, "fwd");
    expect(runtime.sessionState.get("s1", "theme")).toBe("nord");
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
    expect(history.depth("old")).toEqual({ undo: 1, redo: 0, sinceEdit: 0 });
    step("new", "/b", "d", "e"); // 12 MB — over it
    expect(history.depth("old")).toEqual({ undo: 0, redo: 0, sinceEdit: 0 });
    expect(history.depth("new")).toEqual({ undo: 2, redo: 0, sinceEdit: 0 });
    step("new", "/b", "e", "f"); // a lone session over it loses its oldest step
    expect(history.depth("new")).toEqual({ undo: 2, redo: 0, sinceEdit: 0 });
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
    expect(history.depth("s1")).toEqual({ undo: 1, redo: 0, sinceEdit: 0 });

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
    expect(history.depth("s1")).toEqual({ undo: 0, redo: 0, sinceEdit: 0 });
  });
});
