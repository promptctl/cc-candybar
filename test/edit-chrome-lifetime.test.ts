// [LAW:verifiable-goals] Edit chrome's state — the ✚ libraries, the
// configure list, and their page cursors — lives and dies with the edit
// transaction that shows it, driven through the real click path and render:
// the real loader and its synthesis, clicks through the real verb handlers
// against the derived gates, over a real config file.
//
//   - A layout step that ends a placement drops its chrome in that step, so a
//     placement that takes its id again opens with every menu closed.
//   - Closing the transaction, by any route, drops every chrome key.
//   - Opening one drops what a restart left in the store.
//   - Undo of a removal brings its drafts back, not its open menus.
//   - An author's own `{{ menu }}` is not edit chrome, and survives.

import type { Frame } from "../src/render/frame";
import { textOf } from "../src/render/frame";
import { linkUrls } from "./helpers/frame";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { SessionState } from "../src/renderer/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import {
  bookedContext,
  clickUrl,
  CLICK_VERBS,
  effectsOf,
  testVerbContext,
  verbContextWith,
} from "./helpers/click";
import { drawPayload } from "./helpers/draw-payload";
import { TEST_SIGNER } from "./helpers/link-signer";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig } from "../src/dsl/render";
import { systemTimekeeper } from "../src/time";
import { instantOf } from "../src/utils/instant";
import { closeIdleMenus, type VerbContext } from "../src/renderer/verbs";
import {
  VERB_APPLY_LAYOUT_OP,
  VERB_REWIND,
  VERB_SAVE,
  VERB_UNDO,
} from "../src/click/wire";
import {
  configureMember,
  EDIT_CONFIGURE_KEY,
  EDIT_MODE_ARRANGE,
  EDIT_MODE_KEY,
} from "../src/config/loader/edit-mode";
import {
  insertGap,
  placementChromeKeys,
  placementDraftKey,
} from "../src/config/edit-chrome";
import { encodeLayoutOp, type LayoutOp } from "../src/config/layout-ops";
import { presetRootKey } from "../src/config/loader/persist-target";
import { DISCLOSURE_CLOSED } from "../src/config/disclosure";
import { SETTINGS_ANCHOR, SETTINGS_OPEN } from "../src/config/settings-menu";
import {
  menuPageKey,
  menuStateKey,
  sharedMenuStateKey,
} from "../src/config/menu-keys";
import { durableConfig, type DurableConfig } from "./helpers/durable-config";
import {
  sessionIdOf,
  type SessionId,
} from "../src/daemon/foundations/session-id";

type ValidatedConfig = ReturnType<typeof parseAndValidate>;

const ALLOWED = new Set(listResolvablePaletteNames());
const SID = sessionIdOf("s1");

// Two placements, one with a setting whose picker opens a list, and an
// author's own menu outside the edited row.
const SRC = `{
  globals: {},
  variables: {
    sortOrder: { kind: 'state', key: 'sort-order', default: 'asc' },
  },
  actions: {
    applySort: { set: 'sort-order', from: ['asc', 'desc'] },
  },
  segments: {
    vcs: {
      template: 'vcs-{{ .settings.form }}',
      settings: { form: { label: 'form', domain: ['short', 'long'], default: 'short' } },
    },
    plain: { template: 'plain' },
    sortControl: { template: 'sort {{ menu "applySort" "▸" "▾" }}' },
  },
  root: { v: [ { h: [ 'vcs', 'plain' ] }, 'sortControl' ] },
}
`;

// The ✚ after `plain`, the configure list of `vcs`, and the author's menu.
const PLAIN_GAP = insertGap("default", "plain", "after");
const VCS_GAP = insertGap("default", "vcs", "after");
const VCS_LIST = sharedMenuStateKey("edit.default.configure.vcs");
const AUTHOR_MENU = menuStateKey("sortControl", "applySort", undefined);

let durable: DurableConfig;
beforeEach(() => {
  durable = durableConfig("cc-candybar-chrome-life-");
});
const disposals: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  durable.dispose();
});

