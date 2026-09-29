// [LAW:verifiable-goals] brandon-segment-settings-i4n.g64 — configure mode,
// driven through the real spine: the real loader and its synthesis, the real
// render, and clicks dispatched through the real daemon verb handlers against
// the derived gates, over a real config file.
//
//   - Edit mode is ONE key: `closed | arrange | configure:<id>`. Configuring a
//     second placement replaces the first; configuring hides arrange's +/-.
//   - In arrange mode a placement whose segment declares settings carries a
//     ⚙; one that declares none carries none.
//   - Configure mode hangs one control per declared setting below that
//     placement, generated from its domain: a toggle, a word cycle, a stepper.
//   - A control writes a draft: only that placement renders it, `💾 save`
//     counts it, and saving writes it INTO the placement in the config file.

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
import {
  deriveActionValidators,
  registerStateValidator,
  validateStateWrite,
} from "../src/daemon/verbs/state-validators";
import {
  deriveConfigActionValidators,
  registerConfigValidator,
} from "../src/daemon/verbs/config-validators";
import {
  configureMember,
  EDIT_MODE_ARRANGE,
  EDIT_MODE_KEY,
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
import { placementDrafts } from "../src/daemon/setting-drafts";
import { DISCLOSURE_CLOSED } from "../src/config/disclosure";
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
  const compiled = registerDslConfig(config, registry);
  const render = (): string =>
    renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: SID, project_dir: "/tmp/proj" },
      {
        style: "powerline" as const,
        colorCompatibility: "truecolor" as const,
        wrap: true,
        padding: 0,
        charset: "unicode" as const,
        width: 200,
      },
      undefined,
      { preset },
    );
  const disposers = [
    ...deriveActionValidators(config).map(({ key, spec }) =>
      registerStateValidator(key, spec),
    ),
    ...deriveConfigActionValidators(config).map(({ key, spec }) =>
      registerConfigValidator(key, spec),
    ),
  ];
  const ctx: VerbContext = {
    ...testVerbContext(sessionState, durable.historyFor(sessionState)),
    configFor: () => config,
  };
  const click = (url: string): void => {
    const { verb, value } = parseHandlerUrl(url);
    const effects =
      verb === VERB_DISPATCH ? parseEffects(value) : [{ verb, value }];
    for (const e of effects) VERBS.get(e.verb)!(e.value, ctx);
  };
  // The one link whose click writes `value` to `key` — or, for a stepper
  // (`step-state`), steps `key` by `value`.
  const urlWriting = (out: string, key: string, value: string): string => {
    const hits = linkUrls(out).filter((u) =>
      effectsOf(u).some((e) => e.args[1] === key && e.args[2] === value),
    );
    expect(hits).toHaveLength(1);
    return hits[0]!;
  };
  const dispose = (): void => disposers.forEach((d) => d());
  return { config, sessionState, render, click, urlWriting, ctx, dispose };
}

const draftKey = (id: string, setting: string): string =>
  placementDraftKey("default", id, setting);

