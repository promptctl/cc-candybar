// [LAW:single-enforcer] The host's one config discovery: what is found at
// every origin the renderer names, and the one watch per origin that says
// when that may have moved. The renderer reads every config text from what
// this hands it, and opens no file. (docs/design/host-and-renderer.md §6, §7)
//
// [LAW:one-source-of-truth] A snapshot is a fact about an origin. Every
// renderer whose latest output names that origin holds the same snapshot
// and watch, until the last renderer lets it go.

import path from "node:path";
import { originKey, type RenderOrigin } from "../../config-hint.js";
import type {
  ConfigSnapshot,
  LayerRole,
} from "../../config/config-snapshot.js";
import {
  discover,
  readShared,
  type Discovered,
  type DiscoveryWorld,
  type SharedFacts,
} from "./discover.js";
import type { DiscoveryFiles } from "./discovery-files.js";
import { REPO_PLUGIN_DIR } from "./plugin-folders.js";
import { repoConfigsPath } from "./repo-configs.js";
import { digestOf } from "../../utils/plain.js";
import type { DaemonLogger } from "../../utils/logger.js";
import type { WatcherRegistry } from "../cache/watchers.js";
import type { RendererName } from "../foundations/renderer-name.js";
import {
  watchFault,
  watchTargetsOf,
  type HeldWatch,
  type PathsWatch,
  type WatcherHandle,
} from "../foundations/watch-targets.js";

// One origin followed: what discovery found there last, its digest, and the
// watch over where that can change.
interface ObservedOrigin {
  readonly origin: RenderOrigin;
  readonly snapshot: ConfigSnapshot;
  readonly digest: string;
  readonly watch: HeldWatch;
}

interface Followed extends ObservedOrigin {
  readonly renderers: Set<RendererName>;
}

// The config facts available to one renderer and the demands it can replace.
export interface RendererConfigs {
  follow(origins: readonly RenderOrigin[]): void;
  snapshotOf(origin: RenderOrigin): ConfigSnapshot | null;
  path(origin: RenderOrigin, role: LayerRole): string | null | undefined;
  repoDir(origin: RenderOrigin): string | null | undefined;
  landed(files: readonly string[], answered: boolean): readonly RenderOrigin[];
}

export interface ConfigDiscoveryDeps extends DiscoveryWorld {
  readonly watchers: Pick<WatcherRegistry, "acquire" | "follow">;
  readonly files?: DiscoveryFiles;
  readonly log: DaemonLogger;
  // [LAW:effects-at-boundaries] Where the origins whose snapshot a watch
  // moved go: each live holder's `config` turns.
  readonly moved: (
    renderer: RendererName,
    origins: readonly RenderOrigin[],
  ) => void;
}

export class ConfigDiscovery {
  private readonly followed = new Map<string, Followed>();
  // [LAW:one-source-of-truth] The user's answers for repositories are one
  // fact for the whole daemon, so one watch follows them, never one per
  // origin.
  private readonly answersWatch: WatcherHandle;
  private closed = false;

  constructor(private readonly deps: ConfigDiscoveryDeps) {
    const answers = repoConfigsPath(deps.stateDir);
    this.answersWatch = deps.watchers.acquire(
      `repo-configs:${answers}`,
      { dirs: [], polled: [answers] },
      () => this.heard(this.asking(), "answers-watch"),
    );
  }

  // [LAW:single-enforcer] Use the same holder to name demands, send a config
  // turn and resolve edits. A queued reload for a dropped origin cannot read
  // through another renderer's hold.
  forRenderer(renderer: RendererName): RendererConfigs {
    const held = (origin: RenderOrigin): ConfigSnapshot | undefined => {
      const followed = this.followed.get(originKey(origin));
      return followed?.renderers.has(renderer) ? followed.snapshot : undefined;
    };
    return {
      follow: (origins) => this.follow(renderer, origins),
      snapshotOf: (origin) => held(origin) ?? null,
      path: (origin, role) => {
        const snapshot = held(origin);
        return snapshot === undefined
          ? undefined
          : (snapshot.chain.find((layer) => layer.role === role)?.path ?? null);
      },
      repoDir: (origin) => {
        const snapshot = held(origin);
        return snapshot === undefined
          ? undefined
          : (snapshot.repo?.dir ?? null);
      },
      landed: (files, answered) => this.landed(renderer, files, answered),
    };
  }

