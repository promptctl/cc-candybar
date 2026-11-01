// [LAW:verifiable-goals] brandon-unfiled-3248.8ro6 step 3, part 2: a value
// whose source has not answered yet is its own state, never drawn as an answer.
// Every place a template is evaluated takes it as an outcome of its own: a
// placement draws where it stood in the view's last frame (`…` at the width it
// drew, nothing where it drew nothing, one cell in a cold view), a container's
// `when` draws each placement under it so, a globals rule keeps the name the
// view last settled on, and a template variable passes it on rather than
// answering with its default. None of it is a fault: nothing is reported.

import { drawPayload } from "./helpers/draw-payload";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { SessionState } from "../src/daemon/session-state";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { compileDslConfig, compileInputOf, declareDslVariables, EVERY_SCOPE, type RenderWarning } from "../src/dsl/render";
import { LOADING_GLYPH } from "../src/dsl/node-registry";
import type { ValidatedConfig } from "../src/config/dsl-types";
import { paletteForThemeName } from "../src/themes/palette-resolvers";
import { THEME_FLOOR } from "../src/themes/policy";
import { ok, PENDING } from "../src/utils/outcome";
import type { JsonValue } from "../src/var-system/types";
import type { Instant } from "../src/utils/instant";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { lastBinding } from "./helpers/render-binding";
import { selectionFor } from "./helpers/selection";
import { textOf, ansiOf, type Frame } from "../src/render/frame";

const AT = 1_800_000_000 as Instant;

// `doc` is a json source that never answers on its own (its command outlives
// the test), so the test answers for it through the store, and takes the
// answer back to pending as a re-read under a new key will (step 3, part 3).
const config = (rest: string, variables = ""): ValidatedConfig =>
  parseAndValidate(
    "<test>",
    `{
      variables: {
        doc: { kind: "shell", command: "sleep 60", parse: { json: true }, cache: { never: true } },
        ${variables}
      },
      ${rest}
    }`,
  );

interface Drawn {
  readonly frame: Frame;
  readonly text: string;
  readonly errors: readonly string[];
  readonly warnings: readonly RenderWarning[];
}

function renderer(cfg: ValidatedConfig) {
  const compiled = compileDslConfig(compileInputOf(cfg), TEST_SIGNER);
  const store = new VariableStore();
  const session = new SessionState();
  const registry = new SourceRegistry(processLauncher, store, "", session);
  declareDslVariables(cfg, registry, "/tmp", EVERY_SCOPE);
  const drawn = lastBinding(compiled.menuRuntime.action);
  return {
    store,
    registry,
    session,
    // The base palette the latest frame wore.
    palette: () => drawn().look!.basePalette,
    answer: (value: JsonValue) => store.setDocument("doc", ok(value)),
    unanswer: () => store.setDocument("doc", PENDING),
    draw: (width = 160): Drawn => {
      const errors: string[] = [];
      const warnings: RenderWarning[] = [];
      const { frame } = drawPayload(
        cfg,
        compiled,
        store,
        registry,
        { session_id: "s" },
        AT,
        {
          endcaps: "plain",
          colorCompatibility: "truecolor",
          wrap: true,
          padding: 1,
          width,
        },
        {
          onSegmentError: (id, message) => errors.push(`${id}: ${message}`),
          onRenderWarning: (warning) => warnings.push(warning),
        },
        selectionFor(cfg),
      );
      return {
        frame,
        text: textOf(frame).split("\n").at(-1)!,
        errors,
        warnings,
      };
    },
    dispose: () => registry.dispose(),
  };
}

// The cell `id` draws between the plain separators either side of it, padding
// included: what a row of `left | id | right` holds in that place.
const cellBetween = (line: string, left: string, right: string): string =>
  line.slice(line.indexOf(`${left}  |`) + left.length + 3, line.lastIndexOf(`|  ${right}`));

const ROW = `
  segments: {
    left: { template: "L" },
    value: { template: "{{ .doc.label }}", when: "{{ .doc.show }}" },
    right: { template: "R" },
  },
  root: { h: ["left", "value", "right"] },
`;

