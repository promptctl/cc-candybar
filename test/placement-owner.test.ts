// [LAW:verifiable-goals] A placement's session state ends with the
// placement, whatever removes it, in every session, at the next load of the
// chain that placed it, and never touches another chain's placement of the
// same id. Every case runs a real render cache over a real session store and
// real config files, through the verbs a click runs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DiscoveringCache, originOf } from "./helpers/config-host";
import { durableConfig, type DurableConfig } from "./helpers/durable-config";
import {
  CLICK_VERBS,
  onLanded,
  recordRender,
  testVerbContext,
  verbContextWith,
} from "./helpers/click";
import { viewFacts } from "./helpers/view-facts";
import { answerRepo } from "./helpers/repo-approval";
import { bareGates } from "./helpers/gates";
import { NO_PLUGIN_STORAGE } from "./helpers/plugin-storage";
import { TEST_SIGNER } from "./helpers/link-signer";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { locations, stateDir } from "../src/daemon/paths";
import { memoryLimitBytes } from "../src/daemon/limits";
import {
  SOURCES_NOTHING,
  renderCacheBudget,
} from "../src/renderer/render-cache";
import { SessionState } from "../src/renderer/session-state";
import { ownedStore } from "../src/renderer/owned-store";
import { BadVerbArgs, type VerbContext } from "../src/renderer/verbs";
import { encodeLayoutOp } from "../src/config/layout-ops";
import { EDIT_CONFIGURE_KEY } from "../src/config/loader/edit-mode";
import {
  CONFIGURE_LISTS,
  CONFIGURING,
  DRAFTS,
  LIBRARIES,
  chainOwner,
  insertGap,
  type Owner,
  type Placement,
} from "../src/config/placement-keys";
import { DISCLOSURE_CLOSED, DISCLOSURE_OPEN } from "../src/config/disclosure";
import {
  sessionIdOf,
  type SessionId,
} from "../src/daemon/foundations/session-id";
import { systemTimekeeper } from "../src/time";
import type { RenderOrigin } from "../src/config-hint";

const S1 = sessionIdOf("s1");
const S2 = sessionIdOf("s2");
const DIRECTORY: Placement = { preset: "default", id: "directory" };
const MODEL: Placement = { preset: "default", id: "model" };
// An author's own `{{ menu }}` key: no family's, so no load touches it.
const AUTHOR_KEY = "menus.vcs.apply";

// A user file placing two bundled segments, with the `-` action a click fires
// declared, so the derived gate admits exactly that removal.
const USER = (row: string): string => `{
  actions: { rm: { persist: "presets.default.root", removeSegment: "directory" } },
  root: { h: [${row}] },
}
`;
const BOTH = USER(`"directory", "model"`);
const MODEL_ONLY = USER(`"model"`);
const REMOVE_DIRECTORY = encodeLayoutOp({ op: "remove", target: "directory" });

let durable: DurableConfig;
let elsewhere: string;
beforeEach(() => {
  durable = durableConfig("cc-candybar-placement-owner-");
  elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-elsewhere-"));
});
afterEach(() => {
  durable.dispose();
  fs.rmSync(elsewhere, { recursive: true, force: true });
});

