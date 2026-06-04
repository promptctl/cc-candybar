// [LAW:verifiable-goals] 2de.12 acceptance, driven through the real spine
// (registerDslConfig + renderDsl), the real loader (parseAndValidate), and the
// real set-state gate (deriveValidators/deriveActionValidators +
// registerStateValidator + validateStateWrite) — never a parallel rig:
//
//   1. A `{{ action "name" display [boundValue] }}` call renders ONE clickable
//      region whose OSC-8 URL is the action realized against current state —
//      literal writes `to`, option writes the bound option, bounded writes
//      wrap(current ± by), copy/open carry the evaluated template.
//   2. The writable gate DERIVES from the action table: a literal/option set on
//      a CUSTOM key yields an allow-list; a bounded set yields a range; a set on
//      a BASELINE key (theme/style) reuses the baseline gate (derives nothing);
//      copy/open derive nothing.
//   3. deriveActionValidators feeds the SAME registerStateValidator merge/dispose
//      lifecycle widgets use — same-key registrations union, dispose ref-counts.
//   4. deriveValidators merges the widget AND action surfaces at one site.
//   5. The loader proves the ActionDecl invariants (one effect; one set value
//      source; integer bounds; non-zero `by`), resolves `{{ action }}` refs, and
//      requires session.id for any set action.

import { PaletteResolver, getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import {
  deriveActionValidators,
  deriveValidators,
  registerStateValidator,
  validateStateWrite,
} from "../src/daemon/verbs/state-validators";
import { ConfigError } from "../src/config/dsl-loader";
import { effectsOf, boldUrls } from "./helpers/click";

const ALLOWED = new Set(listResolvablePaletteNames());
const THEMES = listResolvablePaletteNames();

function opts(width = Number.POSITIVE_INFINITY) {
  return {
    style: "powerline" as const,
    colorCompatibility: "truecolor" as const,
    width,
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

interface SideEffect {
  readonly verb: string;
  readonly args: string[];
}

// Drive a config through the real spine + the real merged gate (deriveValidators,
// so the harness exercises the widget+action merge site even when there are no
// widgets). `click` validates set-state writes through the derived gate and
// applies them; copy/open are recorded as side effects (they carry no gate).
function buildRuntime(src: string, sessionId = "s1") {
  const config = parseAndValidate("<test>", src, ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { store });
  const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);
  const render = (width = Number.POSITIVE_INFINITY): string =>
    renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: sessionId, project_dir: "/tmp/proj" },
      basePalette,
      opts(width),
    );
  const disposers = deriveValidators(config).map(({ key, spec }) =>
    registerStateValidator(key, spec),
  );
  const sideEffects: SideEffect[] = [];
  const click = (url: string): void => {
    for (const { verb, args } of effectsOf(url)) {
      if (verb === "set-state") {
        const [sid, ...pairs] = args;
        for (let i = 0; i < pairs.length; i += 2) {
          const result = validateStateWrite(pairs[i]!, pairs[i + 1]!);
          if (!result.ok) throw new Error(`click rejected: ${result.reason}`);
          sessionState.set(sid!, pairs[i]!, result.value);
        }
      } else {
        sideEffects.push({ verb, args });
      }
    }
  };
  const dispose = (): void => disposers.forEach((d) => d());
  return { config, store, sessionState, render, click, sideEffects, dispose };
}

// ─── Literal set action ────────────────────────────────────────────────────────

describe("2de.12 — literal set action", () => {
  const SRC = `{
    globals: {},
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
      flavor: { kind: 'state', key: 'flavor', default: 'vanilla' },
    },
    actions: { pick: { set: 'flavor', to: 'chocolate' } },
    segments: { bar: { template: '{{.flavor}} {{ action "pick" "🍫" }}', bg: 'surface', fg: 'foreground' } },
    layout: [['bar']],
  }`;

  test("renders one clickable region whose click sets the literal value", () => {
    const { render, click, sessionState, dispose } = buildRuntime(SRC);
    const out = render();
    expect(stripAnsi(out)).toContain("vanilla 🍫");
    const urls = extractUrls(out);
    expect(urls).toHaveLength(1);
    expect(effectsOf(urls[0]!)).toEqual([
      { verb: "set-state", args: ["s1", "flavor", "chocolate"] },
    ]);
    click(urls[0]!);
    expect(sessionState.get("s1", "flavor")).toBe("chocolate");
    // The next render reflects the mutated state (the cross-process loop in one process).
    expect(stripAnsi(render())).toContain("chocolate 🍫");
    dispose();
  });

  test("derives an allow-list gate of {to} for the custom key", () => {
    const config = parseAndValidate("<test>", SRC, ALLOWED);
    expect(deriveActionValidators(config)).toEqual([
      { key: "flavor", spec: { kind: "allow-list", allowed: ["chocolate"] } },
    ]);
  });

  test("marks the region active when the key already holds the literal value", () => {
    const { render, sessionState, dispose } = buildRuntime(SRC);
    sessionState.set("s1", "flavor", "chocolate");
    const out = render();
    expect(boldUrls(out).map(effectsOf)).toEqual([
      [{ verb: "set-state", args: ["s1", "flavor", "chocolate"] }],
    ]);
    dispose();
  });
});

