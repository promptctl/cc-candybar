// [LAW:verifiable-goals] A session that meets a config releases what it holds
// of a placement that config ended (src/renderer/placement-release.ts), read
// off the session's own state: its `✚` library and page, its configure key,
// its configure list and page, and its unsaved values. The rule holds wherever
// the session's view opens over the config: viewing when the edit reloads,
// idle, evicted, or behind a restart. A placement one load can't draw (a
// segment it doesn't declare, a plugin absent here) has not ended, and a
// config that failed its first load ends nothing.
//
// Every edit here is a hand edit the config watch reloads: no click removed
// anything, so nothing but the rule can release the state.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOST, locs } from "./helpers/host";
import { TEST_SIGNER } from "./helpers/link-signer";
import { SOURCES_NOTHING } from "../src/renderer/render-cache";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { SessionState } from "../src/renderer/session-state";
import { SettingsHistory } from "../src/renderer/settings-history";
import { NavigationHistory } from "../src/renderer/navigation-history";
import { placementRelease } from "../src/renderer/placement-release";
import { viewFacts } from "./helpers/view-facts";
import { NO_PLUGIN_STORAGE } from "./helpers/plugin-storage";
import { stateDir } from "../src/daemon/paths";
import { bareGates } from "./helpers/gates";
import { systemTimekeeper } from "../src/time";
import {
  sessionIdOf,
  type SessionId,
} from "../src/daemon/foundations/session-id";
import { DiscoveringCache, originOf } from "./helpers/config-host";
import { NO_LAYERS } from "./helpers/history-step";
import {
  configureListKey,
  insertGap,
  placementDraftKey,
} from "../src/config/edit-chrome";
import {
  configureMember,
  EDIT_CONFIGURE_KEY,
} from "../src/config/loader/edit-mode";
import { escapedIdent } from "../src/config/ident";
import { menuPageKey } from "../src/config/menu-keys";
import type { StoreWrite } from "../src/renderer-interface/stored-state";

const SID = sessionIdOf("s-release");
const OTHER = sessionIdOf("s-other");

let dir: string;
let file: string;
let cleanups: Array<() => void>;
beforeEach(() => {
  dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ccb-placement-release-")),
  );
  file = path.join(dir, "config.json5");
  cleanups = [() => fs.rmSync(dir, { recursive: true, force: true })];
});
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
});

// A config placing `vcs` once as each of `ids`, spelled as `seg` says.
function write(
  placements: ReadonlyArray<{ readonly seg: string; readonly id: string }>,
): void {
  fs.writeFileSync(
    file,
    JSON.stringify({
      segments: {
        vcs: {
          template: "v",
          settings: {
            detail: { label: "detail", domain: "bool", default: false },
          },
        },
      },
      root: { h: placements },
    }),
  );
}
const KEEP = { seg: "vcs", id: "keep" };
const GONE = { seg: "vcs", id: "gone" };

// The keys a session holds of placement `id` of the default preset: its `✚`
// library after it and that library's page, its configure list and page, and
// an unsaved value.
function keysOf(id: string): readonly string[] {
  const gap = insertGap("default", id, "after").stateKey;
  const list = configureListKey("default", id);
  return [
    gap,
    menuPageKey(gap),
    list,
    menuPageKey(list),
    placementDraftKey(escapedIdent("default"), id, "detail"),
  ];
}
const draftOf = (id: string): string =>
  placementDraftKey(escapedIdent("default"), id, "detail");

// What the host keeps of a store across a restart: each session's last write.
const persisted = <T>(writes: readonly StoreWrite[]): Record<string, T> =>
  Object.fromEntries(
    writes.flatMap((w) =>
      "key" in w && w.value !== null ? [[w.key, w.value]] : [],
    ),
  ) as Record<string, T>;

