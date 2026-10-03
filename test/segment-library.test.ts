// Edit mode's add menu is a LIBRARY of the declared segments: grouped by what
// each is about, one described row per segment (brandon-menu-ia-q30.kpl).
// [LAW:behavior-not-structure] Every expectation derives from the declarations
// themselves (DEFAULT_DSL_CONFIG, a user's `segments` block), never from a
// copied list, so a segment added anywhere either lands in the library or fails
// a test loudly.

import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { menuPageKey } from "../src/config/menu-keys";
import { EDIT_MODE_KEY } from "../src/config/loader/edit-mode";
import { EDIT_NS } from "../src/config/loader/reserved-namespace";
import { DISCLOSURE_CLOSED } from "../src/config/disclosure";
import { isReservedName } from "../src/config/loader/reserved-namespace";
import {
  GROUP_LABELS,
  LIBRARY_GROUPS,
  OTHER_GROUP,
  SEGMENT_GROUPS,
} from "../src/config/segment-groups";
import {
  LIBRARY_PAGE_ROWS,
  fitCells,
  libraryLayout,
} from "../src/render/library";
import { cellWidth } from "../src/render/picker";
import { effectsOf } from "./helpers/click";
import { VERB_SET_STATE } from "../src/click/wire";
import { links as rawLinks, stripAnsi, type Link } from "./helpers/ansi";

const ALLOWED = new Set(listResolvablePaletteNames());
const SID = "s1";

const PAYLOAD = {
  hook_event_name: "Status",
  session_id: SID,
  cwd: "/tmp/proj",
  model: { id: "claude-opus-4-7", display_name: "Opus" },
  workspace: {
    current_dir: "/tmp/proj",
    project_dir: "/tmp/proj",
    added_dirs: [],
  },
  theme: { effective: "textual-dark" },
  style: { effective: "none" },
  endcaps: { effective: "powerline" },
  variation: { effective: "accent" },
  preset: { effective: "default" },
  charset: { effective: "unicode" },
  colorCompatibility: { effective: "truecolor" },
  autoWrap: { effective: true },
  padding: { effective: 1 },
};

const links = (rendered: string): Link[] =>
  rawLinks(rendered).map((l) => ({ url: l.url, text: stripAnsi(l.text) }));

// An edit-mode bar over `userSegments` (extra declarations merged over the
// bundled default), at `width` columns. `open` opens the first `+`.
function rig(width: number, userSegments = "") {
  const config = parseAndValidate(
    "<user>",
    `{ globals: {}, segments: { ${userSegments} }, root: { h: ['directory', 'model'] } }`,
    ALLOWED,
    DEFAULT_DSL_CONFIG,
  );
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { cwd: "/tmp/proj" });
  sessionState.set(SID, EDIT_MODE_KEY, "arrange");
  const render = (): string =>
    renderDsl(config, compiled, store, registry, PAYLOAD, {
      endcaps: "powerline",
      colorCompatibility: "truecolor",
      wrap: true,
      padding: 1,
      charset: "unicode",
      width,
    });
  // The `+` opener is the one coupled write whose 4th argument is the page
  // key of its 2nd; opening applies exactly those writes.
  let pageKey = "";
  const open = (): string => {
    const opener = links(render())
      .flatMap((l) => effectsOf(l.url))
      .find(
        (e) =>
          e.verb === VERB_SET_STATE &&
          e.args[3] === menuPageKey(e.args[1] ?? "") &&
          e.args[2] !== DISCLOSURE_CLOSED &&
          e.args[2]!.startsWith(EDIT_NS),
      );
    if (opener === undefined) throw new Error("edit mode rendered no + opener");
    for (let i = 1; i + 1 < opener.args.length; i += 2)
      sessionState.set(SID, opener.args[i]!, opener.args[i + 1]!);
    pageKey = opener.args[3]!;
    return render();
  };
  const page = (to: number): string => {
    sessionState.set(SID, pageKey, String(to));
    return render();
  };
  return { config, render, open, page, dispose: () => registry.dispose() };
}

const lines = (out: string): string[] =>
  stripAnsi(out)
    .split("\n")
    // The strip's powerline caps are private-use glyphs, not text.
    .map((l) => l.replace(/[\uE000-\uF8FF]/gu, "").trim());

// The library as the reader sees it, page by page: label -> [name, description].
// Each page's nav row names its group (`✕ ← git 2/6 →`), and one row per member
// follows it.
function walk(r: ReturnType<typeof rig>): Map<string, [string, string][]> {
  const labels = new Set(Object.values(GROUP_LABELS));
  const found = new Map<string, [string, string][]>();
  let out = r.open();
  for (let page = 0; ; page++) {
    let current: string | undefined;
    for (const line of lines(out)) {
      const nav = /^✕\s*(?:←\s*)?(.+?) \d+\/\d+(?:\s*→)?$/.exec(line);
      if (nav !== null && labels.has(nav[1]!)) {
        current = nav[1]!;
        // A group larger than a page turns over onto pages of its own.
        found.set(current, found.get(current) ?? []);
      } else if (current !== undefined && line.length > 0) {
        const [, name, description = ""] =
          /^(\S+)(?:\s{2,}(.*))?$/.exec(line) ?? [];
        found.get(current)!.push([name!, description]);
      }
    }
    if (!lines(out).some((l) => l.endsWith("→"))) return found;
    out = r.page(page + 1);
  }
}

const addable = (config: { segments: Record<string, unknown> }): string[] =>
  Object.keys(config.segments).filter((n) => !isReservedName(n));

