import { compareStructural, reaction } from "mobx";
import { configQuery } from "../../src/config/loader/chain-places.js";
// The host's half of a config, for a test that drives a render cache with no
// renderer around it: a real config discovery over the test's own watcher
// registry, which hands the cache each origin's snapshot as the renderer's
// `config` turn would, when the test first names the origin and whenever a
// watch moves it.

import {
  originKey,
  requestedConfigTarget,
  type ConfigTarget,
  type RenderOrigin,
} from "../../src/config-hint";
import {
  ConfigDiscovery,
  type ConfigDiscoveryDeps,
  type RendererConfigs,
} from "../../src/daemon/config-discovery/config-discovery";
import type { ManagedStorage } from "../../src/daemon/cache/managed-storage";
import { MAIN_RENDERER } from "../../src/daemon/foundations/renderer-name";
import type { WatcherRegistry } from "../../src/daemon/cache/watchers";
import type { Locations } from "../../src/config/loader/chain-places";
import type { ConfigSnapshot } from "../../src/config/config-snapshot";
import type { DaemonLogger } from "../../src/utils/logger";
import {
  loadOrigin,
  RenderCache,
  type CacheEntry,
  type LoadOutcome,
  type RenderDeps,
  type StateDeps,
} from "../../src/renderer/render-cache";
import type { ViewFacts } from "../../src/renderer-interface/request-context";
import type { ViewSource } from "../../src/dsl/view-source";
import {
  discover,
  readShared,
} from "../../src/daemon/config-discovery/discover";

// The origin a context names: its project, its working directory, and the
// file `--config` names, or the search where none is named.
export function originOf(
  projectDir: string,
  cwd: string,
  configFile?: string,
): RenderOrigin {
  const target: ConfigTarget =
    configFile === undefined
      ? { source: "search" }
      : { source: "argument", path: configFile };
  return { projectDir, cwd, target };
}

export interface ConfigHost {
  // `originOf`'s origin, followed from now on, its snapshot handed in.
  at(projectDir: string, cwd: string, configFile?: string): RenderOrigin;
  // `origin`, followed from now on, its snapshot handed in.
  follow(origin: RenderOrigin): RenderOrigin;
  // Every followed origin discovered again now, each one that moved handed
  // in: what the host does when file events catch up.
  again(): void;
  readonly discovery: RendererConfigs;
  close(): void;
}

export function configHost(
  cache: { configure(origin: RenderOrigin, snapshot: ConfigSnapshot): void },
  world: {
    readonly locations: Locations;
    readonly stateDir: string;
    readonly watchers: Pick<WatcherRegistry, "batch">;
    readonly log?: DaemonLogger;
    readonly reloaded?: ConfigDiscoveryDeps["reloaded"];
  },
): ConfigHost {
  const origins = new Map<string, RenderOrigin>();
  const handIn = (origin: RenderOrigin): void => {
    const snapshot = configs.snapshotOf(origin);
    if (snapshot === null)
      throw new Error(`${originKey(origin)} is not followed`);
    cache.configure(origin, snapshot);
  };
  const discovery: ConfigDiscovery = new ConfigDiscovery({
    locations: world.locations,
    stateDir: world.stateDir,
    watchers: world.watchers,
    log: world.log ?? (() => {}),
    reloaded: world.reloaded,
    moved: (_renderer, moved) => moved.forEach(handIn),
  });
  const configs = discovery.forRenderer(MAIN_RENDERER);
  const follow = (origin: RenderOrigin): RenderOrigin => {
    const key = originKey(origin);
    if (!origins.has(key)) {
      origins.set(key, origin);
      configs.follow([...origins.values()]);
      handIn(origin);
    }
    return origin;
  };
  return {
    at: (projectDir, cwd, configFile) =>
      follow(originOf(projectDir, cwd, configFile)),
    follow,
    again: () => discovery.again("test"),
    discovery: configs,
    close: () => discovery.close(),
  };
}

// [LAW:effects-at-boundaries] A detached cache has no turn output for a host
// to accept. This observer takes its whole folder declaration at that seam.
export function followManagedStorage(
  cache: Pick<RenderCache<never, never>, "managedFolders">,
  storage: Pick<ManagedStorage, "follow">,
): () => void {
  return reaction(
    () => cache.managedFolders(),
    (folders) => storage.follow(new Set(folders)),
    { equals: compareStructural, fireImmediately: true },
  );
}

// A load of what discovery finds at one origin now, as the doctor's CLI makes
// one: no cache, no watch.
export function loadDiscovered(
  projectDir: string,
  cwd: string,
  configFile: string | undefined,
  { stateDir, ...deps }: StateDeps & { readonly stateDir: string },
): LoadOutcome & { readonly snapshot: ConfigSnapshot } {
  const { snapshot } = discover(
    { ...configQuery(projectDir, requestedConfigTarget(configFile, undefined)), cwd },
    readShared({ locations: deps.locations, stateDir }),
  );
  return { ...loadOrigin(cwd, snapshot, deps), snapshot };
}

// [LAW:locality-or-seam] A render cache whose every origin is followed by a
// real config discovery the moment the cache is asked for it, for a test of
// the cache that is not about the renderer's parking: what the renderer's
// `config` turn would have handed in first is handed in here.
export class DiscoveringCache<
  S extends ViewSource = ViewSource,
  F extends ViewFacts = ViewFacts,
> extends RenderCache<S, F> {
  readonly configs: ConfigHost;
  private shut = false;

  constructor(
    {
      stateDir,
      watchers,
      reloaded,
      ...deps
    }: RenderDeps<S, F> & {
      readonly stateDir: string;
      readonly watchers: Pick<WatcherRegistry, "batch">;
      readonly reloaded?: ConfigDiscoveryDeps["reloaded"];
    },
    opts: ConstructorParameters<typeof RenderCache<S, F>>[1],
  ) {
    super(deps, opts);
    this.configs = configHost(this, {
      locations: deps.locations,
      stateDir,
      watchers,
      log: deps.log,
      reloaded,
    });
  }

  override getOrCreate(origin: RenderOrigin): CacheEntry {
    // A test driving the actual renderer turn has already chosen its input.
    if (!this.shut && !this.holdsConfig(origin)) this.configs.follow(origin);
    return super.getOrCreate(origin);
  }

  override close(): void {
    super.close();
    this.shut = true;
    this.configs.close();
  }
}