describe("a placement whose value is not answered yet draws where it stood", () => {
  test("in a cold view it is one loading cell, reported as pending and as nothing else", () => {
    const on = renderer(config(ROW));
    try {
      const { frame, text, errors, warnings } = on.draw();
      expect(cellBetween(text, "L", "R")).toBe(`  ${LOADING_GLYPH}  `);
      expect(frame.pending).toEqual(["doc"]);
      expect(errors).toEqual([]);
      expect(warnings).toEqual([]);
    } finally {
      on.dispose();
    }
  });

  test("one that drew is `…` at the width it drew, and its row moves nothing", () => {
    const on = renderer(config(ROW));
    try {
      on.answer({ label: "a wide value", show: true });
      const drew = on.draw().text;
      expect(cellBetween(drew, "L", "R")).toBe("  a wide value  ");
      on.unanswer();
      const { text, frame, errors } = on.draw();
      expect(text.length).toBe(drew.length);
      expect(cellBetween(text, "L", "R")).toBe(
        `  ${LOADING_GLYPH}`.padEnd("  a wide value  ".length),
      );
      expect(frame.pending).toEqual(["doc"]);
      expect(errors).toEqual([]);
      // Still not answered: the loading cell holds the width it was drawn at.
      expect(on.draw().text).toBe(text);
      on.answer({ label: "short", show: true });
      expect(cellBetween(on.draw().text, "L", "R")).toBe("  short  ");
    } finally {
      on.dispose();
    }
  });

  test("drawn at another width, it stands where a cold view's does: its last frame was sized for that width", () => {
    const on = renderer(config(ROW));
    try {
      on.answer({ label: "a wide value", show: true });
      on.draw(160);
      on.unanswer();
      expect(cellBetween(on.draw(120).text, "L", "R")).toBe(`  ${LOADING_GLYPH}  `);
    } finally {
      on.dispose();
    }
  });

  test("with edit mode's buttons beside it, every row keeps the width it drew", () => {
    const on = renderer(config(ROW));
    try {
      on.session.set("s", "edit.mode", "arrange");
      on.session.set("s", "edit.live", "open");
      on.answer({ label: "a wide value", show: true });
      const drew = textOf(on.draw().frame).split("\n");
      expect(drew.join("\n")).toContain("a wide value");
      on.unanswer();
      const { frame, errors } = on.draw();
      const rows = textOf(frame).split("\n");
      expect(rows.join("\n")).toContain(LOADING_GLYPH);
      expect(rows.map((row) => row.length)).toEqual(drew.map((row) => row.length));
      expect(errors).toEqual([]);
    } finally {
      on.dispose();
    }
  });

  test("one that drew several rows holds every one of them", () => {
    const on = renderer(
      config(`
        segments: {
          value: { template: "{{ .doc.top }}\\n{{ .doc.bottom }}" },
        },
        root: { h: ["value"] },
      `),
    );
    try {
      on.answer({ top: "a top row", bottom: "and a longer bottom row" });
      const drew = textOf(on.draw().frame).split("\n");
      expect(drew).toHaveLength(2);
      on.unanswer();
      const rows = textOf(on.draw().frame).split("\n");
      expect(rows.map((row) => row.length)).toEqual(drew.map((row) => row.length));
      // The settings door leads the first row.
      expect(rows[0]!.trimEnd().endsWith(`|  ${LOADING_GLYPH}`)).toBe(true);
      expect(drew[1]!.trim()).toBe("and a longer bottom row");
      expect(rows[1]!.trim()).toBe("");
    } finally {
      on.dispose();
    }
  });

  test("one that drew nothing still draws nothing, and no `…`", () => {
    const on = renderer(config(ROW));
    try {
      on.answer({ label: "x", show: false });
      const hidden = on.draw().text;
      expect(hidden).not.toContain("x");
      on.unanswer();
      const { text, frame } = on.draw();
      expect(text).toBe(hidden);
      expect(text).not.toContain(LOADING_GLYPH);
      expect(frame.pending).toEqual(["doc"]);
    } finally {
      on.dispose();
    }
  });

  test("a container whose `when` is not answered yet draws each placement under it so, with no `when` warning", () => {
    const on = renderer(
      config(`
        segments: {
          left: { template: "L" },
          value: { template: "{{ .doc.label }}" },
          right: { template: "R" },
        },
        root: { h: ["left", { h: ["value"], when: "{{ .doc.show }}" }, "right"] },
      `),
    );
    try {
      const cold = on.draw();
      expect(cellBetween(cold.text, "L", "R")).toBe(`  ${LOADING_GLYPH}  `);
      expect(cold.warnings).toEqual([]);
      expect(cold.frame.pending).toEqual(["doc"]);
      on.answer({ label: "shown value", show: true });
      const drew = on.draw().text;
      on.unanswer();
      const { text, warnings } = on.draw();
      expect(text.length).toBe(drew.length);
      expect(cellBetween(text, "L", "R").trim()).toBe(LOADING_GLYPH);
      expect(warnings).toEqual([]);
    } finally {
      on.dispose();
    }
  });

  test("the layout preview asks a placement's own `when` under a gate not answered yet, as the walk does", () => {
    const on = renderer(
      config(`
        segments: {
          left: { template: "L" },
          value: { template: "V", when: "false" },
          preview: { template: "[{{ layoutPreview }}]" },
        },
        root: { h: ["left", { seg: "value", when: "{{ .doc.show }}" }, "preview"] },
      `),
    );
    try {
      const { text, frame } = on.draw();
      // Its own `when` hides it whatever the gate answers: nothing waits.
      expect(frame.pending).toEqual([]);
      expect(text).not.toContain(LOADING_GLYPH);
      expect(text).toMatch(/\[.*left.*\]/s);
      expect(text).not.toMatch(/\[.*value.*\]/s);
    } finally {
      on.dispose();
    }
  });

  test("under a container not answered yet, a `when` that fails is no fault yet: it waits on the container", () => {
    const on = renderer(
      config(`
        segments: {
          left: { template: "L" },
          value: { template: "V", when: '{{ fail "only asked once shown" }}' },
          nested: { template: "N" },
          right: { template: "R" },
        },
        root: { h: ["left", { h: ["value", { h: ["nested"], when: '{{ fail "only asked once shown" }}' }], when: "{{ .doc.show }}" }, "right"] },
      `),
    );
    try {
      on.answer({ show: true });
      // Answered, the container shows what it holds, and their `when`s fail:
      // each is the fault it is.
      const answered = on.draw();
      expect(answered.errors).toHaveLength(1);
      expect(answered.warnings.map((w) => w.kind)).toEqual(["when"]);
      on.unanswer();
      const { text, errors, warnings, frame } = on.draw();
      expect(text).toContain(LOADING_GLYPH);
      expect(errors).toEqual([]);
      expect(warnings).toEqual([]);
      expect(frame.pending).toEqual(["doc"]);
    } finally {
      on.dispose();
    }
  });
});