function world(sessionState = new SessionState()) {
  const watchers = new WatcherRegistry({
    clock: systemTimekeeper,
    counters: {
      watchersOpened: 0,
      watchersClosed: 0,
      watchRefusals: 0,
      watchErrors: 0,
      dirWatchesOpened: 0,
      dirWatchesClosed: 0,
    },
    logger: () => {},
  });
  const lines: string[] = [];
  const cache = new DiscoveringCache(
    {
      clock: systemTimekeeper,
      stateDir: stateDir(durable.host),
      locations: locations(durable.host),
      storage: NO_PLUGIN_STORAGE,
      signer: TEST_SIGNER,
      gates: bareGates(),
      sessionState,
      watchers,
      source: SOURCES_NOTHING,
      log: (_level, line) => lines.push(line),
    },
    { budgetBytes: () => renderCacheBudget(memoryLimitBytes({})) },
  );
  const at = (dir: string): RenderOrigin => originOf(dir, dir, undefined);
  const home = at(durable.projectDir);
  const ownerOf = (origin: RenderOrigin): Owner =>
    cache.getOrCreate(origin).state.owner;
  // The store as a session rendering `origin` reads and writes it.
  const as = (origin: RenderOrigin) =>
    ownedStore(sessionState, () => ownerOf(origin));
  // Every key a placement owns, held by `sid` as a session rendering
  // `origin` holds them: a draft, the configure list, a ✚ library and the
  // configure key naming it.
  const seed = (origin: RenderOrigin, sid: SessionId, at: Placement): void => {
    const view = as(origin);
    view.set(sid, DRAFTS.mint({ ...at, setting: "detail" }), "true");
    view.set(sid, CONFIGURE_LISTS.mint(at), DISCLOSURE_OPEN);
    view.set(
      sid,
      LIBRARIES.mint({ ...at, relation: "after" }),
      DISCLOSURE_OPEN,
    );
    view.set(sid, EDIT_CONFIGURE_KEY, CONFIGURING.mint(at));
  };
  // What `sid` holds of a placement's keys, read as a session rendering `origin`.
  const held = (origin: RenderOrigin, sid: SessionId, at: Placement) => {
    const view = as(origin);
    return {
      draft: view.get(sid, DRAFTS.mint({ ...at, setting: "detail" })),
      list: view.get(sid, CONFIGURE_LISTS.mint(at)),
      library: view.get(sid, LIBRARIES.mint({ ...at, relation: "after" })),
      configuring: view.get(sid, EDIT_CONFIGURE_KEY) === CONFIGURING.mint(at),
    };
  };
  const NONE = { draft: null, list: null, library: null, configuring: false };
  // The click path, wired as the daemon's: the config and owner a click
  // reads are those of the entry its session last rendered, and a landed
  // click reloads. One path for every session, as the daemon has one
  // navigation history.
  let ctx: VerbContext | undefined;
  const clicker = (origin: RenderOrigin, sid: SessionId): VerbContext => {
    recordRender(sessionState, sid, origin.projectDir);
    if (ctx !== undefined) return ctx;
    ctx = verbContextWith(
      testVerbContext(
        sessionState,
        durable.historyFor(sessionState),
        undefined,
        durable.host,
      ),
      {
        configFor: (o) => cache.getOrCreate(o).state.config,
        ownerFor: (o) => cache.getOrCreate(o).state.owner,
        log: (_level, line) => lines.push(line),
      },
    );
    onLanded(ctx, () => cache.configs.again());
    return ctx;
  };
  const fire = async (
    ctx: VerbContext,
    verb: string,
    ...args: string[]
  ): Promise<void> =>
    await CLICK_VERBS.get(verb)!(args.map(encodeURIComponent).join("/"), ctx);
  const released = (): string[] =>
    lines.filter((l) => l.startsWith("placement-state released"));
  const close = (): void => {
    cache.close();
    watchers.closeAll();
  };
  return {
    cache,
    sessionState,
    at,
    home,
    ownerOf,
    as,
    seed,
    held,
    NONE,
    clicker,
    fire,
    released,
    close,
  };
}

