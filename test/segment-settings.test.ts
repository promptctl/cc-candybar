// Per-placement settings (brandon-segment-settings-i4n.qzi): a segment
// DECLARES its settings, each PLACEMENT in `root` is an instance with its own
// id and values, and the segment's templates read `.settings.<name>` scoped to
// the placement being rendered.
import type { RichText } from "@promptctl/rich-js";
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
import { linkUrls, stripAnsi } from "./helpers/ansi";
import { mintPlacement } from "../src/config/layout-ops";
import { arrangedSegment } from "../src/config/edit-chrome";
import { insertSegmentRef, removeSegmentRef } from "../src/config/json5-edit";
import type { LayoutNode } from "../src/config/dsl-types";
import { definedStyle } from "../src/template-engine/cells.js";

const ALLOWED = new Set(listResolvablePaletteNames());

function buildRuntime(src: string) {
  const config = parseAndValidate("<test>", src, ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { cwd: process.cwd() });
  const sink = new Map<string, readonly RichText[]>();
  const render = (): string =>
    renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: "s1", project_dir: "/tmp/proj" },
      {
        style: "powerline" as const,
        colorCompatibility: "truecolor" as const,
        wrap: true,
        padding: 0,
        charset: "unicode" as const,
        width: Number.POSITIVE_INFINITY,
      },
      { perSegmentSink: sink },
    );
  const disposers = deriveActionValidators(config).map(({ key, spec }) =>
    registerStateValidator(key, spec),
  );
  const ctx = testVerbContext(sessionState);
  const click = (url: string): void => {
    const { verb, value } = parseHandlerUrl(url);
    const effects =
      verb === VERB_DISPATCH ? parseEffects(value) : [{ verb, value }];
    for (const e of effects) VERBS.get(e.verb)!(e.value, ctx);
  };
  // The text one placement drew, read off the sink by its id.
  const textOf = (id: string): string =>
    (sink.get(id) ?? [])
      .map((t) => t.plain)
      .join("")
      .trim();
  const dispose = (): void => disposers.forEach((d) => d());
  return { config, sessionState, sink, render, click, textOf, dispose };
}

const SESSION = `'session.id': { kind: 'input', path: 'session_id', default: '' }`;

// One definition, three placements: the bare one reads every default, the
// other two set their own values.
const CLOCK_SRC = `{
  variables: { ${SESSION} },
  segments: {
    clock: {
      template: '{{ if .settings.seconds }}hh:mm:ss{{ else }}hh:mm{{ end }} {{ .settings.zone }} x{{ .settings.width }}',
      settings: {
        seconds: { label: 'Seconds', domain: 'bool', default: false },
        zone: { label: 'Zone', domain: ['local', 'utc'], default: 'local' },
        width: { label: 'Width', domain: { min: 1, max: 9 }, default: 3 },
      },
    },
  },
  root: { h: [
    'clock',
    { seg: 'clock', id: 'utcClock', settings: { zone: 'utc', seconds: true } },
    { seg: 'clock', id: 'wide', settings: { width: 9 } },
  ] },
}`;

describe("a placement renders with its own settings", () => {
  test("each placement of one segment reads its own values, the rest defaults", () => {
    const rt = buildRuntime(CLOCK_SRC);
    rt.render();
    expect(rt.textOf("clock")).toBe("hh:mm local x3");
    expect(rt.textOf("utcClock")).toBe("hh:mm:ss utc x3");
    expect(rt.textOf("wide")).toBe("hh:mm local x9");
    rt.dispose();
  });

  test("a setting reaches the segment's `when`, `bg:` and `fg:` too", () => {
    const rt = buildRuntime(`{
      variables: { ${SESSION} },
      segments: {
        tag: {
          template: 'tag',
          when: '{{ .settings.shown }}',
          bg: '{{ if .settings.alarm }}#ff0000{{ else }}#000000{{ end }}',
          settings: {
            shown: { label: 'Shown', domain: 'bool', default: true },
            alarm: { label: 'Alarm', domain: 'bool', default: false },
          },
        },
      },
      root: { h: [
        { seg: 'tag', id: 'quiet' },
        { seg: 'tag', id: 'loud', settings: { alarm: true } },
        { seg: 'tag', id: 'gone', settings: { shown: false } },
      ] },
    }`);
    rt.render();
    const bgOf = (id: string) =>
      definedStyle(rt.sink.get(id)![0]!.style).bgcolor?.value?.hex;
    expect(bgOf("quiet")).toBe("#000000");
    expect(bgOf("loud")).toBe("#ff0000");
    expect(rt.sink.has("gone")).toBe(false);
    rt.dispose();
  });
});