// ─── Literal set on a BASELINE key reuses the baseline gate ─────────────────────

describe("2de.12 — set on a baseline key derives nothing", () => {
  const SRC = `{
    globals: {},
    variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
    actions: { dark: { set: 'theme', to: 'nord' } },
    segments: { bar: { template: '{{ action "dark" "🌙" }}', bg: 'surface', fg: 'foreground' } },
    layout: [['bar']],
  }`;

  test("the theme literal reuses the permanent theme validator (no derived spec)", () => {
    const config = parseAndValidate("<test>", SRC, ALLOWED);
    expect(deriveActionValidators(config)).toEqual([]);
  });

  test("the click still passes the baseline theme gate end-to-end", () => {
    const { render, click, sessionState, dispose } = buildRuntime(SRC);
    const url = extractUrls(render())[0]!;
    click(url);
    expect(sessionState.get("s1", "theme")).toBe("nord");
    dispose();
  });
});

// ─── Option set action (picker) ─────────────────────────────────────────────────

describe("2de.12 — option set action", () => {
  const SRC = `{
    globals: {},
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
      sel: { kind: 'state', key: 'sel', default: '' },
    },
    actions: { choose: { set: 'sel', from: 'themes' } },
    segments: { bar: { template: '{{ range themes }}{{ action "choose" . }}{{ end }}', bg: 'surface', fg: 'foreground' } },
    layout: [['bar']],
  }`;

  test("renders one clickable per option, each binding its value into the set", () => {
    const { render, dispose } = buildRuntime(SRC);
    const urls = extractUrls(render());
    expect(urls).toHaveLength(THEMES.length);
    expect(urls.map(effectsOf)).toEqual(
      THEMES.map((t) => [{ verb: "set-state", args: ["s1", "sel", t] }]),
    );
    dispose();
  });

  test("derives an allow-list of the resolved option domain for the custom key", () => {
    const config = parseAndValidate("<test>", SRC, ALLOWED);
    expect(deriveActionValidators(config)).toEqual([
      { key: "sel", spec: { kind: "allow-list", allowed: THEMES } },
    ]);
  });

  test("the bound option clicks pass the derived gate and mutate state", () => {
    const { render, click, sessionState, dispose } = buildRuntime(SRC);
    const target = THEMES[1]!;
    const url = extractUrls(render()).find((u) =>
      effectsOf(u).some((e) => e.args[2] === target),
    )!;
    click(url);
    expect(sessionState.get("s1", "sel")).toBe(target);
    dispose();
  });

  test("marks exactly the currently-selected option active", () => {
    const { render, sessionState, dispose } = buildRuntime(SRC);
    sessionState.set("s1", "sel", THEMES[2]!);
    expect(boldUrls(render()).map(effectsOf)).toEqual([
      [{ verb: "set-state", args: ["s1", "sel", THEMES[2]!] }],
    ]);
    dispose();
  });

  test("an explicit boundValue writes a value distinct from the display text", () => {
    // The third arg decouples what's SHOWN from what's WRITTEN: a decorated label
    // over a clean value. The written value must still be in the derived
    // allow-list (the option domain), so it survives the gate.
    const target = THEMES[0]!;
    const src = `{
      globals: {},
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        sel: { kind: 'state', key: 'sel', default: '' },
      },
      actions: { choose: { set: 'sel', from: 'themes' } },
      segments: { bar: { template: '{{ action "choose" "🎨 fancy" "${target}" }}', bg: 'surface', fg: 'foreground' } },
      layout: [['bar']],
    }`;
    const { render, click, sessionState, dispose } = buildRuntime(src);
    const out = render();
    expect(stripAnsi(out)).toContain("🎨 fancy");
    const url = extractUrls(out)[0]!;
    expect(effectsOf(url)).toEqual([
      { verb: "set-state", args: ["s1", "sel", target] },
    ]);
    click(url);
    expect(sessionState.get("s1", "sel")).toBe(target);
    dispose();
  });
});

// ─── Bounded set action (stepper affordances) ───────────────────────────────────