// The bar over `sessionState`, drawn as the daemon draws it: from the open
// draft's config while a transaction is open and from the file otherwise,
// through the transactions' own view of the session, with its history depth
// in the payload.
function editBar(sessionState = new SessionState()) {
  durable.seedOrigin(sessionState, SID);
  const history = durable.historyFor(sessionState);
  const base = testVerbContext(sessionState, history, undefined, durable.host);
  const origin = bookedContext(sessionState, SID)!.durable.origin;
  let loaded = "";
  let config!: ValidatedConfig;
  let store!: VariableStore;
  let registry: SourceRegistry | null = null;
  let compiled!: ReturnType<typeof registerDslConfig>;
  const effective = (): ValidatedConfig => {
    const draft = base.edits
      .snapshot(origin, SID)
      ?.chain.find((layer) => layer.role === "user")?.content;
    const text = draft?.kind === "text" ? draft.text : durable.text()!;
    if (text !== loaded) {
      loaded = text;
      config = parseAndValidate("<test>", text, ALLOWED);
      registry?.dispose();
      store = new VariableStore(systemTimekeeper);
      registry = new SourceRegistry(store, "", base.edits.view);
      compiled = registerDslConfig(config, registry, {
        signer: TEST_SIGNER,
        cwd: process.cwd(),
      });
    }
    return config;
  };
  const render = (): Frame =>
    drawPayload(
      effective(),
      compiled,
      store,
      registry!,
      {
        session_id: SID,
        project_dir: "/tmp/proj",
        history: base.edits.depth(SID, history),
      },
      instantOf(new Date()),
      {
        endcaps: "powerline",
        colorCompatibility: "truecolor",
        wrap: true,
        padding: 0,
        width: Number.POSITIVE_INFINITY,
      },
    ).frame;
  const ctx: VerbContext = verbContextWith(base, { configFor: effective });
  disposals.push(() => registry?.dispose());
  // The one link whose effects match, clicked.
  const clickWhere = async (
    matches: (e: ReturnType<typeof effectsOf>[number]) => boolean,
  ): Promise<void> => {
    const urls = [
      ...new Set(linkUrls(render()).filter((u) => effectsOf(u).some(matches))),
    ];
    expect(urls).toHaveLength(1);
    await clickUrl(urls[0]!, ctx);
  };
  const clickWriting = (key: string, value: string): Promise<void> =>
    clickWhere(
      (e) =>
        e.verb !== VERB_APPLY_LAYOUT_OP &&
        e.args[1] === key &&
        e.args[2] === value,
    );
  const layoutOp = (op: LayoutOp): Promise<void> =>
    clickWhere(
      (e) =>
        e.verb === VERB_APPLY_LAYOUT_OP &&
        e.args[2] === presetRootKey("default") &&
        e.args[3] === encodeLayoutOp(op),
    );
  const enter = async (): Promise<void> => {
    sessionState.set(SID, SETTINGS_ANCHOR, SETTINGS_OPEN);
    await clickWriting(EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    expect(ctx.edits.draft(SID)).not.toBeNull();
  };
  // Whether the ✚ after `anchor` shows its library: its options are drawn.
  const libraryOpen = (anchor: string): boolean =>
    linkUrls(render()).some((u) =>
      effectsOf(u).some(
        (e) =>
          e.verb === VERB_APPLY_LAYOUT_OP &&
          e.args[3] ===
            encodeLayoutOp({
              op: "insert",
              segment: "vcs",
              anchor,
              relation: "after",
            }),
      ),
    );
  const openLibrary = async (gap: typeof PLAIN_GAP): Promise<void> => {
    await clickWriting(gap.stateKey, gap.apply);
    expect(sessionState.get(SID, menuPageKey(gap.stateKey))).not.toBeNull();
  };
  // Configure `vcs` and open its form picker's list.
  const openConfigureList = async (): Promise<void> => {
    await clickWriting(EDIT_CONFIGURE_KEY, configureMember("default", "vcs"));
    const opener = linkUrls(render()).find((u) =>
      effectsOf(u).some(
        (e) => e.args[1] === VCS_LIST && e.args[2] !== DISCLOSURE_CLOSED,
      ),
    );
    await clickUrl(opener!, ctx);
    expect(sessionState.get(SID, VCS_LIST)).not.toBe(DISCLOSURE_CLOSED);
    expect(sessionState.get(SID, menuPageKey(VCS_LIST))).not.toBeNull();
  };
  return {
    sessionState,
    ctx,
    render,
    clickWhere,
    clickWriting,
    layoutOp,
    enter,
    libraryOpen,
    openLibrary,
    openConfigureList,
  };
}

// Every chrome key the cases open, each of which must be gone.
const OPENED_CHROME = [
  PLAIN_GAP.stateKey,
  menuPageKey(PLAIN_GAP.stateKey),
  VCS_LIST,
  menuPageKey(VCS_LIST),
  EDIT_CONFIGURE_KEY,
];
const heldChrome = (store: SessionState, sid: SessionId = SID): string[] =>
  OPENED_CHROME.filter((key) => store.get(sid, key) !== null);

describe("a placement's chrome ends with the placement", () => {
  test("(a) removed and re-added in one edit, it opens with its library closed", async () => {
    durable.write(SRC);
    const bar = editBar();
    await bar.enter();
    await bar.openLibrary(PLAIN_GAP);
    expect(bar.libraryOpen("plain")).toBe(true);
    await bar.layoutOp({ op: "remove", target: "plain" });
    // Dropped in the removal's own step, while the transaction stays open.
    expect(bar.sessionState.get(SID, PLAIN_GAP.stateKey)).toBeNull();
    expect(
      bar.sessionState.get(SID, menuPageKey(PLAIN_GAP.stateKey)),
    ).toBeNull();
    await bar.openLibrary(VCS_GAP);
    await bar.layoutOp({
      op: "insert",
      segment: "plain",
      anchor: "vcs",
      relation: "after",
    });
    expect(bar.ctx.edits.draft(SID)).not.toBeNull();
    expect(bar.libraryOpen("plain")).toBe(false);
  });

  test("(b) removed, saved, and re-added in a later edit, it opens with its library closed", async () => {
    durable.write(SRC);
    const bar = editBar();
    await bar.enter();
    await bar.openLibrary(PLAIN_GAP);
    await bar.layoutOp({ op: "remove", target: "plain" });
    await bar.clickWhere((e) => e.verb === VERB_SAVE);
    expect(bar.ctx.edits.draft(SID)).toBeNull();
    await bar.enter();
    await bar.openLibrary(VCS_GAP);
    await bar.layoutOp({
      op: "insert",
      segment: "plain",
      anchor: "vcs",
      relation: "after",
    });
    expect(bar.libraryOpen("plain")).toBe(false);
  });

  test("the chrome keys a placement ends with are those its edit chrome mints", () => {
    const keys = placementChromeKeys("default", "plain");
    expect(keys).toEqual(
      expect.arrayContaining([
        PLAIN_GAP.stateKey,
        menuPageKey(PLAIN_GAP.stateKey),
        insertGap("default", "plain", "before").stateKey,
      ]),
    );
    expect(placementChromeKeys("default", "vcs")).toEqual(
      expect.arrayContaining([VCS_LIST, menuPageKey(VCS_LIST)]),
    );
  });

  test("undo of a removal brings its drafts back, and not its open menus", async () => {
    durable.write(SRC);
    const bar = editBar();
    const draft = placementDraftKey("default", "vcs", "form");
    await bar.enter();
    await bar.openConfigureList();
    await bar.clickWriting(draft, "long");
    await bar.openLibrary(VCS_GAP);
    await bar.layoutOp({ op: "remove", target: "vcs" });
    expect(bar.sessionState.get(SID, draft)).toBeNull();
    expect(bar.ctx.edits.view.get(SID, draft)).toBeNull();
    const chrome = [
      VCS_GAP.stateKey,
      menuPageKey(VCS_GAP.stateKey),
      VCS_LIST,
      menuPageKey(VCS_LIST),
      EDIT_CONFIGURE_KEY,
    ];
    expect(chrome.filter((k) => bar.sessionState.get(SID, k) !== null)).toEqual(
      [],
    );
    await CLICK_VERBS.get(VERB_UNDO)!(SID, bar.ctx);
    expect(textOf(bar.render())).toContain("vcs");
    expect(bar.ctx.edits.view.get(SID, draft)).toBe("long");
    expect(chrome.filter((k) => bar.sessionState.get(SID, k) !== null)).toEqual(
      [],
    );
  });
});

describe("closing a transaction drops its chrome, by every route", () => {
  // Each route out of edit mode, taken from an edit with chrome open.
  const routes: ReadonlyArray<
    [string, (bar: ReturnType<typeof editBar>) => Promise<void> | void]
  > = [
    ["✓ save", (bar) => bar.clickWhere((e) => e.verb === VERB_SAVE)],
    [
      "↩ cancel",
      async (bar) => {
        // Cancel shows once there is a change to discard.
        await bar.clickWriting(
          placementDraftKey("default", "vcs", "form"),
          "long",
        );
        await bar.clickWhere((e) => e.verb === VERB_REWIND);
      },
    ],
    [
      "the edit toggle",
      (bar) => bar.clickWriting(EDIT_MODE_KEY, DISCLOSURE_CLOSED),
    ],
    [
      "closing the settings menu",
      (bar) => bar.clickWriting(SETTINGS_ANCHOR, DISCLOSURE_CLOSED),
    ],
    [
      "the menus' idle close",
      (bar) =>
        closeIdleMenus(
          SID,
          bookedContext(bar.ctx.sessionState, SID),
          { idleS: 30, timeoutS: 30 },
          bar.ctx,
          bar.ctx.effects,
        ),
    ],
    [
      "the session moving to another config origin",
      (bar) => {
        const origin = bar.ctx.edits.draft(SID)!.origin;
        bar.ctx.edits.moved(SID, { ...origin, cwd: `${origin.cwd}/elsewhere` });
      },
    ],
    ["the session retiring", (bar) => bar.ctx.edits.retire(SID)],
  ];

  test.each(routes)("leaving by %s leaves no chrome key", async (_, leave) => {
    durable.write(SRC);
    const bar = editBar();
    await bar.enter();
    await bar.openLibrary(PLAIN_GAP);
    await bar.openConfigureList();
    expect(heldChrome(bar.sessionState)).toEqual(OPENED_CHROME);
    await leave(bar);
    expect(bar.ctx.edits.draft(SID)).toBeNull();
    expect(heldChrome(bar.sessionState)).toEqual([]);
  });

  test("(e) leaving by the toggle drops the library's page cursor, with no removal", async () => {
    durable.write(SRC);
    const bar = editBar();
    await bar.enter();
    await bar.openLibrary(PLAIN_GAP);
    await bar.clickWriting(EDIT_MODE_KEY, DISCLOSURE_CLOSED);
    expect(
      bar.sessionState.get(SID, menuPageKey(PLAIN_GAP.stateKey)),
    ).toBeNull();
    expect(bar.sessionState.get(SID, PLAIN_GAP.stateKey)).toBeNull();
  });

  test("an author's own menu survives the close", async () => {
    durable.write(SRC);
    const bar = editBar();
    await bar.clickWriting(AUTHOR_MENU, "applySort");
    const page = menuPageKey(AUTHOR_MENU);
    const held = () => [
      bar.sessionState.get(SID, AUTHOR_MENU),
      bar.sessionState.get(SID, page),
    ];
    const before = held();
    expect(before[0]).toBe("applySort");
    expect(before[1]).not.toBeNull();
    await bar.enter();
    await bar.clickWriting(EDIT_MODE_KEY, DISCLOSURE_CLOSED);
    expect(bar.ctx.edits.draft(SID)).toBeNull();
    expect(held()).toEqual(before);
  });
});

describe("opening a transaction starts with no chrome", () => {
  test("(d) what a restart mid-edit left in the store opens on nothing", async () => {
    durable.write(SRC);
    const first = editBar();
    await first.enter();
    await first.openLibrary(PLAIN_GAP);
    await first.openConfigureList();
    // The daemon stops mid-edit: the store is saved as it stands, and the next
    // daemon loads it and clears the edit-mode flag, as the renderer starts.
    const [saved] = first.sessionState
      .drain()
      .flatMap((w) =>
        w.store === "session-state" && w.key === SID && w.value !== null
          ? [w.value]
          : [],
      );
    const restarted = new SessionState({ [SID]: saved! });
    restarted.clear(SID, EDIT_MODE_KEY);
    expect(heldChrome(restarted)).toEqual(OPENED_CHROME);
    const bar = editBar(restarted);
    await bar.enter();
    expect(heldChrome(restarted)).toEqual([]);
    expect(bar.libraryOpen("plain")).toBe(false);
    expect(textOf(bar.render())).not.toContain("form");
  });
});

describe("edit chrome's menu namespace is its own", () => {
  test("an authored menu whose placement collapses into it is a load error", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        SRC.replace("sortControl:", "'edit-sort':").replace(
          "'sortControl'",
          "'edit-sort'",
        ),
        ALLOWED,
      ),
    ).toThrow(/namespace edit mode keeps its own menus in/);
  });
});
