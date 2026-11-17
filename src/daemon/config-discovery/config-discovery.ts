// [LAW:single-enforcer] The host's config discovery: the one owner of every
// session's ConfigSnapshot. It discovers each origin a request names once,
// follows the files that discovery read, and discovers it again when one of
// them, the answers book, or file delivery after a span moves, so a snapshot
// reaches the renderer again only when what it holds changed.

import fs from "node:fs";
import { nearestWatchTarget } from "../../utils/watch-target.js";
import { digestOf } from "../../utils/plain.js";
import { valueOf } from "../../utils/logfmt.js";
import type { DaemonLogger } from "../../utils/logger.js";
import type { ConfigSnapshot } from "../../config/config-snapshot.js";
import type { LayerRole } from "../../config/layer-role.js";
import type { SessionId } from "../foundations/session-id.js";
import {
  watchFault,
  watchTargetsOf,
  type BoundWatch,
  type Invalidation,
  type WatcherHandle,
} from "../foundations/watch-targets.js";
import type { WatcherRegistry } from "../cache/watchers.js";
import type { CheckedRenderRequest } from "../../renderer-interface/request-context.js";
import type { RenderOrigin } from "../../config-hint.js";
import type { ClickConfig } from "../../renderer-interface/interface.js";
import { repoConfigsDir, repoConfigsPath } from "./repo-configs.js";
import {
  discover,
  type DiscoveryQuery,
  type DiscoveryWorld,
} from "./discovery.js";

// [LAW:one-source-of-truth] What a discovery is asked: an origin, the one
// the renderer keys its config by.
export const queryOfOrigin = ({
  projectDir,
  cwd,
  target,
}: RenderOrigin): DiscoveryQuery => ({
  projectDir,
  cwd,
  configFile: target.path,
});

// What a request's discovery is asked: the origin it names.
export const queryOf = (req: CheckedRenderRequest): DiscoveryQuery =>
  queryOfOrigin(req.requested);

// One origin's discovery: what it was asked, the snapshot it found with that
// snapshot's identity, and the watch over the files it read.
interface Found {
  readonly query: DiscoveryQuery;
  readonly snapshot: ConfigSnapshot;
  readonly digest: string;
  readonly watch: BoundWatch;
}

// [LAW:one-source-of-truth] An origin is every input of a discovery: its
// project, its working directory, and the explicit file it names.
const originKey = ({ projectDir, cwd, configFile }: DiscoveryQuery): string =>
  `${projectDir ?? ""}\0${cwd}\0${configFile ?? ""}`;

const heardField = (heard: Invalidation): string => {
  switch (heard.kind) {
    case "changed":
      return heard.paths.join(",");
    case "unknown":
      return "unknown";
    case "failed":
      return `failed:${heard.reason}`;
  }
};

export class ConfigDiscovery {
  // [LAW:one-source-of-truth] Each origin a live session names, discovered.
  private readonly origins = new Map<string, Found>();
  // The origin each session's newest request named.
  private readonly sessions = new Map<SessionId, string>();
  // The origin each session's last draw recorded, as the renderer reported
  // it at its start: what a click on a session no request has reached since
  // is discovered at.
  private readonly recordedOrigins = new Map<SessionId, RenderOrigin>();
  // [LAW:one-source-of-truth] The user's answers for repositories are one
  // fact for every origin, so one watch follows them. The book has a folder
  // of its own, made here so the watch never falls back to the state
  // directory, where the daemon's log writes on every request.
  private readonly answersWatch: WatcherHandle;

  constructor(
    private readonly opts: {
      readonly world: DiscoveryWorld;
      readonly watchers: Pick<WatcherRegistry, "acquire" | "follow">;
      // The sessions a watch's discovery moved the snapshot of: each is owed
      // a config turn.
      readonly moved: (sessions: readonly SessionId[]) => void;
      // A watch heard the files: the storage owner keys its folders again,
      // so a storage folder removed or replaced is made again whether or not
      // the snapshot moved.
      readonly heard: () => void;
      readonly log: DaemonLogger;
    },
  ) {
    const { stateDir } = opts.world;
    fs.mkdirSync(repoConfigsDir(stateDir), { recursive: true });
    const { dir, name } = nearestWatchTarget(repoConfigsPath(stateDir));
    this.answersWatch = opts.watchers.acquire(
      `repo-configs:${dir}/${name}`,
      { dirs: [{ path: dir, filenames: [name] }] },
      (heard) => this.heard("answers", heard, [...this.origins.keys()]),
    );
  }

  // The snapshot of the origin a session's request names, discovered at its
  // first sight. A session that moved lets go of the origin it named before.
  at(session: SessionId, query: DiscoveryQuery): ConfigSnapshot {
    const key = originKey(query);
    const was = this.sessions.get(session);
    this.sessions.set(session, key);
    const found = this.origins.get(key) ?? this.discovered(key, query, null);
    if (was !== undefined && was !== key) this.unnamed(was);
    return found.snapshot;
  }

  // The origin the renderer's state recorded for a session, reported as it
  // starts: the bar a click lands on may be one the daemon before drew.
  recorded(session: SessionId, origin: RenderOrigin): void {
    this.recordedOrigins.set(session, origin);
  }

  // [LAW:no-ambient-temporal-coupling] The config a click on the session acts
  // on: the origin its newest request named, or else the one its last draw
  // recorded, discovered now, so the click reads the files as they are
  // whether or not a watch has heard them yet. Every other session naming the
  // origin is handed the snapshot this moved, as a watch's would be. Null for
  // a session that has never drawn.
  current(session: SessionId, newest: RenderOrigin | null): ClickConfig | null {
    const origin = newest ?? this.recordedOrigins.get(session) ?? null;
    if (origin === null) return null;
    const query = queryOfOrigin(origin);
    const key = originKey(query);
    const known = this.origins.has(key);
    this.at(session, query);
    if (known)
      this.opts.moved(this.rediscover([key]).filter((s) => s !== session));
    return { session, origin, snapshot: this.origins.get(key)!.snapshot };
  }

