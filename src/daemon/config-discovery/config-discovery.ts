// [LAW:single-enforcer] The host's one config discovery: what is found at
// every origin the renderer names, and the one watch per origin that says
// when that may have moved. The renderer reads every config text from what
// this hands it, and opens no file. (docs/design/host-and-renderer.md §6, §7)
//
// [LAW:one-source-of-truth] A snapshot is a fact about an origin. Every
// renderer whose latest output names that origin holds the same snapshot
// and watch, until the last renderer lets it go.

import { originKey, type RenderOrigin } from "../../config-hint.js";
import type { ConfigSelection } from "../../renderer-interface/interface.js";
import {
  retainsConfig,
  type ConfigSnapshot,
  type LayerRole,
} from "../../config/config-snapshot.js";
import {
  discover,
  readShared,
  type Discovered,
  type DiscoveryWorld,
  type SharedFacts,
} from "./discover.js";
import { diskFiles, textFrom, type DiscoveryFiles } from "./discovery-files.js";
import { ConfigText } from "./config-text.js";
import {
  readTextIfPresent,
  type withRegularTextFile,
} from "../../utils/regular-text.js";
import {
  absentPolledEntry,
  type FileObservations,
} from "../foundations/polled-entry.js";
import { configQuery } from "../../config/loader/chain-places.js";
import { resolvedTarget } from "../../utils/atomic-write.js";
import { directoryEntries } from "../../utils/directory-entry.js";
import { digestOf } from "../../utils/plain.js";
import type { DaemonLogger } from "../../utils/logger.js";
import type { WatcherRegistry } from "../cache/watchers.js";
import type { RendererName } from "../foundations/renderer-name.js";
import type { ThrewSink } from "../foundations/verb-error.js";
import { eventLine } from "../../utils/logfmt.js";
import {
  watchFault,
  watchTargetsOf,
  type HeldWatch,
  type PathsWatch,
  type WatchMove,
} from "../foundations/watch-targets.js";

interface ObservedConfig {
  readonly origin: RenderOrigin;
  readonly snapshot: ConfigSnapshot;
  readonly digest: string;
  readonly managedFolders: ReadonlySet<string>;
}

// One origin followed: what discovery found there last, and the watch over
// where that can change.
interface ObservedOrigin extends ObservedConfig {
  readonly watch: HeldWatch;
  readonly landingPaths: ReadonlySet<string>;
}

interface Followed extends ObservedOrigin {
  // [LAW:one-source-of-truth] Each renderer holding the origin, and the
  // digest it was last handed: a holder whose digest differs from the
  // origin's is owed the origin, whatever threw since it moved.
  readonly holders: Map<RendererName, string>;
  // One selected committed input per renderer; null represents a fallback
  // entry. Absence is a followed origin with no entry to reconstruct.
  readonly selected: Map<RendererName, ObservedConfig | null>;
}

// What discovery found at an origin, and the watch now following it.
interface Watched {
  readonly origin: RenderOrigin;
  readonly found: Discovered;
  readonly spec: PathsWatch;
  readonly watch: HeldWatch;
  readonly move: WatchMove;
}

interface DiscoveryBatch {
  readonly facts: SharedFacts;
  readonly observed: FileObservations;
  readonly landingPath: (file: string) => string;
}

// The config facts available to one renderer and the demands it can replace.
export interface RendererConfigs {
  follow(origins: readonly RenderOrigin[]): void;
  snapshotOf(origin: RenderOrigin): ConfigSnapshot | null;
  selected(
    entries: readonly ConfigSelection[],
    delivered: (origin: RenderOrigin) => ConfigSnapshot | undefined,
  ): void;
  retainedOf(origin: RenderOrigin): ConfigSnapshot | "current" | undefined;
  path(origin: RenderOrigin, role: LayerRole): string | null | undefined;
  repoDir(origin: RenderOrigin): string | null | undefined;
  readText(file: string): string | null;
  landed(files: readonly string[]): readonly RenderOrigin[];
}