// A renderer's session stores and render cache, wired as the main renderer
// wires them: the cache's views meet their config through the rule, over the
// session state and histories the clicks write. `stored` is what a restarted
// renderer is handed.
function renderer(
  opts: {
    readonly maxEntries?: number;
    readonly stored?: {
      readonly sessions: ConstructorParameters<typeof SessionState>[0];
      readonly history: ConstructorParameters<typeof SettingsHistory>[2];
    };
  } = {},
) {
  const sessionState = new SessionState(opts.stored?.sessions);
  const history = new SettingsHistory(
    sessionState,
    () => {},
    opts.stored?.history,
  );
  const navigation = new NavigationHistory();
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
  cleanups.push(() => watchers.closeAll());
  const cache = new DiscoveringCache(
    {
      clock: systemTimekeeper,
      stateDir: stateDir(HOST),
      locations: locs(),
      storage: NO_PLUGIN_STORAGE,
      signer: TEST_SIGNER,
      gates: bareGates(),
      sessionState,
      watchers,
      meets: placementRelease({
        sessionState,
        history,
        navigation,
        landingOf: () => null,
      }),
      source: SOURCES_NOTHING,
    },
    {
      budgetBytes: () => 1024 * 1024 * 1024,
      ...(opts.maxEntries !== undefined && { maxEntries: opts.maxEntries }),
    },
  );
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    cache.close();
  };
  cleanups.push(close);
  // The session's view opened over the config at `at`, as a render opens it.
  const open = (sid: SessionId, at = file): void => {
    const where = path.dirname(at);
    cache
      .holdSession(originOf(where, where, at), viewFacts(where, sid))
      [Symbol.dispose]();
  };
  // The session holds every key of each of `ids`, and configures the last;
  // its unsaved values were picked by clicks, so its history steps them.
  const seed = (sid: SessionId, ids: readonly string[]): void => {
    for (const id of ids) {
      for (const key of keysOf(id))
        if (key !== draftOf(id)) sessionState.set(sid, key, "1");
      const journal = history.begin(NO_LAYERS);
      journal.sessionState.set(sid, draftOf(id), "true");
      journal.commit();
    }
    sessionState.set(
      sid,
      EDIT_CONFIGURE_KEY,
      configureMember("default", ids.at(-1)!),
    );
  };
  // What the session holds of placement `id`, by key.
  const held = (sid: SessionId, id: string) =>
    Object.fromEntries(keysOf(id).map((k) => [k, sessionState.get(sid, k)]));
  const configuring = (sid: SessionId) =>
    sessionState.get(sid, EDIT_CONFIGURE_KEY);
  // The keys the session's history steps.
  const stepped = (sid: SessionId): readonly string[] => {
    const { past, future } = history.history(sid);
    return [...past, ...future].flatMap((step) =>
      step.flatMap((c) => (c.kind === "session" ? [c.key] : [])),
    );
  };
  return {
    cache,
    sessionState,
    history,
    open,
    seed,
    held,
    configuring,
    stepped,
    close,
  };
}

const all = (value: string | null, id: string) =>
  Object.fromEntries(
    keysOf(id).map((k) => [
      k,
      k === draftOf(id) && value !== null ? "true" : value,
    ]),
  );

