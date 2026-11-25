// [LAW:verifiable-goals] The config editor and the loader read one file by
// one set of rules: what the editor writes, the live loader reads back as
// written, comments included, and a text one refuses the other refuses in the
// same words. A click on a file the editor refuses is refused naming the
// file, and nothing is written.

import { applyChanges } from "../../src/config/config-changes";
import type { Layer } from "../../src/config/config-snapshot";
import { contentOfText } from "../../src/config/config-snapshot";
import { DEFAULT_DSL_CONFIG } from "../../src/config/default-dsl-config";
import { loadSnapshot } from "../../src/config/dsl-loader";
import {
  deleteValue,
  EMPTY_DOCUMENT,
  HOLDS_NO_VALUE,
  insertValue,
  JSON5_DIALECT,
  setValue,
} from "../../src/config/json5-edit";
import type { Advisory } from "../../src/config/loader/diagnostics";
import { ConfigError } from "../../src/config/loader/diagnostics";
import {
  deleteValues,
  readDeclared,
  writePreset,
  writeValues,
  type EditStore,
  type WriteLayer,
} from "../../src/renderer/config-file-store";
import { BadVerbArgs } from "../../src/daemon/foundations/verb-error";

const HOME = "/home/u";
const USER = "/home/u/.config/cc-candybar/config.json5";
const PROJECT = "/p/.cc-candybar.json5";

const snapshotOf = (chain: readonly Layer[]) => ({
  chain,
  repo: null,
  plugins: [],
  strays: [],
  checkout: null,
  notices: [],
  watch: null,
});

// The live loader over the user's file holding `text`, as a click's commit
// loads it: the config the bar would draw, and what the load warned.
function load(text: string) {
  const warnings: Advisory[] = [];
  const { config } = loadSnapshot(
    snapshotOf([
      { role: "user", path: USER, content: contentOfText(text), listed: {} },
    ]),
    HOME,
    DEFAULT_DSL_CONFIG,
    { warned: (w) => warnings.push(...w) },
  );
  return { config, warnings };
}

// A click over a chain of files, lowest first (the user's, then the
// project's): the layer it writes, and what it recorded writing.
function click(files: ReadonlyArray<readonly [string, string | null]>) {
  const recorded: Array<readonly [string, string]> = [];
  const store: EditStore = {
    read: (file) =>
      contentOfText(files.find(([path]) => path === file)?.[1] ?? null),
    record: (file, _before, after) => recorded.push([file, after]),
  };
  const chain: Layer[] = files.map(([path, text], i) => ({
    role: i === 0 ? "user" : "project",
    path,
    content: contentOfText(text),
    listed: {},
  }));
  const layer = (path: string): WriteLayer => ({
    ...chain.find((l) => l.path === path)!,
    snapshot: snapshotOf(chain),
    home: HOME,
  });
  return { store, recorded, layer };
}

// What a text that holds nothing but whitespace and comments looks like,
// line endings and an unterminated last line included.
const NO_VALUE = ["", "  \n", "\r\n", "// note\n", "// note", "/* note */\n"];

describe("a file that holds no value", () => {
  test.each(NO_VALUE)(
    "%j: the loader refuses it in the words the editor refuses it in",
    (text) => {
      expect(() => load(text)).toThrow(ConfigError);
      expect(() => load(text)).toThrow(HOLDS_NO_VALUE);
      expect(() =>
        setValue(text, ["globals", "padding"], "3", JSON5_DIALECT),
      ).toThrow(HOLDS_NO_VALUE);
      expect(() =>
        insertValue(text, ["globals"], "{}", JSON5_DIALECT, null),
      ).toThrow(HOLDS_NO_VALUE);
      expect(() => deleteValue(text, ["globals"])).toThrow(HOLDS_NO_VALUE);
    },
  );

  test.each(NO_VALUE)(
    "%j: a click on it is refused naming the file, and nothing is written",
    (text) => {
      const { store, recorded, layer } = click([[USER, text]]);
      for (const act of [
        () => writeValues(store, layer(USER), [["padding", "3"]]),
        () => deleteValues(store, layer(USER), ["padding"]),
        () => readDeclared(USER, text, "padding"),
      ]) {
        expect(act).toThrow(BadVerbArgs);
        expect(act).toThrow(`refused: ${USER}: ${HOLDS_NO_VALUE}`);
      }
      expect(recorded).toEqual([]);
    },
  );

  test("a save-as-preset under a layer above that holds no value is refused naming that layer", () => {
    const { store, recorded, layer } = click([
      [USER, "{}\n"],
      [PROJECT, "  \n"],
    ]);
    const save = () => writePreset(store, layer(USER), "default", {}, [], []);
    expect(save).toThrow(BadVerbArgs);
    expect(save).toThrow(`${PROJECT}, above ${USER}, does not load`);
    expect(save).toThrow(HOLDS_NO_VALUE);
    expect(recorded).toEqual([]);
  });
});

