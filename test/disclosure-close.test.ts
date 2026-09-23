// brandon-disclosure-43z — every row of an open disclosure body leads with a
// ✕ that closes THAT disclosure. [LAW:behavior-not-structure] The contract is
// read off the rendered lines (their leading OSC-8 link and what it writes)
// and off the daemon's own verb handlers (a click actually closes), never off
// the walk's shape:
//   - the row a body renders leads with one ✕ whose click writes the body's
//     state key back to the closed sentinel;
//   - a VERTICAL body leads every one of its rows, and an accordion group's ✕
//     writes the SHARED key it was opened through;
//   - nesting does not stack: a row is led by the innermost band it sits on
//     (⚙ config's row carries ⚙'s ✕ and not 🍫's), and a `{{ menu }}` line
//     dropped inside a body keeps the picker's own ✕ alone;
//   - a click on the ✕ closes exactly that disclosure — ⚙ closes while 🍫
//     stays open — and the closed body renders no rows, ✕ included;
//   - a line that DROPS below a horizontal row of the body (a multi-line
//     segment's continuation line, a nested vertical container's later rows)
//     is a row of the same band and is led once too;
//   - a body whose every child is hidden lays no row and so no ✕ — not on
//     the bar, and not in the trigger's cell sink.

import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { SETTINGS_ANCHOR } from "../src/config/settings-menu";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import {
  DISCLOSURE_CLOSED,
  DISCLOSURE_GLYPH_CLOSE,
  DOOR_CLOSE_GLYPH,
  DOOR_GLYPH,
} from "../src/config/disclosure";
import { menuPageKey } from "../src/config/menu-keys";
import { GROUP_NS } from "../src/config/loader/reserved-namespace";
import type { RichText } from "@promptctl/rich-js";
import {
  deriveActionValidators,
  registerStateValidator,
} from "../src/daemon/verbs/state-validators";
import { VERBS } from "../src/daemon/verbs";
import type { VerbContext } from "../src/daemon/verbs";
import { testVerbContext, effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import { parseEffects, VERB_DISPATCH, VERB_SET_STATE } from "../src/click/wire";
import { links, stripAnsi, type Link } from "./helpers/ansi";

const ALLOWED = new Set(listResolvablePaletteNames());
const THEME = "textual-dark";
const SID = "s1";

const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};

const PAYLOAD = {
  session_id: SID,
  cwd: "/tmp/proj",
  model: { id: "claude-opus-4-7", display_name: "Opus" },
  workspace: { current_dir: "/tmp/proj", project_dir: "/tmp/proj", added_dirs: [] },
  theme: { effective: THEME },
  look: { effective: "none" },
  style: { effective: "powerline" },
  preset: { effective: "default" },
  charset: { effective: "unicode" },
  colorCompatibility: { effective: "truecolor" },
  autoWrap: { effective: true },
  padding: { effective: 1 },
};

// Whether a link's click is exactly "write `key` closed" — the row ✕'s write.
const closes = (link: Link, key: string): boolean =>
  effectsOf(link.url).some(
    (e) =>
      e.verb === VERB_SET_STATE &&
      e.args[1] === key &&
      e.args[2] === DISCLOSURE_CLOSED,
  );

// The row's lead: its first link must be the ✕ closing `key`, and no other
// disclosure's ✕ may sit anywhere on the row — one ✕, the innermost band's.
function expectLedBy(line: string, key: string): void {
  const rowLinks = links(line);
  const first = rowLinks[0];
  if (first === undefined) throw new Error(`no link on: ${JSON.stringify(line)}`);
  expect(first.text).toBe(DISCLOSURE_GLYPH_CLOSE);
  expect(closes(first, key)).toBe(true);
  const otherCloses = rowLinks
    .slice(1)
    .filter((l) => l.text === DISCLOSURE_GLYPH_CLOSE && closes(l, key));
  expect(otherCloses).toEqual([]);
}

function build(src: string, withDefault: boolean) {
  const config = parseAndValidate(
    "<test>",
    src,
    ALLOWED,
    withDefault ? DEFAULT_DSL_CONFIG : undefined,
  );
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { cwd: "/tmp/proj" });
  const disposers = deriveActionValidators(config).map(({ key, spec }) =>
    registerStateValidator(key, spec),
  );
  const ctx: VerbContext = testVerbContext(sessionState);
  const sink = new Map<string, readonly RichText[]>();
  const render = (): string[] => {
    const errors: string[] = [];
    const out = renderDsl(config, compiled, store, registry, PAYLOAD, OPTS, {
      perSegmentSink: sink,
      onSegmentError: (name, message) => errors.push(`${name}: ${message}`),
    });
    if (errors.length > 0) throw new Error(errors.join("\n"));
    return out.split("\n");
  };
  // Drive a click through the daemon's own handlers — the gate the row ✕
  // passes is the cycle action's, derived like every other set.
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
  // Click the first link on any rendered line that writes `key` = `value`.
  const clickWriting = (lines: string[], key: string, value: string): void => {
    const link = lines
      .flatMap(links)
      .find((l) =>
        effectsOf(l.url).some((e) => e.args[1] === key && e.args[2] === value),
      );
    if (link === undefined) throw new Error(`nothing writes ${key}=${value}`);
    click(link.url);
  };
  return {
    render,
    sink,
    click,
    clickWriting,
    dispose: () => {
      disposers.forEach((d) => d());
      registry.dispose();
    },
  };
}