describe("a placement's state ends with it", () => {
  test("a hand edit releases it in every session, an idle one with no view included, and leaves the rest", () => {
    durable.write(BOTH);
    const w = world();
    try {
      w.cache
        .holdSession(w.home, viewFacts(durable.projectDir, "s1"))
        [Symbol.dispose]();
      expect(w.ownerOf(w.home)).toBe(durable.owner);
      for (const sid of [S1, S2]) {
        w.seed(w.home, sid, DIRECTORY);
        w.as(w.home).set(
          sid,
          DRAFTS.mint({ ...MODEL, setting: "detail" }),
          "true",
        );
        w.sessionState.set(sid, AUTHOR_KEY, DISCLOSURE_OPEN);
      }
      durable.write(MODEL_ONLY);
      w.cache.configs.again();
      for (const sid of [S1, S2]) {
        expect(w.held(w.home, sid, DIRECTORY)).toEqual(w.NONE);
        expect(
          w.as(w.home).get(sid, DRAFTS.mint({ ...MODEL, setting: "detail" })),
        ).toBe("true");
        expect(w.sessionState.get(sid, AUTHOR_KEY)).toBe(DISCLOSURE_OPEN);
      }
      // [LAW:nothing-unseen] One line per session, naming its owner and chain.
      const lines = w.released();
      expect(lines).toHaveLength(2);
      for (const sid of [S1, S2])
        expect(lines).toContainEqual(
          expect.stringMatching(
            new RegExp(
              `^placement-state released by=load session=${sid} owner=${durable.owner} chain=${durable.configPath} keys=`,
            ),
          ),
        );
    } finally {
      w.close();
    }
  });

  test("another session's click releases it here at the next load", async () => {
    durable.write(BOTH);
    const w = world();
    try {
      w.seed(w.home, S1, DIRECTORY);
      w.seed(w.home, S2, DIRECTORY);
      await w.fire(
        w.clicker(w.home, S2),
        "apply-layout-op",
        S2,
        "user",
        "presets.default.root",
        REMOVE_DIRECTORY,
      );
      expect(durable.text()).toBe(MODEL_ONLY.replace(/"directory", /, ""));
      expect(w.held(w.home, S1, DIRECTORY)).toEqual(w.NONE);
      expect(w.held(w.home, S2, DIRECTORY)).toEqual(w.NONE);
      expect(w.released()).toContainEqual(
        expect.stringMatching(/^placement-state released by=click session=s2 /),
      );
      expect(w.released()).toContainEqual(
        expect.stringMatching(/^placement-state released by=load session=s1 /),
      );
    } finally {
      w.close();
    }
  });

  test("a restart releases at the first load what ended while it was down, and every key naming no owner", () => {
    durable.write(MODEL_ONLY);
    const ended = DRAFTS.own(
      DRAFTS.mint({ ...DIRECTORY, setting: "detail" }),
      durable.owner,
    )!;
    const kept = DRAFTS.own(
      DRAFTS.mint({ ...MODEL, setting: "detail" }),
      durable.owner,
    )!;
    // A chain this load does not read: its keys are not this load's to judge.
    const other = DRAFTS.own(
      DRAFTS.mint({ ...DIRECTORY, setting: "detail" }),
      chainOwner(["/elsewhere.json5"]),
    )!;
    const stored = new SessionState({
      [S1]: {
        [ended]: "true",
        [kept]: "true",
        [other]: "true",
        "edit.draft.default.directory.detail": "true",
        "edit.draft.directory.detail": "true",
        theme: "ocean",
      },
    });
    const w = world(stored);
    try {
      w.cache.getOrCreate(w.home);
      expect([...stored.keys(S1)].sort()).toEqual(
        [kept, other, "theme"].sort(),
      );
    } finally {
      w.close();
    }
  });

  test("a placement re-added under the same id opens with its library closed, no drafts and nothing configured", () => {
    durable.write(BOTH);
    const w = world();
    try {
      w.seed(w.home, S1, DIRECTORY);
      durable.write(MODEL_ONLY);
      w.cache.configs.again();
      durable.write(BOTH);
      w.cache.configs.again();
      expect(w.held(w.home, S1, DIRECTORY)).toEqual(w.NONE);
    } finally {
      w.close();
    }
  });

  test("the clicker's undo restores its drafts, and the next load keeps them", async () => {
    durable.write(BOTH);
    const w = world();
    try {
      w.seed(w.home, S1, DIRECTORY);
      const ctx = w.clicker(w.home, S1);
      await w.fire(
        ctx,
        "apply-layout-op",
        S1,
        "user",
        "presets.default.root",
        REMOVE_DIRECTORY,
      );
      expect(w.held(w.home, S1, DIRECTORY).draft).toBeNull();
      await w.fire(ctx, "undo", S1);
      expect(durable.text()).toBe(BOTH);
      w.cache.configs.again();
      // The draft is a setting, so the click's undo restores it; the
      // disclosures and the configure key are not, and stay closed.
      expect(w.held(w.home, S1, DIRECTORY)).toEqual({
        ...w.NONE,
        draft: "true",
      });
    } finally {
      w.close();
    }
  });

  test("a failed load releases nothing and says nothing", () => {
    durable.write(BOTH);
    const w = world();
    try {
      w.seed(w.home, S1, DIRECTORY);
      w.cache.getOrCreate(w.home);
      const before = w.released().length;
      durable.write("{ root: { h: [ ");
      w.cache.configs.again();
      expect(w.cache.getOrCreate(w.home).lastError).not.toBeNull();
      expect(w.released()).toHaveLength(before);
      durable.write(BOTH);
      w.cache.configs.again();
      expect(w.held(w.home, S1, DIRECTORY).draft).toBe("true");
    } finally {
      w.close();
    }
  });
});

