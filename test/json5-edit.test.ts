// candybar-config-dqe — the config file is THE durable store, so a click
// edits the user's own file. These tests pin the writer's contract: every
// byte outside the one edited span survives verbatim (comments, blank lines,
// unquoted keys, trailing commas, quote style), and the layout-tree edits
// address segments by name in the authored shape grammar.

import JSON5 from "json5";
import {
  deleteValue,
  hasSegmentRef,
  insertSegmentRef,
  json5Text,
  Json5EditError,
  nodeAt,
  parseDocument,
  removeSegmentRef,
  restagesFragment,
  rowEntriesOf,
  setValue as setValueIn,
  JSON5_DIALECT,
  JSON_DIALECT,
  type Dialect,
  textOf,
} from "../src/config/json5-edit";

// The cc-candybar config is the JSON5 consumer; every case below edits it.
const setValue = (
  text: string,
  path: readonly string[],
  valueText: string,
  dialect: Dialect = JSON5_DIALECT,
): string => setValueIn(text, path, valueText, dialect);

const CONFIG = `{
  // ─── header comment ───────────────────────────────────────────────
  // a second header line

  globals: { palette: 'catppuccin-mocha', padding: 2, }, // trailing note

  actions: {
    copySession: { copy: "{{ .session.id }}" },
  },

  /* block comment before segments */
  segments: {
    'quoted-name': { template: "x", bg: "surface" },
    directory: {
      template: "{{ .cwd }}", // why: fish-style
      palette: "nord",
    },
  },

  root: { v: [
    { h: ["directory", "gitaculous", "toolbar"] },
    { h: [
      "model", // the model
      "context",
      { seg: "cacheTimer", when: "{{ .x }}" },
      { kind: "segment", name: "block" },
      "weekly"
    ] },
  ] },
}
`;

/** The one span that may differ between `before` and `after`. */
function onlySpanChanged(
  before: string,
  after: string,
  span: { start: number; end: number },
  replacement: string,
): void {
  expect(after).toBe(before.slice(0, span.start) + replacement + before.slice(span.end));
}

describe("parseDocument", () => {
  test("parses comments, single quotes, unquoted and quoted keys, trailing commas, hex and escapes", () => {
    const doc = parseDocument(`{ a: 0x1F, 'b': 'it\\'s', "c d": [1, .5, -Infinity, NaN, null, true,], /* c */ e: "\\u0041", }`);
    const value = (k: string) => nodeAt(doc, [k]);
    expect(value("a")).toMatchObject({ kind: "number", value: 31 });
    expect(value("b")).toMatchObject({ kind: "string", value: "it's" });
    expect(value("e")).toMatchObject({ kind: "string", value: "A" });
    const cd = value("c d");
    expect(cd?.kind).toBe("array");
    expect(cd?.kind === "array" && cd.elements.map((n) => n.kind)).toEqual([
      "number", "number", "number", "number", "null", "boolean",
    ]);
  });

  test("spans are exact: textOf a node reproduces its source bytes", () => {
    const doc = parseDocument(CONFIG);
    expect(textOf(CONFIG, nodeAt(doc, ["globals", "palette"])!)).toBe("'catppuccin-mocha'");
    expect(textOf(CONFIG, nodeAt(doc, ["segments", "quoted-name"])!)).toBe('{ template: "x", bg: "surface" }');
  });

  test("a syntax error is a loud Json5EditError with an offset", () => {
    expect(() => parseDocument("{ a: }")).toThrow(Json5EditError);
    expect(() => parseDocument("{ a: 1 } x")).toThrow(/trailing content/);
    expect(() => parseDocument("{ a: 'unterminated }")).toThrow(/unterminated/);
  });

  // [LAW:parse-dont-validate] JSON5 reads the LAST duplicate; a splice that
  // addressed the first would leave the live value untouched, and a delete
  // of the last would promote a value the user never chose.
  test("a duplicate key is refused at parse, naming the key", () => {
    expect(() =>
      parseDocument("{ globals: { palette: 'a', palette: 'b' } }"),
    ).toThrow(/duplicate key "palette"/);
    expect(() =>
      setValue("{ palette: 'a', palette: 'b' }", ["palette"], "'c'"),
    ).toThrow(Json5EditError);
  });
});