export interface ConfigDiscoveryDeps extends DiscoveryWorld {
  // One physical discovery batch can repair source watches for several renderers.
  readonly reloaded?: (folders: ReadonlySet<string>) => void;
  readonly watchers: Pick<WatcherRegistry, "batch">;
  readonly files?: () => Partial<Omit<DiscoveryFiles, "stateText">>;
  readonly openText?: typeof withRegularTextFile;
  readonly log: DaemonLogger;
  // Where an origin's rediscovery or a renderer's hand-off that threw is
  // reported. What it owed stays owed for the next batch.
  readonly failed: ThrewSink;
  // [LAW:effects-at-boundaries] Where the origins whose snapshot a watch
  // moved go: each live holder's `config` turns.
  readonly moved: (
    renderer: RendererName,
    origins: readonly RenderOrigin[],
  ) => void;
}

export class ConfigDiscovery {
  private readonly followed = new Map<string, Followed>();
  // [LAW:carrying-cost] Reuse discovery's digest for an immutable offered
  // snapshot. A weak key cannot hold an old revision after its last owner.
  private readonly observations = new WeakMap<ConfigSnapshot, ObservedConfig>();
  private readonly watches: ReturnType<WatcherRegistry["batch"]>;
  // [LAW:one-source-of-truth] The origins owed a rediscovery. One leaves only
  // once its own rediscovery has written its entry.
  private readonly owed = new Set<string>();
  private readonly texts: ConfigText;
  private closed = false;

  constructor(private readonly deps: ConfigDiscoveryDeps) {
    this.texts = new ConfigText(deps.openText);
    // [LAW:one-source-of-truth] Every origin follows the files it consulted.
    // The shared registry polls each path once across their subscriptions.
    // [LAW:single-enforcer] One watch delivery window for all config origins
    // means one discovery batch for the paths an event made relevant.
    this.watches = deps.watchers.batch("config discovery", () => {
      this.heard([], "config-watch", "observed", null);
    });
  }

  // [LAW:single-enforcer] Use the same holder to name demands, send a config
  // turn and resolve edits. A queued reload for a dropped origin cannot read
  // through another renderer's hold.
  forRenderer(renderer: RendererName): RendererConfigs {
    const held = (origin: RenderOrigin): ConfigSnapshot | undefined => {
      const followed = this.followed.get(originKey(origin));
      return followed?.holders.has(renderer) ? followed.snapshot : undefined;
    };
    return {
      follow: (origins) => this.follow(renderer, origins),
      snapshotOf: (origin) => held(origin) ?? null,
      selected: (entries, delivered) =>
        this.select(renderer, entries, delivered),
      retainedOf: (origin) => this.retainedOf(renderer, origin),
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
      // [LAW:one-source-of-truth] Writes reobserve the destination using the
      // same descriptor cache as discovery. The held snapshots only name it.
      readText: (file) =>
        readTextIfPresent(file, (at) => this.texts.read(at).text),
      landed: (files) => this.landed(renderer, files),
    };
  }

