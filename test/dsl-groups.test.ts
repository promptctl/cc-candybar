// [LAW:verifiable-goals] Group-sugar acceptance (2de.4), driven through the real
// spine (registerDslConfig + renderDsl), the real loader (parse → merge →
// validate), and the real set-state gate — never a parallel rig:
//
//   1. `{ kind: "group" }` lowers to canonical container/segment nodes and
//      SYNTHESIZES its state var + cycle action + toggle segment under the
//      reserved `groups.` namespace — one declaration, every artifact derived.
//   2. The toggle round trip: closed renders "label ▸" and no body; the click
//      writes the group's name; the next render shows "label ▾" + body; the
//      second click writes "closed". The glyph TRAILS the label it gates.
//   3. Accordion = sibling groups sharing `key`: one key holds one open name,
//      so opening B auto-closes A — no accordion mode, just the shared value.
//   4. Nested disclosure = nested groups with DISTINCT keys; a closed parent
//      hides the whole subtree (child state persists invisibly).
//   5. The loader proves the group invariants (identifier name, unique names,
//      reserved namespace, ancestor/descendant key sharing, one open per key).

import { ownValidators } from "./helpers/ambient-chrome";
import { getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import {
  deriveActionValidators,
  registerStateValidator,
} from "../src/daemon/verbs/state-validators";
import { ConfigError } from "../src/config/dsl-loader";
import { testVerbContext, effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import { parseEffects, VERB_DISPATCH } from "../src/click/wire";
import { VERBS } from "../src/daemon/verbs";
import type { VerbContext } from "../src/daemon/verbs";

const ALLOWED = new Set(listResolvablePaletteNames());

function opts() {
  return {
    style: "powerline" as const,
    colorCompatibility: "truecolor" as const,
    wrap: true,
    padding: 0,
    charset: "unicode" as const,
    width: Number.POSITIVE_INFINITY,
  };
}

function extractUrls(rendered: string): string[] {
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\]8;;([^\x1b]+)\x1b\\/g;
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) urls.push(m[1]!);
  return urls;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

// Same real-spine harness as dsl-actions: real loader, real render, clicks
// dispatched through the real daemon verb handlers against the derived gate.
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
  const disposers = deriveActionValidators(config).map(({ key, spec }) =>
    registerStateValidator(key, spec),
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
  // Click the toggle whose URL writes `value` to `key` (a group toggle's
  // set-state), regardless of which row it rendered on.
  const clickToggle = (out: string, key: string, value: string): void => {
    const url = extractUrls(out).find((u) =>
      effectsOf(u).some((e) => e.args[1] === key && e.args[2] === value),
    );
    if (!url) throw new Error(`no toggle writing ${key}=${value} rendered`);
    click(url);
  };
  const dispose = (): void => disposers.forEach((d) => d());
  return { config, store, sessionState, render, click, clickToggle, dispose };
}

// ─── The toggle round trip ───────────────────────────────────────────────────

const DETAILS_SRC = `{
  globals: {},
  variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
  segments: {
    metrics: { template: 'METRICS-BODY', bg: 'surface', fg: 'foreground' },
  },
  root: {
    kind: 'container', direction: 'vertical', children: [
      { kind: 'group', name: 'details', label: 'details', children: [
        { kind: 'segment', name: 'metrics' },
      ]},
    ],
  },
}`;

describe("2de.4 — group sugar: toggle round trip", () => {
  test("closed by default: toggle renders ▸, body absent (no blank line)", () => {
    const { render, dispose } = buildRuntime(DETAILS_SRC);
    const out = stripAnsi(render());
    expect(out).toContain("details ▸");
    expect(out).not.toContain("METRICS-BODY");
    expect(out.split("\n")).toHaveLength(1);
    dispose();
  });

  test("click opens: ▾ + body rendered; second click closes", () => {
    const { render, clickToggle, sessionState, dispose } =
      buildRuntime(DETAILS_SRC);
    clickToggle(render(), "groups.details", "details");
    expect(sessionState.get("s1", "groups.details")).toBe("details");
    const open = stripAnsi(render());
    expect(open).toContain("details ▾");
    expect(open).toContain("METRICS-BODY");
    clickToggle(render(), "groups.details", "closed");
    expect(stripAnsi(render())).not.toContain("METRICS-BODY");
    dispose();
  });

  test("open: true renders the body before any click", () => {
    const src = DETAILS_SRC.replace(
      "label: 'details',",
      "label: 'details', open: true,",
    );
    const { render, dispose } = buildRuntime(src);
    const out = stripAnsi(render());
    expect(out).toContain("details ▾");
    expect(out).toContain("METRICS-BODY");
    dispose();
  });

  test("synthesizes var + cycle action + toggle segment under groups.*, and the gate derives", () => {
    const config = parseAndValidate("<test>", DETAILS_SRC, ALLOWED);
    expect(config.variables["groups.details"]).toEqual({
      kind: "state",
      key: "groups.details",
      default: "closed",
    });
    expect(config.actions["groups.details"]).toEqual({
      set: "groups.details",
      cycle: ["closed", "details"],
    });
    expect(config.segments["groups.details"]?.template).toBe(
      '{{ action "groups.details" "details ▸" "details ▾" }}',
    );
    expect(ownValidators(config, deriveActionValidators(config))).toEqual([
      {
        key: "groups.details",
        spec: { kind: "allow-list", allowed: ["closed", "details"] },
      },
    ]);
  });

  test("a label needing escaping survives the template splice", () => {
    const src = DETAILS_SRC.replace(
      "label: 'details',",
      `label: 'say "hi" \\\\ ok',`,
    );
    const { render, dispose } = buildRuntime(src);
    expect(stripAnsi(render())).toContain('say "hi" \\ ok ▸');
    dispose();
  });
});

// ─── Accordion: siblings sharing a key ───────────────────────────────────────

const ACCORDION_SRC = `{
  globals: {},
  variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
  segments: {
    filesBody: { template: 'FILES-BODY', bg: 'surface', fg: 'foreground' },
    toolsBody: { template: 'TOOLS-BODY', bg: 'surface', fg: 'foreground' },
  },
  root: {
    kind: 'container', direction: 'vertical', children: [
      { kind: 'group', name: 'files', label: 'files', key: 'menu', children: [
        { kind: 'segment', name: 'filesBody' },
      ]},
      { kind: 'group', name: 'tools', label: 'tools', key: 'menu', children: [
        { kind: 'segment', name: 'toolsBody' },
      ]},
    ],
  },
}`;

describe("2de.4 — accordion (shared key)", () => {
  test("one key holds one open group: opening B auto-closes A", () => {
    const { render, clickToggle, dispose } = buildRuntime(ACCORDION_SRC);
    clickToggle(render(), "menu", "files");
    let out = stripAnsi(render());
    expect(out).toContain("files ▾");
    expect(out).toContain("FILES-BODY");
    expect(out).toContain("tools ▸");
    expect(out).not.toContain("TOOLS-BODY");
    // B's toggle renders closed (current "files" is outside its cycle domain),
    // so its click writes "tools" — expand B, auto-closing A on the shared key.
    clickToggle(render(), "menu", "tools");
    out = stripAnsi(render());
    expect(out).toContain("files ▸");
    expect(out).not.toContain("FILES-BODY");
    expect(out).toContain("tools ▾");
    expect(out).toContain("TOOLS-BODY");
    dispose();
  });

  test("the shared key's gate is the union of the sibling cycles", () => {
    const config = parseAndValidate("<test>", ACCORDION_SRC, ALLOWED);
    expect(ownValidators(config, deriveActionValidators(config))).toEqual([
      {
        key: "menu",
        spec: { kind: "allow-list", allowed: ["closed", "files", "tools"] },
      },
    ]);
  });
});

// ─── Nested disclosure: distinct keys ────────────────────────────────────────

describe("2de.4 — nested groups (distinct keys)", () => {
  const SRC = `{
    globals: {},
    variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
    segments: {
      leaf: { template: 'LEAF-BODY', bg: 'surface', fg: 'foreground' },
    },
    root: {
      kind: 'container', direction: 'vertical', children: [
        { kind: 'group', name: 'outer', label: 'outer', children: [
          { kind: 'group', name: 'inner', label: 'inner', children: [
            { kind: 'segment', name: 'leaf' },
          ]},
        ]},
      ],
    },
  }`;

  test("nested group synthesizes toggle with depth-derived indent prefix", () => {
    const config = parseAndValidate("<test>", SRC, ALLOWED);
    // outer is depth-0: no indent
    expect(config.segments["groups.outer"]?.template).toBe(
      '{{ action "groups.outer" "outer ▸" "outer ▾" }}',
    );
    // inner is depth-1 (one ancestor group): 2-space leading indent, glyph trails
    expect(config.segments["groups.inner"]?.template).toBe(
      '{{ action "groups.inner" "  inner ▸" "  inner ▾" }}',
    );
  });

  test("a closed parent hides the whole subtree; child state persists invisibly", () => {
    const { render, clickToggle, dispose } = buildRuntime(SRC);
    // Closed outer: inner toggle not rendered at all.
    expect(stripAnsi(render())).not.toContain("inner");
    clickToggle(render(), "groups.outer", "outer");
    let out = stripAnsi(render());
    expect(out).toContain("inner ▸");
    expect(out).not.toContain("LEAF-BODY");
    clickToggle(render(), "groups.inner", "inner");
    expect(stripAnsi(render())).toContain("LEAF-BODY");
    // Close outer: everything inside vanishes; reopen: inner is STILL open.
    clickToggle(render(), "groups.outer", "closed");
    expect(stripAnsi(render())).not.toContain("LEAF-BODY");
    clickToggle(render(), "groups.outer", "outer");
    expect(stripAnsi(render())).toContain("LEAF-BODY");
    dispose();
  });
});

// ─── Loader invariants ───────────────────────────────────────────────────────

describe("2de.4 — loader proves the group invariants", () => {
  const expectIssue = (src: string, re: RegExp) => {
    try {
      parseAndValidate("<test>", src, ALLOWED);
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toMatch(re);
    }
  };

  const withGroups = (groups: string, extraSections = "") => `{
    globals: {},
    variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
    segments: { body: { template: 'B', bg: 'surface', fg: 'foreground' } },
    ${extraSections}
    root: { kind: 'container', direction: 'vertical', children: [${groups}] },
  }`;

  const group = (fields: string) =>
    `{ kind: 'group', ${fields}, children: [{ kind: 'segment', name: 'body' }] }`;

  test("a non-identifier name is rejected", () => {
    expectIssue(
      withGroups(group(`name: 'my-group', label: 'x'`)),
      /must be an identifier/,
    );
  });

  test("the reserved name 'closed' is rejected", () => {
    expectIssue(
      withGroups(group(`name: 'closed', label: 'x'`)),
      /not the reserved "closed"/,
    );
  });

  test("a missing label is rejected", () => {
    expectIssue(withGroups(group(`name: 'g'`)), /label/);
  });

  test("duplicate group names are rejected", () => {
    expectIssue(
      withGroups(
        `${group(`name: 'g', label: 'a'`)}, ${group(`name: 'g', label: 'b'`)}`,
      ),
      /duplicate group name "g"/,
    );
  });

  test("a user variable under the reserved namespace is rejected", () => {
    expectIssue(
      withGroups(
        group(`name: 'g', label: 'x'`),
        `// reserved-namespace squatter
        `,
      ).replace(
        "'session.id': { kind: 'input', path: 'session_id', default: '' }",
        "'session.id': { kind: 'input', path: 'session_id', default: '' }, 'groups.mine': { kind: 'literal', value: 'v' }",
      ),
      /reserved "groups\." namespace/,
    );
  });

  test("an ancestor and descendant sharing a key are rejected", () => {
    const src = withGroups(
      `{ kind: 'group', name: 'outer', label: 'o', key: 'menu', children: [
         { kind: 'group', name: 'inner', label: 'i', key: 'menu', children: [
           { kind: 'segment', name: 'body' },
         ]},
       ]}`,
    );
    expectIssue(src, /shares key "menu" with its ancestor/);
  });

  test("two open:true groups on one shared key are rejected", () => {
    const src = withGroups(
      `${group(`name: 'a', label: 'a', key: 'menu', open: true`)},
       ${group(`name: 'b', label: 'b', key: 'menu', open: true`)}`,
    );
    expectIssue(src, /both declare open: true/);
  });

  test("sibling groups sharing a key with one open: true parse, default = its name", () => {
    const src = withGroups(
      `${group(`name: 'a', label: 'a', key: 'menu', open: true`)},
       ${group(`name: 'b', label: 'b', key: 'menu'`)}`,
    );
    const config = parseAndValidate("<test>", src, ALLOWED);
    expect(config.variables["groups.a"]).toEqual({
      kind: "state",
      key: "menu",
      default: "a",
    });
    expect(config.variables["groups.b"]).toEqual({
      kind: "state",
      key: "menu",
      default: "a",
    });
  });

  test("a slash-bearing group key is rejected", () => {
    expectIssue(
      withGroups(group(`name: 'g', label: 'x', key: 'a/b'`)),
      /slash-free SessionState key/,
    );
  });

  test("an unknown key on a group node is rejected", () => {
    expectIssue(
      withGroups(group(`name: 'g', label: 'x', glyph: '✦'`)),
      /Unknown layout-node key "glyph"/,
    );
  });
});