describe("a setting named like an Object member", () => {
  test("an unset one reads its declared default, never the inherited member", () => {
    const rt = buildRuntime(`{
      variables: { ${SESSION} },
      segments: {
        tag: {
          template: '{{ if .settings.toString }}yes{{ else }}no{{ end }}',
          settings: {
            toString: { label: 'T', domain: 'bool', default: false },
            compact: { label: 'C', domain: 'bool', default: false },
          },
        },
      },
      root: { h: [{ seg: 'tag', settings: { compact: true } }] },
    }`);
    rt.render();
    expect(rt.textOf("tag")).toBe("no");
    rt.dispose();
  });
});

describe("two placements of a menu-hosting segment open independently", () => {
  const SRC = `{
    variables: {
      ${SESSION},
      'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 },
    },
    actions: { applyTheme: { set: 'theme', from: 'themes' } },
    segments: { picker: { template: 'T {{ menu "applyTheme" "▸" "▾" }}' } },
    root: { h: ['picker', { seg: 'picker', id: 'second' }] },
  }`;

  test("each placement's menu is keyed by its id, and opening one leaves the other closed", () => {
    const rt = buildRuntime(SRC);
    expect(rt.config.variables["menus.picker.applyTheme"]).toBeDefined();
    expect(rt.config.variables["menus.second.applyTheme"]).toBeDefined();
    const open = (key: string): void => {
      const url = linkUrls(rt.render()).find((u) =>
        effectsOf(u).some((e) => e.args[1] === key && e.args[2] === "applyTheme"),
      );
      if (url === undefined) throw new Error(`no toggle for ${key}`);
      rt.click(url);
    };
    open("menus.second.applyTheme");
    expect(rt.sessionState.get("s1", "menus.second.applyTheme")).toBe(
      "applyTheme",
    );
    rt.render();
    // The open copy drops its picker body; the other still draws its glyph only.
    expect(rt.sink.get("second")!.length).toBeGreaterThan(
      rt.sink.get("picker")!.length,
    );
    open("menus.picker.applyTheme");
    expect(rt.sessionState.get("s1", "menus.picker.applyTheme")).toBe(
      "applyTheme",
    );
    expect(rt.sessionState.get("s1", "menus.second.applyTheme")).toBe(
      "applyTheme",
    );
    rt.dispose();
  });
});

