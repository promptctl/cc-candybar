// [LAW:verifiable-goals] Byte-exact coverage of EVERY bundled menu, both states.
// [LAW:dataflow-not-control-flow] Coverage is DERIVED and snapshotted: a new menu
// fails it until covered, so none can be forgotten.

import { createEngine } from "@promptctl/go-template-js";
import { getThemePalette } from "@promptctl/rich-js";

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
import {
  deriveConfigActionValidators,
  registerConfigValidator,
} from "../src/daemon/verbs/config-validators";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { menuPageKey } from "../src/config/menu-keys";
import { EDIT_MODE_KEY, EDIT_NS } from "../src/config/loader/edit-mode";
import {
  DISCLOSURE_CLOSED,
  DISCLOSURE_GLYPH_CLOSED,
  DISCLOSURE_GLYPH_OPEN,
} from "../src/config/disclosure";
import { testVerbContext, effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import { parseEffects, VERB_DISPATCH, VERB_SET_STATE } from "../src/click/wire";
import { VERBS } from "../src/daemon/verbs";
import type { VerbContext } from "../src/daemon/verbs";
import type { DslConfig } from "../src/config/dsl-types";

const ALLOWED = new Set(listResolvablePaletteNames());
const SID = "s1";

const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};

// Static: this file only OPENS disclosures, so no environment reaches the bytes.
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
  look: { effective: "none" },
  style: { effective: "powerline" },
  preset: { effective: "default" },
  charset: { effective: "unicode" },
  colorCompatibility: { effective: "truecolor" },
  autoWrap: { effective: true },
  padding: { effective: 1 },
};

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

interface Link {
  readonly url: string;
  readonly text: string;
}
function links(rendered: string): Link[] {
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\]8;;([^\x1b]+)\x1b\\([\s\S]*?)\x1b\]8;;\x1b\\/g;
  const out: Link[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) {
    out.push({ url: m[1]!, text: stripAnsi(m[2]!) });
  }
  return out;
}

// [LAW:dataflow-not-control-flow] An opener identifies itself by the SHAPE of its
// own click, not a `menus.` prefix a page cursor also carries.
interface Opener extends Link {
  readonly member: string;
}
function menuOpeners(rendered: string): Opener[] {
  return links(rendered).flatMap(({ url, text }) =>
    effectsOf(url)
      .filter(
        (e) =>
          e.verb === VERB_SET_STATE &&
          e.args[3] === menuPageKey(e.args[1] ?? "") &&
          e.args[2] !== DISCLOSURE_CLOSED,
      )
      .map((e) => ({ url, text, member: e.args[2]! })),
  );
}

function buildRuntime(root: string) {
  const config = parseAndValidate(
    "<user>",
    `{ globals: {}, root: ${root} }`,
    ALLOWED,
    DEFAULT_DSL_CONFIG,
  );
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { cwd: "/tmp/proj" });
  const basePalette = getThemePalette("textual-dark");
  const disposers = [
    ...deriveActionValidators(config).map(({ key, spec }) =>
      registerStateValidator(key, spec),
    ),
    ...deriveConfigActionValidators(config).map(({ key, spec }) =>
      registerConfigValidator(key, spec),
    ),
  ];
  const ctx: VerbContext = testVerbContext(sessionState);
  const render = (): string =>
    renderDsl(config, compiled, store, registry, PAYLOAD, basePalette, OPTS);
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
  // [LAW:no-silent-failure] A skipped click would snapshot a closed menu as open.
  const clickLabel = (rendered: string, label: string): void => {
    const link = links(rendered).find((l) => l.text.includes(label));
    if (!link) throw new Error(`no clickable region labelled "${label}"`);
    click(link.url);
  };
  const dispose = (): void => disposers.forEach((d) => d());
  return { config, sessionState, render, click, clickLabel, dispose };
}

// [LAW:single-enforcer] The loader's own authority, not a foolable substring scan.
function hostsMenu(template: string): boolean {
  const engine = createEngine<string>({ fromString: (s) => s });
  try {
    return engine.parse(template).referencedFunctions().has("menu");
  } catch {
    return false;
  }
}
// [LAW:one-type-per-behavior] Edit chrome's `+` is ONE synthesis site, not N menus.
function menuHostingSegments(config: DslConfig): string[] {
  return Object.entries(config.segments)
    .filter(
      ([name, seg]) => !name.startsWith(EDIT_NS) && hostsMenu(seg.template),
    )
    .map(([name]) => name)
    .sort();
}

