// [LAW:verifiable-goals] brandon-segment-settings-i4n.g64 — configure mode,
// driven through the real spine: the real loader and its synthesis, the real
// render, and clicks dispatched through the real daemon verb handlers against
// the derived gates, over a real config file.
//
//   - Configuring is a level inside arranging: edit mode stays `arrange` and a
//     second key names the one placement configured. Configuring a second
//     placement replaces the first; arrange's chrome stays, so every ⚙ is
//     still there to switch with, and the body's ✕ returns to arranging.
//   - In arrange mode every placement carries a ⚙: `theme` is a setting each
//     one has (brandon-settings-menu-6c5), declared or not.
//   - Configure mode hangs one control per declared setting below that
//     placement, generated from its domain: a toggle, a word carousel, a stepper.
//   - A control writes a draft: only that placement renders it, `💾 save`
//     counts it, and saving writes it INTO the placement in the config file.

import { configurePlacement } from "./helpers/configure";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { testVerbContext, effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import {
  parseEffects,
  VERB_DISPATCH,
  VERB_SAVE,
  VERB_SAVE_PRESET,
  VERB_UNDO,
} from "../src/click/wire";
import { VERBS, type VerbContext } from "../src/daemon/verbs";
import { stateGate } from "../src/daemon/verbs/state-validators";
import {
  configureMember,
  EDIT_MODE_ARRANGE,
  EDIT_MODE_KEY,
  EDIT_CONFIGURE_KEY,
} from "../src/config/loader/edit-mode";
import {
  ADD_GLYPH,
  CONFIGURE_GLYPH,
  REMOVE_GLYPH,
  placementDraftKey,
} from "../src/config/edit-chrome";
import {
  placementId,
  walkNodes,
  type DslConfig,
  type SegmentNode,
} from "../src/config/dsl-types";
import { presetRoot } from "../src/config/presets";
import { encodeLayoutOp } from "../src/config/layout-ops";
import { presetRootKey } from "../src/config/loader/persist-target";
import { placementDrafts } from "../src/daemon/setting-drafts";
import { DISCLOSURE_CLOSED } from "../src/config/disclosure";
import { SETTINGS_ANCHOR, SETTINGS_OPEN } from "../src/config/settings-menu";
import { durableConfig, type DurableConfig } from "./helpers/durable-config";
import { linkUrls, stripAnsi } from "./helpers/ansi";

const ALLOWED = new Set(listResolvablePaletteNames());
const SID = "s1";

// One segment declaring a setting of each domain shape, placed twice — once
// bare, once with an id and a value of its own — beside a segment declaring
// none. The template spells every setting, so a cell's text says which values
// it renders with.
const SRC = `{
  globals: {},
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 200 },
  },
  segments: {
    vcs: {
      template: '{{ if .settings.detail }}D{{ else }}d{{ end }}-{{ .settings.form }}-{{ .settings.depth }}',
      settings: {
        detail: { label: 'detail', domain: 'bool', default: false },
        form: { label: 'form', domain: ['short', 'long'], default: 'short' },
        depth: { label: 'depth', domain: { min: 1, max: 3 }, default: 2 },
      },
    },
    plain: { template: 'plain' },
  },
  root: { v: [
    { h: [
      'vcs',
      { seg: 'vcs', id: 'vcs2', settings: { form: 'long' } },
      'plain',
    ] },
  ] },
}
`;

let durable: DurableConfig;
beforeEach(() => {
  durable = durableConfig("cc-candybar-configure-");
});
afterEach(() => {
  durable.dispose();
});

// `preset` is the layout the render walks — the floor unless a test names one.
function buildRuntime(
  src: string,
  sessionState = new SessionState(),
  preset?: string,
) {
  const config = parseAndValidate("<test>", src, ALLOWED);
  durable.seedOrigin(sessionState, SID);
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { cwd: process.cwd() });
  const render = (): string =>
    renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: SID, project_dir: "/tmp/proj" },
      {
        endcaps: "powerline" as const,
        colorCompatibility: "truecolor" as const,
        wrap: true,
        padding: 0,
        charset: "unicode" as const,
        width: 200,
      },
      undefined,
      { preset },
    );
  // The config a click reads, re-read from the file on a reload — as the
  // daemon's render cache does.
  let current = config;
  const ctx: VerbContext = {
    ...testVerbContext(sessionState, durable.historyFor(sessionState)),
    configFor: () => current,
    reloadConfig: () => {
      current = parseAndValidate("<reloaded>", durable.text()!, ALLOWED);
    },
  };
  const click = (url: string): void => {
    const { verb, value } = parseHandlerUrl(url);
    const effects =
      verb === VERB_DISPATCH ? parseEffects(value) : [{ verb, value }];
    for (const e of effects) VERBS.get(e.verb)!(e.value, ctx);
  };
  // A link whose click writes `value` to `key` — or, for a stepper
  // (`step-state`), steps `key` by `value`. A carousel over two words draws
  // the other one behind both its arrows, so there may be more than one; they
  // are one click.
  const urlWriting = (out: string, key: string, value: string): string => {
    const hits = new Set(
      linkUrls(out).filter((u) =>
        effectsOf(u).some((e) => e.args[1] === key && e.args[2] === value),
      ),
    );
    expect(hits.size).toBe(1);
    return [...hits][0]!;
  };
  return { config, sessionState, render, click, urlWriting, ctx };
}