describe("a placement is named by its id", () => {
  test("a placement whose settings break its template is the one the error names", () => {
    const rt = buildRuntime(`{
      variables: { ${SESSION} },
      segments: {
        tag: {
          template: '{{ if .settings.boom }}{{ ramp 1 "step" 5 "#ff0000" 1 "#0000ff" }}{{ end }}ok',
          settings: { boom: { label: 'Boom', domain: 'bool', default: false } },
        },
      },
      root: { h: ['tag', { seg: 'tag', id: 'broken', settings: { boom: true } }] },
    }`);
    const text = stripAnsi(rt.render());
    expect(rt.textOf("tag")).toBe("ok");
    expect(text).toContain("⚠ broken: ");
    rt.dispose();
  });

  test("two presets may give one id to two different menu-hosting segments", () => {
    const config = parseAndValidate(
      "<test>",
      `{
        variables: {
          ${SESSION},
          'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 },
        },
        actions: { applyTheme: { set: 'theme', from: 'themes' } },
        segments: {
          menuA: { template: 'A {{ menu "applyTheme" "▸" "▾" }}' },
          menuB: { template: 'B {{ menu "applyTheme" "▸" "▾" }}' },
        },
        presets: {
          a: { root: { h: [{ seg: 'menuA', id: 'picker' }] } },
          b: { root: { h: [{ seg: 'menuB', id: 'picker' }] } },
        },
      }`,
      ALLOWED,
    );
    expect(config.variables["menus.picker.applyTheme"]).toBeDefined();
  });

  test("two placements of a keyed menu share the open state its key names", () => {
    const config = parseAndValidate(
      "<test>",
      `{
        variables: {
          ${SESSION},
          'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 },
        },
        actions: { applyTheme: { set: 'theme', from: 'themes' } },
        segments: { picker: { template: 'T {{ menu "applyTheme" "▸" "▾" (dict "key" "k") }}' } },
        root: { h: ['picker', { seg: 'picker', id: 'picker-2' }] },
      }`,
      ALLOWED,
    );
    expect(config.variables["menus.k"]).toBeDefined();
  });

  test("edit mode labels each placement with its id", () => {
    const config = parseAndValidate("<test>", CLOCK_SRC, ALLOWED);
    expect(config.segments["edit.label:utcClock:clock"]?.template).toBe('{{ "utcClock" }}');
    expect(config.segments["edit.label:clock:clock"]?.template).toBe('{{ "clock" }}');
    expect(arrangedSegment("edit.label:utcClock:clock")).toBe("clock");
  });
});

// Every refusal names what is wrong and where.
describe("load errors", () => {
  const withSegment = (settings: string, root: string, template = "x") => `{
    variables: { ${SESSION} },
    segments: { s: { template: '${template}', settings: { ${settings} } } },
    root: ${root},
  }`;
  const BOOL = `on: { label: 'On', domain: 'bool', default: false }`;
  const refusal = (src: string): string => {
    try {
      parseAndValidate("<test>", src, ALLOWED);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      return (e as ConfigError).message;
    }
    throw new Error("expected a ConfigError");
  };

  test("two placements sharing an id", () => {
    expect(refusal(withSegment(BOOL, `{ h: ['s', 's'] }`))).toContain(
      `root has 2 placements with the id "s"`,
    );
    expect(
      refusal(
        withSegment(BOOL, `{ h: [{ seg: 's', id: 'a' }, { seg: 's', id: 'a' }] }`),
      ),
    ).toContain(`root has 2 placements with the id "a"`);
  });

  test("a placement setting its segment does not declare", () => {
    expect(
      refusal(withSegment(BOOL, `{ h: [{ seg: 's', settings: { off: true } }] }`)),
    ).toContain(
      `placement "s" of segment "s" sets "off", which segment "s" does not declare (it has: on, theme)`,
    );
  });

  test.each([
    [BOOL, `{ on: 'yes' }`, `sets "on" to "yes", but it must be true or false`],
    [
      `zone: { label: 'Zone', domain: ['local', 'utc'], default: 'local' }`,
      `{ zone: 'mars' }`,
      `sets "zone" to "mars", but it must be one of "local", "utc"`,
    ],
    [
      `n: { label: 'N', domain: { min: 1, max: 3 }, default: 1 }`,
      `{ n: 4 }`,
      `sets "n" to 4, but it must be an integer from 1 to 3`,
    ],
  ])("a placement value outside its domain (%s)", (decl, values, message) => {
    expect(
      refusal(withSegment(decl, `{ h: [{ seg: 's', settings: ${values} }] }`)),
    ).toContain(message);
  });

  test("a template reading a setting its segment does not declare", () => {
    expect(
      refusal(withSegment(BOOL, `{ h: ['s'] }`, "{{ .settings.off }}")),
    ).toContain(
      `Template reads ".settings.off", but segment "s" has no setting "off" (it has: on, theme)`,
    );
  });

  test.each([
    [`on: { label: 'On', domain: 'bool', default: 'no' }`, `default must be true or false, got "no"`],
    [`on: { label: 'On', domain: [], default: 'a' }`, `a list domain must be a non-empty list of words`],
    [`on: { label: 'On', domain: { min: 3, max: 1 }, default: 2 }`, `a range domain is { min, max } with integers min ≤ max`],
    [`on: { domain: 'bool', default: true }`, `a setting needs a one-line, non-empty "label"`],
    [`on: { label: 'a\\nb', domain: 'bool', default: true }`, `a setting needs a one-line, non-empty "label"`],
    [`on: { label: 'On', domain: ['', 'a'], default: 'a' }`, `a list domain's words must be non-empty, slash-free, and newline-free`],
    [`on: { label: 'On', domain: ['a/b', 'a'], default: 'a' }`, `a list domain's words must be non-empty, slash-free, and newline-free`],
    [`'show-hash': { label: 'Hash', domain: 'bool', default: true }`, `setting name "show-hash" is read as .settings.show-hash`],
  ])("a malformed declaration: %s", (decl, message) => {
    expect(refusal(withSegment(decl, `{ h: ['s'] }`))).toContain(message);
  });

  test("a variable stored under `settings`", () => {
    expect(
      refusal(`{
        variables: { ${SESSION}, 'settings.x': { kind: 'literal', value: 'v' } },
        segments: { s: { template: 'x' } },
        root: { h: ['s'] },
      }`),
    ).toContain(`variable "settings.x" is named under "settings"`);
  });

  test("the settings menu's retired anchor name points at its successor", () => {
    expect(
      refusal(`{
        variables: { ${SESSION} },
        segments: { s: { template: 'x' } },
        root: { h: ['settings.menu', 's'] },
      }`),
    ).toContain(`was renamed to "candybar.menu"`);
  });

  test("a placement id holding the layout-op delimiter", () => {
    expect(
      refusal(withSegment(BOOL, `{ h: [{ seg: 's', id: 'a:b' }] }`)),
    ).toContain(`a placement "id" must be a non-empty string without "/" or ":"`);
  });
});