  // [LAW:single-enforcer] Only this renderer's demands are replaced. Acquire
  // any new watches in one batch before releasing the final holds, so a
  // directory both name keeps its OS handle.
  private follow(
    renderer: RendererName,
    origins: readonly RenderOrigin[],
  ): void {
    if (this.closed) return;
    const wanted = new Map(origins.map((o) => [originKey(o), o]));
    const fresh = [...wanted].filter(([key]) => !this.followed.has(key));
    if (fresh.length > 0) {
      const shared = readShared(this.deps, this.deps.files);
      for (const [key, origin] of fresh)
        this.followed.set(key, {
          ...this.discovered(origin, shared, null),
          renderers: new Set([renderer]),
        });
    }
    let released = 0;
    for (const [key, { renderers, watch }] of this.followed) {
      if (wanted.has(key)) {
        renderers.add(renderer);
        continue;
      }
      if (!renderers.delete(renderer) || renderers.size > 0) continue;
      this.followed.delete(key);
      watch.handle.release();
      released++;
    }
    if (fresh.length + released === 0) return;
    this.deps.log(
      "info",
      `config discovery why=follow followed=${this.followed.size} discovered=${fresh.length} released=${released}`,
    );
  }

  // A turn's changes landed on `files`, and, when `answered`, answers to the
  // trust book: every origin whose chain holds one of the files, or, for an
  // answer, every origin with a repository to ask about, is discovered again.
  // The writer reloads in this slot; the other holders get their own turns.
  private landed(
    writer: RendererName,
    files: readonly string[],
    answered: boolean,
  ): readonly RenderOrigin[] {
    const touched = [...this.followed]
      .filter(
        ([, { snapshot }]) =>
          (answered && snapshot.repo !== null) ||
          snapshot.chain.some((l) => files.includes(l.path)),
      )
      .map(([key]) => key);
    return this.publish(this.rediscovered(touched, "landed"), writer);
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
    this.publish(this.rediscovered(keys, why), null);
  }

  // [LAW:single-enforcer] The snapshot's current holders define recipients
  // for both a watch and a landed write. Only the writer already has a slot.
  private publish(
    moved: readonly Followed[],
    writer: RendererName | null,
  ): readonly RenderOrigin[] {
    const byRenderer = new Map<RendererName, RenderOrigin[]>();
    for (const { origin, renderers } of moved)
      for (const renderer of renderers) {
        const origins = byRenderer.get(renderer) ?? [];
        origins.push(origin);
        byRenderer.set(renderer, origins);
      }
    for (const [renderer, origins] of byRenderer)
      if (renderer !== writer) this.deps.moved(renderer, origins);
    return writer === null ? [] : (byRenderer.get(writer) ?? []);
  }

  // [LAW:single-enforcer] The one batch that discovers followed origins again:
  // one read of what they share, each origin's watch following where its
  // config can change now. Answers those whose snapshot digests anew.
  private rediscovered(
    keys: readonly string[],
    why: string,
  ): readonly Followed[] {
    if (keys.length === 0) return [];
    const shared = readShared(this.deps, this.deps.files);
    const moved: Followed[] = [];
    for (const key of keys) {
      const was = this.followed.get(key);
      if (was === undefined) continue;
      const now = {
        ...this.discovered(was.origin, shared, was.watch),
        renderers: was.renderers,
      };
      this.followed.set(key, now);
      if (now.digest !== was.digest) moved.push(now);
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
  ): ObservedOrigin {
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
      `config watch bound projectDir=${projectDir} cwd=${cwd} dirs=${paths.targets.dirs.map((d) => d.path).join(",")} polled=${paths.targets.polled.join(",")}`,
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
