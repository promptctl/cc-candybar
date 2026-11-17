// The host's half of a config, for a test that drives a render cache with no
// renderer around it: a real config discovery over the test's own watcher
// registry, which hands the cache each origin's snapshot as the renderer's
// `config` turn would, when the test first names the origin and whenever a
// watch moves it.

import {
  originKey,
  type ConfigTarget,
  type RenderOrigin,
} from "../../src/config-hint";
import { ConfigDiscovery } from "../../src/daemon/config-discovery/config-discovery";
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
  readonly discovery: ConfigDiscovery;
  close(): void;
}

export function configHost(
  cache: { configure(origin: RenderOrigin, snapshot: ConfigSnapshot): void },
  world: {
    readonly locations: Locations;
    readonly stateDir: string;
    readonly watchers: Pick<WatcherRegistry, "acquire" | "follow">;
    readonly log?: DaemonLogger;
  },
): ConfigHost {
  const origins = new Map<string, RenderOrigin>();
  const handIn = (origin: RenderOrigin): void => {
    const snapshot = discovery.snapshotOf(origin);
    if (snapshot === null)
      throw new Error(`${originKey(origin)} is not followed`);
    cache.configure(origin, snapshot);
  };
  const discovery: ConfigDiscovery = new ConfigDiscovery({
    locations: world.locations,
    stateDir: world.stateDir,
    watchers: world.watchers,
    log: world.log ?? (() => {}),
    moved: (moved) => moved.forEach(handIn),
  });
  const follow = (origin: RenderOrigin): RenderOrigin => {
    const key = originKey(origin);
    if (!origins.has(key)) {
      origins.set(key, origin);
      discovery.follow([...origins.values()]);
      handIn(origin);
    }
    return origin;
  };
  return {
    at: (projectDir, cwd, configFile) =>
      follow(originOf(projectDir, cwd, configFile)),
    follow,
    again: () => discovery.again("test"),
    discovery,
    close: () => discovery.close(),
  };
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
    { projectDir, configFile, cwd },
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
      ...deps
    }: RenderDeps<S> & {
      readonly stateDir: string;
      readonly watchers: Pick<WatcherRegistry, "acquire" | "follow">;
    },
    opts: ConstructorParameters<typeof RenderCache<S, F>>[1],
  ) {
    super(deps, opts);
    this.configs = configHost(this, {
      locations: deps.locations,
      stateDir,
      watchers,
      log: deps.log,
    });
  }

  override getOrCreate(origin: RenderOrigin): CacheEntry {
    if (!this.shut) this.configs.follow(origin);
    return super.getOrCreate(origin);
  }

  override close(): void {
    super.close();
    this.shut = true;
    this.configs.close();
  }
}