describe("2de.12 — bounded set action", () => {
  const SRC = `{
    globals: {},
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
      'hue.step': { kind: 'state', key: 'hue', default: '14' },
    },
    actions: {
      down: { set: 'hue', min: 0, max: 60, by: -2 },
      up: { set: 'hue', min: 0, max: 60, by: 2 },
    },
    segments: { bar: { template: '{{ action "down" "◀" }} {{.hue.step}} {{ action "up" "▶" }}', bg: 'surface', fg: 'foreground' } },
    layout: [['bar']],
  }`;

  test("◀ writes current+by(down), ▶ writes current+by(up); the display is plain text", () => {
    const { render, dispose } = buildRuntime(SRC);
    const out = render();
    expect(stripAnsi(out)).toContain("◀ 14 ▶");
    const urls = extractUrls(out);
    expect(urls.map(effectsOf)).toEqual([
      [{ verb: "set-state", args: ["s1", "hue", "12"] }],
      [{ verb: "set-state", args: ["s1", "hue", "16"] }],
    ]);
    dispose();
  });

  test("navigation WRAPS past a bound to the other end", () => {
    const { render, sessionState, dispose } = buildRuntime(SRC);
    sessionState.set("s1", "hue", "60"); // max
    const urls = extractUrls(render());
    expect(urls.map(effectsOf)).toEqual([
      [{ verb: "set-state", args: ["s1", "hue", "58"] }],
      [{ verb: "set-state", args: ["s1", "hue", "0"] }], // wrapped, not clamped
    ]);
    dispose();
  });

  test("two bounded actions on one key merge to a single range gate", () => {
    const config = parseAndValidate("<test>", SRC, ALLOWED);
    expect(deriveActionValidators(config)).toEqual([
      { key: "hue", spec: { kind: "range", min: 0, max: 60 } },
    ]);
  });

  test("a click steps and the next render shows the new value", () => {
    const { render, click, dispose } = buildRuntime(SRC);
    click(extractUrls(render())[1]!); // ▶: 14 → 16
    expect(stripAnsi(render())).toContain("◀ 16 ▶");
    dispose();
  });
});

// ─── copy / open actions ────────────────────────────────────────────────────────

describe("2de.12 — copy / open actions derive no gate", () => {
  const SRC = `{
    globals: {},
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
      project_dir: { kind: 'input', path: 'project_dir', default: '' },
    },
    actions: {
      copyId: { copy: '{{.session.id}}' },
      openDir: { open: '{{.project_dir}}' },
    },
    segments: { bar: { template: '{{ action "copyId" "⎘" }} {{ action "openDir" "📂" }}', bg: 'surface', fg: 'foreground' } },
    layout: [['bar']],
  }`;

  test("copy/open contribute no validator spec", () => {
    const config = parseAndValidate("<test>", SRC, ALLOWED);
    expect(deriveActionValidators(config)).toEqual([]);
  });

  test("copy carries the evaluated template; open carries the evaluated target", () => {
    const { render, click, sideEffects, dispose } = buildRuntime(SRC);
    const urls = extractUrls(render());
    expect(urls).toHaveLength(2);
    urls.forEach(click);
    expect(sideEffects).toEqual([
      { verb: "copy", args: ["s1"] },
      { verb: "open-vscode", args: ["/tmp/proj"] },
    ]);
    dispose();
  });
});

// ─── deriveActionValidators merge / dispose lifecycle ───────────────────────────

describe("2de.12 — derived specs feed the registerStateValidator lifecycle", () => {
  test("same-key allow-lists union; dispose ref-counts down to removal", () => {
    const d1 = registerStateValidator("k", {
      kind: "allow-list",
      allowed: ["a", "b"],
    });
    const d2 = registerStateValidator("k", {
      kind: "allow-list",
      allowed: ["b", "c"],
    });
    // Union of both registrations is accepted.
    for (const v of ["a", "b", "c"]) {
      expect(validateStateWrite("k", v).ok).toBe(true);
    }
    d1();
    // d1's "a" is gone; d2's "b","c" remain.
    expect(validateStateWrite("k", "a").ok).toBe(false);
    expect(validateStateWrite("k", "c").ok).toBe(true);
    d2();
    expect(validateStateWrite("k", "c").ok).toBe(false); // key removed
  });

  test("deriveValidators merges the widget and action surfaces at one site", () => {
    // A widget set-action on key `w`, an action set on key `a`, and BOTH a widget
    // and an action writing the shared key `shared` — the merge unions the shared
    // members and keeps the surface-specific keys distinct.
    const src = `{
      globals: {},
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        wv: { kind: 'state', key: 'w', default: '' },
        av: { kind: 'state', key: 'a', default: '' },
        sv: { kind: 'state', key: 'shared', default: '' },
      },
      widgets: {
        wbtn: { kind: 'buttons', items: [
          { glyph: 'W', onClick: { set: 'w', to: 'x' } },
          { glyph: 'S', onClick: { set: 'shared', to: 'fromWidget' } },
        ] },
      },
      actions: {
        abtn: { set: 'a', to: 'y' },
        sbtn: { set: 'shared', to: 'fromAction' },
      },
      segments: { bar: { template: '{{ widget "wbtn" }} {{ action "abtn" "A" }} {{ action "sbtn" "S" }}', bg: 'surface', fg: 'foreground' } },
      layout: [['bar']],
    }`;
    const config = parseAndValidate("<test>", src, ALLOWED);
    const merged = Object.fromEntries(
      deriveValidators(config).map(({ key, spec }) => [key, spec]),
    );
    expect(merged.w).toEqual({ kind: "allow-list", allowed: ["x"] });
    expect(merged.a).toEqual({ kind: "allow-list", allowed: ["y"] });
    // The shared key unions both surfaces' members.
    expect(merged.shared).toEqual({
      kind: "allow-list",
      allowed: expect.arrayContaining(["fromWidget", "fromAction"]),
    });
  });
});