describe("setValue — replacing an existing value touches only that value's span", () => {
  test("the ticket's acceptance: comments, blank lines, unquoted keys, trailing commas all survive", () => {
    const doc = parseDocument(CONFIG);
    const target = nodeAt(doc, ["globals", "palette"])!;
    const after = setValue(CONFIG, ["globals", "palette"], '"nord"');
    onlySpanChanged(CONFIG, after, target.span, '"nord"');
    expect(JSON5.parse(after).globals).toEqual({ palette: "nord", padding: 2 });
  });

  test("a number and a nested segment field", () => {
    const doc = parseDocument(CONFIG);
    const padded = setValue(CONFIG, ["globals", "padding"], "0");
    onlySpanChanged(CONFIG, padded, nodeAt(doc, ["globals", "padding"])!.span, "0");
    const pal = setValue(CONFIG, ["segments", "directory", "palette"], '"dracula"');
    onlySpanChanged(CONFIG, pal, nodeAt(doc, ["segments", "directory", "palette"])!.span, '"dracula"');
  });

  test("a multi-line replacement is re-indented to the entry's own line", () => {
    const src = `{\n  presets: {\n    compact: {\n      root: "old",\n    },\n  },\n}\n`;
    const after = setValue(src, ["presets", "compact", "root"], `{\n  h: [\n    "a",\n  ],\n}`);
    expect(after).toBe(`{\n  presets: {\n    compact: {\n      root: {\n        h: [\n          "a",\n        ],\n      },\n    },\n  },\n}\n`);
    expect(JSON5.parse(after).presets.compact.root).toEqual({ h: ["a"] });
  });
});

describe("setValue — adding an entry matches the container's own style", () => {
  test("appends after the last entry of a multi-line object, AFTER its trailing comment, with its trailing comma", () => {
    const after = setValue(CONFIG, ["segments", "directory", "bg"], '"surface"');
    expect(after).toContain(`      palette: "nord",\n      bg: "surface",\n    },`);
    expect(JSON5.parse(after).segments.directory.bg).toBe("surface");
    // Nothing else moved.
    expect(after.replace(`      bg: "surface",\n`, "")).toBe(CONFIG);
  });

  test("a trailing comment on the last entry stays on its own line", () => {
    const src = `{\n  a: 1, // about a\n}\n`;
    expect(setValue(src, ["b"], "2")).toBe(`{\n  a: 1, // about a\n  b: 2,\n}\n`);
  });

  test("no trailing comma in the source → none added", () => {
    const src = `{\n  a: 1 // about a\n}\n`;
    expect(setValue(src, ["b"], "2")).toBe(`{\n  a: 1, // about a\n  b: 2\n}\n`);
  });

  test("an inline object grows inline", () => {
    expect(setValue(`{ a: 1 }`, ["b"], "2")).toBe(`{ a: 1, b: 2 }`);
    expect(setValue(`{ a: 1, }`, ["b"], "2")).toBe(`{ a: 1, b: 2, }`);
    const after = setValue(CONFIG, ["globals", "look"], '"vivid"');
    expect(after).toContain(`globals: { palette: 'catppuccin-mocha', padding: 2, look: "vivid", }, // trailing note`);
  });

  test("an empty object opens onto an indented line", () => {
    const src = `{\n  globals: {},\n}\n`;
    expect(setValue(src, ["globals", "padding"], "1")).toBe(`{\n  globals: {\n    padding: 1,\n  },\n}\n`);
  });

  test("missing intermediate objects are created, nested and indented", () => {
    const src = `{\n  root: "bar",\n}\n`;
    const after = setValue(src, ["segments", "git", "palette"], '"nord"');
    expect(after).toBe(`{\n  root: "bar",\n  segments: {\n    git: {\n      palette: "nord",\n    },\n  },\n}\n`);
    expect(JSON5.parse(after).segments.git.palette).toBe("nord");
  });

  test("a key that is not an identifier is quoted", () => {
    const after = setValue(`{}`, ["presets", "v1.compact", "root"], '"x"');
    expect(after).toContain(`"v1.compact": {`);
    expect(JSON5.parse(after).presets["v1.compact"].root).toBe("x");
  });

  test("an empty document becomes a one-entry object", () => {
    expect(setValue("", ["globals", "palette"], '"nord"')).toBe(`{\n  globals: {\n    palette: "nord",\n  },\n}\n`);
    expect(setValue("  \n", ["padding"], "1")).toBe(`{\n  padding: 1,\n}\n`);
  });

  test("a step through a non-object is a loud error", () => {
    expect(() => setValue(`{ globals: 1 }`, ["globals", "palette"], '"x"')).toThrow(/globals is not an object/);
  });
});