const BUNDLED = `{ globals: { palette: '${THEME}' }, root: { h: ['directory', 'model'] } }`;

describe("brandon-disclosure-43z — the bundled 🍫 → ⚙ → picker chain", () => {
  test("each body row leads with its own disclosure's ✕ and nothing stacks", () => {
    const rt = build(BUNDLED, true);
    let lines = rt.render();
    expect(lines).toHaveLength(1);
    // The bar row carries no row ✕: only the door itself, which is a trigger.
    expect(links(lines[0]!).filter((l) => l.text === DISCLOSURE_GLYPH_CLOSE)).toEqual([]);

    // The door opens INLINE: its tray takes the door's own row, led by the
    // door's ❌ and by no row ✕.
    rt.clickWriting(lines, SETTINGS_ANCHOR, "open");
    lines = rt.render();
    expect(lines).toHaveLength(1);
    const [door] = links(lines[0]!);
    expect(door?.text).toBe(DOOR_CLOSE_GLYPH);
    expect(closes(door!, SETTINGS_ANCHOR)).toBe(true);
    expect(links(lines[0]!).filter((l) => l.text === DISCLOSURE_GLYPH_CLOSE)).toEqual([]);

    // ⚙ config open: its row is led by ⚙'s ✕ — and 🍫's ✕ is not on it.
    const configKey = `${SETTINGS_ANCHOR.replace(/menu$/, "")}config`;
    rt.clickWriting(lines, configKey, "open");
    lines = rt.render();
    expect(lines).toHaveLength(2);
    expectLedBy(lines[1]!, configKey);
    expect(links(lines[1]!).some((l) => closes(l, SETTINGS_ANCHOR))).toBe(false);

    // A picker dropped inside ⚙'s body keeps the picker's own ✕ alone: the
    // line is the menu's band, not ⚙'s row.
    const opener = links(lines[1]!).find((l) =>
      effectsOf(l.url).some(
        (e) =>
          e.verb === VERB_SET_STATE &&
          e.args[3] === menuPageKey(e.args[1] ?? "") &&
          e.args[2] !== DISCLOSURE_CLOSED,
      ),
    );
    if (opener === undefined) throw new Error("⚙'s row hosts no menu opener");
    rt.click(opener.url);
    lines = rt.render();
    expect(lines).toHaveLength(3);
    const pickerLine = lines[2]!;
    const [first] = links(pickerLine);
    expect(first?.text).toBe(DISCLOSURE_GLYPH_CLOSE);
    expect(closes(first!, configKey)).toBe(false);
    expect(closes(first!, SETTINGS_ANCHOR)).toBe(false);

    // Clicking ⚙'s row ✕ closes ⚙ (and the picker hanging under it) while 🍫
    // stays open.
    rt.click(links(lines[1]!)[0]!.url);
    lines = rt.render();
    expect(lines).toHaveLength(1);

    // 🧰 tools opens a VERTICAL body whose rows are bare `settings.` segments
    // — chrome-exempt, so no edit-mode row wraps them: the segment itself
    // leads its row (a user group's rows reach the lead through the row edit
    // chrome wraps them in, which is why this case is pinned here as well).
    const toolsKey = `${SETTINGS_ANCHOR.replace(/menu$/, "")}tools`;
    rt.clickWriting(lines, toolsKey, "open");
    lines = rt.render();
    expect(lines).toHaveLength(2);
    expectLedBy(lines[1]!, toolsKey);
    rt.click(links(lines[1]!)[0]!.url);
    lines = rt.render();
    expect(lines).toHaveLength(1);

    // And the door's ❌ closes the menu: back to the bar alone.
    rt.click(links(lines[0]!)[0]!.url);
    lines = rt.render();
    expect(lines).toHaveLength(1);
    expect(links(lines[0]!)[0]?.text).toBe(DOOR_GLYPH);
    rt.dispose();
  });
});

