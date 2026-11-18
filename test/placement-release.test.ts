// [LAW:verifiable-goals] Whatever removes a placement, no session's state for
// it survives the next load of its config: a placement re-added under the same
// id opens with its libraries closed and no drafts, in every session, while
// the clicking session's undo of a removal restores its own drafts. Driven
// through the real render cache, config discovery and verb table over real
// config files.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  RenderCache,
  SOURCES_NOTHING,
  COMPILE_BYTES,
  ENTRY_BYTES,
} from "../src/renderer/render-cache";
import { SessionState } from "../src/renderer/session-state";
import { configHost, originOf } from "./helpers/config-host";
import { durableConfig, type DurableConfig } from "./helpers/durable-config";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { systemTimekeeper } from "../src/time";
import { locations, stateDir } from "../src/daemon/paths";
import { TEST_SIGNER } from "./helpers/link-signer";
import { bareGates } from "./helpers/gates";
import { NO_PLUGIN_STORAGE } from "./helpers/plugin-storage";
import {
  sessionIdOf,
  type SessionId,
} from "../src/daemon/foundations/session-id";
import type { RenderOrigin } from "../src/config-hint";
import { insertGap, placementDraftKey } from "../src/config/edit-chrome";
import { menuPageKey } from "../src/config/menu-keys";
import {
  configureMember,
  EDIT_CONFIGURE_KEY,
  EDIT_MODE_ARRANGE,
  EDIT_MODE_KEY,
} from "../src/config/loader/edit-mode";
import {
  configOf,
  SESSION_CONFIG_KEY,
} from "../src/renderer/placement-release";
import { buildRig } from "./helpers/rig";
import { linkUrls } from "./helpers/frame";
import { clickUrl, CLICK_VERBS, effectsOf, onLanded } from "./helpers/click";
import { VERB_APPLY_LAYOUT_OP, VERB_UNDO } from "../src/click/wire";
import { presetRootKey } from "../src/config/loader/persist-target";
import { encodeLayoutOp } from "../src/config/layout-ops";
import type { VerbContext } from "../src/renderer/verbs";

const S1 = sessionIdOf("s1");
const S2 = sessionIdOf("s2");

// `vcs` placed with a setting beside `plain`; `without` is the same bar after
// a removal of `vcs`.
const WITH = `{
  segments: {
    vcs: {
      template: 'vcs-{{ .settings.form }}',
      settings: { form: { label: 'form', domain: ['short', 'long'], default: 'short' } },
    },
    plain: { template: 'plain' },
  },
  root: { h: ['vcs', 'plain'] },
}
`;
const WITHOUT = WITH.replace(
  "root: { h: ['vcs', 'plain'] }",
  "root: { h: ['plain'] }",
);

// What a session holds for the placement `vcs`: an unsaved value, the
// configure key naming it, and the `✚` library beside it open on a page.
const DRAFT = placementDraftKey("default", "vcs", "form");
const LIBRARY = insertGap("default", "vcs", "after").stateKey;
const PLACED: Readonly<Record<string, string>> = {
  [DRAFT]: "long",
  [EDIT_CONFIGURE_KEY]: configureMember("default", "vcs"),
  [LIBRARY]: "open",
  [menuPageKey(LIBRARY)]: "2",
};
// What it holds beside them, which no placement owns.
const OWN: Readonly<Record<string, string>> = {
  "menus.plain.pick": "pick",
  [EDIT_MODE_KEY]: EDIT_MODE_ARRANGE,
};

let durable: DurableConfig;
let cleanups: Array<() => void>;
beforeEach(() => {
  durable = durableConfig("cc-candybar-release-");
  cleanups = [];
});
afterEach(() => {
  for (const c of cleanups.reverse()) c();
  durable.dispose();
});