  // The snapshot the session's newest request named, or null for a session
  // whose request this host has not seen.
  snapshotOf(session: SessionId): ConfigSnapshot | null {
    const key = this.sessions.get(session);
    return key === undefined ? null : this.origins.get(key)!.snapshot;
  }

  // [LAW:single-enforcer] The file a change to `role` lands in: the session's
  // layer as its snapshot holds it, or null when its chain has no such layer.
  layerPath(session: SessionId, role: LayerRole): string | null {
    return (
      this.snapshotOf(session)?.chain.find((l) => l.role === role)?.path ?? null
    );
  }

  // The directory the session's repository question is answered under, or
  // null when it has none.
  repoDir(session: SessionId): string | null {
    return this.snapshotOf(session)?.repo?.dir ?? null;
  }

  // [LAW:no-ambient-temporal-coupling] A turn's changes landed: every origin
  // whose chain holds a written file is discovered again now, or every origin
  // with a repository when the turn answered the trust book, so the sessions
  // they moved get their config turns before the click's `effect-done`. The
  // watch then finds nothing new.
  landed(files: readonly string[], answered: boolean): readonly SessionId[] {
    return this.rediscover(
      [...this.origins].flatMap(([key, { snapshot }]) =>
        (answered && snapshot.repo !== null) ||
        snapshot.chain.some((l) => files.includes(l.path))
          ? [key]
          : [],
      ),
    );
  }

  // Every origin discovered again, `why`: file events resumed after a span
  // in which an edit may have gone unheard, or a caller changed files no
  // watch hears.
  again(why: string): void {
    const moved = this.rediscover([...this.origins.keys()]);
    this.opts.log(
      "info",
      `config discovery again why=${valueOf(why)} origins=${this.origins.size} moved=${moved.length}`,
    );
    this.opts.moved(moved);
  }

  // The host ended the session: an origin no live session names lets go of
  // its watch.
  retire(session: SessionId): void {
    const key = this.sessions.get(session);
    this.sessions.delete(session);
    this.recordedOrigins.delete(session);
    if (key !== undefined) this.unnamed(key);
  }

  close(): void {
    this.answersWatch.release();
    for (const { watch } of this.origins.values()) watch.held.handle.release();
    this.origins.clear();
    this.sessions.clear();
    this.recordedOrigins.clear();
  }

  private heard(
    what: "answers" | "config",
    heard: Invalidation,
    keys: readonly string[],
  ): void {
    this.opts.heard();
    const moved = this.rediscover(keys);
    this.opts.log(
      "info",
      `config discovery heard=${what}:${valueOf(heardField(heard))} origins=${keys.length} moved=${moved.length}`,
    );
    if (moved.length > 0) this.opts.moved(moved);
  }

  // Each origin at `keys` discovered again; the sessions naming those whose
  // snapshot moved.
  private rediscover(keys: readonly string[]): readonly SessionId[] {
    const moved = new Set<string>();
    for (const key of keys) {
      const found = this.origins.get(key);
      if (found === undefined) continue;
      const again = this.discovered(key, found.query, found.watch);
      if (again.digest !== found.digest) moved.add(key);
    }
    return [...this.sessions].flatMap(([session, key]) =>
      moved.has(key) ? [session] : [],
    );
  }

  // [LAW:effects-at-boundaries] One discovery of `key`, and its watch,
  // following the files it read: the watch it held is kept while they are
  // the same, and rebound when they moved.
  private discovered(
    key: string,
    query: DiscoveryQuery,
    held: BoundWatch | null,
  ): Found {
    const { snapshot, targets } = discover(query, this.opts.world);
    const paths = watchTargetsOf(targets);
    const spec = { ...paths, key: `config:${key}:${paths.key}` };
    const { watch, move } = this.opts.watchers.follow(
      held?.held ?? null,
      spec,
      (heard) => this.heard("config", heard, [key]),
    );
    const bound: BoundWatch = { derived: spec, held: watch };
    // [LAW:no-silent-failure] What the watch cannot hear rides the snapshot,
    // so the bar says an edit there may be missed.
    const full: ConfigSnapshot = {
      ...snapshot,
      watch: watchFault("config watch", bound, null),
    };
    const found: Found = {
      query,
      snapshot: full,
      digest: digestOf(full),
      watch: bound,
    };
    this.origins.set(key, found);
    if (move === "rebound") {
      // [LAW:nothing-unseen] A rebind is the fact that the files moved (a
      // candidate appeared, a link was re-pointed), and which directories the
      // origin now hears: a change that fires nothing is read against this.
      this.opts.log(
        "info",
        `config watch bound projectDir=${valueOf(query.projectDir ?? "-")} cwd=${valueOf(query.cwd)} dirs=${spec.targets.dirs.map((d) => d.path).join(",")}`,
      );
      for (const { path, reason } of spec.unresolved)
        this.opts.log(
          "warn",
          `config watch unresolved projectDir=${valueOf(query.projectDir ?? "-")} path=${path} reason=${reason}`,
        );
    }
    return found;
  }

  private unnamed(key: string): void {
    for (const named of this.sessions.values()) if (named === key) return;
    this.origins.get(key)?.watch.held.handle.release();
    this.origins.delete(key);
  }
}