// Two accordion groups on one shared key; the open one has a VERTICAL body of
// three rows, one of them a nested horizontal row.
const GROUPS = `{
  globals: { palette: '${THEME}' },
  variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
  segments: {
    a: { template: 'A' }, b: { template: 'B' }, c: { template: 'C' }, d: { template: 'D' },
  },
  root: { v: [
    { h: ['a'] },
    { kind: 'group', name: 'one', label: 'one', key: 'acc', children: ['b', { h: ['c', 'd'] }, 'a'] },
    { kind: 'group', name: 'two', label: 'two', key: 'acc', children: ['d'] },
  ] },
}`;

describe("brandon-disclosure-43z — a group body", () => {
  test("every row of a vertical body leads with a ✕ writing the group's (shared) key closed, and the click closes it", () => {
    const rt = build(GROUPS, false);
    let lines = rt.render();
    // Closed: the two toggles on their own rows, no body, no ✕ anywhere.
    expect(lines).toHaveLength(3);
    expect(lines.flatMap(links).filter((l) => l.text === DISCLOSURE_GLYPH_CLOSE)).toEqual([]);

    rt.clickWriting(lines, "acc", "one");
    lines = rt.render();
    // Bar row, toggle `one`, its three body rows, toggle `two`.
    expect(lines).toHaveLength(6);
    for (const row of lines.slice(2, 5)) expectLedBy(row, "acc");
    // The nested horizontal row is led once — by the container, not per cell.
    expect(links(lines[3]!).filter((l) => l.text === DISCLOSURE_GLYPH_CLOSE)).toHaveLength(1);
    // Rows outside the body carry none.
    for (const row of [lines[0]!, lines[1]!, lines[5]!]) {
      expect(links(row).filter((l) => l.text === DISCLOSURE_GLYPH_CLOSE)).toEqual([]);
    }

    rt.click(links(lines[4]!)[0]!.url);
    lines = rt.render();
    expect(lines).toHaveLength(3);
    rt.dispose();
  });
});

// The lines a body can drop below one of its horizontal rows — a multi-line
// segment's continuation lines, a nested vertical container's later rows — and
// a body whose only child is hidden.
const DROPS = `{
  globals: { palette: '${THEME}' },
  variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
  segments: {
    a: { template: 'A' }, b: { template: 'B' }, c: { template: 'C' }, d: { template: 'D' },
    m: { template: 'M1\\nM2\\nM3' },
  },
  root: { v: [
    { h: ['a'] },
    { kind: 'group', name: 'wide', label: 'wide', children: [
      { h: ['m', 'c'] },
      { h: [{ v: ['b', 'd'] }, 'a'] },
    ] },
    { kind: 'group', name: 'bare', label: 'bare', children: [{ seg: 'b', when: 'false' }] },
  ] },
}`;

const closeLinks = (line: string): Link[] =>
  links(line).filter((l) => l.text === DISCLOSURE_GLYPH_CLOSE);

describe("brandon-disclosure-43z — lines dropped below a body's horizontal row", () => {
  test("a multi-line segment's continuation lines and a nested vertical's later rows are each led once", () => {
    const rt = build(DROPS, false);
    const key = `${GROUP_NS}wide`;
    let lines = rt.render();
    expect(lines).toHaveLength(3);

    rt.clickWriting(lines, key, "wide");
    lines = rt.render();
    // Bar row, toggle `wide`, then the body: `M1 C` with M2 and M3 dropped
    // below it, `B A` with D dropped below it; then toggle `bare`.
    expect(lines).toHaveLength(8);
    const body = lines.slice(2, 7);
    expect(body.map((l) => stripAnsi(l))).toEqual([
      expect.stringContaining("M1"),
      expect.stringContaining("M2"),
      expect.stringContaining("M3"),
      expect.stringContaining("B"),
      expect.stringContaining("D"),
    ]);
    for (const row of body) {
      expectLedBy(row, key);
      expect(closeLinks(row)).toHaveLength(1);
    }
    for (const row of [lines[0]!, lines[1]!, lines[7]!]) {
      expect(closeLinks(row)).toEqual([]);
    }
    // The trigger sinks one ✕ per row it led — five — beside its own cells.
    const leads = rt.sink.get(key)!.filter((c) => c.plain === DISCLOSURE_GLYPH_CLOSE);
    expect(leads).toHaveLength(5);
    rt.dispose();
  });

  test("a body whose every child is hidden lays no row and no ✕, on the bar or in the sink", () => {
    const rt = build(DROPS, false);
    const key = `${GROUP_NS}bare`;
    let lines = rt.render();
    rt.clickWriting(lines, key, "bare");
    lines = rt.render();
    // Bar row, toggle `wide`, toggle `bare` — open, with nothing under it.
    expect(lines).toHaveLength(3);
    expect(lines.flatMap(closeLinks)).toEqual([]);
    const cells = rt.sink.get(key)!;
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.filter((c) => c.plain === DISCLOSURE_GLYPH_CLOSE)).toEqual([]);
    rt.dispose();
  });
});