// A render cache over `sessionState`, as the renderer builds one, whose
// origins are followed by a real discovery: `again` hands in each origin whose
// files moved, as the host does on a file event or a click's landing.
function cacheOver(sessionState: SessionState) {
  const lines: string[] = [];
  const log = (_level: string, message: string) => lines.push(message);
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
  const cache = new RenderCache(
    {
      clock: systemTimekeeper,
      locations: locations(durable.host),
      storage: NO_PLUGIN_STORAGE,
      signer: TEST_SIGNER,
      gates: bareGates(),
      sessionState,
      log,
      source: SOURCES_NOTHING,
    },
    { budgetBytes: () => 4 * ENTRY_BYTES + COMPILE_BYTES },
  );
  const configs = configHost(cache, {
    locations: locations(durable.host),
    stateDir: stateDir(durable.host),
    watchers,
  });
  cleanups.push(
    () => watchers.closeAll(),
    () => configs.close(),
    () => cache.close(),
  );
  const released = () =>
    lines.filter((l) => l.startsWith("placement state released"));
  return { cache, configs, lines, released };
}

// A config file of its own, named explicitly: one config per file.
function fileAt(name: string, text: string): string {
  const file = join(durable.projectDir, name);
  writeFileSync(file, text);
  return file;
}

// `sessionId` holds `vcs`'s state and its own, and last clicked in the config
// `origin` loads — what its clicks there would have left.
function seed(
  store: SessionState,
  cache: RenderCache,
  origin: RenderOrigin,
  sessionId: SessionId,
): void {
  store.setBatch(
    sessionId,
    Object.entries({ ...PLACED, ...OWN }).map(([key, value]) => ({
      key,
      value,
    })),
  );
  store.set(sessionId, SESSION_CONFIG_KEY, configOf(cache.snapshotFor(origin)));
}

const stateOf = (store: SessionState, sessionId: SessionId) =>
  Object.fromEntries(
    store.keys(sessionId).map((key) => [key, store.get(sessionId, key)]),
  );

describe("a placement's state ends at the next load of its config", () => {
  test("a hand edit ends an idle session's state, says so, and the re-added id opens clean", () => {
    const store = new SessionState();
    const { cache, configs, released } = cacheOver(store);
    const file = fileAt("a.json5", WITH);
    const origin = configs.at(durable.projectDir, durable.projectDir, file);
    cache.getOrCreate(origin);
    // S2 has no view: it is idle, its state in the store alone.
    seed(store, cache, origin, S2);
    configs.again();
    expect(released()).toEqual([]);

    writeFileSync(file, WITHOUT);
    configs.again();
    expect(cache.getOrCreate(origin).state.config.root).toBeDefined();
    const left = stateOf(store, S2);
    for (const key of Object.keys(PLACED)) expect(left).not.toHaveProperty(key);
    expect(left).toMatchObject(OWN);
    expect(released()).toEqual([
      `placement state released session="s2" config=${configOf(cache.snapshotFor(origin))} keys=${JSON.stringify(Object.keys(PLACED))}`,
    ]);

    // The same id again: nothing of the old placement is there to inherit.
    writeFileSync(file, WITH);
    configs.again();
    for (const key of Object.keys(PLACED))
      expect(store.get(S2, key)).toBeNull();
  });

  test("a removal made while the daemon was down ends at its first load", () => {
    const file = fileAt("a.json5", WITH);
    // The profile the daemon before kept, whose file has since lost `vcs`.
    const before = new SessionState();
    const first = cacheOver(before);
    const origin = first.configs.at(
      durable.projectDir,
      durable.projectDir,
      file,
    );
    first.cache.getOrCreate(origin);
    seed(before, first.cache, origin, S2);
    const stored = { [S2]: stateOf(before, S2) as Record<string, string> };
    writeFileSync(file, WITHOUT);

    const store = new SessionState(stored);
    const { cache, configs } = cacheOver(store);
    cache.getOrCreate(configs.at(durable.projectDir, durable.projectDir, file));
    for (const key of Object.keys(PLACED))
      expect(store.get(S2, key)).toBeNull();
    expect(stateOf(store, S2)).toMatchObject(OWN);
  });

  test("a load that fails releases nothing", () => {
    const store = new SessionState();
    const { cache, configs, released } = cacheOver(store);
    const file = fileAt("a.json5", WITH);
    const origin = configs.at(durable.projectDir, durable.projectDir, file);
    cache.getOrCreate(origin);
    seed(store, cache, origin, S2);
    // The bar without `vcs`, cut off mid-write.
    writeFileSync(file, WITHOUT.slice(0, WITHOUT.length / 2));
    configs.again();
    expect(cache.getOrCreate(origin).lastError).not.toBeNull();
    expect(stateOf(store, S2)).toMatchObject(PLACED);
    expect(released()).toEqual([]);
  });

  test("a placement whose segment the load cannot see has not ended", () => {
    const store = new SessionState();
    const { cache, configs, released } = cacheOver(store);
    const file = fileAt("a.json5", WITH);
    const origin = configs.at(durable.projectDir, durable.projectDir, file);
    cache.getOrCreate(origin);
    seed(store, cache, origin, S2);
    // A typo mid-edit: the declaration renamed, its placement not yet.
    writeFileSync(file, WITH.replace("    vcs: {", "    vcz: {"));
    configs.again();
    const entry = cache.getOrCreate(origin);
    expect(entry.lastError).toBeNull();
    expect(entry.state.dropped).not.toEqual([]);
    expect(stateOf(store, S2)).toMatchObject(PLACED);
    expect(released()).toEqual([]);
  });

  test("two configs placing the same preset and id: one's release leaves the other's sessions", () => {
    const store = new SessionState();
    const { cache, configs } = cacheOver(store);
    const a = fileAt("a.json5", WITH);
    const b = fileAt("b.json5", WITH);
    const atA = configs.at(durable.projectDir, durable.projectDir, a);
    const atB = configs.at(durable.projectDir, durable.projectDir, b);
    cache.getOrCreate(atA);
    cache.getOrCreate(atB);
    seed(store, cache, atA, S1);
    seed(store, cache, atB, S2);
    writeFileSync(a, WITHOUT);
    configs.again();
    expect(store.get(S1, DRAFT)).toBeNull();
    expect(stateOf(store, S2)).toMatchObject(PLACED);
  });
});