describe("deleteValue", () => {
  test("a member alone on its line takes its whole line, including its trailing comment", () => {
    const after = deleteValue(CONFIG, ["segments", "directory", "template"]);
    expect(after).toBe(CONFIG.replace(`      template: "{{ .cwd }}", // why: fish-style\n`, ""));
  });

  test("a multi-line member takes all of its lines", () => {
    const after = deleteValue(CONFIG, ["segments", "directory"]);
    expect(after).toBe(CONFIG.replace(
      `    directory: {\n      template: "{{ .cwd }}", // why: fish-style\n      palette: "nord",\n    },\n`,
      "",
    ));
    expect(JSON5.parse(after).segments).toEqual({ "quoted-name": { template: "x", bg: "surface" } });
  });

  test("inline members: first, middle, last", () => {
    expect(deleteValue(`{ a: 1, b: 2, c: 3 }`, ["a"])).toBe(`{ b: 2, c: 3 }`);
    expect(deleteValue(`{ a: 1, b: 2, c: 3 }`, ["b"])).toBe(`{ a: 1, c: 3 }`);
    expect(deleteValue(`{ a: 1, b: 2, c: 3 }`, ["c"])).toBe(`{ a: 1, b: 2 }`);
    expect(deleteValue(`{ a: 1, b: 2, c: 3, }`, ["c"])).toBe(`{ a: 1, b: 2, }`);
    expect(deleteValue(`{ a: 1 }`, ["a"])).toBe(`{  }`);
  });

  test("an absent path returns the text unchanged; an empty document stays empty", () => {
    expect(deleteValue(CONFIG, ["globals", "look"])).toBe(CONFIG);
    expect(deleteValue(CONFIG, ["nope", "x"])).toBe(CONFIG);
    expect(deleteValue("", ["a"])).toBe("");
  });
});

