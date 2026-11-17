// A render cache whose every origin is discovered from disk the moment it is
// held, as the host hands a request's snapshot in on its config turn: a test
// that edits a file and holds the origin again draws what the edit left.

import crypto from "node:crypto";
import {
  loadSnapshot,
  RenderCache,
  type CacheEntry,
  type LoadOutcome,
  type RenderDeps,
  type StateDeps,
} from "../../src/renderer/render-cache";
import {
  discover,
  type DiscoveryWorld,
} from "../../src/daemon/config-discovery/discovery";
import type { ConfigSnapshot } from "../../src/config/config-snapshot";
import {
  parseSessionId,
  type SessionId,
} from "../../src/daemon/foundations/session-id";
import type { RenderOrigin } from "../../src/config-hint";
import { SESSION_RENDER_ORIGIN_KEY } from "../../src/daemon/foundations/session-keys";
import type { SessionStateReader } from "../../src/renderer-interface/session-state";
import { parseRenderOrigin } from "../../src/renderer/verbs";
import type { HostWorld } from "../../src/daemon/renderer-host";
import type { WriteLayer } from "../../src/renderer/config-file-store";
import type { Locations } from "../../src/daemon/config-discovery/discovery";
import fs from "node:fs";
import path from "node:path";
import { textSnapshot } from "./text-snapshot";
import { ConfigDiscovery } from "../../src/daemon/config-discovery/config-discovery";
import { WatcherRegistry } from "../../src/daemon/cache/watchers";
import { systemTimekeeper } from "../../src/time";
import type {
  CheckedRenderRequest,
  ViewFacts,
} from "../../src/renderer-interface/request-context";
import type { ViewSource } from "../../src/dsl/view-source";
import { stateDir } from "../../src/daemon/paths";
import { HOST, locs } from "./host";

// The test machine's discovery: its locations, and its answers book.
export const DISK: DiscoveryWorld = {
  locations: locs(),
  stateDir: stateDir(HOST),
};

// [LAW:single-enforcer] What discovery finds for `snapshot`'s session (its
// installed and approved plugins, its checkout) under a chain a test states:
// `files` in chain order, read as the host reads them.
export function chainOver(
  snapshot: ConfigSnapshot,
  files: readonly string[],
  home: string = DISK.locations.home,
): ConfigSnapshot {
  return {
    ...snapshot,
    chain: textSnapshot(
      files.map((f) => [f, fs.readFileSync(f, "utf8")] as const),
      snapshot.checkout.root,
      home,
    ).chain,
  };
}

// What the host's discovery hands in for one origin.
export function snapshotOf(
  projectDir: string | undefined,
  cwd: string,
  configFile: string | undefined,
  world: DiscoveryWorld = DISK,
): ConfigSnapshot {
  return {
    ...discover({ projectDir, cwd, configFile }, world).snapshot,
    watch: null,
  };
}

// The snapshot the host hands in with a request's config turn: its origin
// discovered from disk at the request.
export const requestSnapshot = ({
  requested: { projectDir, cwd, target },
}: CheckedRenderRequest): ConfigSnapshot =>
  snapshotOf(projectDir, cwd, target.path);

// One origin's config as a renderer loads it the first time: discovered from
// disk, then loaded from the snapshot.
export function loadFromDisk(
  projectDir: string | undefined,
  cwd: string,
  configFile: string | undefined,
  deps: Omit<StateDeps, "home">,
  world: DiscoveryWorld = DISK,
): LoadOutcome {
  return loadSnapshot(snapshotOf(projectDir, cwd, configFile, world), cwd, {
    ...deps,
    home: world.locations.home,
  });
}

// What the host's discovery hands in for the origin a render recorded.
export const originSnapshot = (
  { projectDir, cwd, target }: RenderOrigin,
  world: DiscoveryWorld = DISK,
): ConfigSnapshot => snapshotOf(projectDir, cwd, target.path, world);

// The snapshot of the origin a session's last render recorded, as the host's
// discovery holds it for the session; null for a session that never rendered.
export function sessionSnapshot(
  sessionState: SessionStateReader,
  world: DiscoveryWorld = DISK,
): (session: SessionId) => ConfigSnapshot | null {
  return (session) => {
    const raw = sessionState.get(session, SESSION_RENDER_ORIGIN_KEY);
    return raw === null ? null : originSnapshot(parseRenderOrigin(raw), world);
  };
}