describe("a click that removes a placement", () => {
  // S1 clicks through the real verb table over the user's config file, and
  // the cache follows the same origin; a landing hands the cache what moved.
  function clickingBar() {
    durable.write(WITH);
    const store = new SessionState();
    const { cache, configs, released } = cacheOver(store);
    const origin = configs.follow(
      originOf(durable.projectDir, durable.projectDir),
    );
    cache.getOrCreate(origin);
    durable.seedOrigin(store, S1);
    const rig = buildRig({
      source: WITH,
      sessionId: S1,
      sessionState: store,
      history: durable.historyFor(store),
      host: durable.host,
    });
    cleanups.push(() => rig.dispose());
    const ctx: VerbContext = {
      ...rig.ctx,
      configFor: () => cache.getOrCreate(origin).state.config,
    };
    onLanded(ctx, () => configs.again());
    store.set(S1, EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    store.set(S1, DRAFT, "long");
    const remove = linkUrls(rig.draw({ opts: { width: 200 } }).frame).find(
      (u) =>
        effectsOf(u).some(
          (e) =>
            e.verb === VERB_APPLY_LAYOUT_OP &&
            e.args[2] === presetRootKey("default") &&
            e.args[3] === encodeLayoutOp({ op: "remove", target: "vcs" }),
        ),
    );
    expect(remove).toBeDefined();
    return { store, cache, origin, ctx, released, remove: remove! };
  }

  test("ends another session's state for it at the load its landing makes", async () => {
    const { store, cache, origin, ctx, remove } = clickingBar();
    seed(store, cache, origin, S2);
    await clickUrl(remove, ctx);
    expect(durable.text()).toBe(WITHOUT);
    for (const key of Object.keys(PLACED))
      expect(store.get(S2, key)).toBeNull();
    expect(stateOf(store, S2)).toMatchObject(OWN);
  });

  test("ends the clicker's own state in its click, and its undo brings it back", async () => {
    const { store, ctx, released, remove } = clickingBar();
    await clickUrl(remove, ctx);
    expect(store.get(S1, DRAFT)).toBeNull();
    // The click left the session's state in the config it clicked in.
    expect(store.get(S1, SESSION_CONFIG_KEY)).toBe(
      configOf(
        ctx.snapshotFor(originOf(durable.projectDir, durable.projectDir)),
      ),
    );
    const before = released().length;
    await CLICK_VERBS.get(VERB_UNDO)!(S1, ctx);
    expect(durable.text()).toBe(WITH);
    expect(store.get(S1, DRAFT)).toBe("long");
    // The load the undo's landing made found the placement there again.
    expect(released().slice(before)).toEqual([]);
  });
});