describe("a template variable over a value not answered yet is not answered yet", () => {
  const cfg = () =>
    config(
      `
        segments: { left: { template: "L" }, value: { template: "{{ .label }}" }, right: { template: "R" } },
        root: { h: ["left", "value", "right"] },
      `,
      `label: { kind: "template", template: "{{ .doc.label }}", default: "DEFAULT" },`,
    );

  test("its default answers a failure alone: pending draws `…`, records no error, and names the source", () => {
    const on = renderer(cfg());
    try {
      const { text, frame, errors } = on.draw();
      expect(cellBetween(text, "L", "R")).toBe(`  ${LOADING_GLYPH}  `);
      expect(frame.pending).toEqual(["doc"]);
      expect(errors).toEqual([]);
      expect(on.registry.getLastError("label")).toBeUndefined();
      on.answer({});
      // A read that fails — the field is missing — is answered by the default.
      expect(cellBetween(on.draw().text, "L", "R")).toBe("  DEFAULT  ");
      expect(on.registry.getLastError("label")?.message).toContain("label");
      // Not answered again, it is no longer failing: its failure is over.
      on.unanswer();
      expect(on.draw().frame.pending).toEqual(["doc"]);
      expect(on.registry.getLastError("label")).toBeUndefined();
    } finally {
      on.dispose();
    }
  });
});

describe("a json source with no default", () => {
  test("draws `…` before its first scan, and the missing-field ⚠ when its scan had nothing to read", async () => {
    const on = renderer(
      parseAndValidate(
        "<test>",
        `{
          variables: {
            doc: { kind: "shell", command: "sleep 0.2; printf ''", parse: { json: true }, cache: { never: true } },
          },
          segments: { left: { template: "L" }, value: { template: "{{ .doc.label }}" }, right: { template: "R" } },
          root: { h: ["left", "value", "right"] },
        }`,
      ),
    );
    try {
      expect(cellBetween(on.draw().text, "L", "R")).toBe(`  ${LOADING_GLYPH}  `);
      expect(await on.registry.settled(5000)).toEqual([]);
      const { text, errors, frame } = on.draw();
      // Absent is a missing field (src/template-engine/scope.ts).
      expect(text).toContain('⚠ value: field "doc.label" not found on receiver');
      expect(errors).toEqual([expect.stringContaining('value: field "doc.label" not found on receiver')]);
      expect(frame.pending).toEqual([]);
    } finally {
      on.dispose();
    }
  });
});