describe("edit mode addresses placements by id", () => {
  const tree = (...ids: [string, string?][]): LayoutNode => ({
    kind: "container",
    direction: "horizontal",
    children: ids.map(([name, id]) => ({ kind: "segment", name, ...(id && { id }) })),
  });

  test("an insertion keeps the segment's name as its id while it is free, else mints the next", () => {
    expect(mintPlacement("git", "dir", [tree(["dir"])])).toEqual({ seg: "git" });
    expect(mintPlacement("git", "git", [tree(["git"])])).toEqual({ seg: "git", id: "git-2" });
    expect(mintPlacement("git", "git", [tree(["git"], ["git", "git-2"])])).toEqual({
      seg: "git",
      id: "git-3",
    });
  });

  test("an insertion's id is free in every tree holding its anchor, since the layer it writes can reach other presets", () => {
    expect(
      mintPlacement("git", "dir", [tree(["dir"], ["git"]), tree(["dir"], ["git", "git-2"])]),
    ).toEqual({ seg: "git", id: "git-3" });
    // A tree without the anchor never receives the insertion.
    expect(mintPlacement("git", "dir", [tree(["dir"]), tree(["git"])])).toEqual({
      seg: "git",
    });
  });

  const FILE = `{
  root: { h: ["dir", "git", { seg: "git", id: "gitFull" }] },
}
`;

  test("remove takes out the placement with that id, not the first of its segment", () => {
    expect(removeSegmentRef(FILE, ["root"], "gitFull")).toBe(`{
  root: { h: ["dir", "git"] },
}
`);
  });

  test("insert writes a minted id as { seg, id }", () => {
    expect(
      insertSegmentRef(FILE, ["root"], { seg: "git", id: "git-2" }, "dir", "after"),
    ).toBe(`{
  root: { h: ["dir", { seg: "git", id: "git-2" }, "git", { seg: "git", id: "gitFull" }] },
}
`);
  });
});