describe("every {{ menu }} the bundled default renders", () => {
  // The coverage guard: a menu added later lands here and fails until covered.
  test("coverage: the menu-hosting segments of the bundled default", () => {
    const { config, dispose } = buildRuntime(`{ h: ['model'] }`);
    expect(menuHostingSegments(config)).toMatchSnapshot();
    dispose();
  });

  // Each rooted on its own, because a user root omits the group that holds them.
  describe.each([
    ["charsetControl"],
    ["colorCompatControl"],
    ["directoryPaletteControl"],
  ])("%s", (segName) => {
    test("closed, then open: exact bytes", () => {
      const { render, click, dispose } = buildRuntime(`{ h: ['${segName}'] }`);
      const closed = render();
      expect(closed).toMatchSnapshot("closed");

      const openers = menuOpeners(closed);
      expect(openers).toHaveLength(1);
      click(openers[0]!.url);
      expect(render()).toMatchSnapshot("open");
      dispose();
    });
  });

  // They share one accordion key, so each open state needs its own runtime.
  const openConfigMenu = () => {
    const rig = buildRuntime(`{ h: ['directory', 'model'] }`);
    rig.clickLabel(rig.render(), "☰");
    rig.clickLabel(rig.render(), "config");
    return rig;
  };

  test("the config menu with all four pickers closed: exact bytes", () => {
    const rig = openConfigMenu();
    const out = rig.render();
    expect(
      menuOpeners(out)
        .map((o) => o.member)
        .sort(),
    ).toMatchSnapshot("openable members");
    expect(out).toMatchSnapshot("closed");
    rig.dispose();
  });

  describe("edit mode's + insert affordances", () => {
    const editRig = () => {
      const rig = buildRuntime(`{ h: ['directory', 'model'] }`);
      rig.sessionState.set(SID, EDIT_MODE_KEY, "open");
      return rig;
    };

    test("closed: exact bytes of the whole edit-mode bar", () => {
      const rig = editRig();
      const out = rig.render();
      // No disclosure glyph may ride beside a `+`, in either state.
      const row0 = stripAnsi(out).split("\n")[0]!;
      expect(row0).toContain("+");
      expect(row0).not.toContain(`+${DISCLOSURE_GLYPH_CLOSED}`);
      expect(row0).not.toContain(`+${DISCLOSURE_GLYPH_OPEN}`);
      expect(out).toMatchSnapshot("closed");
      rig.dispose();
    });

    test("one + opened: exact bytes", () => {
      const rig = editRig();
      const opener = menuOpeners(rig.render()).find((o) =>
        o.member.startsWith(EDIT_NS),
      );
      if (!opener) throw new Error("edit mode rendered no + opener");
      rig.click(opener.url);
      const out = rig.render();
      expect(stripAnsi(out).split("\n")[0]!).not.toContain(
        `+${DISCLOSURE_GLYPH_OPEN}`,
      );
      expect(out).toMatchSnapshot("open");
      rig.dispose();
    });

    // [LAW:verifiable-goals] Only a per-state display answers "which `+` is open".
    test("an opened + is distinguishable from its unopened siblings", () => {
      const rig = editRig();
      const openers = menuOpeners(rig.render()).filter((o) =>
        o.member.startsWith(EDIT_NS),
      );
      expect(openers.length).toBeGreaterThan(1);

      const closedRow = stripAnsi(rig.render()).split("\n")[0]!;
      rig.click(openers[0]!.url);
      const openRow = stripAnsi(rig.render()).split("\n")[0]!;
      expect(openRow).not.toBe(closedRow);
      rig.dispose();
    });
  });

  test("each picker control, opened: exact bytes", () => {
    const members = (() => {
      const rig = openConfigMenu();
      const found = menuOpeners(rig.render()).map((o) => o.member);
      rig.dispose();
      return found;
    })();
    expect(members.length).toBeGreaterThan(0);

    for (const member of members) {
      const rig = openConfigMenu();
      const opener = menuOpeners(rig.render()).find((o) => o.member === member);
      if (!opener) throw new Error(`opener for "${member}" vanished`);
      rig.click(opener.url);
      expect(rig.render()).toMatchSnapshot(member);
      rig.dispose();
    }
  });
});