describe("a globals rule over a value not answered yet decides nothing, and is no fault", () => {
  const cfg = () =>
    config(
      `
        globals: { palette: '{{ if .doc.prod }}nord{{ else }}gruvbox{{ end }}' },
        segments: { left: { template: "L" } },
        root: { h: ["left"] },
      `,
    );

  test("a cold view wears the slot's floor, then the rule's theme, which a later pending keeps", () => {
    const on = renderer(cfg());
    try {
      const cold = on.draw();
      expect(on.palette()).toBe(paletteForThemeName(THEME_FLOOR));
      expect(cold.warnings).toEqual([]);
      expect(cold.frame.pending).toEqual(["doc"]);
      on.answer({ prod: true });
      on.draw();
      expect(on.palette()).toBe(paletteForThemeName("nord"));
      on.unanswer();
      const held = on.draw();
      expect(on.palette()).toBe(paletteForThemeName("nord"));
      expect(held.warnings).toEqual([]);
      expect(held.frame.pending).toEqual(["doc"]);
      on.answer({ prod: false });
      on.draw();
      expect(on.palette()).toBe(paletteForThemeName("gruvbox"));
    } finally {
      on.dispose();
    }
  });
});

// brandon-unfiled-3248.8ro6 step 3, part 3: not answered yet flows through the
// walk as a value. A placement waiting on a source still hangs what is open
// under it, so the open body is drawn, keeps the shape it drew, and its
// placements keep their record rather than coming back cold.
describe("what hangs open under a placement not answered yet stays open", () => {
  test("an open group whose `when` is not answered yet draws its body, each placement in it where it stood", () => {
    const on = renderer(
      config(`
        segments: {
          left: { template: "L" },
          inner: { template: "an inner value" },
        },
        root: { v: ["left", { kind: "group", name: "g", label: "group", open: true, when: "{{ .doc.show }}", children: ["inner"] }] },
      `),
    );
    try {
      on.answer({ show: true });
      const drew = textOf(on.draw().frame).split("\n");
      expect(drew.join("\n")).toContain("an inner value");
      on.unanswer();
      const { frame, errors, warnings } = on.draw();
      const rows = textOf(frame).split("\n");
      // The body's row is still there, the width it drew, its placement
      // waiting on the gate over it.
      expect(rows.map((row) => row.length)).toEqual(drew.map((row) => row.length));
      expect(rows.join("\n")).not.toContain("an inner value");
      expect(rows.filter((row) => row.includes(LOADING_GLYPH))).toHaveLength(2);
      expect(frame.pending).toEqual(["doc"]);
      expect(errors).toEqual([]);
      expect(warnings).toEqual([]);
      on.answer({ show: true });
      expect(textOf(on.draw().frame).split("\n")).toEqual(drew);
    } finally {
      on.dispose();
    }
  });

  test("an open group whose own colour is not answered yet draws its body under its loading cell", () => {
    const on = renderer(
      config(`
        segments: {
          left: { template: "L" },
          inner: { template: "an inner value" },
        },
        root: { v: ["left", { kind: "group", name: "g", label: "a group label", open: true, bg: "{{ .doc.colour }}", children: ["inner"] }] },
      `),
    );
    try {
      on.answer({ colour: "error" });
      const drew = textOf(on.draw().frame).split("\n");
      expect(drew.join("\n")).toContain("a group label");
      on.unanswer();
      const { frame, errors } = on.draw();
      const rows = textOf(frame).split("\n");
      // The toggle waits where it stood; the body it hangs open is answered,
      // and drawn as it was.
      expect(rows.join("\n")).not.toContain("a group label");
      expect(rows.join("\n")).toContain(LOADING_GLYPH);
      expect(rows.join("\n")).toContain("an inner value");
      expect(rows.map((row) => row.length)).toEqual(drew.map((row) => row.length));
      expect(frame.pending).toEqual(["doc"]);
      expect(errors).toEqual([]);
    } finally {
      on.dispose();
    }
  });
});