describe("removeSegmentRef — the authored shape grammar, addressed by name", () => {
  test("a bare-string ref alone on its line takes its line and its comment", () => {
    const after = removeSegmentRef(CONFIG, ["root"], "model");
    expect(after).toBe(CONFIG.replace(`      "model", // the model\n`, ""));
  });

  test("an inline ref: first, middle, last", () => {
    expect(removeSegmentRef(CONFIG, ["root"], "directory")).toBe(
      CONFIG.replace(`["directory", "gitaculous", "toolbar"]`, `["gitaculous", "toolbar"]`),
    );
    expect(removeSegmentRef(CONFIG, ["root"], "gitaculous")).toBe(
      CONFIG.replace(`["directory", "gitaculous", "toolbar"]`, `["directory", "toolbar"]`),
    );
    expect(removeSegmentRef(CONFIG, ["root"], "toolbar")).toBe(
      CONFIG.replace(`["directory", "gitaculous", "toolbar"]`, `["directory", "gitaculous"]`),
    );
  });

  test("the { seg } and { kind: 'segment' } spellings are refs too", () => {
    expect(removeSegmentRef(CONFIG, ["root"], "cacheTimer")).toBe(
      CONFIG.replace(`      { seg: "cacheTimer", when: "{{ .x }}" },\n`, ""),
    );
    expect(removeSegmentRef(CONFIG, ["root"], "block")).toBe(
      CONFIG.replace(`      { kind: "segment", name: "block" },\n`, ""),
    );
  });

  test("the last element without a trailing comma", () => {
    expect(removeSegmentRef(CONFIG, ["root"], "weekly")).toBe(
      CONFIG.replace(`      "weekly"\n`, ""),
    );
  });

  test("descends into group children and canonical containers; absent → null", () => {
    const src = `{ root: { kind: "container", direction: "vertical", children: [
      { kind: "group", name: "g", label: "G", children: ["a", "b"] },
    ] } }`;
    expect(removeSegmentRef(src, ["root"], "b")).toBe(src.replace(`["a", "b"]`, `["a"]`));
    expect(removeSegmentRef(src, ["root"], "zzz")).toBeNull();
    expect(removeSegmentRef(CONFIG, ["presets", "compact", "root"], "a")).toBeNull();
  });

  test("the first match in pre-order wins when a name repeats", () => {
    const src = `{ root: { v: [ { h: ["a", "x"] }, { h: ["x", "b"] } ] } }`;
    expect(removeSegmentRef(src, ["root"], "x")).toBe(`{ root: { v: [ { h: ["a"] }, { h: ["x", "b"] } ] } }`);
  });
});

describe("insertSegmentRef", () => {
  test("after/before an inline anchor", () => {
    expect(insertSegmentRef(CONFIG, ["root"], "gitPr", "gitaculous", "after")).toBe(
      CONFIG.replace(`["directory", "gitaculous", "toolbar"]`, `["directory", "gitaculous", "gitPr", "toolbar"]`),
    );
    expect(insertSegmentRef(CONFIG, ["root"], "gitPr", "directory", "before")).toBe(
      CONFIG.replace(`["directory", "gitaculous", "toolbar"]`, `["gitPr", "directory", "gitaculous", "toolbar"]`),
    );
  });

  test("after an own-line anchor: a new line at the same indent, after the anchor's comment", () => {
    expect(insertSegmentRef(CONFIG, ["root"], "speed", "model", "after")).toBe(
      CONFIG.replace(`      "model", // the model\n`, `      "model", // the model\n      "speed",\n`),
    );
    expect(insertSegmentRef(CONFIG, ["root"], "speed", "weekly", "after")).toBe(
      CONFIG.replace(`      "weekly"\n`, `      "weekly",\n      "speed"\n`),
    );
  });

  test("before an own-line anchor", () => {
    expect(insertSegmentRef(CONFIG, ["root"], "speed", "context", "before")).toBe(
      CONFIG.replace(`      "context",\n`, `      "speed",\n      "context",\n`),
    );
  });

  test("an absent anchor → null", () => {
    expect(insertSegmentRef(CONFIG, ["root"], "speed", "nope", "after")).toBeNull();
  });
});

// A preset root may be a bare segment ref — `root: "sidebar"` or the gated
// `{ seg, when }` object (loader/layout.ts accepts both) — and edit chrome
// splices `-`/`+` beside it like any other segment. The editors address it
// as the one-child horizontal container it abbreviates, so the click lands
// instead of failing as "stale" on a file that never changed.
describe("a bare-segment root is the one-child container it abbreviates", () => {
  const bare = `{ presets: { compact: { root: "sidebar" } } }`;
  const gated = `{ presets: { compact: { root: { seg: "sidebar", when: "{{ .x }}" } } } }`;
  const path = ["presets", "compact", "root"];

  test("remove of the sole segment leaves an empty container, the root's own span rewritten", () => {
    expect(removeSegmentRef(bare, path, "sidebar")).toBe(
      `{ presets: { compact: { root: { h: [] } } } }`,
    );
    expect(removeSegmentRef(gated, path, "sidebar")).toBe(
      `{ presets: { compact: { root: { h: [] } } } }`,
    );
  });

  test("insert beside the sole segment keeps the original ref verbatim, its when included", () => {
    expect(insertSegmentRef(bare, path, "clock", "sidebar", "after")).toBe(
      `{ presets: { compact: { root: { h: ["sidebar", "clock"] } } } }`,
    );
    expect(insertSegmentRef(gated, path, "clock", "sidebar", "before")).toBe(
      `{ presets: { compact: { root: { h: ["clock", { seg: "sidebar", when: "{{ .x }}" }] } } } }`,
    );
  });

  test("a miss on a bare root is still null — the normalization is never committed alone", () => {
    expect(removeSegmentRef(bare, path, "zzz")).toBeNull();
    expect(insertSegmentRef(bare, path, "clock", "zzz", "after")).toBeNull();
  });
});