describe("a file that does not exist", () => {
  test("a click writes a document the loader reads the value from", () => {
    const { store, recorded, layer } = click([[USER, null]]);
    writeValues(store, layer(USER), [["padding", "3"]]);
    expect(recorded).toEqual([
      [USER, `{\n  globals: {\n    padding: 3,\n  },\n}\n`],
    ]);
    const { config, warnings } = load(recorded[0]![1]);
    expect(config.globals.padding).toBe(3);
    expect(warnings).toEqual([]);
  });

  test("a reset there writes nothing", () => {
    const { store, recorded, layer } = click([[USER, null]]);
    deleteValues(store, layer(USER), ["padding"]);
    expect(recorded).toEqual([]);
  });

  test("the empty document it starts from is the one an edit to {} writes", () => {
    const edit = (text: string) =>
      setValue(text, ["globals", "padding"], "3", JSON5_DIALECT);
    expect(edit(EMPTY_DOCUMENT)).toBe(edit("{}\n"));
  });
});

// JSON5 ends a `//` comment at any line terminator. Read past one, the
// document after it is hidden in the comment.
describe("a line comment ends where JSON5 ends it", () => {
  test.each(["\r", " ", " "])(
    "a comment ended by %j: the editor edits the document after it, and the loader reads the edit",
    (eol) => {
      const text = `{ // note${eol} globals: { padding: 1 } }\n`;
      const after = setValue(text, ["globals", "padding"], "3", JSON5_DIALECT);
      expect(after).toBe(`{ // note${eol} globals: { padding: 3 } }\n`);
      expect(load(after)).toEqual({
        config: expect.objectContaining({
          globals: expect.objectContaining({ padding: 3 }),
        }),
        warnings: [],
      });
    },
  );

  test("a comment ended by a carriage return before the document is not a file that holds no value", () => {
    expect(
      load("// note\r{ globals: { padding: 4 } }\n").config.globals.padding,
    ).toBe(4);
  });
});

// [LAW:behavior-not-structure] Each container holds only the user's comment;
// the edit adds a key, the comment stays in the bytes, and the loader reads
// the key.
describe("an insert into an object whose only content is a comment", () => {
  const PADDING = ["globals", "padding"] as const;
  test.each([
    [
      "a line comment on the brace's line",
      "{ // the user's note\n}\n",
      "{ // the user's note\n  globals: {\n    padding: 3,\n  },\n}\n",
    ],
    [
      "a line comment on its own line",
      "{\n  // the user's note\n}\n",
      "{\n  // the user's note\n  globals: {\n    padding: 3,\n  },\n}\n",
    ],
    [
      "a block comment inline",
      "{ /* the user's note */ }\n",
      "{ /* the user's note */\n  globals: {\n    padding: 3,\n  },\n}\n",
    ],
    [
      "two comments",
      "{\n  // one\n  /* two */\n}\n",
      "{\n  // one\n  /* two */\n  globals: {\n    padding: 3,\n  },\n}\n",
    ],
    [
      "a nested object",
      "{\n  globals: {\n    // the user's note\n  },\n}\n",
      "{\n  globals: {\n    // the user's note\n    padding: 3,\n  },\n}\n",
    ],
    [
      "CRLF line endings",
      "{\r\n  // the user's note\r\n}\r\n",
      "{\r\n  // the user's note\r\n  globals: {\r\n    padding: 3,\r\n  },\r\n}\r\n",
    ],
  ])("%s", (_, text, written) => {
    const after = setValue(text, PADDING, "3", JSON5_DIALECT);
    expect(after).toBe(written);
    expect(load(after)).toEqual({
      config: expect.objectContaining({
        globals: expect.objectContaining({ padding: 3 }),
      }),
      warnings: [],
    });
  });

  test("an insert keeps the comment, as a click's change carries it to the host", () => {
    const text = "{ // the user's note\n}\n";
    const inserted = insertValue(
      text,
      ["globals"],
      "{ padding: 3 }",
      JSON5_DIALECT,
      null,
    );
    expect(inserted).toBe(
      "{ // the user's note\n  globals: { padding: 3 },\n}\n",
    );
    expect(
      applyChanges(text, [
        {
          op: "insert",
          at: ["globals"],
          text: "{ padding: 3 }",
          precedes: null,
        },
      ]),
    ).toEqual({ kind: "applied", text: inserted });
    expect(load(inserted).config.globals.padding).toBe(3);
  });

  test("a click keeps the comment", () => {
    const text = "{\n  globals: {\n    // keep me\n  },\n}\n";
    const { store, recorded, layer } = click([[USER, text]]);
    writeValues(store, layer(USER), [["padding", "3"]]);
    expect(recorded).toEqual([
      [USER, "{\n  globals: {\n    // keep me\n    padding: 3,\n  },\n}\n"],
    ]);
    expect(load(recorded[0]![1]).config.globals.padding).toBe(3);
  });
});