  // [LAW:single-enforcer] Only discoveries held by this renderer can
  // introduce a folder. A still-declared folder can outlive a discovery when
  // a last-good or retired in-flight config uses it. Once let go, that prior
  // admission gives no authority to acquire it anew.
  admitManagedFolders(
    renderer: RendererName,
    requested: readonly string[],
    previous: ReadonlySet<string> | undefined,
  ): ReadonlySet<string> {
    if (this.closed) return new Set();
    const wanted = new Set(requested);
    if (
      previous?.size === wanted.size &&
      [...wanted].every((f) => previous.has(f))
    )
      return previous;
    const admitted = new Set<string>();
    const take = (known: ReadonlySet<string>): void => {
      for (const folder of wanted)
        if (known.has(folder)) {
          wanted.delete(folder);
          admitted.add(folder);
        }
    };
    if (previous !== undefined) take(previous);
    for (const followed of this.followed.values()) {
      if (wanted.size === 0) break;
      if (!followed.holders.has(renderer)) continue;
      take(followed.managedFolders);
      const retained = this.retainedOf(renderer, followed.origin);
      if (retained === "current" || retained === undefined) continue;
      const observation = this.observations.get(retained);
      if (observation !== undefined) take(observation.managedFolders);
    }
    return admitted;
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
      const shared = this.batch();
      const observed: ObservedConfig[] = [];
      for (const [key, origin] of fresh) {
        const watched = this.watched(origin, shared, null);
        // An acquired watch belongs to the origin's entry or is let go: a
        // throw before the entry exists leaves no holder behind.
        let found: ObservedOrigin;
        try {
          found = this.observedAt(watched, shared);
        } catch (thrown) {
          watched.watch.handle.release();
          throw thrown;
        }
        // The renderer's own turn reads this snapshot: it holds the digest.
        this.followed.set(key, {
          ...found,
          holders: new Map([[renderer, found.digest]]),
          selected: new Map(),
        });
        observed.push(found);
      }
      this.reloaded(observed);
    }
    let released = 0;
    for (const [key, { holders, selected, watch, digest }] of this.followed) {
      if (wanted.has(key)) {
        holders.set(renderer, holders.get(renderer) ?? digest);
        continue;
      }
      selected.delete(renderer);
      if (!holders.delete(renderer) || holders.size > 0) continue;
      this.followed.delete(key);
      this.owed.delete(key);
      watch.handle.release();
      released++;
    }
    // [LAW:nothing-unseen] One record per follow, one that changed nothing
    // included.
    this.deps.log(
      "info",
      eventLine("config discovery", [
        ["why", "follow"],
        ["followed", String(this.followed.size)],
        ["observed", String(fresh.length)],
        ["released", String(released)],
      ]),
    );
  }

  // [LAW:single-enforcer] The renderer can keep its earlier selection or
  // select an input actually delivered to it. Resolve the whole declaration
  // before replacing its references, including a release with no selection.
  private select(
    renderer: RendererName,
    entries: readonly ConfigSelection[],
    delivered: (origin: RenderOrigin) => ConfigSnapshot | undefined,
  ): void {
    if (this.closed) return;
    const next = new Map<string, ObservedConfig | null>();
    for (const { origin, digest } of entries) {
      const key = originKey(origin);
      const followed = this.followed.get(key);
      if (!followed?.holders.has(renderer))
        throw new Error(`selected config origin is not followed: ${key}`);
      if (digest === null) {
        next.set(key, null);
        continue;
      }
      const previous = followed.selected.get(renderer);
      const offered = delivered(origin);
      const observation =
        previous?.digest === digest
          ? previous
          : offered === undefined
            ? undefined
            : this.observations.get(offered);
      if (
        observation?.digest !== digest ||
        originKey(observation.origin) !== key
      )
        throw new Error(`selected config revision was not delivered: ${key}`);
      const shared = [...followed.selected.values()].find(
        (held) => held?.digest === digest,
      );
      next.set(key, shared ?? observation);
    }
    for (const [key, { selected }] of this.followed) {
      const observation = next.get(key);
      if (observation === undefined) selected.delete(renderer);
      else selected.set(renderer, observation);
    }
  }

  private retainedOf(
    renderer: RendererName,
    origin: RenderOrigin,
  ): ConfigSnapshot | "current" | undefined {
    const followed = this.followed.get(originKey(origin));
    const old = followed?.selected.get(renderer);
    if (followed === undefined || old === undefined) return undefined;
    if (old === null || old.digest === followed.digest) return "current";
    return retainsConfig(
      origin.target,
      old.snapshot.repo,
      followed.snapshot.repo,
    )
      ? old.snapshot
      : "current";
  }

  // Rediscover origins watching a file the turn wrote or could not restore.
  // The writer reloads in this slot; the other holders get their own turns.
  private landed(
    writer: RendererName,
    files: readonly string[],
  ): readonly RenderOrigin[] {
    const landingPath = directoryEntries();
    const changed = files.flatMap((file) => [file, landingPath(file)]);
    const touched = [...this.followed]
      .filter(([, { landingPaths }]) =>
        changed.some((file) => landingPaths.has(file)),
      )
      .map(([key]) => key);
    return this.heard(touched, "landed", "observed", writer);
  }

  // [LAW:no-silent-failure] Every origin is discovered again, for `why`: what
  // a span of file events the OS did not deliver may have changed.
  again(why: string): void {
    this.heard([...this.followed.keys()], why, "moved", null);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.owed.clear();
    for (const { watch } of this.followed.values()) watch.handle.release();
    this.followed.clear();
    this.texts.clear();
  }

  // [LAW:single-enforcer] The one discovery batch, for a watch, a write and a
  // catch-up alike: `keys` join the origins owed a rediscovery, every owed
  // origin is discovered again, and every holder is handed what it is owed.
  // Answers the writer's own origins, for its slot.
  private heard(
    keys: readonly string[],
    why: string,
    recover: "observed" | "moved",
    writer: RendererName | null,
  ): readonly RenderOrigin[] {
    if (this.closed) return [];
    for (const key of keys) this.owed.add(key);
    const { observed, moved } = this.rediscovered(why);
    const { handed, sent } = this.publish(writer);
    // [LAW:nothing-unseen] One record per batch, one that changed nothing
    // included; `owed` counts the origins a throw left for the next batch.
    this.deps.log(
      "info",
      eventLine("config discovery", [
        ["why", why],
        ["followed", String(this.followed.size)],
        ["observed", String(observed.length)],
        ["moved", String(moved.length)],
        ["sent", String(sent)],
        ["owed", String(this.owed.size)],
      ]),
    );
    // A targeted watch or write can retry even if the snapshot is unchanged.
    // A broad catch-up already has its own storage recovery trigger.
    this.reloaded(recover === "observed" ? observed : moved);
    return handed;
  }

  // [LAW:one-source-of-truth] Recipients come from what each holder was last
  // handed: every holder whose digest differs from its origin's, whichever
  // batch moved the origin and whatever threw since. The writer's come back
  // for its own slot; every other renderer gets its turns.
  private publish(writer: RendererName | null): {
    readonly handed: readonly RenderOrigin[];
    readonly sent: number;
  } {
    const owedBy = new Map<RendererName, Followed[]>();
    for (const followed of this.followed.values())
      for (const [renderer, digest] of followed.holders)
        if (digest !== followed.digest)
          owedBy.set(renderer, [...(owedBy.get(renderer) ?? []), followed]);
    let sent = 0;
    for (const [renderer, owed] of owedBy) {
      if (renderer === writer) continue;
      // [LAW:no-silent-failure] A hand-off that threw is reported, and the
      // renderer stays owed its origins for the next batch.
      try {
        this.deps.moved(
          renderer,
          owed.map(({ origin }) => origin),
        );
        handedTo(renderer, owed);
        sent++;
      } catch (thrown) {
        this.deps.failed(
          "config hand-off threw",
          [["renderer", renderer]],
          thrown,
        );
      }
    }
    if (writer === null) return { handed: [], sent };
    const mine = owedBy.get(writer) ?? [];
    handedTo(writer, mine);
    return { handed: mine.map(({ origin }) => origin), sent };
  }

  // [LAW:single-enforcer] Discovers every owed origin again: one read of what
  // they share, each origin's watch following where its config can change
  // now. An origin leaves the owed set once its own entry is written.
  private rediscovered(why: string): {
    readonly observed: readonly ObservedConfig[];
    readonly moved: readonly ObservedConfig[];
  } {
    const owed = [...this.followed].filter(([key]) => this.owed.has(key));
    const observed: ObservedConfig[] = [];
    const moved: ObservedConfig[] = [];
    // [LAW:carrying-cost] A batch that owes nothing reads nothing shared.
    if (owed.length === 0) return { observed, moved };
    const shared = this.batch();
    for (const [key, was] of owed) {
      // [LAW:no-silent-failure] An origin whose rediscovery threw is reported
      // and stays owed. Another origin's change still lands and is handed on.
      try {
        const watched = this.watched(was.origin, shared, was.watch);
        // [LAW:one-source-of-truth] The entry holds the watch it now follows
        // before anything else can throw: a rebound watch is never orphaned,
        // and a released one is never kept.
        this.followed.set(key, { ...was, watch: watched.watch });
        const found = this.observedAt(watched, shared);
        const now = {
          ...found,
          snapshot: found.digest === was.digest ? was.snapshot : found.snapshot,
          holders: was.holders,
          selected: was.selected,
        };
        this.followed.set(key, now);
        this.owed.delete(key);
        observed.push(now);
        if (now.digest !== was.digest) moved.push(now);
      } catch (thrown) {
        this.deps.failed(
          "config discovery threw",
          [
            ["origin", key],
            ["why", why],
          ],
          thrown,
        );
      }
    }
    return { observed, moved };
  }

  private reloaded(observed: readonly ObservedConfig[]): void {
    if (this.deps.reloaded === undefined) return;
    const folders = new Set<string>();
    for (const { managedFolders } of observed)
      for (const folder of managedFolders) folders.add(folder);
    if (folders.size > 0) this.deps.reloaded(folders);
  }

  // [LAW:single-enforcer] The observation supplied to a poll watch comes
  // from the same descriptor as the snapshot's text.
  private batch(): DiscoveryBatch {
    const observed = new Map<string, string>();
    const readText = (file: string): string => {
      const read = this.texts.read(file);
      observed.set(file, read.entry);
      return read.text;
    };
    const facts = readShared(this.deps, {
      ...diskFiles,
      text: textFrom(readText),
      ...this.deps.files?.(),
      stateText: (file) => {
        const target = resolvedTarget(file);
        const text = readTextIfPresent(target, readText);
        // [LAW:one-source-of-truth] The book and its writer use the same
        // final target. A dangling link itself is still present to lstat.
        if (text === null) observed.set(target, absentPolledEntry);
        return text;
      },
    });
    return {
      facts,
      observed,
      landingPath: directoryEntries(facts.files.realpath),
    };
  }

  // What discovery finds at `origin` now, with its watch following the
  // targets that finding names. The caller owns the watch from here.
  private watched(
    origin: RenderOrigin,
    shared: DiscoveryBatch,
    held: HeldWatch | null,
  ): Watched {
    const found = discover(
      {
        ...configQuery(origin.projectDir, origin.target),
        cwd: origin.cwd,
      },
      shared.facts,
    );
    const key = originKey(origin);
    const paths = watchTargetsFor(found);
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
    const { watch, move } = this.watches.follow(
      held,
      spec,
      () => {
        this.owed.add(key);
      },
      shared.observed,
    );
    return { origin, found, spec, watch, move };
  }

  // The watched origin's snapshot, with what its watch cannot hear. Runs
  // once the caller owns the watch, so nothing here can orphan it.
  private observedAt(
    { origin, found, spec, watch, move }: Watched,
    shared: DiscoveryBatch,
  ): ObservedOrigin {
    if (move === "rebound") this.bound(origin, spec);
    const snapshot: ConfigSnapshot = {
      ...found.snapshot,
      watch: watchFault("config watch", { derived: spec, held: watch }, null),
    };
    const managedFolders = new Set(
      pluginFiles(snapshot).flatMap(({ definition }) =>
        definition.kind === "text" ? [definition.storage] : [],
      ),
    );
    const observed = {
      origin,
      snapshot,
      digest: digestOf(snapshot),
      managedFolders,
    };
    this.observations.set(snapshot, observed);
    return {
      ...observed,
      watch,
      landingPaths: new Set(
        spec.targets.polled.flatMap((file) => [file, shared.landingPath(file)]),
      ),
    };
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

// `renderer` was handed each of `origins` as it stands now.
function handedTo(renderer: RendererName, origins: readonly Followed[]): void {
  for (const { holders, digest } of origins) holders.set(renderer, digest);
}

// [LAW:single-enforcer] Where an origin's config can change: every candidate
// location of its chain, there or not, every plugin root searched and the
// project's own, and every definition it loads or lists. Installing, fixing
// or editing a definition moves the config as an edit to the file would. An
// existing root is watched for every child: a folder made in it is a plugin
// installed. The project's plugin folder is consulted whatever its answer: a
// plugin dropped there is a question to ask.
function watchTargetsFor(found: Discovered): PathsWatch {
  const { snapshot, targets } = found;
  const { roots } = targets;
  return watchTargetsOf({
    named: [
      ...targets.files,
      ...roots,
      ...pluginFiles(snapshot).map((p) => p.path),
    ],
    whole: roots,
  });
}

function pluginFiles(snapshot: ConfigSnapshot) {
  return [
    ...snapshot.plugins,
    ...snapshot.chain.flatMap((layer) => Object.values(layer.listed)),
  ];
}
