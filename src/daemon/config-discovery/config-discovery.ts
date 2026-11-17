// [LAW:single-enforcer] The host's one config discovery: what is found at
// every origin the renderer names, and the one watch per origin that says
// when that may have moved. The renderer reads every config text from what
// this hands it, and opens no file. (docs/design/host-and-renderer.md §6, §7)
//
// [LAW:one-source-of-truth] A snapshot is a fact about an origin, never a
// session's: the origins followed are exactly the set the renderer's latest
// output named, keyed by `originKey`, and one it stops naming is dropped
// with its watch.

import fs from "node:fs";
import path from "node:path";
import { originKey, type RenderOrigin } from "../../config-hint.js";
import type { ConfigSnapshot } from "../../config/config-snapshot.js";
import {
  discover,
  readShared,
  type Discovered,
  type DiscoveryWorld,
  type SharedFacts,
} from "../../config/loader/discover.js";
import { REPO_PLUGIN_DIR } from "../../config/loader/plugin-folders.js";
import { repoConfigsDir, repoConfigsPath } from "../../config/repo-configs.js";
import { nearestWatchTarget } from "../../utils/watch-target.js";
import { digestOf } from "../../utils/plain.js";
import type { DaemonLogger } from "../../utils/logger.js";
import type { WatcherRegistry } from "../cache/watchers.js";
import {
  watchFault,
  watchTargetsOf,
  type HeldWatch,
  type PathsWatch,
  type WatcherHandle,
} from "../foundations/watch-targets.js";

// One origin followed: what discovery found there last, its digest, and the
// watch over where that can change.
interface Followed {
  readonly origin: RenderOrigin;
  readonly snapshot: ConfigSnapshot;
  readonly digest: string;
  readonly watch: HeldWatch;
}

export interface ConfigDiscoveryDeps extends DiscoveryWorld {
  readonly watchers: Pick<WatcherRegistry, "acquire" | "follow">;
  readonly log: DaemonLogger;
  // [LAW:effects-at-boundaries] Where the origins whose snapshot a watch
  // moved go: the renderer's `config` turns.
  readonly moved: (origins: readonly RenderOrigin[]) => void;
}

export class ConfigDiscovery {
  private readonly followed = new Map<string, Followed>();
  // [LAW:one-source-of-truth] The user's answers for repositories are one
  // fact for the whole daemon, so one watch follows them, never one per
  // origin. The book has a folder of its own, made here so the watch never
  // falls back to the state directory, where the daemon's log writes on every
  // request.
  private readonly answersWatch: WatcherHandle;
  private closed = false;

  constructor(private readonly deps: ConfigDiscoveryDeps) {
    fs.mkdirSync(repoConfigsDir(deps.stateDir), { recursive: true });
    const { dir, name } = nearestWatchTarget(repoConfigsPath(deps.stateDir));
    this.answersWatch = deps.watchers.acquire(
      `repo-configs:${dir}/${name}`,
      { dirs: [{ path: dir, filenames: [name] }] },
      () => this.heard(this.asking(), "answers-watch"),
    );
  }

  // [LAW:single-enforcer] The origins followed become exactly `origins`. Each
  // new one is discovered, all in one batch over one read of what origins
  // share, and its watch acquired before any let go is released, so a
  // directory both name keeps its OS handle. Answers the newly followed.
  follow(origins: readonly RenderOrigin[]): readonly RenderOrigin[] {
    if (this.closed) return [];
    const wanted = new Map(origins.map((o) => [originKey(o), o]));
    const fresh = [...wanted].filter(([key]) => !this.followed.has(key));
    const gone = [...this.followed].filter(([key]) => !wanted.has(key));
    if (fresh.length + gone.length === 0) return [];
    if (fresh.length > 0) {
      const shared = readShared(this.deps);
      for (const [key, origin] of fresh)
        this.followed.set(key, this.discovered(origin, shared, null));
    }
    for (const [key, { watch }] of gone) {
      this.followed.delete(key);
      watch.handle.release();
    }
    this.deps.log(
      "info",
      `config discovery why=follow followed=${this.followed.size} discovered=${fresh.length} released=${gone.length}`,
    );
    return fresh.map(([, origin]) => origin);
  }

  // What discovery found at `origin` last: null while it is not followed.
  snapshotOf(origin: RenderOrigin): ConfigSnapshot | null {
    return this.followed.get(originKey(origin))?.snapshot ?? null;
  }

  // A turn's changes landed on `files`, and, when `answered`, answers to the
  // trust book: every origin whose chain holds one of the files, or, for an
  // answer, every origin with a repository to ask about, is discovered again.
  // Answers those whose snapshot moved.
  landed(files: readonly string[], answered: boolean): readonly RenderOrigin[] {
    const touched = [...this.followed]
      .filter(
        ([, { snapshot }]) =>
          (answered && snapshot.repo !== null) ||
          snapshot.chain.some((l) => files.includes(l.path)),
      )
      .map(([key]) => key);
    return this.rediscovered(touched, "landed");
  }

