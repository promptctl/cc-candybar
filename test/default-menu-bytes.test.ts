// [LAW:verifiable-goals] Byte-exact coverage of EVERY `{{ menu }}` the bundled
// default can render — both disclosure states — so that a change to where a
// menu's trigger glyph comes from is measured, not asserted.
//
// candybar-settings-ui-aok.4 moves the ▸/▾ out of the `{{ menu }}` runtime and
// into the authored template, which is a change no existing test could have
// caught: `test/__snapshots__/dsl-spine.test.ts.snap` holds ONE line, and the
// only glyph in it belongs to an `{{ action }}` disclosure. This file is
// written FIRST, against unchanged code, precisely so the committed bytes are
// evidence rather than a description of the change — a snapshot taken after a
// change agrees with whatever the change did.
//
// Coverage is DERIVED, not listed: `menuHostingSegments` reads the validated
// bundled config and asks the template engine which segments reference the
// helper, and the answer is itself snapshotted. A future bundled menu joins the
// coverage by existing [LAW:dataflow-not-control-flow]; it cannot be forgotten,
// because adding one fails the coverage snapshot until it is acknowledged.
//
// The two reachable families need two roots, for a structural reason:
//   • the drawer controls (charset / colorCompatibility / directory palette)
//     live under the bundled `settingsDrawer` group, which a user `root`
//     deletes — so each is rooted directly, one per case;
//   • the four settings-menu picker controls are SYNTHESIZED into every preset
//     root, so rooting one would place it twice (a load error, by design) —
//     they are reached the way a user reaches them, by clicking ☰ then ⚙.

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
import { effectsOf } from "./helpers/click";
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

// Static effective values: this file only ever OPENS disclosures, never picks
// an option, so the daemon-resolved labels stay fixed for the whole run and the
// committed bytes carry no environment in them.
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

// The OSC-8 spans of a render, paired with the text each one wraps — enough to
// click an affordance by the label a user would click.
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

// [LAW:dataflow-not-control-flow] A menu's opener identifies itself in its own
// click: the disclosure toggle is the coupled batch `renderMenu` emits, so its
// 4th arg is by construction the PAGE key of its 2nd, and its 3rd is a member
// rather than the closed sentinel. Matching that exact shape — rather than the
// `menus.` prefix, which a page-cursor key also carries — keeps a ←/→ page
// click (a 3-arg write, no 4th arg) from reading as an opener on a render where
// a picker is already open. So this test needs to know no key names — the member
// it writes IS the menu's apply-action name, which is also how each snapshot
// below gets its label.
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
  const ctx: VerbContext = { sessionState, dlog: () => {} };
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
  // Click by the label a user clicks. Loud when absent: a silently skipped
  // click would snapshot a closed menu under an "open" name and prove the
  // opposite of what this file claims [LAW:no-silent-failure].
  const clickLabel = (rendered: string, label: string): void => {
    const link = links(rendered).find((l) => l.text.includes(label));
    if (!link) throw new Error(`no clickable region labelled "${label}"`);
    click(link.url);
  };
  const dispose = (): void => disposers.forEach((d) => d());
  return { config, sessionState, render, click, clickLabel, dispose };
}

// [LAW:single-enforcer] "Hosts a menu" is decided by the same authority the
// loader's synthesis pass uses — the parsed template's referenced functions —
// not by a substring scan that a pipeline or a `.menu` field name could fool.
function hostsMenu(template: string): boolean {
  const engine = createEngine<string>({ fromString: (s) => s });
  try {
    return engine.parse(template).referencedFunctions().has("menu");
  } catch {
    return false;
  }
}
// [LAW:one-type-per-behavior] Edit chrome's `+` affordances are excluded from
// the enumerated coverage because they are not N menus to cover — they are ONE
// synthesis site (`insertChrome`) minting an instance per insertion point, so
// their count is a fact about the active preset's segment count rather than
// about the menu surface. One rendered instance is the representative, and it
// gets its own bytes below.
function menuHostingSegments(config: DslConfig): string[] {
  return Object.entries(config.segments)
    .filter(
      ([name, seg]) => !name.startsWith(EDIT_NS) && hostsMenu(seg.template),
    )
    .map(([name]) => name)
    .sort();
}

describe("every {{ menu }} the bundled default renders", () => {
  // The coverage guard. A bundled menu added later lands in this list, and the
  // failing snapshot is the reminder that it wants bytes committed below.
  test("coverage: the menu-hosting segments of the bundled default", () => {
    const { config, dispose } = buildRuntime(`{ h: ['model'] }`);
    expect(menuHostingSegments(config)).toMatchSnapshot();
    dispose();
  });

  // The drawer controls: durable-only settings (terminal capability facts and
  // one segment-scoped palette pin), each rooted on its own because the group
  // that normally holds them is not in a user root.
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

  // The four settings-menu picker controls, reached the way a user reaches
  // them. They share one accordion key, so each open state gets its own
  // runtime — one key holds one open member, and a shared rig would only ever
  // snapshot the last one opened.
  const openConfigMenu = () => {
    const rig = buildRuntime(`{ h: ['directory', 'model'] }`);
    rig.clickLabel(rig.render(), "☰");
    rig.clickLabel(rig.render(), "config");
    return rig;
  };

  test("the config menu with all four pickers closed: exact bytes", () => {
    const rig = openConfigMenu();
    const out = rig.render();
    // Four controls, four closed disclosures — the shape the per-picker cases
    // below each open one of.
    expect(
      menuOpeners(out)
        .map((o) => o.member)
        .sort(),
    ).toMatchSnapshot("openable members");
    expect(out).toMatchSnapshot("closed");
    rig.dispose();
  });

  // [LAW:verifiable-goals] The affordance the ticket is about. These bytes
  // began as the "before" — every `+` rendered `+▸`, a `+` the template wrote
  // beside an arrow the `{{ menu }}` runtime appended — and they are the only
  // ones in this file the change was allowed to move.
  describe("edit mode's + insert affordances", () => {
    const editRig = () => {
      const rig = buildRuntime(`{ h: ['directory', 'model'] }`);
      rig.sessionState.set(SID, EDIT_MODE_KEY, "open");
      return rig;
    };

    test("closed: exact bytes of the whole edit-mode bar", () => {
      const rig = editRig();
      const out = rig.render();
      // Two segments ⇒ three insertion points, each a closed disclosure. The
      // requirement, verbatim: "I'd also prefer the 'plus sign' menus to NOT
      // have the arrow" — so no disclosure glyph rides beside a `+`, in either
      // state, while the settings menu's own `{{ action }}` disclosure keeps
      // the ▸ it has always authored.
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

    // [LAW:verifiable-goals] The regression removing the glyph invites, pinned
    // so it cannot return quietly. A preset's N insertion points render
    // byte-identical rows and drop byte-identical bodies, so if the open one
    // does not LOOK different on row 0, the bar has stopped answering "which
    // `+` did I open" — and it answers only because the trigger binds a display
    // per state. A static display would pass every snapshot above and fail
    // here, which is the point.
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