// The configure links: each writes edit mode's key to a configure member.
const configureUrls = (out: string): string[] =>
  linkUrls(out).filter((u) =>
    effectsOf(u).some(
      (e) =>
        e.args[1] === EDIT_MODE_KEY &&
        String(e.args[2]).startsWith(configureMember("")),
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
  test("arrange mode offers ⚙ on exactly the placements whose segment declares settings", () => {
    durable.write(SRC);
    const rt = buildRuntime(SRC);
    expect(configureUrls(rt.render())).toEqual([]);
    rt.sessionState.set(SID, EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    const urls = configureUrls(rt.render());
    // Two placements of `vcs`; `plain` declares nothing. Each ⚙ is drawn in
    // the label and the live view, so a placement's url shows up once per view
    // it is drawn in — one member per placement is what counts.
    const members = new Set(
      urls.flatMap((u) => effectsOf(u).map((e) => e.args[2])),
    );
    expect(members).toEqual(
      new Set([configureMember("vcs"), configureMember("vcs2")]),
    );
    expect(stripAnsi(rt.render())).toContain(CONFIGURE_GLYPH);
    rt.dispose();
  });

  test("configuring hides arrange's chrome and hangs only that placement's controls", () => {
    durable.write(SRC);
    const rt = buildRuntime(SRC);
    rt.sessionState.set(SID, EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    const arranged = rt.render();
    const [first] = configureUrls(arranged).filter((u) =>
      effectsOf(u).some((e) => e.args[2] === configureMember("vcs2")),
    );
    rt.click(first!);
    expect(rt.sessionState.get(SID, EDIT_MODE_KEY)).toBe(
      configureMember("vcs2"),
    );
    const text = stripAnsi(rt.render());
    for (const glyph of [ADD_GLYPH, REMOVE_GLYPH, CONFIGURE_GLYPH]) {
      expect(text).not.toContain(glyph);
    }
    // Every cell renders as it does outside edit mode…
    expect(text).toContain("d-short-2");
    expect(text).toContain("d-long-2");
    expect(text).toContain("plain");
    // …and vcs2's controls, one per setting, hang below it — its own values.
    expect(text).toContain("☐ detail");
    expect(text).toContain("form: long");
    expect(text).toMatch(/◀ depth 2 ▶/);
    expect(text.match(/☐ detail|☑ detail/g)).toHaveLength(1);

    // Configuring the other placement REPLACES this one: one key, one value.
    const [other] = configureUrls(arranged).filter((u) =>
      effectsOf(u).some((e) => e.args[2] === configureMember("vcs")),
    );
    rt.click(other!);
    const again = stripAnsi(rt.render());
    expect(again).toContain("form: short");
    expect(again).not.toContain("form: long");
    expect(again.match(/☐ detail|☑ detail/g)).toHaveLength(1);
    rt.dispose();
  });

  test("each generated control writes its setting's draft, and only its placement changes", () => {
    durable.write(SRC);
    const rt = buildRuntime(SRC);
    rt.sessionState.set(SID, EDIT_MODE_KEY, configureMember("vcs2"));
    // The flag toggles, the word list cycles, the stepper steps and wraps.
    rt.click(rt.urlWriting(rt.render(), draftKey("vcs2", "detail"), "true"));
    rt.click(rt.urlWriting(rt.render(), draftKey("vcs2", "form"), "short"));
    rt.click(rt.urlWriting(rt.render(), draftKey("vcs2", "depth"), "1"));
    const text = stripAnsi(rt.render());
    expect(text).toContain("D-short-3");
    expect(text).toContain("☑ detail");
    expect(text).toContain("form: short");
    expect(text).toMatch(/◀ depth 3 ▶/);
    // The bare placement of the same segment is untouched.
    expect(text).toContain("d-short-2");
    // The stepper wraps inside its declared range, never past it.
    rt.click(rt.urlWriting(rt.render(), draftKey("vcs2", "depth"), "1"));
    expect(stripAnsi(rt.render())).toContain("D-short-1");
    rt.click(rt.urlWriting(rt.render(), draftKey("vcs2", "depth"), "-1"));
    expect(stripAnsi(rt.render())).toContain("D-short-3");
    rt.dispose();
  });

  test("a control's gate is its declared domain", () => {
    durable.write(SRC);
    const rt = buildRuntime(SRC);
    // A range gate clamps into the declared range rather than refusing.
    expect(validateStateWrite(draftKey("vcs2", "depth"), "4")).toEqual({
      ok: true,
      value: "3",
    });
    expect(validateStateWrite(draftKey("vcs2", "form"), "medium").ok).toBe(
      false,
    );
    expect(validateStateWrite(draftKey("vcs2", "detail"), "yes").ok).toBe(
      false,
    );
    // Edit mode's key admits closed, arrange, and a configure member per
    // configurable placement — never one naming a placement with no settings.
    expect(validateStateWrite(EDIT_MODE_KEY, configureMember("vcs2")).ok).toBe(
      true,
    );
    expect(validateStateWrite(EDIT_MODE_KEY, configureMember("plain")).ok).toBe(
      false,
    );
    rt.dispose();
  });

  test("the body's ✕ closes edit mode", () => {
    durable.write(SRC);
    const rt = buildRuntime(SRC);
    rt.sessionState.set(SID, EDIT_MODE_KEY, configureMember("vcs"));
    rt.click(rt.urlWriting(rt.render(), EDIT_MODE_KEY, DISCLOSURE_CLOSED));
    expect(rt.sessionState.get(SID, EDIT_MODE_KEY)).toBe(DISCLOSURE_CLOSED);
    expect(stripAnsi(rt.render())).not.toContain("form:");
    rt.dispose();
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
    rt.dispose();
  });
});

describe("configure mode's drafts are saved into the placement", () => {
  test("a draft is counted until save writes it into its placement, bare or not", () => {
    durable.write(SRC);
    const rt = buildRuntime(SRC);
    const drafts = () =>
      placementDrafts(rt.config, (k) => rt.sessionState.get(SID, k));
    rt.sessionState.set(SID, EDIT_MODE_KEY, configureMember("vcs2"));
    rt.click(rt.urlWriting(rt.render(), draftKey("vcs2", "detail"), "true"));
    // Writing a value back to what the file already says is no draft.
    rt.click(rt.urlWriting(rt.render(), draftKey("vcs2", "form"), "short"));
    rt.click(rt.urlWriting(rt.render(), draftKey("vcs2", "form"), "long"));
    rt.sessionState.set(SID, EDIT_MODE_KEY, configureMember("vcs"));
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
    after.dispose();
    rt.dispose();
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
    rt.sessionState.set(SID, EDIT_MODE_KEY, configureMember("tag"));
    rt.click(rt.urlWriting(rt.render(), draftKey("tag", "show"), "false"));
    // The control that turned it off is still there to turn it back on.
    expect(stripAnsi(rt.render())).toContain("☐ show");
    rt.click(rt.urlWriting(rt.render(), draftKey("tag", "show"), "true"));
    expect(stripAnsi(rt.render())).toContain("☑ show");
    // Out of configure mode, the placement's own gate decides again.
    rt.sessionState.set(SID, draftKey("tag", "show"), "false");
    rt.sessionState.set(SID, EDIT_MODE_KEY, DISCLOSURE_CLOSED);
    expect(stripAnsi(rt.render())).not.toContain("TAG");
    rt.dispose();
  });

  test("a label is display text, however it is spelled", () => {
    const src = SRC.replace(`label: 'depth'`, `label: 'max "items" {{ x }}'`);
    durable.write(src);
    const rt = buildRuntime(src);
    rt.sessionState.set(SID, EDIT_MODE_KEY, configureMember("vcs2"));
    expect(stripAnsi(rt.render())).toContain(`◀ max "items" {{ x }} 2 ▶`);
    rt.dispose();
  });

  test("a preset named like edit mode's own state still renders its controls", () => {
    const src = SRC.replace(
      "globals: {},",
      "globals: { preset: 'mode' }, presets: { mode: { root: { v: [{ h: [{ seg: 'vcs', id: 'vcs2' }] }] } } },",
    );
    durable.write(src);
    const rt = buildRuntime(src, new SessionState(), "mode");
    rt.sessionState.set(SID, EDIT_MODE_KEY, configureMember("vcs2"));
    const text = stripAnsi(rt.render());
    expect(text).toMatch(/◀ depth 2 ▶/);
    expect(text).not.toContain("⚠");
    rt.dispose();
  });
});

describe("placement drafts are settings, to undo and to save as a preset", () => {
  test("a configure pick is one undo step, and an undone save brings the draft back", () => {
    durable.write(SRC);
    const rt = buildRuntime(SRC);
    rt.sessionState.set(SID, EDIT_MODE_KEY, configureMember("vcs2"));
    rt.click(rt.urlWriting(rt.render(), draftKey("vcs2", "detail"), "true"));
    VERBS.get(VERB_UNDO)!(SID, rt.ctx);
    expect(rt.sessionState.get(SID, draftKey("vcs2", "detail"))).toBeNull();

    rt.click(rt.urlWriting(rt.render(), draftKey("vcs2", "detail"), "true"));
    VERBS.get(VERB_SAVE)!(SID, rt.ctx);
    expect(rt.sessionState.get(SID, draftKey("vcs2", "detail"))).toBeNull();
    VERBS.get(VERB_UNDO)!(SID, rt.ctx);
    expect(durable.text()).toBe(SRC);
    expect(rt.sessionState.get(SID, draftKey("vcs2", "detail"))).toBe("true");
    rt.dispose();
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
    rt.sessionState.set(SID, EDIT_MODE_KEY, configureMember("vcs2"));
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
    rt.dispose();
  });
});