  // [LAW:no-silent-failure] Every origin is discovered again, for `why`: what
  // a span of file events the OS did not deliver may have changed.
  again(why: string): void {
    this.heard([...this.followed.keys()], why);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.answersWatch.release();
    for (const { watch } of this.followed.values()) watch.handle.release();
    this.followed.clear();
  }

  // The origins an answer to the trust book can move.
  private asking(): readonly string[] {
    return [...this.followed]
      .filter(([, { snapshot }]) => snapshot.repo !== null)
      .map(([key]) => key);
  }

  // A watch heard `keys`' origins may have changed: those whose snapshot
  // moved go to the renderer.
  private heard(keys: readonly string[], why: string): void {
    if (this.closed) return;
    const moved = this.rediscovered(keys, why);
    if (moved.length > 0) this.deps.moved(moved);
  }

  // [LAW:single-enforcer] The one batch that discovers followed origins again:
  // one read of what they share, each origin's watch following where its
  // config can change now. Answers those whose snapshot digests anew.
  private rediscovered(
    keys: readonly string[],
    why: string,
  ): readonly RenderOrigin[] {
    if (keys.length === 0) return [];
    const shared = readShared(this.deps);
    const moved: RenderOrigin[] = [];
    for (const key of keys) {
      const was = this.followed.get(key);
      if (was === undefined) continue;
      const now = this.discovered(was.origin, shared, was.watch);
      this.followed.set(key, now);
      if (now.digest !== was.digest) moved.push(now.origin);
    }
    this.deps.log(
      "info",
      `config discovery why=${why} followed=${this.followed.size} discovered=${keys.length} moved=${moved.length}`,
    );
    return moved;
  }

  // What discovery finds at `origin` now, with its watch following the
  // targets that finding names, and what that watch cannot hear in the
  // snapshot.
  private discovered(
    origin: RenderOrigin,
    shared: SharedFacts,
    held: HeldWatch | null,
  ): Followed {
    const found = discover(
      {
        projectDir: origin.projectDir,
        configFile: origin.target.path,
        cwd: origin.cwd,
      },
      shared,
    );
    const key = originKey(origin);
    const paths = watchTargetsFor(origin, found);
    // [LAW:one-source-of-truth] The key names the origin, the target set and
    // the folders it binds, so the registry's `follow` rebinds exactly when
    // either moved.
    const spec = {
      ...paths,
      key: `config:${JSON.stringify(key)}:${paths.key}`,
    };
    // [LAW:single-enforcer] Any change an origin's watch hears re-resolves its
    // whole chain, so a higher-precedence file appearing supersedes a lower
    // one; which path changed does not filter it, as the origin already
    // scopes the watch set.
    const { watch, move } = this.deps.watchers.follow(held, spec, () =>
      this.heard([key], "config-watch"),
    );
    if (move === "rebound") this.bound(origin, paths);
    const snapshot: ConfigSnapshot = {
      ...found.snapshot,
      watch: watchFault("config watch", { derived: spec, held: watch }, null),
    };
    return { origin, snapshot, digest: digestOf(snapshot), watch };
  }

  // [LAW:nothing-unseen] A rebind is the fact that the target set moved (a
  // candidate appeared, a link was re-pointed), and which directories the
  // origin now hears: a change that fires nothing is read against this line.
  private bound(origin: RenderOrigin, paths: PathsWatch): void {
    const { projectDir, cwd } = origin;
    this.deps.log(
      "info",
      `config watch bound projectDir=${projectDir} cwd=${cwd} dirs=${paths.targets.dirs.map((d) => d.path).join(",")}`,
    );
    for (const { path: p, reason } of paths.unresolved)
      this.deps.log(
        "warn",
        `config watch unresolved projectDir=${projectDir} path=${p} reason=${reason}`,
      );
  }
}

// [LAW:single-enforcer] Where an origin's config can change: every candidate
// location of its chain, there or not, every plugin root searched and the
// project's own, and every definition it loads or lists. Installing, fixing
// or editing a definition moves the config as an edit to the file would. An
// existing root is watched for every child: a folder made in it is a plugin
// installed. The project's plugin folder is consulted whatever its answer: a
// plugin dropped there is a question to ask.
function watchTargetsFor(origin: RenderOrigin, found: Discovered): PathsWatch {
  const { snapshot, targets } = found;
  const roots = [
    ...new Set([
      ...targets.roots,
      path.join(origin.projectDir, REPO_PLUGIN_DIR),
    ]),
  ];
  return watchTargetsOf({
    named: [
      ...targets.candidates,
      ...roots,
      ...snapshot.plugins.map((p) => p.path),
      ...snapshot.chain.flatMap((l) =>
        Object.values(l.listed).map((p) => p.path),
      ),
    ],
    whole: roots,
  });
}