// [LAW:one-source-of-truth] A `{ rows }` root fragment (brandon-config-merge-uk3):
// the edits descend into each named row, a bare-string row is the one-child
// container it abbreviates (the same normalization a bare root gets), and
// every sibling row stays byte-identical.
describe("a `{ rows }` root: edits reach the named rows", () => {
  const rows = `{ root: { rows: {
    a: { h: ["x", "y"] }, // row a
    sys: "demo",
    b: { h: ["z"] },
  } } }`;

  test("remove / insert inside one row leave the other rows verbatim", () => {
    expect(removeSegmentRef(rows, ["root"], "y")).toBe(rows.replace(`["x", "y"]`, `["x"]`));
    expect(insertSegmentRef(rows, ["root"], "w", "z", "before")).toBe(
      rows.replace(`["z"]`, `["w", "z"]`),
    );
  });

  test("a bare-string row is normalized to the container it abbreviates, alone", () => {
    expect(removeSegmentRef(rows, ["root"], "demo")).toBe(
      rows.replace(`sys: "demo"`, `sys: { h: [] }`),
    );
    expect(insertSegmentRef(rows, ["root"], "clock", "demo", "after")).toBe(
      rows.replace(`sys: "demo"`, `sys: { h: ["demo", "clock"] }`),
    );
    expect(removeSegmentRef(rows, ["root"], "zzz")).toBeNull();
  });

  test("rowEntriesOf names the rows in authored order; a tree has none", () => {
    const fragment = nodeAt(parseDocument(rows), ["root"])!;
    expect(rowEntriesOf(fragment)?.map((e) => e.key)).toEqual(["a", "sys", "b"]);
    expect(rowEntriesOf(nodeAt(parseDocument(CONFIG), ["root"])!)).toBeNull();
  });

  test("restagesFragment: a tree restages, and so does any entry beside `rows` — the loader's `restages` on the document", () => {
    const at = (src: string): boolean =>
      restagesFragment(nodeAt(parseDocument(src), ["root"])!);
    expect(at(`{ root: { rows: {} } }`)).toBe(false);
    expect(at(`{ root: { rows: {}, when: '{{ .x }}' } }`)).toBe(true);
    expect(at(`{ root: { rows: {}, distribution: 'monotonic' } }`)).toBe(true);
    expect(at(`{ root: { rows: { a: 'demo' } } }`)).toBe(true);
    expect(at(`{ root: 'demo' }`)).toBe(true);
    expect(at(`{ root: { h: ['demo'] } }`)).toBe(true);
  });

  test("hasSegmentRef sees through rows, bare and arrayed alike", () => {
    const fragment = nodeAt(parseDocument(rows), ["root"])!;
    expect(hasSegmentRef(fragment, "demo")).toBe(true);
    expect(hasSegmentRef(fragment, "z")).toBe(true);
    expect(hasSegmentRef(fragment, "nope")).toBe(false);
  });
});

