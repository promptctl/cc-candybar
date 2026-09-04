// [LAW:verifiable-goals] brandon-layout-edit-2gc.1 done-gates, driven through
// the real spine (mirroring dsl-persist-actions.test.ts's model one arm
// over), re-aimed at the config FILE as the one durable store
// (candybar-config-dqe):
//
//   1. The loader proves the `removeSegment`/`insertSegment` ActionDecl
//      shapes: persist-only, literal at author time, rejects `:`/`/` in any
//      name, rejects a bad `relation`.
//   2. Cross-ref catches an undeclared preset name, an undeclared segment
//      name, and the wrong ARM paired with a "presets.<name>.root" target
//      (to/from/cycle/bounded have no meaning as a tree op) — all load-time,
//      never a click-time surprise.
//   3. deriveConfigActionValidators derives a ONE-MEMBER allow-list per
//      declared layout action (the op token IS the gate) — a click carrying
//      any other token is a loud rejection, never silently applied
//      (satisfies the ticket's "a template CANNOT write a layout position
//      the declarations do not name").
//   4. A click on a compiled layout-op action fires VERB_APPLY_LAYOUT_OP
//      through the REAL daemon handler, which validates the token and then
//      rewrites the tree IN THE SESSION'S CONFIG FILE, in place, in the
//      authoring grammar (bare names inside `{ h: [...] }` / `{ v: [...] }`)
//      — every byte outside the edited span survives, the edit is one
//      whole-file history entry, and a target/anchor the tree no longer
//      holds is a LOUD error from the store (the bar clicked was stale),
//      never a silent no-op.
//   5. RenderCache reads the edited tree back through the SAME watcher-driven
//      reload path a hand edit to the config file takes (bundled default <
//      CONFIG FILE < ACTIVE PRESET), and the edit survives a real restart
//      because the file IS the edit. A first-ever edit under a bundled
//      preset's name materializes the whole bundled declaration first
//      (`segments`/`presets` merge by name, wholesale).
//   6. brandon-layout-edit-2gc.5's own done-gate: "customized" is now the
//      fact that the config FILE authors a root at the path presetRoot()
//      reports for the active preset (`root` for a preset staging the
//      config root, `presets.<n>.root` otherwise) — hand-written or
//      click-written, indistinguishable by design — projected as
//      `entry.state.authoredRoots` and `.preset.customized`. Edit mode
//      synthesizes a `reset`-backed banner for it per preset for free, and
//      firing that reset through the real daemon handler DELETES the
//      authored root from the file, so the next reload falls back to the
//      bundled tree — never a silent drift between screen and disk.

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
import { ConfigError } from "../src/config/dsl-loader";
import { effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import { parseEffects, VERB_DISPATCH } from "../src/click/wire";
import { VERBS } from "../src/daemon/verbs";
import type { VerbContext } from "../src/daemon/verbs";
import {
  deriveConfigActionValidators,
  registerConfigValidator,
  validateConfigWrite,
} from "../src/daemon/verbs/config-validators";
import { RenderCache } from "../src/daemon/cache/render";
import type { CacheEntry } from "../src/daemon/cache/render";
import { EDIT_NS } from "../src/config/loader/edit-mode";
import {
  addableSegmentDomains,
  addableDomainName,
} from "../src/config/edit-chrome";
import { GitDataProvider } from "../src/daemon/cache/git";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { encodeLayoutOp } from "../src/config/layout-ops";
import { walkNodes, type LayoutNode } from "../src/config/dsl-types";
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
  // The global settings menu and the edit toggle it reaches are on every bar;
  // this file's assertions are about the fixture's OWN clickable regions.
  return ownLinks(urls);
}

// ─── loader: the removeSegment/insertSegment ActionDecl arms ─────────────────

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

// ─── config-validators: the derived gate is a one-member allow-list ──────────

// The members one derived contribution gates, by key — the shape assertions
// about "did MY action contribute its token" read, now that edit chrome unions
// its own tokens onto the same per-preset key.
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
    // [LAW:behavior-not-structure] The contract is "this action contributes ITS
    // token to that preset's root gate". The same key also carries the tokens
    // edit chrome mints for every content segment — now on every bar, since the
    // global settings menu makes edit mode reachable — so membership, not the
    // whole list, is what this action's declaration decides.
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
    // Both actions land on ONE key (the union is the point); membership rather
    // than exact contents, since edit chrome contributes to the same key.
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

  // brandon-layout-edit-2gc.5 PR review: a preset that declares NO
  // removeSegment/insertSegment/insertSegmentFrom action at all (e.g. one
  // edited down to zero non-exempt segments, so spliceContainer's loop never
  // ran) must still register `presets.<name>.root` — otherwise its OWN
  // synthesized `reset` action's target is unknown to the gate the moment
  // it's needed most.
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
    // The registration is the contract: a preset with no layout-op action of
    // its own still gets its root key, so its reset click is never orphaned.
    // Its members are whatever edit chrome minted for that preset's tree.
    expect(rootEntry).toBeDefined();
    expect(rootEntry!.spec.kind).toBe("allow-list");
  });
});