// The host's discovery as a test's host turns resolve a click's changes
// against: each session's layers and repository from `snapshot`. A landing
// owes no config turn: the test's next hold discovers what it left.
export function diskConfigs(
  snapshot: (session: SessionId) => ConfigSnapshot | null,
): HostWorld["configs"] {
  return {
    path: (session, role) =>
      snapshot(session)?.chain.find((l) => l.role === role)?.path ?? null,
    repoDir: (session) => snapshot(session)?.repo?.dir ?? null,
    landed: () => [],
  };
}

// The user's layer at an explicit `file`, as a click writing it sees it: the
// chain the host's discovery found for that file, read now.
export const explicitLayer = (
  file: string,
  locations: Locations = DISK.locations,
): WriteLayer => ({
  role: "user",
  source: {
    snapshot: snapshotOf(path.dirname(file), path.dirname(file), file, {
      locations,
      stateDir: DISK.stateDir,
    }),
    home: locations.home,
  },
});

// A render cache fed as the daemon feeds its renderer: the host's own config
// discovery, over the test's watcher registry (or one of its own), hands in
// each origin's snapshot when a session first holds it, and again whenever a
// watch hears it move. Each origin is held by a session of its own.
export class DiskRenderCache<
  S extends ViewSource = ViewSource,
  F extends ViewFacts = ViewFacts,
> extends RenderCache<S, F> {
  readonly discovery: ConfigDiscovery;
  private readonly origins = new Map<
    SessionId,
    readonly [projectDir: string, cwd: string, configFile: string | undefined]
  >();
  private readonly ownWatchers: WatcherRegistry | null;

  // `heard` is what the host does when a discovery's watch hears its files:
  // the daemon keys its storage folders again.
  constructor(
    {
      watchers,
      heard = () => {},
      ...world
    }: DiscoveryWorld & {
      readonly watchers?: WatcherRegistry;
      readonly heard?: () => void;
    },
    deps: RenderDeps<S>,
    options: ConstructorParameters<typeof RenderCache<S, F>>[1],
  ) {
    super(deps, options);
    this.ownWatchers =
      watchers === undefined
        ? new WatcherRegistry({ clock: systemTimekeeper, logger: () => {} })
        : null;
    this.discovery = new ConfigDiscovery({
      world,
      watchers: watchers ?? this.ownWatchers!,
      moved: (sessions) => {
        for (const session of sessions) this.handIn(session);
      },
      heard,
      log: deps.log ?? (() => {}),
    });
  }

  override getOrCreate(
    projectDir: string,
    cwd: string,
    configFile: string | undefined,
  ): CacheEntry {
    const session = sessionOf(projectDir, cwd, configFile);
    if (!this.origins.has(session)) {
      this.origins.set(session, [projectDir, cwd, configFile]);
      this.discovery.at(session, { projectDir, cwd, configFile });
      this.handIn(session);
    }
    return super.getOrCreate(projectDir, cwd, configFile);
  }

  // Every origin discovered again, as the host does when file events resume
  // after a span: an entry whose snapshot moved reloads, and one whose did
  // not keeps what it serves.
  reload(): void {
    this.discovery.again("test");
  }

  // A click's changes landed: the origins whose chain holds a written file
  // are discovered again, and each session one moved is handed its snapshot,
  // as the host does before the click's `effect-done`.
  landed(files: readonly string[]): void {
    for (const session of this.discovery.landed(files, false))
      this.handIn(session);
  }

  override close(): void {
    super.close();
    this.discovery.close();
    this.ownWatchers?.closeAll();
  }

  private handIn(session: SessionId): void {
    const [projectDir, cwd, configFile] = this.origins.get(session)!;
    this.configure(
      session,
      projectDir,
      cwd,
      configFile,
      this.discovery.snapshotOf(session)!,
    );
  }
}

// The session a test's origin is held by: one per origin.
function sessionOf(
  projectDir: string,
  cwd: string,
  configFile: string | undefined,
): SessionId {
  const parsed = parseSessionId(
    crypto
      .createHash("sha256")
      .update(`${projectDir}\0${cwd}\0${configFile ?? ""}`)
      .digest("hex"),
  );
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.id;
}