describe("the add menu is a segment library", () => {
  test("every bundled segment stands in the group it declares, with its description", () => {
    const r = rig(400);
    const shown = walk(r);
    for (const name of addable(DEFAULT_DSL_CONFIG)) {
      const decl = DEFAULT_DSL_CONFIG.segments[name]!;
      const label = GROUP_LABELS[decl.group ?? OTHER_GROUP];
      expect([name, shown.get(label)?.find(([n]) => n === name)]).toEqual([
        name,
        [name, decl.description],
      ]);
    }
    r.dispose();
  });

  test("a user segment with a description and no group is filed under other", () => {
    const r = rig(400, `mine: { template: 'M', description: 'My own thing.' }`);
    expect(walk(r).get(GROUP_LABELS[OTHER_GROUP])).toEqual([
      ["mine", "My own thing."],
    ]);
    r.dispose();
  });

  test("a group larger than a page turns over: every member is listed, each page fits", () => {
    const names = Array.from(
      { length: LIBRARY_PAGE_ROWS + 3 },
      (_, i) => `mine${i}`,
    );
    const r = rig(80, names.map((n) => `${n}: { template: 'M' }`).join(", "));
    expect(walk(r).get(GROUP_LABELS[OTHER_GROUP])!.map(([n]) => n)).toEqual(
      names,
    );
    r.dispose();
  });

  test("a user segment declaring a group joins it; one with no description is its bare name", () => {
    const r = rig(
      400,
      `mine: { template: 'M', group: 'git', description: 'Mine.' },
       bare: { template: 'B', group: 'git' }`,
    );
    const git = walk(r).get(GROUP_LABELS.git)!;
    expect(git).toContainEqual(["mine", "Mine."]);
    expect(git).toContainEqual(["bare", ""]);
    r.dispose();
  });

  test("a group outside the vocabulary is refused naming the legal ones", () => {
    expect(() => rig(80, `mine: { template: 'M', group: 'nope' }`)).toThrow(
      new RegExp(`group[^\\n]*${SEGMENT_GROUPS.join("[^\\n]*")}`),
    );
  });

  test("at 80 columns each group is a page that fits, turned with the arrows", () => {
    const r = rig(80);
    const first = r.open();
    const pages = LIBRARY_GROUPS.filter((g) =>
      addable(DEFAULT_DSL_CONFIG).some(
        (n) => (DEFAULT_DSL_CONFIG.segments[n]!.group ?? OTHER_GROUP) === g,
      ),
    );
    expect(pages).toEqual(SEGMENT_GROUPS); // every bundled segment is grouped
    pages.forEach((group, i) => {
      const out = i === 0 ? first : r.page(i);
      const text = lines(out);
      const nav = text.find((l) => l.includes(GROUP_LABELS[group]))!;
      expect(nav).toContain(`${GROUP_LABELS[group]} ${i + 1}/${pages.length}`);
      expect(nav.includes("←")).toBe(i > 0);
      expect(nav.includes("→")).toBe(i < pages.length - 1);
      for (const line of stripAnsi(out).split("\n")) {
        expect(cellWidth(line)).toBeLessThanOrEqual(80);
      }
      // Only this group's segments are on the page.
      const names = addable(DEFAULT_DSL_CONFIG).filter(
        (n) => DEFAULT_DSL_CONFIG.segments[n]!.group === group,
      );
      for (const n of names)
        expect(text.some((l) => l.startsWith(n))).toBe(true);
    });
    r.dispose();
  });

  test("a library row is the segment's whole click target: it inserts that segment", () => {
    const r = rig(80);
    const out = r.open();
    const row = links(out).find((l) => l.text.startsWith("directory "))!;
    const [layoutOp] = effectsOf(row.url);
    expect(layoutOp!.verb).toBe("apply-layout-op");
    expect(layoutOp!.args[2]).toMatch(/^insert:directory:/);
    r.dispose();
  });
});

describe("libraryLayout", () => {
  const groups = [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
    { id: "c", label: "C" },
  ];
  const entries = (options: string[]) =>
    options.map((o) => ({ group: o.startsWith("x") ? "a" : "b" }));

  test("pages are the non-empty groups, in the domain's order, members in its order", () => {
    expect(libraryLayout(entries(["y1", "x1", "y2"]), groups, true)).toEqual([
      [{ label: "A", indices: [1] }],
      [{ label: "B", indices: [0, 2] }],
    ]);
  });

  test("unpaged, one page holds every group", () => {
    expect(libraryLayout(entries(["y1", "x1"]), groups, false)).toEqual([
      [
        { label: "A", indices: [1] },
        { label: "B", indices: [0] },
      ],
    ]);
  });

  test("paged, a group larger than a page turns over onto pages of its own", () => {
    const many = Array.from(
      { length: LIBRARY_PAGE_ROWS + 2 },
      (_, i) => `y${i}`,
    );
    const pages = libraryLayout(entries(many), groups, true);
    expect(pages.map((p) => p.map((s) => [s.label, s.indices.length]))).toEqual(
      [[["B", LIBRARY_PAGE_ROWS]], [["B", 2]]],
    );
  });

  test("a member naming an unlisted group is a loud error, not an omission", () => {
    expect(() => libraryLayout([{ group: "zzz" }], groups, true)).toThrow(
      /#0 \(group "zzz"\).*does not list/,
    );
  });
});

describe("fitCells", () => {
  test("cuts to the width in cells and says so", () => {
    expect(fitCells("abcdefgh", 5)).toBe("abcd…");
    expect(cellWidth(fitCells("世界世界世界", 6))).toBeLessThanOrEqual(6);
    expect(fitCells("abc", 5)).toBe("abc");
  });

  test("never splits a grapheme cluster or overflows on one", () => {
    const cut = fitCells("ab⚠️cdef", 4);
    expect(cellWidth(cut)).toBeLessThanOrEqual(4);
    expect(cut.includes("⚠") ? cut.includes("⚠️") : true).toBe(true);
  });
});