// A CRLF-authored file (core.autocrlf, an editor default) keeps its own
// terminator: a removed member takes both bytes of its line ending, and a
// synthesized line ends the way the file's lines do — never a mixed-EOL file.
describe("a CRLF document keeps its own line terminator", () => {
  const CRLF = CONFIG.replace(/\n/g, "\r\n");
  const noBareLf = (text: string): void => {
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
  };

  test("remove takes the whole CRLF line, comment included", () => {
    const after = removeSegmentRef(CRLF, ["root"], "model")!;
    expect(after).toBe(CRLF.replace(`      "model", // the model\r\n`, ""));
    noBareLf(after);
  });

  test("insert after / before an own-line anchor ends the new line in CRLF", () => {
    const after = insertSegmentRef(CRLF, ["root"], "speed", "model", "after")!;
    expect(after).toBe(
      CRLF.replace(`      "model", // the model\r\n`, `      "model", // the model\r\n      "speed",\r\n`),
    );
    noBareLf(after);
    const before = insertSegmentRef(CRLF, ["root"], "speed", "context", "before")!;
    expect(before).toBe(CRLF.replace(`      "context",\r\n`, `      "speed",\r\n      "context",\r\n`));
    noBareLf(before);
  });

  test("an appended entry and a nested multi-line value use CRLF", () => {
    const appended = setValue(CRLF, ["segments", "directory", "fg"], '"text"');
    expect(appended).toBe(
      CRLF.replace(`      palette: "nord",\r\n`, `      palette: "nord",\r\n      fg: "text",\r\n`),
    );
    noBareLf(appended);
    const nested = setValue(CRLF, ["presets", "mine", "root"], json5Text({ h: ["a"] }));
    expect(JSON5.parse(nested)).toMatchObject({ presets: { mine: { root: { h: ["a"] } } } });
    noBareLf(nested);
  });

  test("an empty document takes LF; a CRLF-only document takes CRLF", () => {
    expect(setValue("", ["globals", "padding"], "2")).not.toContain("\r");
    const crlf = setValue("\r\n", ["globals", "padding"], "2");
    expect(JSON5.parse(crlf)).toEqual({ globals: { padding: 2 } });
    expect(crlf).toContain("\r\n");
    noBareLf(crlf);
  });
});

describe("json5Text", () => {
  test("identifier keys unquoted, others quoted, one member per line, nested indentation", () => {
    expect(json5Text({ template: "{{ .x }}", "v1.c": [1, { a: true }], empty: {}, none: [] })).toBe(
      `{\n  template: "{{ .x }}",\n  "v1.c": [\n    1,\n    {\n      a: true,\n    },\n  ],\n  empty: {},\n  none: [],\n}`,
    );
    expect(JSON5.parse(json5Text({ template: "{{ .x }}", "v1.c": [1, { a: true }] }))).toEqual({
      template: "{{ .x }}", "v1.c": [1, { a: true }],
    });
  });
});

// [LAW:behavior-not-structure] The JSON dialect: what a strict-JSON consumer
// (Claude Code's settings.json) can read back — quoted keys, no trailing comma
// on minted containers — while an existing member's style is still mirrored.
describe("setValue — the JSON dialect mints strict JSON", () => {
  test("an empty document", () => {
    const after = setValue("", ["env", "X"], '"1"', JSON_DIALECT);
    expect(JSON.parse(after)).toEqual({ env: { X: "1" } });
    expect(after).toBe('{\n  "env": {\n    "X": "1"\n  }\n}\n');
  });

  test("a missing intermediate object", () => {
    const after = setValue(
      '{\n  "model": "opus"\n}\n',
      ["env", "X"],
      '"1"',
      JSON_DIALECT,
    );
    expect(JSON.parse(after)).toEqual({ model: "opus", env: { X: "1" } });
  });

  test("an empty container", () => {
    const after = setValue('{ "env": {} }', ["env", "X"], '"1"', JSON_DIALECT);
    expect(JSON.parse(after)).toEqual({ env: { X: "1" } });
  });

  test("appending after an existing member quotes the key", () => {
    const after = setValue(
      '{\n  "env": {\n    "A": "1"\n  }\n}\n',
      ["env", "X"],
      '"1"',
      JSON_DIALECT,
    );
    expect(JSON.parse(after)).toEqual({ env: { A: "1", X: "1" } });
  });
});