describe("a hand-removed placement's state is released the next time its session meets the config", () => {
  test("viewing: the reload's successor view releases it, and nothing else", () => {
    write([KEEP, GONE]);
    const r = renderer();
    r.seed(SID, ["keep", "gone"]);
    r.open(SID);
    // Meeting the config the keys were minted from releases nothing.
    expect(r.held(SID, "gone")).toEqual(all("1", "gone"));
    write([KEEP]);
    r.cache.configs.again();
    expect(r.held(SID, "gone")).toEqual(all(null, "gone"));
    expect(r.configuring(SID)).toBeNull();
    expect(r.stepped(SID)).not.toContain(draftOf("gone"));
    expect(r.held(SID, "keep")).toEqual(all("1", "keep"));
    expect(r.stepped(SID)).toContain(draftOf("keep"));
  });

  test("idle: a session with no view keeps it until its view opens again", () => {
    write([KEEP, GONE]);
    const r = renderer();
    r.seed(SID, ["gone"]);
    r.open(SID);
    r.cache.retireSession(SID);
    write([KEEP]);
    r.cache.configs.again();
    expect(r.held(SID, "gone")).toEqual(all("1", "gone"));
    r.open(SID);
    expect(r.held(SID, "gone")).toEqual(all(null, "gone"));
    expect(r.configuring(SID)).toBeNull();
  });

  test("evicted: the entry built again opens a view that releases it", () => {
    write([KEEP, GONE]);
    const elsewhere = path.join(dir, "elsewhere");
    fs.mkdirSync(elsewhere);
    const otherFile = path.join(elsewhere, "config.json5");
    fs.writeFileSync(otherFile, fs.readFileSync(file));
    const r = renderer({ maxEntries: 1 });
    r.seed(SID, ["gone"]);
    r.open(SID);
    // Another config's entry takes the only place: this one is evicted.
    r.open(OTHER, otherFile);
    expect(r.cache.stats.size).toBe(1);
    write([KEEP]);
    r.cache.configs.again();
    expect(r.held(SID, "gone")).toEqual(all("1", "gone"));
    r.open(SID);
    expect(r.held(SID, "gone")).toEqual(all(null, "gone"));
    expect(r.configuring(SID)).toBeNull();
  });

  test("restarted: a renderer handed the stored state releases it at the session's first open", () => {
    write([KEEP, GONE]);
    const before = renderer();
    before.seed(SID, ["gone"]);
    before.open(SID);
    const stored = {
      sessions: persisted<Record<string, string>>(before.sessionState.drain()),
      history: persisted<ReturnType<SettingsHistory["history"]>>(
        before.history.drain(),
      ),
    };
    before.close();
    write([KEEP]);
    const after = renderer({ stored });
    expect(after.held(SID, "gone")).toEqual(all("1", "gone"));
    expect(after.stepped(SID)).toContain(draftOf("gone"));
    after.open(SID);
    expect(after.held(SID, "gone")).toEqual(all(null, "gone"));
    expect(after.configuring(SID)).toBeNull();
    expect(after.stepped(SID)).not.toContain(draftOf("gone"));
  });

  test("a session moved to a config that doesn't place it releases it there", () => {
    write([KEEP, GONE]);
    const elsewhere = path.join(dir, "elsewhere");
    fs.mkdirSync(elsewhere);
    const otherFile = path.join(elsewhere, "config.json5");
    fs.writeFileSync(
      otherFile,
      JSON.stringify({
        segments: { plain: { template: "p" } },
        root: { h: ["plain"] },
      }),
    );
    const r = renderer();
    r.seed(SID, ["gone"]);
    r.open(SID);
    r.open(SID, otherFile);
    expect(r.held(SID, "gone")).toEqual(all(null, "gone"));
  });
});

describe("a placement one load can't draw has not ended", () => {
  test("a placement whose segment the load doesn't declare keeps its state", () => {
    write([KEEP, GONE]);
    const r = renderer();
    r.seed(SID, ["gone"]);
    r.open(SID);
    // A typo mid-edit: the placement stays, naming a segment nothing declares.
    write([KEEP, { seg: "vcz", id: "gone" }]);
    r.cache.configs.again();
    r.open(SID);
    expect(r.held(SID, "gone")).toEqual(all("1", "gone"));
    expect(r.configuring(SID)).toBe(configureMember("default", "gone"));
  });

  test("a placement of a plugin absent from this origin keeps its state", () => {
    write([KEEP, { seg: "repo.lit.ticket", id: "gone" }]);
    const r = renderer();
    r.seed(SID, ["gone"]);
    r.open(SID);
    expect(r.held(SID, "gone")).toEqual(all("1", "gone"));
    expect(r.configuring(SID)).toBe(configureMember("default", "gone"));
  });

  test("a config that fails its first load keeps every placement's state", () => {
    fs.writeFileSync(file, "{ root: ");
    const r = renderer();
    r.seed(SID, ["gone"]);
    r.open(SID);
    expect(
      r.cache.getOrCreate(originOf(dir, dir, file)).lastError,
    ).not.toBeNull();
    expect(r.held(SID, "gone")).toEqual(all("1", "gone"));
    expect(r.configuring(SID)).toBe(configureMember("default", "gone"));
  });

  test("a reload that fails keeps the placements of the config it keeps serving", () => {
    write([KEEP, GONE]);
    const r = renderer();
    r.seed(SID, ["gone"]);
    r.open(SID);
    fs.writeFileSync(file, "{ root: ");
    r.cache.configs.again();
    r.open(SID);
    expect(r.held(SID, "gone")).toEqual(all("1", "gone"));
  });
});