// ─── end-to-end: click → the config FILE, through the real daemon handler ────

let durable: DurableConfig;

// [LAW:one-source-of-truth] The runtime parses `src` for the render AND
// writes the same text as the session's config file, so the tree a click
// edits is the tree the bar rendered — exactly the daemon's own situation.
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
  return { config, store, render, click, dispose };
}

describe("apply-layout-op click → the config file", () => {
  beforeEach(() => {
    durable = durableConfig("cc-candybar-layout-click-");
  });
  afterEach(() => {
    durable.dispose();
  });

  // The comment beside `root` is the canary: a click edits ONE span of the
  // tree, and everything else in the file — this comment included — is
  // preserved verbatim.
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
    // The file's own root is the edited tree, in the authoring grammar.
    expect(durable.parsed().root).toEqual({ v: [{ h: ["git"] }, "bar"] });
    // One span changed; the rest of the file is the author's, byte for byte.
    const written = durable.text()!;
    expect(written).toContain(ROOT_COMMENT);
    expect(written).toContain(
      "removeDirectory: { persist: 'presets.default.root'",
    );
    expect(written).not.toBe(original);
    // And the edit is ONE whole-file history entry — the same shape a
    // persist/reset records, so undo needs no layout-specific path.
    expect(durable.history().past).toEqual([
      { file: durable.configPath, before: original, after: written },
    ]);
    dispose();
  });

  test("two clicks COMPOSE — the second edits the tree the first left behind", () => {
    const { render, click, dispose } = buildLayoutRuntime(SRC);
    const urls = extractUrls(render());
    click(urls[0]!); // remove directory
    click(urls[1]!); // insert gitPr after git
    expect(durable.parsed().root).toEqual({
      v: [{ h: ["git", "gitPr"] }, "bar"],
    });
    expect(durable.history().past).toHaveLength(2);
    dispose();
  });

  // [LAW:no-silent-failure] The bar that emitted the click was rendered
  // before the tree changed. There is no op log to "replay past" a stale
  // entry any more — the store refuses the edit, names the missing segment,
  // and touches neither the file nor the history.
  test("a stale target/anchor is a LOUD error from the store, and the file is untouched", () => {
    const { render, click, dispose } = buildLayoutRuntime(SRC);
    const urls = extractUrls(render());
    click(urls[0]!); // remove directory
    const afterFirst = durable.text()!;

    // The same `-` again: "directory" is already gone.
    expect(() => click(urls[0]!)).toThrow(/has no segment "directory"/);
    expect(durable.text()).toBe(afterFirst);
    expect(durable.history().past).toHaveLength(1);

    // An insert whose anchor was removed since the render, likewise.
    click(urls[2]!); // remove git
    expect(() => click(urls[1]!)).toThrow(/has no segment "git"/);
    expect(durable.parsed().root).toEqual({ v: [{ h: [] }, "bar"] });
    expect(durable.history().past).toHaveLength(2);
    dispose();
  });

  test("a hand-crafted click carrying an undeclared op token is rejected loudly", () => {
    const { dispose } = buildLayoutRuntime(SRC);
    const sessionState = new SessionState();
    durable.seedOrigin(sessionState, "s1");
    const ctx: VerbContext = { sessionState, dlog: () => {} };
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

  // [LAW:no-silent-failure] A click carries only a session id; WHICH file it
  // edits comes from the origin the render recorded. A session that never
  // rendered has none — the verb refuses rather than guessing the daemon's
  // own XDG path.
  test("a click on a session with no recorded render origin is refused — no file to write", () => {
    const { dispose } = buildLayoutRuntime(SRC);
    const ctx: VerbContext = {
      sessionState: new SessionState(),
      dlog: () => {},
    };
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

// ─── the "customized" banner's own escaping: quote/backslash preset names ──

// brandon-layout-edit-2gc.5 PR review: quotes and backslashes are LEGAL in a
// preset name (only empty/slash/newline are rejected — see loader/
// presets.ts), and wrapWithPresetRows splices the name into a
// synthesized Go-template string literal. Unlike the newline case (which
// gets rejected at load, since escaping can't fix an embedded literal
// newline), a quote/backslash-bearing name is escaped, not rejected — so
// this proves the escape actually holds through real parseAndValidate +
// registerDslConfig + renderDsl, not just by inspection.
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
    // The compile itself (parse every synthesized template) must not throw —
    // an unescaped quote would break the Go-template source.
    const store = new VariableStore();
    const registry = new SourceRegistry(
      store,
      "",
      undefined,
      new SessionState(),
    );
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

// brandon-layout-edit-2gc.5 PR review round 4: a preset's declared root may
// carry its OWN top-level `when` — including the A-grammar's bare-segment-
// ref shorthand `{ seg, when }` (loader/layout.ts), NOT only a container.
// wrapWithPresetRows's when-carry-up only reaches a container's own
// `when`; without ALSO copying it onto spliceEditChromeForPreset's
// synthetic wrapper for a bare-segment root, that shape's own gate never
// reached the carry-up at all.
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
    const registry = new SourceRegistry(
      store,
      "",
      undefined,
      new SessionState(),
    );
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

// ─── RenderCache integration: the file's tree, reload, restart, reset ───────

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

// [LAW:locality-or-seam] The bundled default's `toolbar` segment references
// `edit.toggle` (brandon-layout-edit-2gc.4), and `RenderCache` merges every
// project's config on top of that default — so `edit.mode`/`edit.toggle`
// (and, once validateConfig runs, per-preset `-`/`+` chrome) are now present
// in EVERY resolved preset root this suite builds, `when`-gated shut but
// structurally always there. This describe block asserts what a layout edit
// does to a preset's ORDINARY content, so chrome nodes — recognizable purely
// by the reserved `edit.` namespace their synthesis mints them under — are
// filtered out here rather than at every call site.
function segmentNamesOf(root: LayoutNode): string[] {
  const out: string[] = [];
  const walk = (node: LayoutNode): void => {
    if (node.kind === "segment") {
      // Synthesized chrome, not content: edit mode's +/- affordances and the
      // global settings menu (candybar-settings-ui-aok.1) both ride every
      // resolved preset root. These assertions are about the CONTENT tree.
      if (!node.name.startsWith(EDIT_NS) && !node.name.startsWith(SETTINGS_NS))
        out.push(node.name);
    } else {
      for (const c of node.children) walk(c);
    }
  };
  walk(root);
  return out;
}

// The content names of the tree a preset renders, read the way the render
// does (presetRoot — a preset staging the config root reads `root`).
function presetNamesOf(entry: CacheEntry, preset: string): string[] {
  return segmentNamesOf(presetRoot(entry.state!.config, preset).node);
}

// Fire one leaf verb through the REAL handler, with the wire's own encoding
// — exactly what a hand click sends, no key discovered from an action name.
function fireVerb(verb: string, ctx: VerbContext, ...args: string[]): void {
  VERBS.get(verb)!(args.map(encodeURIComponent).join("/"), ctx);
}

// A session that has rendered from the fixture's file — the origin a durable
// verb resolves the file from. The cache's own SessionState, so the click
// reads the same store the render published into.
function originCtx(sessionState: SessionState, sessionId = "s1"): VerbContext {
  durable.seedOrigin(sessionState, sessionId);
  return { sessionState, dlog: () => {} };
}

describe("RenderCache: authoredRoots — the file authors a root at the preset's path", () => {
  let savedCcConfig: string | undefined;

  beforeEach(() => {
    durable = durableConfig("cc-candybar-layout-authored-");
    savedCcConfig = process.env.CC_CANDYBAR_CONFIG;
    delete process.env.CC_CANDYBAR_CONFIG;
  });
  afterEach(() => {
    if (savedCcConfig === undefined) delete process.env.CC_CANDYBAR_CONFIG;
    else process.env.CC_CANDYBAR_CONFIG = savedCcConfig;
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
      return entry.state!.authoredRoots;
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

  // [LAW:one-source-of-truth] "Where does this preset's tree live" is ONE
  // decision (presetRoot): a declared preset with no root of its own stages
  // the config root, so the file's `root` customizes it exactly as it does
  // the floor — the same fact read at the same path.
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
  let savedCcConfig: string | undefined;

  beforeEach(() => {
    durable = durableConfig("cc-candybar-layout-rc-");
    savedCcConfig = process.env.CC_CANDYBAR_CONFIG;
    delete process.env.CC_CANDYBAR_CONFIG;
  });
  afterEach(() => {
    if (savedCcConfig === undefined) delete process.env.CC_CANDYBAR_CONFIG;
    else process.env.CC_CANDYBAR_CONFIG = savedCcConfig;
    durable.dispose();
  });

  const ROOT_COMMENT = "// the hand-authored row";
  // Declares its own `rm`/`ins` actions so the cache's derived gate admits
  // exactly the tokens the tests fire — the same gate a rendered `-`/`+`
  // click passes through.
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

  // [LAW:one-source-of-truth] The click's write reaches the LIVE cache through
  // the SAME watcher a hand edit to the file fires — there is no second
  // "overrides changed" channel. The first application is the click itself;
  // a retry (fs.watch has no ready signal — see reload-signal.ts) re-touches
  // the file with the bytes the click left, so every application ends in the
  // same on-disk state and emits an event.
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
      // Hand-authored `root` → already "customized" before any click: the
      // banner's fact is "the file authors this tree", by whichever hand.
      expect(entry.state!.authoredRoots.has("default")).toBe(true);

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

  // [LAW:verifiable-goals] "The change survives a daemon restart" — a fresh
  // RenderCache/GitDataProvider/WatcherRegistry (exactly what a real restart
  // rebuilds), reading nothing but the config file on disk.
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

  // [LAW:verifiable-goals] brandon-layout-edit-2gc.4's own done-gate: the
  // bundled default's `toolbar` segment hosts `edit.toggle`
  // (docs/interaction-authoring.md's "The bundled default ships this on"),
  // which raises a self-lockout question .3's handoff flagged explicitly —
  // does removing the trigger's own host via edit mode's `-` strand a user
  // with no way back? Proven here through the REAL RenderCache (the ONLY
  // harness that resolves the file's tree against the bundled default AND
  // recomputes the `+` picker's addable domain fresh each reload — see
  // dsl-edit-mode.test.ts's sibling test for why its lighter-weight harness
  // can prove the click but not this), against a project with NO
  // hand-authored segments/root/actions of its own, so every artifact here
  // — `toolbar`, `edit.toggle`, the addable domain, and the gate the clicks
  // pass — comes from DEFAULT_DSL_CONFIG's own edit chrome alone.
  test("toolbar removed via edit mode is offered back by every remaining `+`, and a real reload restores it", () => {
    const bareUserConfig = `{ globals: {}, segments: {} }`;
    durable.write(bareUserConfig);

    const { cache, sessionState, cleanups } = makeCache();
    try {
      // Before any click: toolbar is in the resolved tree, the file authors
      // no root of its own, and the `+` picker's addable domain does NOT yet
      // offer toolbar (it's already placed).
      const before = cache.getOrCreate(
        durable.projectDir,
        durable.projectDir,
        undefined,
      );
      expect(before.lastError).toBeNull();
      expect(presetNamesOf(before, "default")).toContain("toolbar");
      expect(before.state!.authoredRoots.has("default")).toBe(false);

      // Edit mode's own `-` beside toolbar: the token its synthesized action
      // declares, through the gate this cache entry registered for it.
      fireVerb(
        "apply-layout-op",
        originCtx(sessionState),
        "s1",
        "presets.default.root",
        encodeLayoutOp({ op: "remove", target: "toolbar" }),
      );
      // MATERIALIZATION: the file never authored a root, so the whole
      // bundled root was copied in (authoring grammar) and then edited —
      // its siblings untouched.
      const parsed = durable.parsed();
      expect(parsed.root).toBeDefined();
      expect(parsed.globals).toEqual({});
      expect(parsed.segments).toEqual({});

      // A fresh cache — a real restart, not an in-process cache rebuild —
      // reloading against the SAME project dir (same config file).
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
        expect(afterRemove.state!.authoredRoots.has("default")).toBe(true);
        // The trigger is gone, but the REST of the preset's chrome is still
        // there — other `-`/`+` affordances remain, so the bar isn't a dead
        // end (only the render's own `when` gate hides them until a session
        // sets edit.mode open, which this test doesn't need to drive to
        // confirm the STRUCTURE is intact).
        const allNames: string[] = [];
        for (const node of walkNodes(
          presetRoot(afterRemove.state!.config, "default").node,
        )) {
          if (node.kind === "segment") allNames.push(node.name);
        }
        const remainingChrome = allNames.filter((n) => n.startsWith(EDIT_NS));
        expect(remainingChrome.length).toBeGreaterThan(0);
        // And "toolbar" is now a legal target of an insertSegmentFrom pick —
        // every `+` in this preset ranges the SAME addable domain, computed
        // fresh from the tree above, so any of them offers it back.
        expect(
          addableSegmentDomains(afterRemove.state!.config).get(
            addableDomainName("default"),
          ),
        ).toContain("toolbar");

        // Click that `+` and pick "toolbar": the exact token
        // insertSegmentFrom's real click writes, through the gate this
        // reload derived from that domain.
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
          // Fully recovered — through clicks the bar itself offered, no
          // hand edit, surviving two full "restarts" along the way.
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

  // [LAW:verifiable-goals] brandon-layout-edit-2gc.5's own done-gate: the
  // visible diagnostic and its reset affordance, driven through the REAL
  // RenderCache (authoredRoots is a fact of THIS reload, never re-read), the
  // REAL synthesized reset action (edit-chrome.ts's wrapWithPresetRows,
  // reached only when DEFAULT_DSL_CONFIG's `toolbar` wires edit.toggle —
  // exactly the merged-default path every other test in this describe block
  // already exercises), and the REAL daemon reset-config handler — never a
  // synthetic stand-in for any of the three.
  test("a customized preset shows the diagnostic; resetting deletes the authored root and restores the bundled tree", () => {
    durable.write(`{ globals: {}, segments: {} }`);

    const { cache, sessionState, cleanups } = makeCache();
    try {
      // Before any edit: not customized — the file authors no root — and
      // the tree is the bundled default's own.
      const before = cache.getOrCreate(
        durable.projectDir,
        durable.projectDir,
        undefined,
      );
      expect(before.lastError).toBeNull();
      expect(before.state!.authoredRoots.has("default")).toBe(false);
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
        expect(customized.state!.authoredRoots.has("default")).toBe(true);
        expect(presetNamesOf(customized, "default")).toEqual(
          namesBefore.filter((n) => n !== "directory"),
        );
        // The synthesized reset action targets the SAME key the +/-
        // affordances already write — no second gate to register.
        const resetActionNames = Object.entries(
          customized.state!.config.actions,
        )
          .filter(([, a]) => "reset" in a && a.reset === "presets.default.root")
          .map(([name]) => name);
        expect(resetActionNames.length).toBe(1);

        // Fire the reset click through the REAL daemon handler — no key
        // to discover from the action name; reset-config only ever needs
        // the target key, exactly like a hand click would send.
        fireVerb(
          "reset-config",
          originCtx(sessionState2),
          "s1",
          "presets.default.root",
        );
        // The authored root is DELETED from the file; its siblings stay.
        expect(durable.parsed()).toEqual({ globals: {}, segments: {} });

        const { cache: cache3, cleanups: cleanups3 } = makeCache();
        try {
          const restored = cache3.getOrCreate(
            durable.projectDir,
            durable.projectDir,
            undefined,
          );
          expect(restored.lastError).toBeNull();
          expect(restored.state!.authoredRoots.has("default")).toBe(false);
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

  // brandon-layout-edit-2gc.5 PR review: the bundled default's OWN
  // "compact" preset has exactly 3 non-exempt segments (directory/git/
  // context — candybar-settings-ui-aok.3 dropped its standalone preset
  // control, since the settings menu is spliced into every preset root and
  // carries one) — removing all 3 via the synthesized `-` chrome
  // leaves spliceContainer with zero children, so removeChrome/insertChrome
  // contribute NOTHING for "compact" on the next reload. Proves the reset
  // banner's own click still works in exactly that state, through the REAL
  // RenderCache and the REAL daemon reset-config handler — not just that
  // the key is derived (the narrower unit test above).
  //
  // Also the materialization gate: the file never declared `compact`, and
  // `presets` merge by name WHOLESALE, so the first `-` copies the whole
  // bundled compact declaration (its `globals` and its `root`, in authoring
  // grammar) into the file before editing — a one-field `compact` would
  // shadow the bundled one and lose its `padding: 0`.
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
      expect(entry.state!.authoredRoots.has("compact")).toBe(false);

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
      expect(emptied.state!.authoredRoots.has("compact")).toBe(true);
      expect(presetNamesOf(emptied, "compact")).toEqual([]);

      // Would throw BadVerbArgs("unknown config key") before the
      // always-registered preset-root contribution.
      expect(() =>
        fireVerb(
          "reset-config",
          originCtx(sessionState2),
          "s1",
          "presets.compact.root",
        ),
      ).not.toThrow();
      // reset = DELETE that path: the authored root is gone from the file.
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
      expect(restored.state!.authoredRoots.has("compact")).toBe(false);
    } finally {
      for (const fn of cleanups3) fn();
    }
  });
});