const draftKey = (id: string, setting: string): string =>
  placementDraftKey("default", id, setting);

// The configure links: each writes the configure key to a placement.
const configureUrls = (out: string): string[] =>
  linkUrls(out).filter((u) =>
    effectsOf(u).some(
      (e) =>
        e.args[1] === EDIT_CONFIGURE_KEY && e.args[2] !== DISCLOSURE_CLOSED,
    ),
  );

function placementOf(config: DslConfig, id: string): SegmentNode {
  const node = [...walkNodes(presetRoot(config, "default").node)].find(
    (n): n is SegmentNode =>
      n.kind === "segment" && n.name === "vcs" && placementId(n) === id,
  );
  expect(node).toBeDefined();
  return node!;
}

describe("configure mode: one placement's settings at a time", () => {
  test("arrange mode offers ⚙ on every placement — theme is a setting each one has", () => {
    durable.write(SRC);
    const rt = buildRuntime(SRC);
    expect(configureUrls(rt.render())).toEqual([]);
    rt.sessionState.set(SID, EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    const urls = configureUrls(rt.render());
    // Two placements of `vcs`, and `plain`, which declares nothing but still
    // has `theme` (brandon-settings-menu-6c5). Each ⚙ is drawn in
    // the label and the live view, so a placement's url shows up once per view
    // it is drawn in — one member per placement is what counts.
    const members = new Set(
      urls.flatMap((u) => effectsOf(u).map((e) => e.args[2])),
    );
    expect(members).toEqual(
      new Set([
        configureMember("default", "vcs"),
        configureMember("default", "vcs2"),
        configureMember("default", "plain"),
      ]),
    );
    expect(stripAnsi(rt.render())).toContain(CONFIGURE_GLYPH);
  });

  test("configuring keeps arrange's chrome, shows the live bar, and hangs only that placement's controls", () => {
    durable.write(SRC);
    const rt = buildRuntime(SRC);
    rt.sessionState.set(SID, EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    const arranged = rt.render();
    const [first] = configureUrls(arranged).filter((u) =>
      effectsOf(u).some(
        (e) => e.args[2] === configureMember("default", "vcs2"),
      ),
    );
    rt.click(first!);
    expect(rt.sessionState.get(SID, EDIT_MODE_KEY)).toBe(EDIT_MODE_ARRANGE);
    expect(rt.sessionState.get(SID, EDIT_CONFIGURE_KEY)).toBe(
      configureMember("default", "vcs2"),
    );
    const configuring = rt.render();
    const text = stripAnsi(configuring);
    for (const glyph of [ADD_GLYPH, REMOVE_GLYPH, CONFIGURE_GLYPH]) {
      expect(text).toContain(glyph);
    }
    // Every cell renders its live output…
    expect(text).toContain("d-short-2");
    expect(text).toContain("d-long-2");
    expect(text).toContain("plain");
    // …and vcs2's controls, one per setting, hang below it — its own values.
    expect(text).toContain("☐ detail");
    expect(text).toContain("form ◀ long ▶");
    expect(text).toMatch(/◀ depth 2 ▶/);
    expect(text.match(/☐ detail|☑ detail/g)).toHaveLength(1);

    // Configuring the other placement — through the ⚙ still on the bar —
    // REPLACES this one: one key, one value.
    const [other] = configureUrls(configuring).filter((u) =>
      effectsOf(u).some((e) => e.args[2] === configureMember("default", "vcs")),
    );
    rt.click(other!);
    const again = stripAnsi(rt.render());
    expect(again).toContain("form ◀ short ▶");
    expect(again).not.toContain("form ◀ long ▶");
    expect(again.match(/☐ detail|☑ detail/g)).toHaveLength(1);
  });

  test("each generated control writes its setting's draft, and only its placement changes", () => {
    durable.write(SRC);
    const rt = buildRuntime(SRC);
    configurePlacement(rt.sessionState, SID, "default", "vcs2");
    // The flag toggles, the word carousel picks, the stepper steps and wraps.
    rt.click(rt.urlWriting(rt.render(), draftKey("vcs2", "detail"), "true"));
    rt.click(rt.urlWriting(rt.render(), draftKey("vcs2", "form"), "short"));
    rt.click(rt.urlWriting(rt.render(), draftKey("vcs2", "depth"), "1"));
    const text = stripAnsi(rt.render());
    expect(text).toContain("D-short-3");
    expect(text).toContain("☑ detail");
    expect(text).toContain("form ◀ short ▶");
    expect(text).toMatch(/◀ depth 3 ▶/);
    // The bare placement of the same segment is untouched.
    expect(text).toContain("d-short-2");
    // The stepper wraps inside its declared range, never past it.
    rt.click(rt.urlWriting(rt.render(), draftKey("vcs2", "depth"), "1"));
    expect(stripAnsi(rt.render())).toContain("D-short-1");
    rt.click(rt.urlWriting(rt.render(), draftKey("vcs2", "depth"), "-1"));
    expect(stripAnsi(rt.render())).toContain("D-short-3");
  });

  test("a control's gate is its declared domain", () => {
    durable.write(SRC);
    const rt = buildRuntime(SRC);
    const gate = stateGate(rt.config);
    // A range gate clamps into the declared range rather than refusing.
    expect(gate.validate(draftKey("vcs2", "depth"), "4")).toEqual({
      ok: true,
      value: "3",
    });
    expect(gate.validate(draftKey("vcs2", "form"), "medium").ok).toBe(false);
    expect(gate.validate(draftKey("vcs2", "detail"), "yes").ok).toBe(false);
    // The configure key admits closed and one member per placement — never
    // one naming no placement of this preset.
    expect(
      gate.validate(EDIT_CONFIGURE_KEY, configureMember("default", "plain")).ok,
    ).toBe(true);
    expect(gate.validate(EDIT_CONFIGURE_KEY, DISCLOSURE_CLOSED).ok).toBe(true);
    expect(
      gate.validate(EDIT_CONFIGURE_KEY, configureMember("default", "absent"))
        .ok,
    ).toBe(false);
  });

  test("the body's ✕ returns to arranging", () => {
    durable.write(SRC);
    const rt = buildRuntime(SRC);
    configurePlacement(rt.sessionState, SID, "default", "vcs");
    // One control per row — detail, form, depth, theme — and the body leads
    // with one ✕. It writes the configure key alone; `✎ done` closes it too,
    // as part of leaving edit mode.
    const closes = linkUrls(rt.render()).filter((u) => {
      const effects = effectsOf(u);
      return (
        effects.length === 1 &&
        effects[0]!.args[1] === EDIT_CONFIGURE_KEY &&
        effects[0]!.args[2] === DISCLOSURE_CLOSED
      );
    });
    expect(closes).toHaveLength(1);
    rt.click(closes[0]!);
    expect(rt.sessionState.get(SID, EDIT_CONFIGURE_KEY)).toBe(
      DISCLOSURE_CLOSED,
    );
    expect(rt.sessionState.get(SID, EDIT_MODE_KEY)).toBe(EDIT_MODE_ARRANGE);
    const after = stripAnsi(rt.render());
    expect(after).not.toContain("form ◀");
    expect(after).toContain(CONFIGURE_GLYPH);
  });

  test("edit mode's ✓ save writes the configured placement's picks, then leaves", () => {
    durable.write(SRC);
    const rt = buildRuntime(SRC);
    configurePlacement(rt.sessionState, SID, "default", "vcs");
    rt.click(rt.urlWriting(rt.render(), draftKey("vcs", "depth"), "1"));
    const save = linkUrls(rt.render()).find((u) => {
      const effects = effectsOf(u);
      return (
        effects.some((e) => e.verb === VERB_SAVE) &&
        effects.some(
          (e) => e.args[1] === EDIT_MODE_KEY && e.args[2] === DISCLOSURE_CLOSED,
        )
      );
    });
    expect(save).toBeDefined();
    rt.click(save!);
    expect(durable.text()).toContain(`{ seg: "vcs", settings: { depth: 3 } }`);
    expect(rt.sessionState.get(SID, draftKey("vcs", "depth"))).toBeNull();
    expect(rt.sessionState.get(SID, EDIT_MODE_KEY)).toBe(DISCLOSURE_CLOSED);
  });

  test("✎ done leaves edit mode and closes the settings left open", () => {
    durable.write(SRC);
    const rt = buildRuntime(SRC);
    configurePlacement(rt.sessionState, SID, "default", "vcs");
    const done = linkUrls(rt.render()).find((u) =>
      effectsOf(u).some(
        (e) => e.args[1] === EDIT_MODE_KEY && e.args[2] === DISCLOSURE_CLOSED,
      ),
    );
    rt.click(done!);
    expect(rt.sessionState.get(SID, EDIT_MODE_KEY)).toBe(DISCLOSURE_CLOSED);
    expect(rt.sessionState.get(SID, EDIT_CONFIGURE_KEY)).toBe(
      DISCLOSURE_CLOSED,
    );
    // Arranging again starts with nothing configured.
    rt.sessionState.set(SID, EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    expect(stripAnsi(rt.render())).not.toContain("form ◀");
  });

  test("a pick the declaration does not admit reads as no pick", () => {
    durable.write(SRC);
    const rt = buildRuntime(SRC);
    rt.sessionState.set(SID, draftKey("vcs2", "depth"), "9");
    rt.sessionState.set(SID, draftKey("vcs2", "form"), "medium");
    expect(stripAnsi(rt.render())).toContain("d-long-2");
    expect(
      placementDrafts(rt.config, (k) => rt.sessionState.get(SID, k)),
    ).toEqual([]);
  });
});

describe("configure mode's drafts are saved into the placement", () => {
  test("a draft is counted until save writes it into its placement, bare or not", () => {
    durable.write(SRC);
    const rt = buildRuntime(SRC);
    const drafts = () =>
      placementDrafts(rt.config, (k) => rt.sessionState.get(SID, k));
    configurePlacement(rt.sessionState, SID, "default", "vcs2");
    rt.click(rt.urlWriting(rt.render(), draftKey("vcs2", "detail"), "true"));
    // Writing a value back to what the file already says is no draft.
    rt.click(rt.urlWriting(rt.render(), draftKey("vcs2", "form"), "short"));
    rt.click(rt.urlWriting(rt.render(), draftKey("vcs2", "form"), "long"));
    configurePlacement(rt.sessionState, SID, "default", "vcs");
    rt.click(rt.urlWriting(rt.render(), draftKey("vcs", "depth"), "1"));
    expect(drafts()).toEqual([
      {
        preset: "default",
        id: "vcs",
        setting: "depth",
        key: draftKey("vcs", "depth"),
        value: 3,
      },
      {
        preset: "default",
        id: "vcs2",
        setting: "detail",
        key: draftKey("vcs2", "detail"),
        value: true,
      },
    ]);

    const logged: string[] = [];
    VERBS.get(VERB_SAVE)!(SID, {
      ...rt.ctx,
      dlog: (_level, message) => logged.push(message),
    });
    // The save's one event names every placement value it wrote.
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("default/vcs.settings.depth=3");
    expect(logged[0]).toContain("default/vcs2.settings.detail=true");

    // Released: the session holds no pick, and follows the file again.
    expect(rt.sessionState.get(SID, draftKey("vcs", "depth"))).toBeNull();
    expect(rt.sessionState.get(SID, draftKey("vcs2", "detail"))).toBeNull();
    // The file holds each value in its own placement; the bare ref took the
    // spelling that carries values, and everything else is byte-for-byte.
    const saved = durable.text()!;
    expect(saved).toContain(`{ seg: "vcs", settings: { depth: 3 } }`);
    expect(saved).toContain(
      `{ seg: 'vcs', id: 'vcs2', settings: { form: 'long', detail: true } }`,
    );
    const reloaded = parseAndValidate("<saved>", saved, ALLOWED);
    expect(placementOf(reloaded, "vcs").settings).toEqual({ depth: 3 });
    expect(placementOf(reloaded, "vcs2").settings).toEqual({
      form: "long",
      detail: true,
    });
    const after = buildRuntime(saved);
    const text = stripAnsi(after.render());
    expect(text).toContain("d-short-3");
    expect(text).toContain("D-long-2");
  });
});

describe("configure mode survives what a placement's settings do to it", () => {
  // A setting that hides its own placement: the gate reads the very value the
  // toggle writes.
  const HIDING = `{
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
    },
    segments: {
      tag: {
        template: 'TAG',
        when: '{{ .settings.show }}',
        settings: { show: { label: 'show', domain: 'bool', default: true } },
      },
    },
    root: { v: [{ h: ['tag'] }] },
  }`;

  test("the placement being configured shows its controls whatever its own when says", () => {
    durable.write(HIDING);
    const rt = buildRuntime(HIDING);
    configurePlacement(rt.sessionState, SID, "default", "tag");
    rt.click(rt.urlWriting(rt.render(), draftKey("tag", "show"), "false"));
    // The control that turned it off is still there to turn it back on.
    expect(stripAnsi(rt.render())).toContain("☐ show");
    rt.click(rt.urlWriting(rt.render(), draftKey("tag", "show"), "true"));
    expect(stripAnsi(rt.render())).toContain("☑ show");
    // Out of configure mode, the placement's own gate decides again.
    rt.sessionState.set(SID, draftKey("tag", "show"), "false");
    rt.sessionState.set(SID, EDIT_MODE_KEY, DISCLOSURE_CLOSED);
    expect(stripAnsi(rt.render())).not.toContain("TAG");
  });

  test("a label is display text, however it is spelled", () => {
    const src = SRC.replace(`label: 'depth'`, `label: 'max "items" {{ x }}'`);
    durable.write(src);
    const rt = buildRuntime(src);
    configurePlacement(rt.sessionState, SID, "default", "vcs2");
    expect(stripAnsi(rt.render())).toContain(`◀ max "items" {{ x }} 2 ▶`);
  });

  test("a preset named like edit mode's own state still renders its controls", () => {
    const src = SRC.replace(
      "globals: {},",
      "globals: { preset: 'mode' }, presets: { mode: { root: { v: [{ h: [{ seg: 'vcs', id: 'vcs2' }] }] } } },",
    );
    durable.write(src);
    const rt = buildRuntime(src, new SessionState(), "mode");
    configurePlacement(rt.sessionState, SID, "mode", "vcs2");
    const text = stripAnsi(rt.render());
    expect(text).toMatch(/◀ depth 2 ▶/);
    expect(text).not.toContain("⚠");
  });
});

describe("placement drafts are settings, to undo and to save as a preset", () => {
  test("a configure pick is one undo step, and an undone save brings the draft back", () => {
    durable.write(SRC);
    const rt = buildRuntime(SRC);
    configurePlacement(rt.sessionState, SID, "default", "vcs2");
    rt.click(rt.urlWriting(rt.render(), draftKey("vcs2", "detail"), "true"));
    VERBS.get(VERB_UNDO)!(SID, rt.ctx);
    expect(rt.sessionState.get(SID, draftKey("vcs2", "detail"))).toBeNull();

    rt.click(rt.urlWriting(rt.render(), draftKey("vcs2", "detail"), "true"));
    VERBS.get(VERB_SAVE)!(SID, rt.ctx);
    expect(rt.sessionState.get(SID, draftKey("vcs2", "detail"))).toBeNull();
    VERBS.get(VERB_UNDO)!(SID, rt.ctx);
    expect(durable.text()).toBe(SRC);
    expect(rt.sessionState.get(SID, draftKey("vcs2", "detail"))).toBe("true");
  });

  test("save as preset writes the placement's draft into the new preset and releases it", () => {
    // A preset that stages its own layout, so the new preset's copy of it is
    // its own and the preset it was copied from keeps the file's value.
    const src = SRC.replace(
      "globals: {},",
      "globals: { preset: 'p' }, presets: { p: { root: { v: [{ h: [{ seg: 'vcs', id: 'vcs2', settings: { form: 'long' } }] }] } } },",
    );
    durable.write(src);
    const rt = buildRuntime(src, new SessionState(), "p");
    const key = placementDraftKey("p", "vcs2", "detail");
    configurePlacement(rt.sessionState, SID, "p", "vcs2");
    rt.click(rt.urlWriting(rt.render(), key, "true"));
    VERBS.get(VERB_SAVE_PRESET)!(SID, rt.ctx);
    expect(rt.sessionState.get(SID, key)).toBeNull();
    const saved = parseAndValidate("<saved>", durable.text()!, ALLOWED);
    const settingsIn = (preset: string) =>
      [...walkNodes(presetRoot(saved, preset).node)].find(
        (n): n is SegmentNode =>
          n.kind === "segment" && placementId(n) === "vcs2",
      )?.settings;
    expect(settingsIn("custom-1")).toEqual({ form: "long", detail: true });
    expect(settingsIn("p")).toEqual({ form: "long" });
  });

  // The layout a preset shares with others — the file's own `root`, as one
  // tree or by named row — is copied into the new preset before a value lands
  // in it, so saving as a preset changes no other preset.
  test.each([
    ["a whole-tree root", SRC],
    [
      "a root of named rows",
      SRC.replace("root: { v: [", "root: { rows: { main: ").replace(
        /\] \},\n  \] \},\n\}/,
        "] },\n  } },\n}",
      ),
    ],
  ])(
    "save as preset from %s leaves the preset it copied untouched",
    (_label, src) => {
      durable.write(src);
      const rt = buildRuntime(src);
      configurePlacement(rt.sessionState, SID, "default", "vcs2");
      rt.click(rt.urlWriting(rt.render(), draftKey("vcs2", "detail"), "true"));
      VERBS.get(VERB_SAVE_PRESET)!(SID, rt.ctx);
      const saved = parseAndValidate("<saved>", durable.text()!, ALLOWED);
      const settingsIn = (preset: string) =>
        [...walkNodes(presetRoot(saved, preset).node)].find(
          (n): n is SegmentNode =>
            n.kind === "segment" && placementId(n) === "vcs2",
        )?.settings;
      expect(settingsIn("custom-1")).toEqual({ form: "long", detail: true });
      expect(settingsIn("default")).toEqual({ form: "long" });
    },
  );

  test("removing a placement releases its unsaved values", () => {
    durable.write(SRC);
    const rt = buildRuntime(SRC);
    configurePlacement(rt.sessionState, SID, "default", "vcs");
    rt.click(rt.urlWriting(rt.render(), draftKey("vcs", "detail"), "true"));
    rt.sessionState.set(SID, EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    const remove = rt.urlWriting(
      rt.render(),
      presetRootKey("default"),
      encodeLayoutOp({ op: "remove", target: "vcs" }),
    );
    rt.click(remove);
    expect(rt.sessionState.get(SID, draftKey("vcs", "detail"))).toBeNull();
    // The configure key named it, so it ends with it: a later placement that
    // takes the id opens with nothing configured.
    expect(rt.sessionState.get(SID, EDIT_CONFIGURE_KEY)).toBeNull();
    // One click, one step: its undo brings the placement and its draft back.
    VERBS.get(VERB_UNDO)!(SID, rt.ctx);
    expect(durable.text()).toBe(SRC);
    expect(rt.sessionState.get(SID, draftKey("vcs", "detail"))).toBe("true");
  });

  test.each([
    ["a placement this tree does not hold", "default", "gone"],
    ["another preset's placement", "other", "vcs"],
  ])(
    "a configure key naming %s leaves the names view",
    (_label, preset, id) => {
      durable.write(SRC);
      const rt = buildRuntime(SRC);
      configurePlacement(rt.sessionState, SID, preset, id);
      const text = stripAnsi(rt.render());
      expect(text).toContain("vcs2");
      expect(text).not.toContain("d-short-2");
    },
  );

  test("every control that leaves edit mode closes the configured placement", () => {
    durable.write(SRC);
    const rt = buildRuntime(SRC);
    configurePlacement(rt.sessionState, SID, "default", "vcs2");
    // The menu's own ✎ control sits in its layout tab.
    rt.sessionState.set(SID, SETTINGS_ANCHOR, SETTINGS_OPEN);
    rt.sessionState.set(SID, "candybar.tab", "layout");
    const leaving = linkUrls(rt.render()).filter((u) =>
      effectsOf(u).some(
        (e) => e.args[1] === EDIT_MODE_KEY && e.args[2] === DISCLOSURE_CLOSED,
      ),
    );
    // ✎ done on the bar and ✎ in the menu.
    expect(new Set(leaving).size).toBe(2);
    for (const url of leaving) {
      expect(
        effectsOf(url).some(
          (e) =>
            e.args[1] === EDIT_CONFIGURE_KEY && e.args[2] === DISCLOSURE_CLOSED,
        ),
      ).toBe(true);
    }
  });

  test("an enclosing row's gate does not hide the placement being configured", () => {
    const src = SRC.replace(
      "  root: { v: [\n    { h: [",
      "  root: { v: [\n    { when: '{{ eq 1 2 }}', h: [",
    );
    expect(src).not.toBe(SRC);
    durable.write(src);
    const rt = buildRuntime(src);
    expect(stripAnsi(rt.render())).not.toContain("d-long-2");
    configurePlacement(rt.sessionState, SID, "default", "vcs2");
    expect(stripAnsi(rt.render())).toContain("form ◀ long ▶");
  });

  test("a preset whose name leads with a digit renders its stepper", () => {
    const src = SRC.replace(
      "globals: {},",
      "globals: {}, presets: { '2col': {} },",
    );
    durable.write(src);
    const rt = buildRuntime(src, new SessionState(), "2col");
    configurePlacement(rt.sessionState, SID, "2col", "vcs2");
    const text = stripAnsi(rt.render());
    expect(text).toMatch(/◀ depth 2 ▶/);
    expect(text).not.toContain("⚠");
  });

  test("configure mode names its preset: another preset's placement of the id stays closed", () => {
    const src = SRC.replace("globals: {},", "globals: {}, presets: { b: {} },");
    durable.write(src);
    const rt = buildRuntime(src, new SessionState(), "b");
    configurePlacement(rt.sessionState, SID, "default", "vcs2");
    expect(stripAnsi(rt.render())).not.toContain("form:");
    configurePlacement(rt.sessionState, SID, "b", "vcs2");
    expect(stripAnsi(rt.render())).toContain("form ◀ long ▶");
  });

  test("a removal from a row two presets share ends both presets' drafts, and says so", () => {
    // `b` stages the config's own root, so it renders the row `default` does.
    const src = SRC.replace("globals: {},", "globals: {}, presets: { b: {} },");
    durable.write(src);
    const rt = buildRuntime(src);
    const inB = placementDraftKey("b", "vcs", "detail");
    rt.sessionState.set(SID, inB, "true");
    rt.sessionState.set(SID, EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    const remove = rt.urlWriting(
      rt.render(),
      presetRootKey("default"),
      encodeLayoutOp({ op: "remove", target: "vcs" }),
    );
    const logged: string[] = [];
    const { verb, value } = parseHandlerUrl(remove);
    const [effect] =
      verb === VERB_DISPATCH ? parseEffects(value) : [{ verb, value }];
    VERBS.get(effect!.verb)!(effect!.value, {
      ...rt.ctx,
      dlog: (_level, message) => logged.push(message),
    });
    expect(rt.sessionState.get(SID, inB)).toBeNull();
    expect(logged.join("\n")).toContain(`released=${JSON.stringify([inB])}`);
  });
});
