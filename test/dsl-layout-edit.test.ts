// [LAW:verifiable-goals] Driven through the real spine and the REAL daemon handler:
// a layout click rewrites the session's config FILE in place, in the authoring grammar.

import { ownLinks } from "./helpers/ambient-chrome";
import { SETTINGS_NS } from "../src/config/settings-menu";
import { writeFileSync } from "node:fs";
import { getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { ConfigError, parseDslConfig } from "../src/config/dsl-loader";
import { authoredFragment } from "../src/daemon/config-file-store";
import { testVerbContext, effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import {
  encodeSegments,
  parseEffects,
  URL_SCHEME,
  VERB_DISPATCH,
  VERB_RESET_CONFIG,
} from "../src/click/wire";
import { VERBS } from "../src/daemon/verbs";
import type { VerbContext } from "../src/daemon/verbs";
import {
  deriveConfigActionValidators,
  registerConfigValidator,
  validateConfigWrite,
} from "../src/daemon/verbs/config-validators";
import { RenderCache } from "../src/daemon/cache/render";
import type { CacheEntry } from "../src/daemon/cache/render";
import {
  EDIT_NS,
  EDIT_MODE_KEY,
  EDIT_MODE_OPEN,
} from "../src/config/loader/edit-mode";
import {
  addableSegmentDomains,
  addableDomainName,
} from "../src/config/edit-chrome";
import { GitDataProvider } from "../src/daemon/cache/git";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { encodeLayoutOp, type LayoutOp } from "../src/config/layout-ops";
import {
  walkNodes,
  type LayoutNode,
  type Root,
  type RootFragment,
} from "../src/config/dsl-types";
import { presetRoot } from "../src/config/presets";
import { durableConfig, type DurableConfig } from "./helpers/durable-config";
import { ReloadSignal } from "./helpers/reload-signal";

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
  // The settings menu and edit toggle are on every bar; these assertions are about the fixture's OWN clickable regions.
  return ownLinks(urls);
}

describe("removeSegment/insertSegment loader shape", () => {
  const base = (actions: string, presets = "{}") => `{
    globals: {},
    variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
    actions: ${actions},
    segments: {
      directory: { template: 'd', bg: 'surface', fg: 'foreground' },
      git: { template: 'g', bg: 'surface', fg: 'foreground' },
    },
    root: { h: ['directory', 'git'] },
    presets: ${presets},
  }`;

  test("removeSegment parses", () => {
    const config = parseAndValidate(
      "<test>",
      base(
        `{ rm: { persist: 'presets.default.root', removeSegment: 'directory' } }`,
      ),
      ALLOWED,
    );
    expect(config.actions.rm).toEqual({
      persist: "presets.default.root",
      removeSegment: "directory",
    });
  });

  test("insertSegment + anchor + relation parses", () => {
    const config = parseAndValidate(
      "<test>",
      base(
        `{ ins: { persist: 'presets.default.root', insertSegment: 'directory', anchor: 'git', relation: 'before' } }`,
      ),
      ALLOWED,
    );
    expect(config.actions.ins).toEqual({
      persist: "presets.default.root",
      insertSegment: "directory",
      anchor: "git",
      relation: "before",
    });
  });

  test("insertSegment without anchor is rejected", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(
          `{ ins: { persist: 'presets.default.root', insertSegment: 'directory' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(ConfigError);
  });

  test("relation must be before/after, not an arbitrary string", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(
          `{ ins: { persist: 'presets.default.root', insertSegment: 'directory', anchor: 'git', relation: 'sideways' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(ConfigError);
  });

  test("a name containing ':' is rejected — layout-ops.ts's own token delimiter", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(
          `{ rm: { persist: 'presets.default.root', removeSegment: 'a:b' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(ConfigError);
  });

  test("a name containing '/' is rejected — the click wire's own delimiter", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(
          `{ rm: { persist: 'presets.default.root', removeSegment: 'a/b' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(ConfigError);
  });

  test("removeSegment has no `set` counterpart — persist only", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(
          `{ rm: { set: 'presets.default.root', removeSegment: 'directory' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(ConfigError);
  });
});

describe("cross-ref: presets.<name>.root target", () => {
  const base = (actions: string) => `{
    globals: {},
    variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
    actions: ${actions},
    segments: {
      directory: { template: 'd', bg: 'surface', fg: 'foreground' },
      git: { template: 'g', bg: 'surface', fg: 'foreground' },
    },
    root: { h: ['directory', 'git'] },
    presets: { compact: {} },
  }`;

  test("a tree op on a non-preset-root target is a load error, not a click-time one", () => {
    for (const key of ["padding", "segments.git.palette"]) {
      expect(() =>
        parseAndValidate(
          "<test>",
          base(`{ rm: { persist: '${key}', removeSegment: 'directory' } }`),
          ALLOWED,
        ),
      ).toThrow(/is not a "presets\.<name>\.root" target — "removeSegment" is a tree op/);
    }
  });

  test("an undeclared preset name is a load error", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(
          `{ rm: { persist: 'presets.bogus.root', removeSegment: 'directory' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(/names preset "bogus" which is not declared/);
  });

  test("removeSegment naming an undeclared segment is a load error", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(
          `{ rm: { persist: 'presets.compact.root', removeSegment: 'nope' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(/removeSegment "nope" is not a declared segment/);
  });

  test("insertSegment's anchor naming an undeclared segment is a load error", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(
          `{ ins: { persist: 'presets.compact.root', insertSegment: 'directory', anchor: 'nope', relation: 'after' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(/anchor "nope" is not a declared segment/);
  });

  test("a 'to' literal targeting a preset-root key is a load error — only removeSegment/insertSegment apply", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(
          `{ bad: { persist: 'presets.compact.root', to: 'remove:directory' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(
      /can only be paired with "removeSegment", "insertSegment", or "insertSegmentFrom"/,
    );
  });

  test("a 'reset' over a preset-root key is legal — deleting the authored root needs no arm check", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(`{ undo: { reset: 'presets.compact.root' } }`),
        ALLOWED,
      ),
    ).not.toThrow();
  });
});

// [LAW:one-source-of-truth] The spelling is lossless, own fields included, or a click-written row would reload as something the user never configured.
describe("authoredFragment — lossless over every own field", () => {
  const readBack = (fragment: RootFragment): RootFragment =>
    parseDslConfig(
      "<authored>",
      JSON.stringify({ root: authoredFragment(fragment) }),
      ALLOWED,
    ).root!;

  test("a tree keeps the root's `when`/`distribution` and a row's `distribution`", () => {
    const tree: LayoutNode = {
      kind: "container",
      direction: "vertical",
      when: "{{ .x }}",
      distribution: "monotonic",
      children: [
        {
          kind: "container",
          direction: "horizontal",
          distribution: "golden-angle",
          children: [
            { kind: "segment", name: "directory" },
            { kind: "segment", name: "git", when: "{{ .y }}" },
          ],
        },
        { kind: "segment", name: "bar" },
      ],
    };
    expect(authoredFragment(tree)).toEqual({
      v: [
        {
          h: ["directory", { seg: "git", when: "{{ .y }}" }],
          distribution: "golden-angle",
        },
        "bar",
      ],
      when: "{{ .x }}",
      distribution: "monotonic",
    });
    expect(readBack(tree)).toEqual(tree);
  });

  test("a rows map keeps its own fields beside its rows", () => {
    const root: Root = {
      rows: {
        main: {
          kind: "container",
          direction: "horizontal",
          distribution: "uniform",
          children: [{ kind: "segment", name: "directory" }],
        },
      },
      when: "{{ .x }}",
      distribution: "ends-interleaved",
    };
    expect(readBack(root)).toEqual(root);
  });
});

function allowedFor(
  contributions: readonly { key: string; spec: { kind: string } }[],
  key: string,
): readonly string[] {
  const entry = contributions.find((c) => c.key === key);
  if (entry === undefined) throw new Error(`no contribution for "${key}"`);
  const spec = entry.spec as { kind: string; allowed?: readonly string[] };
  if (spec.kind !== "allow-list" || spec.allowed === undefined) {
    throw new Error(`contribution for "${key}" is not an allow-list`);
  }
  return spec.allowed;
}

describe("deriveConfigActionValidators over layout-op actions", () => {
  test("derives a one-member allow-list keyed by the op's own encoded token", () => {
    const config = parseAndValidate(
      "<test>",
      `{
        globals: {},
        variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
        actions: { rm: { persist: 'presets.default.root', removeSegment: 'directory' } },
        segments: {
          directory: { template: 'd', bg: 'surface', fg: 'foreground' },
          git: { template: 'g', bg: 'surface', fg: 'foreground' },
        },
        root: { h: ['directory', 'git'] },
        presets: {},
      }`,
      ALLOWED,
    );
    const contributions = deriveConfigActionValidators(config);
    // [LAW:behavior-not-structure] The contract is membership — this action contributes ITS token — not the whole list.
    expect(allowedFor(contributions, "presets.default.root")).toContain(
      encodeLayoutOp({ op: "remove", target: "directory" }),
    );
  });

  test("two layout actions on the same preset union into a two-member allow-list", () => {
    const config = parseAndValidate(
      "<test>",
      `{
        globals: {},
        variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
        actions: {
          rm: { persist: 'presets.default.root', removeSegment: 'directory' },
          ins: { persist: 'presets.default.root', insertSegment: 'git', anchor: 'directory', relation: 'after' },
        },
        segments: {
          directory: { template: 'd', bg: 'surface', fg: 'foreground' },
          git: { template: 'g', bg: 'surface', fg: 'foreground' },
        },
        root: { h: ['directory'] },
        presets: {},
      }`,
      ALLOWED,
    );
    const contributions = deriveConfigActionValidators(config);
    // Both actions land on ONE key (the union is the point), so assert membership.
    const allowed = new Set(allowedFor(contributions, "presets.default.root"));
    for (const token of [
      encodeLayoutOp({ op: "remove", target: "directory" }),
      encodeLayoutOp({
        op: "insert",
        segment: "git",
        anchor: "directory",
        relation: "after",
      }),
    ]) {
      expect(allowed).toContain(token);
    }
  });

  test("a token no action declares is rejected by the derived gate", () => {
    const dispose = registerConfigValidator("presets.default.root", {
      kind: "allow-list",
      allowed: [encodeLayoutOp({ op: "remove", target: "directory" })],
    });
    try {
      const result = validateConfigWrite(
        "presets.default.root",
        encodeLayoutOp({ op: "remove", target: "git" }),
      );
      expect(result.ok).toBe(false);
    } finally {
      dispose();
    }
  });

  // A preset declaring no layout-op action must still register `presets.<name>.root`, or its synthesized reset has no gate.
  test("a preset's root key is registered even with zero layout-op actions targeting it", () => {
    const config = parseAndValidate(
      "<test>",
      `{
        globals: {},
        variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
        actions: { undoIt: { reset: 'presets.empty.root' } },
        segments: { directory: { template: 'd', bg: 'surface', fg: 'foreground' } },
        root: { h: ['directory'] },
        presets: { empty: {} },
      }`,
      ALLOWED,
    );
    const contributions = deriveConfigActionValidators(config);
    const rootEntry = contributions.find((c) => c.key === "presets.empty.root");
    expect(rootEntry).toBeDefined();
    expect(rootEntry!.spec.kind).toBe("allow-list");
  });
});

let durable: DurableConfig;

// [LAW:one-source-of-truth] The runtime parses `src` for the render AND writes it as the session's config file, exactly as the daemon does.
function buildLayoutRuntime(src: string, sessionId = "s1") {
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
  return { config, store, render, click, dispose };
}

describe("apply-layout-op click → the config file", () => {
  beforeEach(() => {
    durable = durableConfig("cc-candybar-layout-click-");
  });
  afterEach(() => {
    durable.dispose();
  });

  // The comment beside `root` is the canary: everything outside the edited span is preserved verbatim.
  const ROOT_COMMENT = "// identity row over the edit bar";
  const SRC = `{
    globals: {},
    variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
    actions: {
      removeDirectory: { persist: 'presets.default.root', removeSegment: 'directory' },
      insertGitPrAfterGit: { persist: 'presets.default.root', insertSegment: 'gitPr', anchor: 'git', relation: 'after' },
      removeGit: { persist: 'presets.default.root', removeSegment: 'git' },
    },
    segments: {
      directory: { template: 'd', bg: 'surface', fg: 'foreground' },
      git: { template: 'g', bg: 'surface', fg: 'foreground' },
      gitPr: { template: 'p', bg: 'surface', fg: 'foreground' },
      bar: { template: '{{ action "removeDirectory" "-" }} {{ action "insertGitPrAfterGit" "+" }} {{ action "removeGit" "x" }}', bg: 'surface', fg: 'foreground' },
    },
    ${ROOT_COMMENT}
    root: { v: [ { h: ['directory', 'git'] }, 'bar' ] },
    presets: {},
  }`;

  test("a click fires apply-layout-op and removes the segment from the file's root", () => {
    const { render, click, dispose } = buildLayoutRuntime(SRC);
    const original = durable.text()!;
    const urls = extractUrls(render());
    expect(effectsOf(urls[0]!)[0]!.verb).toBe("apply-layout-op");
    click(urls[0]!);
    expect(durable.parsed().root).toEqual({ v: [{ h: ["git"] }, "bar"] });
    const written = durable.text()!;
    expect(written).toContain(ROOT_COMMENT);
    expect(written).toContain(
      "removeDirectory: { persist: 'presets.default.root'",
    );
    expect(written).not.toBe(original);
    // ONE whole-file history entry — the same shape persist/reset records, so undo needs no layout-specific path.
    expect(durable.history().past).toEqual([
      { before: original, after: written },
    ]);
    dispose();
  });

  test("two clicks COMPOSE — the second edits the tree the first left behind", () => {
    const { render, click, dispose } = buildLayoutRuntime(SRC);
    const urls = extractUrls(render());
    click(urls[0]!);
    click(urls[1]!);
    expect(durable.parsed().root).toEqual({
      v: [{ h: ["git", "gitPr"] }, "bar"],
    });
    expect(durable.history().past).toHaveLength(2);
    dispose();
  });

  // [LAW:no-silent-failure] The store refuses a stale edit, names the missing segment, and touches neither file nor history.
  test("a stale target/anchor is a LOUD error from the store, and the file is untouched", () => {
    const { render, click, dispose } = buildLayoutRuntime(SRC);
    const urls = extractUrls(render());
    click(urls[0]!);
    const afterFirst = durable.text()!;

    expect(() => click(urls[0]!)).toThrow(/holds no segment "directory".*stale/);
    expect(durable.text()).toBe(afterFirst);
    expect(durable.history().past).toHaveLength(1);

    click(urls[2]!);
    expect(() => click(urls[1]!)).toThrow(/holds no segment "git".*stale/);
    expect(durable.parsed().root).toEqual({ v: [{ h: [] }, "bar"] });
    expect(durable.history().past).toHaveLength(2);
    dispose();
  });

  // [LAW:no-silent-failure] A preset declared NOWHERE is not "a preset declaring no root"; both the edit and the reset must refuse.
  test("a click on a preset the file no longer declares is refused — never redirected onto the file's root", () => {
    const ROOT = "{ v: [ { h: ['directory', 'git'] }, 'bar' ] }";
    const SRC_CUSTOM = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      actions: {
        removeDirectory: { persist: 'presets.mine.root', removeSegment: 'directory' },
        resetMine: { reset: 'presets.mine.root' },
      },
      segments: {
        directory: { template: 'd', bg: 'surface', fg: 'foreground' },
        git: { template: 'g', bg: 'surface', fg: 'foreground' },
        bar: { template: '{{ action "removeDirectory" "-" }} {{ action "resetMine" "r" }}', bg: 'surface', fg: 'foreground' },
      },
      root: ${ROOT},
      presets: { mine: { root: { h: ['git', 'bar'] } } },
    }`;
    const { render, click, dispose } = buildLayoutRuntime(SRC_CUSTOM);
    const urls = extractUrls(render());
    durable.write(SRC_CUSTOM.replace(/presets: \{ mine: [^\n]*\},/, "presets: {},"));
    expect(durable.parsed().presets).toEqual({});

    const undeclared = /neither the config file nor the bundled default declares presets\.mine/;
    expect(() => click(urls[0]!)).toThrow(undeclared);
    // The reset link is hand-built: the harness filters edit chrome's own banner, and the verb is what is under test.
    const resetUrl = `${URL_SCHEME}://${VERB_RESET_CONFIG}/${encodeSegments(["s1", "presets.mine.root"])}`;
    expect(() => click(resetUrl)).toThrow(undeclared);
    expect(durable.parsed().root).toEqual({ v: [{ h: ["directory", "git"] }, "bar"] });
    expect(durable.history().past).toHaveLength(0);
    dispose();
  });

  // [LAW:one-source-of-truth] `restagesFragment` and `restages` must classify one fragment alike.
  test("a reset on a preset authored as `{ rows: {}, distribution }` deletes the preset's root, not the file's", () => {
    const ROOT = "{ v: [ { h: ['directory', 'git'] }, 'bar' ] }";
    const SRC_PLACED = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      actions: {
        resetMine: { reset: 'presets.mine.root' },
      },
      segments: {
        directory: { template: 'd', bg: 'surface', fg: 'foreground' },
        git: { template: 'g', bg: 'surface', fg: 'foreground' },
        bar: { template: '{{ action "resetMine" "r" }}', bg: 'surface', fg: 'foreground' },
      },
      root: ${ROOT},
      presets: { mine: { root: { rows: {}, distribution: 'monotonic' } } },
    }`;
    const { render, click, dispose } = buildLayoutRuntime(SRC_PLACED);
    render();
    const resetUrl = `${URL_SCHEME}://${VERB_RESET_CONFIG}/${encodeSegments(["s1", "presets.mine.root"])}`;
    click(resetUrl);
    expect(durable.parsed().presets).toEqual({ mine: {} });
    expect(durable.parsed().root).toEqual({ v: [{ h: ["directory", "git"] }, "bar"] });
    expect(durable.history().past).toHaveLength(1);
    dispose();
  });

  test("a hand-crafted click carrying an undeclared op token is rejected loudly", () => {
    const { dispose } = buildLayoutRuntime(SRC);
    const sessionState = new SessionState();
    durable.seedOrigin(sessionState, "s1");
    const ctx: VerbContext = testVerbContext(sessionState);
    const applyLayoutOp = VERBS.get("apply-layout-op")!;
    const before = durable.text();
    expect(() =>
      applyLayoutOp(
        `${encodeURIComponent("s1")}/${encodeURIComponent("presets.default.root")}/${encodeURIComponent(
          encodeLayoutOp({ op: "remove", target: "noSuchSegmentAnywhere" }),
        )}`,
        ctx,
      ),
    ).toThrow(/apply-layout-op/);
    expect(durable.text()).toBe(before);
    dispose();
  });

  // [LAW:no-silent-failure] WHICH file a click edits comes from the origin the render recorded; a session that never rendered has none.
  test("a click on a session with no recorded render origin is refused — no file to write", () => {
    const { dispose } = buildLayoutRuntime(SRC);
    const ctx: VerbContext = testVerbContext(new SessionState());
    const applyLayoutOp = VERBS.get("apply-layout-op")!;
    expect(() =>
      applyLayoutOp(
        `${encodeURIComponent("s1")}/${encodeURIComponent("presets.default.root")}/${encodeURIComponent(
          encodeLayoutOp({ op: "remove", target: "directory" }),
        )}`,
        ctx,
      ),
    ).toThrow(/has not rendered yet/);
    expect(durable.parsed().root).toEqual({
      v: [{ h: ["directory", "git"] }, "bar"],
    });
    dispose();
  });
});

// Quotes and backslashes are LEGAL in a preset name, so they are escaped into the synthesized template, not rejected.
describe('the "customized" banner escapes quote/backslash preset names', () => {
  // eslint-disable-next-line no-control-regex
  const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;

  test('a preset named with a " and a \\ compiles and renders the literal label', () => {
    const presetName = 'foo"bar\\baz';
    const config = parseAndValidate(
      "<test>",
      `{
        globals: {},
        variables: {
          'session.id': { kind: 'input', path: 'session_id', default: '' },
          'preset.customized': { kind: 'input', path: 'preset.customized', type: 'boolean', default: false },
        },
        segments: {
          directory: { template: 'd', bg: 'surface', fg: 'foreground' },
          editControl: { template: '{{ action "edit.toggle" "e" }}', bg: 'surface', fg: 'foreground' },
        },
        root: { h: ['directory', 'editControl'] },
        presets: { ${JSON.stringify(presetName)}: {} },
      }`,
      ALLOWED,
    );
    // An unescaped quote would break the Go-template source, so the compile itself must not throw.
    const store = new VariableStore();
    const sessionState = new SessionState();
    sessionState.set("s1", EDIT_MODE_KEY, EDIT_MODE_OPEN);
    const registry = new SourceRegistry(store, "", undefined, sessionState);
    let compiled: ReturnType<typeof registerDslConfig>;
    expect(() => {
      compiled = registerDslConfig(config, registry);
    }).not.toThrow();
    const basePalette = getThemePalette("textual-dark"!);
    const rendered = renderDsl(
      config,
      compiled!,
      store,
      registry,
      {
        session_id: "s1",
        project_dir: "/tmp/proj",
        preset: { effective: presetName, customized: true },
      },
      basePalette,
      opts(),
      undefined,
      { preset: presetName },
    );
    expect(rendered.replace(ANSI, "")).toContain(`↺ ${presetName} customized`);
    registry.dispose();
  });
});

// A preset's declared root may carry its OWN top-level `when`, including the bare-segment-ref shorthand `{ seg, when }`.
describe("the reset banner respects a preset root's own top-level `when`", () => {
  // eslint-disable-next-line no-control-regex
  const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;

  function buildConfig(rootWhen: string) {
    return parseAndValidate(
      "<test>",
      `{
        globals: {},
        variables: {
          'session.id': { kind: 'input', path: 'session_id', default: '' },
          'preset.customized': { kind: 'input', path: 'preset.customized', type: 'boolean', default: false },
        },
        segments: {
          directory: { template: 'd', bg: 'surface', fg: 'foreground' },
          editControl: { template: '{{ action "edit.toggle" "e" }}', bg: 'surface', fg: 'foreground' },
        },
        root: { h: ['directory', 'editControl'] },
        presets: { gated: { root: { seg: 'directory', when: ${JSON.stringify(rootWhen)} } } },
      }`,
      ALLOWED,
    );
  }

  function renderGated(config: ReturnType<typeof buildConfig>): string {
    const store = new VariableStore();
    const sessionState = new SessionState();
    sessionState.set("s1", EDIT_MODE_KEY, EDIT_MODE_OPEN);
    const registry = new SourceRegistry(store, "", undefined, sessionState);
    try {
      const compiled = registerDslConfig(config, registry);
      const basePalette = getThemePalette("textual-dark"!);
      return renderDsl(
        config,
        compiled,
        store,
        registry,
        {
          session_id: "s1",
          project_dir: "/tmp/proj",
          preset: { effective: "gated", customized: true },
        },
        basePalette,
        opts(),
        undefined,
        { preset: "gated" },
      ).replace(ANSI, "");
    } finally {
      registry.dispose();
    }
  }

  test("the banner is hidden when a bare-segment-root's own when is false, even though .preset.customized is true", () => {
    expect(renderGated(buildConfig("{{ false }}"))).not.toContain("customized");
  });

  test("the banner still shows when the root's own when is true (sanity: the gate above isn't just always-empty)", () => {
    expect(renderGated(buildConfig("{{ true }}"))).toContain(
      "↺ gated customized",
    );
  });
});

function makeCache(reloads?: ReloadSignal): {
  cache: RenderCache;
  sessionState: SessionState;
  cleanups: Array<() => void>;
} {
  const cleanups: Array<() => void> = [];
  const watchers = new WatcherRegistry({
    counters: { watchersOpened: 0, watchersClosed: 0, watchersEvicted: 0 },
    logger: () => {},
  });
  cleanups.push(() => watchers.closeAll());
  const gitService = new GitDataProvider({
    sanityIntervalMs: 0,
    logger: () => {},
  });
  cleanups.push(() => gitService.close());
  const sessionState = new SessionState();
  const cache = new RenderCache(
    { gitService, sessionState, watchers },
    reloads === undefined ? {} : { observers: reloads.observers },
  );
  return { cache, sessionState, cleanups };
}

// [LAW:locality-or-seam] Edit chrome and the settings menu ride EVERY resolved preset root, so chrome is filtered by its reserved `edit.` namespace here rather than at every call site.
function segmentNamesOf(root: LayoutNode): string[] {
  const out: string[] = [];
  const walk = (node: LayoutNode): void => {
    if (node.kind === "segment") {
      if (!node.name.startsWith(EDIT_NS) && !node.name.startsWith(SETTINGS_NS))
        out.push(node.name);
    } else {
      for (const c of node.children) walk(c);
    }
  };
  walk(root);
  return out;
}

function presetNamesOf(entry: CacheEntry, preset: string): string[] {
  return segmentNamesOf(presetRoot(entry.state.config, preset).node);
}

function fireVerb(verb: string, ctx: VerbContext, ...args: string[]): void {
  VERBS.get(verb)!(args.map(encodeURIComponent).join("/"), ctx);
}

// A session that has rendered from the fixture's file — the origin a durable verb resolves the file from.
function originCtx(sessionState: SessionState, sessionId = "s1"): VerbContext {
  durable.seedOrigin(sessionState, sessionId);
  return testVerbContext(sessionState);
}

describe("RenderCache: authoredRoots — the file authors a root at the preset's path", () => {
  beforeEach(() => {
    durable = durableConfig("cc-candybar-layout-authored-");
  });
  afterEach(() => {
    durable.dispose();
  });

  function authoredRootsOf(): ReadonlySet<string> {
    const { cache, cleanups } = makeCache();
    try {
      const entry = cache.getOrCreate(
        durable.projectDir,
        durable.projectDir,
        undefined,
      );
      expect(entry.lastError).toBeNull();
      return entry.state.authoredRoots;
    } finally {
      for (const fn of cleanups) fn();
    }
  }

  test("a file declaring neither `root` nor any `presets.<n>.root` customizes nothing — the bundled presets' own roots are not the file's", () => {
    durable.write(`{ globals: {}, segments: {} }`);
    expect([...authoredRootsOf()]).toEqual([]);
  });

  test("a file declaring `root` customizes the floor preset — it stages the config root, so `root` IS its tree", () => {
    durable.write(`{
      segments: { directory: { template: 'd', bg: 'surface', fg: 'foreground' } },
      root: { h: ['directory'] },
    }`);
    const authored = authoredRootsOf();
    expect(authored.has("default")).toBe(true);
    expect(authored.has("compact")).toBe(false);
  });

  test("a file declaring `presets.compact.root` customizes compact, not the floor", () => {
    durable.write(`{
      segments: { directory: { template: 'd', bg: 'surface', fg: 'foreground' } },
      presets: { compact: { root: { h: ['directory'] } } },
    }`);
    const authored = authoredRootsOf();
    expect(authored.has("compact")).toBe(true);
    expect(authored.has("default")).toBe(false);
  });

  // [LAW:one-source-of-truth] "Where does this preset's tree live" is ONE decision (presetRoot).
  test("a declared preset with no root of its own is customized by the file's `root`, like the floor", () => {
    durable.write(`{
      segments: { directory: { template: 'd', bg: 'surface', fg: 'foreground' } },
      root: { h: ['directory'] },
      presets: { mine: {} },
    }`);
    const authored = authoredRootsOf();
    expect(authored.has("default")).toBe(true);
    expect(authored.has("mine")).toBe(true);
  });
});

describe("RenderCache: layout edits land in the file and reload from it", () => {
  beforeEach(() => {
    durable = durableConfig("cc-candybar-layout-rc-");
  });
  afterEach(() => {
    durable.dispose();
  });

  const ROOT_COMMENT = "// the hand-authored row";
  const userConfigBody = `{
  globals: {},
  segments: {
    directory: { template: "d", bg: "surface", fg: "foreground" },
    git: { template: "g", bg: "surface", fg: "foreground" },
    gitPr: { template: "p", bg: "surface", fg: "foreground" },
  },
  actions: {
    rm: { persist: "presets.default.root", removeSegment: "directory" },
    ins: { persist: "presets.default.root", insertSegment: "gitPr", anchor: "git", relation: "after" },
  },
  ${ROOT_COMMENT}
  root: { h: ["directory", "git"] },
  presets: {},
}
`;

  const REMOVE_DIRECTORY = encodeLayoutOp({
    op: "remove",
    target: "directory",
  });
  const INSERT_GITPR_AFTER_GIT = encodeLayoutOp({
    op: "insert",
    segment: "gitPr",
    anchor: "git",
    relation: "after",
  });

  // [LAW:one-source-of-truth] The click's write reaches the LIVE cache through the SAME watcher a hand edit fires.
  // A retry re-touches the file with the bytes the click left (fs.watch has no ready signal).
  test("a `-` click rewrites the file's root, and the live cache reloads it through the config-file watcher", async () => {
    durable.write(userConfigBody);
    const reloads = new ReloadSignal();
    const { cache, sessionState, cleanups } = makeCache(reloads);
    try {
      const entry = cache.getOrCreate(
        durable.projectDir,
        durable.projectDir,
        undefined,
      );
      expect(entry.lastError).toBeNull();
      expect(presetNamesOf(entry, "default")).toEqual(["directory", "git"]);
      // Hand-authored `root` → already "customized": the fact is "the file authors this tree", by whichever hand.
      expect(entry.state.authoredRoots.has("default")).toBe(true);

      const ctx = originCtx(sessionState);
      let clicked = false;
      await reloads.after(entry, () => {
        if (clicked) {
          writeFileSync(durable.configPath, durable.text()!);
          return;
        }
        clicked = true;
        fireVerb(
          "apply-layout-op",
          ctx,
          "s1",
          "presets.default.root",
          REMOVE_DIRECTORY,
        );
      });

      expect(entry.lastError).toBeNull();
      expect(presetNamesOf(entry, "default")).toEqual(["git"]);
      expect(durable.parsed().root).toEqual({ h: ["git"] });
      expect(durable.text()).toContain(ROOT_COMMENT);
    } finally {
      for (const fn of cleanups) fn();
    }
  });

  // A bare-segment-ref root is addressed as the one-child container it abbreviates, and a tree edited down to nothing still loads.
  test("layout edits land on a bare-segment preset root, down to an empty container that still loads", () => {
    durable.write(`{
  globals: {},
  segments: {
    sidebar: { template: "s", bg: "surface", fg: "foreground" },
    clock: { template: "c", bg: "surface", fg: "foreground" },
  },
  actions: {
    add: { persist: "presets.compact.root", insertSegment: "clock", anchor: "sidebar", relation: "after" },
    rmSidebar: { persist: "presets.compact.root", removeSegment: "sidebar" },
    rmClock: { persist: "presets.compact.root", removeSegment: "clock" },
  },
  root: { h: ["sidebar"] },
  presets: { compact: { root: "sidebar" } },
}
`);
    const { cache, sessionState, cleanups } = makeCache();
    try {
      const entry = cache.getOrCreate(
        durable.projectDir,
        durable.projectDir,
        undefined,
      );
      expect(entry.lastError).toBeNull();
      expect(presetNamesOf(entry, "compact")).toEqual(["sidebar"]);
      const ctx = originCtx(sessionState);
      const fire = (op: LayoutOp): void =>
        fireVerb(
          "apply-layout-op",
          ctx,
          "s1",
          "presets.compact.root",
          encodeLayoutOp(op),
        );
      fire({ op: "insert", segment: "clock", anchor: "sidebar", relation: "after" });
      expect(durable.parsed().presets).toEqual({
        compact: { root: { h: ["sidebar", "clock"] } },
      });
      fire({ op: "remove", target: "sidebar" });
      fire({ op: "remove", target: "clock" });
      expect(durable.parsed().presets).toEqual({ compact: { root: { h: [] } } });
    } finally {
      for (const fn of cleanups) fn();
    }

    const { cache: restarted, cleanups: restartedCleanups } = makeCache();
    try {
      const entry = restarted.getOrCreate(
        durable.projectDir,
        durable.projectDir,
        undefined,
      );
      expect(entry.lastError).toBeNull();
      expect(presetNamesOf(entry, "compact")).toEqual([]);
    } finally {
      for (const fn of restartedCleanups) fn();
    }
  });

  test("a remove and an insert compose, in order, onto the same preset", () => {
    durable.write(userConfigBody);
    const { cache, sessionState, cleanups } = makeCache();
    try {
      cache.getOrCreate(durable.projectDir, durable.projectDir, undefined);
      const ctx = originCtx(sessionState);
      fireVerb(
        "apply-layout-op",
        ctx,
        "s1",
        "presets.default.root",
        REMOVE_DIRECTORY,
      );
      fireVerb(
        "apply-layout-op",
        ctx,
        "s1",
        "presets.default.root",
        INSERT_GITPR_AFTER_GIT,
      );
      expect(durable.parsed().root).toEqual({ h: ["git", "gitPr"] });
    } finally {
      for (const fn of cleanups) fn();
    }

    const { cache: restarted, cleanups: restartedCleanups } = makeCache();
    try {
      const entry = restarted.getOrCreate(
        durable.projectDir,
        durable.projectDir,
        undefined,
      );
      expect(entry.lastError).toBeNull();
      expect(presetNamesOf(entry, "default")).toEqual(["git", "gitPr"]);
    } finally {
      for (const fn of restartedCleanups) fn();
    }
  });

  // [LAW:verifiable-goals] A fresh cache/provider/registry — what a real restart rebuilds — reading nothing but the file on disk.
  test("the edit survives a restart", () => {
    durable.write(userConfigBody);
    const { cache, sessionState, cleanups } = makeCache();
    try {
      cache.getOrCreate(durable.projectDir, durable.projectDir, undefined);
      fireVerb(
        "apply-layout-op",
        originCtx(sessionState),
        "s1",
        "presets.default.root",
        REMOVE_DIRECTORY,
      );
    } finally {
      for (const fn of cleanups) fn();
    }

    const { cache: restarted, cleanups: restartedCleanups } = makeCache();
    try {
      const entry = restarted.getOrCreate(
        durable.projectDir,
        durable.projectDir,
        undefined,
      );
      expect(entry.lastError).toBeNull();
      expect(presetNamesOf(entry, "default")).toEqual(["git"]);
    } finally {
      for (const fn of restartedCleanups) fn();
    }
  });

  // [LAW:verifiable-goals] Removing edit.toggle's own host must not strand the user with no way back.
  // [LAW:one-source-of-truth] The cascade resolves a click to ONE row — the first merged row holding the segment, not the first in file-text order.
  test("a segment placed in an inherited row and a file row: the edit lands on the row the cascade resolved", () => {
    durable.write(
      `{ globals: {}, segments: {}, root: { rows: { extra: { h: ['directory'] } } } }`,
    );
    const { cache, sessionState, cleanups } = makeCache();
    try {
      const entry = cache.getOrCreate(
        durable.projectDir,
        durable.projectDir,
        undefined,
      );
      expect(entry.lastError).toBeNull();
      fireVerb(
        "apply-layout-op",
        originCtx(sessionState),
        "s1",
        "presets.default.root",
        encodeLayoutOp({ op: "remove", target: "directory" }),
      );
      const parsed = durable.parsed() as {
        root: { rows: Record<string, { h: string[] }> };
      };
      expect(Object.keys(parsed.root.rows)).toEqual(["extra", "identity"]);
      expect(parsed.root.rows.extra!.h).toEqual(["directory"]);
      expect(parsed.root.rows.identity!.h).not.toContain("directory");
    } finally {
      for (const fn of cleanups) fn();
    }
  });

  // [LAW:one-source-of-truth] `{ rows: {} }` is the merge identity: presetRoot reports `root`, so the store must edit `root` too.
  test("a preset declaring the identity fragment stages the config's root: the edit and the stale error both name `root`", () => {
    durable.write(
      `{ globals: {}, segments: {}, presets: { default: { root: { rows: {} } } } }`,
    );
    const { cache, sessionState, cleanups } = makeCache();
    try {
      const entry = cache.getOrCreate(
        durable.projectDir,
        durable.projectDir,
        undefined,
      );
      expect(entry.lastError).toBeNull();
      expect(entry.state.authoredRoots.has("default")).toBe(false);
      const removeDirectory = (): void =>
        fireVerb(
          "apply-layout-op",
          originCtx(sessionState),
          "s1",
          "presets.default.root",
          encodeLayoutOp({ op: "remove", target: "directory" }),
        );
      removeDirectory();
      const parsed = durable.parsed() as {
        root: { rows: Record<string, { h: string[] }> };
        presets: { default: { root: unknown } };
      };
      expect(Object.keys(parsed.root.rows)).toEqual(["identity"]);
      expect(parsed.root.rows.identity!.h).not.toContain("directory");
      expect(parsed.presets.default.root).toEqual({ rows: {} });
      expect(removeDirectory).toThrow(/^root holds no segment "directory"/);
    } finally {
      for (const fn of cleanups) fn();
    }
  });

  test("toolbar removed via edit mode is offered back by every remaining `+`, and a real reload restores it", () => {
    const bareUserConfig = `{ globals: {}, segments: {} }`;
    durable.write(bareUserConfig);

    const { cache, sessionState, cleanups } = makeCache();
    try {
      const before = cache.getOrCreate(
        durable.projectDir,
        durable.projectDir,
        undefined,
      );
      expect(before.lastError).toBeNull();
      expect(presetNamesOf(before, "default")).toContain("toolbar");
      expect(before.state.authoredRoots.has("default")).toBe(false);

      fireVerb(
        "apply-layout-op",
        originCtx(sessionState),
        "s1",
        "presets.default.root",
        encodeLayoutOp({ op: "remove", target: "toolbar" }),
      );
      // MATERIALIZATION: only the bundled row holding `toolbar` was copied in; the status row stays inherited.
      const parsed = durable.parsed() as {
        root: { rows: Record<string, { h: string[] }> };
        globals: unknown;
        segments: unknown;
      };
      expect(Object.keys(parsed.root.rows)).toEqual(["identity"]);
      expect(parsed.root.rows.identity!.h).not.toContain("toolbar");
      expect(parsed.root.rows.identity!.h).toContain("directory");
      expect(parsed.globals).toEqual({});
      expect(parsed.segments).toEqual({});

      // A fresh cache — a real restart — against the SAME config file.
      const {
        cache: cache2,
        sessionState: sessionState2,
        cleanups: cleanups2,
      } = makeCache();
      try {
        const afterRemove = cache2.getOrCreate(
          durable.projectDir,
          durable.projectDir,
          undefined,
        );
        expect(afterRemove.lastError).toBeNull();
        expect(presetNamesOf(afterRemove, "default")).not.toContain("toolbar");
        expect(afterRemove.state.authoredRoots.has("default")).toBe(true);
        const allNames: string[] = [];
        for (const node of walkNodes(
          presetRoot(afterRemove.state.config, "default").node,
        )) {
          if (node.kind === "segment") allNames.push(node.name);
        }
        const remainingChrome = allNames.filter((n) => n.startsWith(EDIT_NS));
        expect(remainingChrome.length).toBeGreaterThan(0);
        // Every `+` ranges the SAME addable domain, computed fresh from the tree above.
        expect(
          addableSegmentDomains(afterRemove.state.config).get(
            addableDomainName("default"),
          ),
        ).toContain("toolbar");

        fireVerb(
          "apply-layout-op",
          originCtx(sessionState2),
          "s1",
          "presets.default.root",
          encodeLayoutOp({
            op: "insert",
            segment: "toolbar",
            anchor: "gitaculous",
            relation: "after",
          }),
        );

        const { cache: cache3, cleanups: cleanups3 } = makeCache();
        try {
          const restored = cache3.getOrCreate(
            durable.projectDir,
            durable.projectDir,
            undefined,
          );
          expect(restored.lastError).toBeNull();
          expect(presetNamesOf(restored, "default")).toContain("toolbar");
        } finally {
          for (const fn of cleanups3) fn();
        }
      } finally {
        for (const fn of cleanups2) fn();
      }
    } finally {
      for (const fn of cleanups) fn();
    }
  });

  // [LAW:verifiable-goals] The visible diagnostic and its reset affordance, through the REAL cache, action, and daemon handler.
  test("a customized preset shows the diagnostic; resetting deletes the authored root and restores the bundled tree", () => {
    durable.write(`{ globals: {}, segments: {} }`);

    const { cache, sessionState, cleanups } = makeCache();
    try {
      const before = cache.getOrCreate(
        durable.projectDir,
        durable.projectDir,
        undefined,
      );
      expect(before.lastError).toBeNull();
      expect(before.state.authoredRoots.has("default")).toBe(false);
      const namesBefore = presetNamesOf(before, "default");
      expect(namesBefore).toContain("directory");

      fireVerb(
        "apply-layout-op",
        originCtx(sessionState),
        "s1",
        "presets.default.root",
        REMOVE_DIRECTORY,
      );

      const {
        cache: cache2,
        sessionState: sessionState2,
        cleanups: cleanups2,
      } = makeCache();
      try {
        const customized = cache2.getOrCreate(
          durable.projectDir,
          durable.projectDir,
          undefined,
        );
        expect(customized.lastError).toBeNull();
        expect(customized.state.authoredRoots.has("default")).toBe(true);
        expect(presetNamesOf(customized, "default")).toEqual(
          namesBefore.filter((n) => n !== "directory"),
        );
        // The synthesized reset targets the SAME key the +/- affordances write — no second gate.
        const resetActionNames = Object.entries(
          customized.state.config.actions,
        )
          .filter(([, a]) => "reset" in a && a.reset === "presets.default.root")
          .map(([name]) => name);
        expect(resetActionNames.length).toBe(1);

        fireVerb(
          "reset-config",
          originCtx(sessionState2),
          "s1",
          "presets.default.root",
        );
        expect(durable.parsed()).toEqual({ globals: {}, segments: {} });

        const { cache: cache3, cleanups: cleanups3 } = makeCache();
        try {
          const restored = cache3.getOrCreate(
            durable.projectDir,
            durable.projectDir,
            undefined,
          );
          expect(restored.lastError).toBeNull();
          expect(restored.state.authoredRoots.has("default")).toBe(false);
          expect(presetNamesOf(restored, "default")).toEqual(namesBefore);
        } finally {
          for (const fn of cleanups3) fn();
        }
      } finally {
        for (const fn of cleanups2) fn();
      }
    } finally {
      for (const fn of cleanups) fn();
    }
  });

  // The bundled "compact" preset can be edited down to zero non-exempt segments, so its reload contributes no chrome;
  // and `presets` merge WHOLESALE, so the first `-` materializes the whole bundled declaration.
  test("a preset emptied of every segment can still be reset through a real click", () => {
    durable.write(`{ globals: {}, segments: {} }`);

    const { cache, sessionState, cleanups } = makeCache();
    try {
      const entry = cache.getOrCreate(
        durable.projectDir,
        durable.projectDir,
        undefined,
      );
      expect(entry.lastError).toBeNull();
      expect(presetNamesOf(entry, "compact")).toEqual([
        "directory",
        "git",
        "context",
      ]);
      expect(entry.state.authoredRoots.has("compact")).toBe(false);

      const ctx = originCtx(sessionState);
      const compactRemove = (target: string): void =>
        fireVerb(
          "apply-layout-op",
          ctx,
          "s1",
          "presets.compact.root",
          encodeLayoutOp({ op: "remove", target }),
        );
      compactRemove("directory");
      expect(durable.parsed().presets).toEqual({
        compact: { root: { h: ["git", "context"] }, globals: { padding: 0 } },
      });
      compactRemove("git");
      compactRemove("context");
      expect(durable.parsed().presets).toEqual({
        compact: { root: { h: [] }, globals: { padding: 0 } },
      });
    } finally {
      for (const fn of cleanups) fn();
    }

    const {
      cache: cache2,
      sessionState: sessionState2,
      cleanups: cleanups2,
    } = makeCache();
    try {
      const emptied = cache2.getOrCreate(
        durable.projectDir,
        durable.projectDir,
        undefined,
      );
      expect(emptied.lastError).toBeNull();
      expect(emptied.state.authoredRoots.has("compact")).toBe(true);
      expect(presetNamesOf(emptied, "compact")).toEqual([]);

      // Would throw BadVerbArgs("unknown config key") without the always-registered preset-root contribution.
      expect(() =>
        fireVerb(
          "reset-config",
          originCtx(sessionState2),
          "s1",
          "presets.compact.root",
        ),
      ).not.toThrow();
      const compact = durable.parsed().presets as Record<string, unknown>;
      expect(compact.compact).not.toHaveProperty("root");
    } finally {
      for (const fn of cleanups2) fn();
    }

    const { cache: cache3, cleanups: cleanups3 } = makeCache();
    try {
      const restored = cache3.getOrCreate(
        durable.projectDir,
        durable.projectDir,
        undefined,
      );
      expect(restored.lastError).toBeNull();
      expect(restored.state.authoredRoots.has("compact")).toBe(false);
    } finally {
      for (const fn of cleanups3) fn();
    }
  });
});