describe("two chains placing one id", () => {
  // `durable.projectDir` renders [user, project]; `elsewhere` renders [user].
  const PROJECT = (row: string) => `{ root: { h: [${row}] } }\n`;

  test("share no state, and a removal from one releases nothing of the other's, in one session or two", () => {
    durable.write(BOTH);
    fs.writeFileSync(durable.projectPath, PROJECT(`"directory", "model"`));
    answerRepo(durable.projectDir, "approved", durable.host.env);
    const w = world();
    try {
      const user = w.at(elsewhere);
      const project = w.home;
      expect(w.ownerOf(user)).toBe(durable.owner);
      expect(w.ownerOf(project)).toBe(
        chainOwner([durable.configPath, durable.projectPath]),
      );
      // One session in both configs, and another in the project's alone. A
      // session configures one placement at a time, so S1's configure key
      // is the user config's, seeded last.
      w.seed(project, S1, DIRECTORY);
      w.seed(user, S1, DIRECTORY);
      w.seed(project, S2, DIRECTORY);
      expect(w.held(user, S2, DIRECTORY)).toEqual(w.NONE);
      fs.writeFileSync(durable.projectPath, PROJECT(`"model"`));
      w.cache.configs.again();
      expect(w.held(project, S1, DIRECTORY)).toEqual(w.NONE);
      expect(w.held(project, S2, DIRECTORY)).toEqual(w.NONE);
      // The user file still places it, in the chain under the project too.
      expect(w.held(user, S1, DIRECTORY)).toEqual({
        draft: "true",
        list: DISCLOSURE_OPEN,
        library: DISCLOSURE_OPEN,
        configuring: true,
      });
    } finally {
      w.close();
    }
  });

  test("a layer appearing over a chain still releases what the chain under it ended", () => {
    durable.write(BOTH);
    const w = world();
    try {
      w.seed(w.home, S1, DIRECTORY);
      answerRepo(durable.projectDir, "approved", durable.host.env);
      fs.writeFileSync(durable.projectPath, PROJECT(`"model"`));
      durable.write(MODEL_ONLY);
      w.cache.configs.again();
      expect(w.ownerOf(w.home)).not.toBe(durable.owner);
      expect(
        ownedStore(w.sessionState, () => durable.owner).get(
          S1,
          DRAFTS.mint({ ...DIRECTORY, setting: "detail" }),
        ),
      ).toBeNull();
    } finally {
      w.close();
    }
  });

  test("two worktrees of one text share a compile and keep their drafts apart", () => {
    durable.write(BOTH);
    const a = path.join(elsewhere, "a");
    const b = path.join(elsewhere, "b");
    for (const dir of [a, b]) {
      fs.mkdirSync(dir);
      answerRepo(dir, "approved", durable.host.env);
      fs.writeFileSync(
        path.join(dir, ".cc-candybar.json5"),
        PROJECT(`"directory", "model"`),
      );
    }
    const w = world();
    try {
      const [ta, tb] = [w.at(a), w.at(b)];
      w.cache.getOrCreate(ta);
      w.cache.getOrCreate(tb);
      expect(w.cache.stats.compiles).toBe(1);
      expect(w.ownerOf(ta)).not.toBe(w.ownerOf(tb));
      w.seed(ta, S1, DIRECTORY);
      expect(w.held(tb, S1, DIRECTORY)).toEqual(w.NONE);
      fs.writeFileSync(path.join(b, ".cc-candybar.json5"), PROJECT(`"model"`));
      w.cache.configs.again();
      expect(w.held(ta, S1, DIRECTORY).draft).toBe("true");
    } finally {
      w.close();
    }
  });

  test("going back in one config never reopens the other's library", async () => {
    durable.write(BOTH);
    fs.writeFileSync(durable.projectPath, PROJECT(`"directory", "model"`));
    answerRepo(durable.projectDir, "approved", durable.host.env);
    const w = world();
    try {
      const user = w.at(elsewhere);
      const project = w.home;
      const library = LIBRARIES.mint({ ...DIRECTORY, relation: "after" });
      // An open library holds the action its menu applies.
      const open = insertGap("default", "directory", "after").apply;
      // In the user's config the session opens, then closes, the ✚ library.
      const inUser = w.clicker(user, S1);
      await w.fire(inUser, "set-state", S1, library, open);
      await w.fire(inUser, "set-state", S1, library, DISCLOSURE_CLOSED);
      // It then renders the project's config, whose ✚ beside the same id is closed.
      w.as(project).set(S1, library, DISCLOSURE_CLOSED);
      const inProject = w.clicker(project, S1);
      await expect(w.fire(inProject, "back", S1)).rejects.toThrow(BadVerbArgs);
      expect(w.as(project).get(S1, library)).toBe(DISCLOSURE_CLOSED);
      expect(w.as(user).get(S1, library)).toBe(DISCLOSURE_CLOSED);
    } finally {
      w.close();
    }
  });
});
