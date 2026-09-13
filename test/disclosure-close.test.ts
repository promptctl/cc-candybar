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
//     (⚙ config's row carries ⚙'s ✕ and not ☰'s), and a `{{ menu }}` line
//     dropped inside a body keeps the picker's own ✕ alone;
//   - a click on the ✕ closes exactly that disclosure — ⚙ closes while ☰
//     stays open — and the closed body renders no rows, ✕ included.

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
} from "../src/config/disclosure";
import { menuPageKey } from "../src/config/menu-keys";
import {
  deriveActionValidators,
  registerStateValidator,
} from "../src/daemon/verbs/state-validators";
import { VERBS } from "../src/daemon/verbs";
import type { VerbContext } from "../src/daemon/verbs";
import { testVerbContext, effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import { parseEffects, VERB_DISPATCH, VERB_SET_STATE } from "../src/click/wire";

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

// One OSC-8 link as the bar emits it: `ESC ] 8 ; ; url ESC \ text ESC ] 8 ; ; ESC \`.
const OSC8 = /\x1b\]8;;([^\x1b]*)\x1b\\(.*?)\x1b\]8;;\x1b\\/g;
interface Link {
  readonly text: string;
  readonly url: string;
}
const linksOn = (line: string): Link[] =>
  [...line.matchAll(OSC8)].map((m) => ({ url: m[1]!, text: m[2]! }));

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
  const links = linksOn(line);
  const first = links[0];
  if (first === undefined) throw new Error(`no link on: ${JSON.stringify(line)}`);
  expect(first.text).toBe(DISCLOSURE_GLYPH_CLOSE);
  expect(closes(first, key)).toBe(true);
  const otherCloses = links
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
  const render = (): string[] => {
    const errors: string[] = [];
    const out = renderDsl(config, compiled, store, registry, PAYLOAD, OPTS, {
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
      .flatMap(linksOn)
      .find((l) =>
        effectsOf(l.url).some((e) => e.args[1] === key && e.args[2] === value),
      );
    if (link === undefined) throw new Error(`nothing writes ${key}=${value}`);
    click(link.url);
  };
  return {
    render,
    click,
    clickWriting,
    dispose: () => {
      disposers.forEach((d) => d());
      registry.dispose();
    },
  };
}

const BUNDLED = `{ globals: { palette: '${THEME}' }, root: { h: ['directory', 'model'] } }`;

describe("brandon-disclosure-43z — the bundled ☰ → ⚙ → picker chain", () => {
  test("each body row leads with its own disclosure's ✕ and nothing stacks", () => {
    const rt = build(BUNDLED, true);
    let lines = rt.render();
    expect(lines).toHaveLength(1);
    // The bar row carries no row ✕: only the door itself, which is a trigger.
    expect(linksOn(lines[0]!).filter((l) => l.text === DISCLOSURE_GLYPH_CLOSE)).toEqual([]);

    rt.clickWriting(lines, SETTINGS_ANCHOR, "open");
    lines = rt.render();
    expect(lines).toHaveLength(2);
    expectLedBy(lines[1]!, SETTINGS_ANCHOR);

    // ⚙ config open: its row is led by ⚙'s ✕ — and ☰'s ✕ is not on it.
    const configKey = `${SETTINGS_ANCHOR.replace(/menu$/, "")}config`;
    rt.clickWriting(lines, configKey, "open");
    lines = rt.render();
    expect(lines).toHaveLength(3);
    expectLedBy(lines[1]!, SETTINGS_ANCHOR);
    expectLedBy(lines[2]!, configKey);
    expect(linksOn(lines[2]!).some((l) => closes(l, SETTINGS_ANCHOR))).toBe(false);

    // A picker dropped inside ⚙'s body keeps the picker's own ✕ alone: the
    // line is the menu's band, not ⚙'s row.
    const opener = linksOn(lines[2]!).find((l) =>
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
    expect(lines).toHaveLength(4);
    const pickerLine = lines[3]!;
    const [first] = linksOn(pickerLine);
    expect(first?.text).toBe(DISCLOSURE_GLYPH_CLOSE);
    expect(closes(first!, configKey)).toBe(false);
    expect(closes(first!, SETTINGS_ANCHOR)).toBe(false);

    // Clicking ⚙'s row ✕ closes ⚙ (and the picker hanging under it) while ☰
    // stays open with its own row still led.
    rt.click(linksOn(lines[2]!)[0]!.url);
    lines = rt.render();
    expect(lines).toHaveLength(2);
    expectLedBy(lines[1]!, SETTINGS_ANCHOR);

    // 🧰 tools opens a VERTICAL body whose rows are bare `settings.` segments
    // — chrome-exempt, so no edit-mode row wraps them: the segment itself
    // leads its row (a user group's rows reach the lead through the row edit
    // chrome wraps them in, which is why this case is pinned here as well).
    const toolsKey = `${SETTINGS_ANCHOR.replace(/menu$/, "")}tools`;
    rt.clickWriting(lines, toolsKey, "open");
    lines = rt.render();
    expect(lines).toHaveLength(3);
    expectLedBy(lines[2]!, toolsKey);
    rt.click(linksOn(lines[2]!)[0]!.url);
    lines = rt.render();
    expect(lines).toHaveLength(2);

    // And ☰'s row ✕ closes the menu: back to the bar alone.
    rt.click(linksOn(lines[1]!)[0]!.url);
    lines = rt.render();
    expect(lines).toHaveLength(1);
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
    expect(lines.flatMap(linksOn).filter((l) => l.text === DISCLOSURE_GLYPH_CLOSE)).toEqual([]);

    rt.clickWriting(lines, "acc", "one");
    lines = rt.render();
    // Bar row, toggle `one`, its three body rows, toggle `two`.
    expect(lines).toHaveLength(6);
    for (const row of lines.slice(2, 5)) expectLedBy(row, "acc");
    // The nested horizontal row is led once — by the container, not per cell.
    expect(linksOn(lines[3]!).filter((l) => l.text === DISCLOSURE_GLYPH_CLOSE)).toHaveLength(1);
    // Rows outside the body carry none.
    for (const row of [lines[0]!, lines[1]!, lines[5]!]) {
      expect(linksOn(row).filter((l) => l.text === DISCLOSURE_GLYPH_CLOSE)).toEqual([]);
    }

    rt.click(linksOn(lines[4]!)[0]!.url);
    lines = rt.render();
    expect(lines).toHaveLength(3);
    rt.dispose();
  });
});