// ─── Loader validation ──────────────────────────────────────────────────────────

describe("2de.12 — loader proves the ActionDecl invariants", () => {
  const base = (actions: string, extra = "") => `{
    globals: {},
    variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' }, k: { kind: 'state', key: 'k', default: '' } },
    actions: ${actions},
    segments: { bar: { template: '{{ action "a" "x" }}${extra}', bg: 'surface', fg: 'foreground' } },
    layout: [['bar']],
  }`;

  const expectIssue = (src: string, re: RegExp) => {
    try {
      parseAndValidate("<test>", src, ALLOWED);
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toMatch(re);
    }
  };

  test("all five shapes parse", () => {
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' }, k: { kind: 'state', key: 'k', default: '' } },
      actions: {
        lit: { set: 'k', to: 'v' },
        opt: { set: 'k', from: 'styles' },
        bnd: { set: 'k2', min: 0, max: 9, by: 1 },
        cp: { copy: 'x' },
        op: { open: 'y' },
      },
      segments: { bar: { template: '{{ action "lit" "L" }}{{ action "opt" "O" }}{{ action "bnd" "B" }}{{ action "cp" "C" }}{{ action "op" "P" }}', bg: 'surface', fg: 'foreground' } },
      layout: [['bar']],
    }`;
    expect(() => parseAndValidate("<test>", src, ALLOWED)).not.toThrow();
  });

  test("two of set/copy/open is rejected", () => {
    expectIssue(base(`{ a: { set: 'k', to: 'v', copy: 'x' } }`), /exactly one of/);
  });

  test("two value sources on a set is rejected", () => {
    expectIssue(
      base(`{ a: { set: 'k', to: 'v', from: 'themes' } }`),
      /exactly one value source/,
    );
  });

  test("a set with no value source is rejected", () => {
    expectIssue(base(`{ a: { set: 'k' } }`), /exactly one value source/);
  });

  test("an unknown `from` domain is rejected", () => {
    expectIssue(base(`{ a: { set: 'k', from: 'colors' } }`), /from must be one of/);
  });

  test("bounded min >= max is rejected", () => {
    expectIssue(
      base(`{ a: { set: 'k', min: 9, max: 0, by: 1 } }`),
      /must be less than max/,
    );
  });

  test("bounded by === 0 is rejected", () => {
    expectIssue(
      base(`{ a: { set: 'k', min: 0, max: 9, by: 0 } }`),
      /non-zero integer/,
    );
  });

  test("an unknown key on a set action is rejected", () => {
    expectIssue(
      base(`{ a: { set: 'k', to: 'v', oops: 1 } }`),
      /Unknown key "oops"/,
    );
  });

  test("an unresolved `{{ action }}` reference is rejected", () => {
    expectIssue(
      base(`{ a: { set: 'k', to: 'v' } }`, '{{ action "ghost" "?" }}'),
      /references unknown action "ghost"/,
    );
  });

  test("a set action requires a global session.id", () => {
    const src = `{
      globals: {},
      variables: { k: { kind: 'state', key: 'k', default: '' } },
      actions: { a: { set: 'k', to: 'v' } },
      segments: { bar: { template: '{{ action "a" "x" }}', bg: 'surface', fg: 'foreground' } },
      layout: [['bar']],
    }`;
    expectIssue(src, /require a global "session\.id"/);
  });

  test("a copy-only config does NOT require session.id", () => {
    const src = `{
      globals: {},
      variables: {},
      actions: { a: { copy: 'literal' } },
      segments: { bar: { template: '{{ action "a" "⎘" }}', bg: 'surface', fg: 'foreground' } },
      layout: [['bar']],
    }`;
    expect(() => parseAndValidate("<test>", src, ALLOWED)).not.toThrow();
  });
});
