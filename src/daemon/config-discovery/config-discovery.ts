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
import { eventLine, type Field } from "../../utils/logfmt.js";
import type { DaemonLogger } from "../../utils/logger.js";
import type { WatcherRegistry } from "../cache/watchers.js";
import type { RendererName } from "../foundations/renderer-name.js";
import type { WorkThrew } from "../foundations/work-threw.js";
import {
  watchFault,
  watchTargetsOf,
  type HeldWatch,
  type PathsWatch,
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

// [LAW:effects-at-boundaries] Where a holder's moved origins go: its own
// `config` turns.
type Moved = (origins: readonly RenderOrigin[]) => void;

// [LAW:one-source-of-truth] Whether a change may have moved an origin that no
// batch has discovered again. One per origin, carried from each entry to the
// next, so the watch that hears the change and the batch that discovers it
// share it, and releasing the origin releases it.
interface Debt {
  owed: boolean;
}

// What starts a batch: a renderer's write landing (answered in its own
// slot), the config watch's delivery window, or catching up on events the OS
// did not deliver.
type Trigger =
  | { readonly kind: "landed"; readonly writer: RendererName }
  | { readonly kind: "config-watch" }
  | { readonly kind: "again"; readonly why: string };

interface Followed extends ObservedOrigin {
  // Each holder, by where its moved origins go.
  readonly renderers: Map<RendererName, Moved>;
  readonly debt: Debt;
  // One selected committed input per renderer; null represents a fallback
  // entry. Absence is a followed origin with no entry to reconstruct.
  readonly selected: Map<RendererName, ObservedConfig | null>;
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
  // [LAW:no-silent-failure] Where an origin that could not be discovered
  // again is reported. It stays owed to the next batch.
  readonly threw: WorkThrew;
}

export class ConfigDiscovery {
  private readonly followed = new Map<string, Followed>();
  // [LAW:carrying-cost] Reuse discovery's digest for an immutable offered
  // snapshot. A weak key cannot hold an old revision after its last owner.
  private readonly observations = new WeakMap<ConfigSnapshot, ObservedConfig>();
  private readonly watches: ReturnType<WatcherRegistry["batch"]>;
  private readonly texts: ConfigText;
  private closed = false;

  constructor(private readonly deps: ConfigDiscoveryDeps) {
    this.texts = new ConfigText(deps.openText);
    // [LAW:one-source-of-truth] Every origin follows the files it consulted.
    // The shared registry polls each path once across their subscriptions.
    // [LAW:single-enforcer] One watch delivery window for all config origins
    // means one discovery batch for the paths an event made relevant.
    this.watches = deps.watchers.batch("config-discovery", () =>
      this.rediscovered({ kind: "config-watch" }),
    );
  }

  // [LAW:single-enforcer] Use the same holder to name demands, send a config
  // turn and resolve edits. A queued reload for a dropped origin cannot read
  // through another renderer's hold. `moved` is where its origins go when a
  // batch it did not start moves them.
  forRenderer(renderer: RendererName, moved: Moved): RendererConfigs {
    const held = (origin: RenderOrigin): ConfigSnapshot | undefined => {
      const followed = this.followed.get(originKey(origin));
      return followed?.renderers.has(renderer) ? followed.snapshot : undefined;
    };
    return {
      follow: (origins) => this.follow(renderer, moved, origins),
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
      if (!followed.renderers.has(renderer)) continue;
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
    moved: Moved,
    origins: readonly RenderOrigin[],
  ): void {
    if (this.closed) return;
    const wanted = new Map(origins.map((o) => [originKey(o), o]));
    const fresh = [...wanted].filter(([key]) => !this.followed.has(key));
    const observed: ObservedConfig[] = [];
    // [LAW:no-silent-failure] A fresh origin that cannot be discovered throws
    // to the caller, once the origins already followed are settled: their
    // folders rechecked, this renderer's holds replaced.
    try {
      if (fresh.length > 0) {
        const shared = this.batch();
        for (const [key, origin] of fresh)
          observed.push(
            this.discovered(key, origin, shared, null, {
              renderers: new Map([[renderer, moved]]),
              selected: new Map(),
              debt: { owed: false },
            }),
          );
      }
    } finally {
      this.reloaded(observed);
      let released = 0;
      for (const [key, { renderers, selected, watch }] of this.followed) {
        if (wanted.has(key)) {
          renderers.set(renderer, moved);
          continue;
        }
        selected.delete(renderer);
        if (!renderers.delete(renderer) || renderers.size > 0) continue;
        this.followed.delete(key);
        watch.handle.release();
        released++;
      }
      if (observed.length + released > 0)
        this.deps.log(
          "info",
          eventLine("config discovery", [
            ["why", "follow"],
            ["followed", String(this.followed.size)],
            ["discovered", String(observed.length)],
            ["released", String(released)],
          ]),
        );
    }
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
      if (!followed?.renderers.has(renderer))
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
    for (const { landingPaths, debt } of this.followed.values())
      if (changed.some((file) => landingPaths.has(file))) debt.owed = true;
    return this.rediscovered({ kind: "landed", writer });
  }

  // [LAW:no-silent-failure] Every origin is discovered again, for `why`: what
  // a span of file events the OS did not deliver may have changed.
  again(why: string): void {
    for (const { debt } of this.followed.values()) debt.owed = true;
    this.rediscovered({ kind: "again", why });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const { watch } of this.followed.values()) watch.handle.release();
    this.followed.clear();
    this.texts.clear();
  }

  // [LAW:single-enforcer] The snapshot's current holders define recipients
  // for both a watch and a landed write. Only the writer already has a slot,
  // and its origins are its answer.
  private publish(
    moved: readonly Followed[],
    writer: RendererName | null,
  ): readonly RenderOrigin[] {
    const byRenderer = new Map<
      RendererName,
      { readonly to: Moved; readonly origins: RenderOrigin[] }
    >();
    for (const { origin, renderers } of moved)
      for (const [renderer, to] of renderers) {
        const held = byRenderer.get(renderer) ?? { to, origins: [] };
        held.origins.push(origin);
        byRenderer.set(renderer, held);
      }
    for (const [renderer, { to, origins }] of byRenderer)
      if (renderer !== writer) to(origins);
    return writer === null ? [] : (byRenderer.get(writer)?.origins ?? []);
  }

  // [LAW:single-enforcer] The one batch that discovers the owed origins
  // again: one read of what they share, each origin's watch following where
  // its config can change now. Those whose snapshot digests anew go to their
  // holders; a landed write's writer has them as its answer.
  private rediscovered(trigger: Trigger): readonly RenderOrigin[] {
    const owed = [...this.followed].filter(([, { debt }]) => debt.owed);
    if (owed.length === 0) return [];
    const why = trigger.kind === "again" ? trigger.why : trigger.kind;
    const shared = this.batch();
    const moved: Followed[] = [];
    const observed: ObservedConfig[] = [];
    for (const [key, was] of owed) {
      // [LAW:no-silent-failure] An origin that cannot be observed keeps the
      // last snapshot and stays owed. Its failure cannot suppress a sibling's
      // already-observed change or reverse a successful write.
      try {
        const now = this.discovered(key, was.origin, shared, was, was);
        observed.push(now);
        if (now.digest !== was.digest) moved.push(now);
      } catch (thrown) {
        this.deps.threw(
          "config discovery threw",
          [
            ["why", why],
            ["origin", key],
          ],
          thrown,
        );
      }
    }
    // [LAW:no-ambient-temporal-coupling] The moved origins go to their
    // holders first: a holder's turn is queued, not run, so the recheck below
    // still lands before it, and nothing after can drop a change already
    // written to its entry.
    const answered = this.publish(
      moved,
      trigger.kind === "landed" ? trigger.writer : null,
    );
    this.deps.log(
      "info",
      eventLine("config discovery", [
        ["why", why],
        ["followed", String(this.followed.size)],
        ["discovered", String(owed.length)],
        ["moved", String(moved.length)],
        ["owed", String(owed.length - observed.length)],
      ]),
    );
    // A targeted watch or write can retry even if the snapshot is unchanged.
    // A broad catch-up already has its own storage recovery trigger.
    this.reloaded(trigger.kind === "again" ? moved : observed);
    return answered;
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

  // What discovery finds at `origin` now, written as its entry: its watch
  // following the targets that finding names, and what that watch cannot
  // hear in the snapshot. A snapshot that digests as `was` did stays `was`'s.
  private discovered(
    key: string,
    origin: RenderOrigin,
    shared: DiscoveryBatch,
    was: Followed | null,
    holders: Pick<Followed, "renderers" | "selected" | "debt">,
  ): Followed {
    const found = discover(
      {
        ...configQuery(origin.projectDir, origin.target),
        cwd: origin.cwd,
      },
      shared.facts,
    );
    const paths = watchTargetsFor(found);
    // [LAW:one-source-of-truth] The key names the origin, the target set and
    // the folders it binds, so the registry's `follow` rebinds exactly when
    // either moved.
    const spec = {
      ...paths,
      key: `config:${JSON.stringify(key)}:${paths.key}`,
    };
    const managedFolders = new Set(
      pluginFiles(found.snapshot).flatMap(({ definition }) =>
        definition.kind === "text" ? [definition.storage] : [],
      ),
    );
    const landingPaths = new Set(
      paths.targets.polled.flatMap((file) => [file, shared.landingPath(file)]),
    );
    // [LAW:no-ambient-temporal-coupling] Everything that can throw is above.
    // A rebind releases the held watch, so from here to the entry's write
    // nothing can throw: the snapshot is assembled from what is in hand and
    // digested as plain data.
    // [LAW:single-enforcer] Any change an origin's watch hears re-resolves its
    // whole chain, so a higher-precedence file appearing supersedes a lower
    // one; which path changed does not filter it, as the origin already
    // scopes the watch set.
    const { debt } = holders;
    const { watch, move } = this.watches.follow(
      was?.watch ?? null,
      spec,
      () => {
        debt.owed = true;
      },
      shared.observed,
    );
    const fresh: ConfigSnapshot = {
      ...found.snapshot,
      watch: watchFault("config watch", { derived: spec, held: watch }, null),
    };
    const digest = digestOf(fresh);
    const observed = {
      origin,
      snapshot: digest === was?.digest ? was.snapshot : fresh,
      digest,
      managedFolders,
    };
    this.observations.set(observed.snapshot, observed);
    const { renderers, selected } = holders;
    const entry = {
      ...observed,
      watch,
      landingPaths,
      renderers,
      selected,
      debt,
    };
    this.followed.set(key, entry);
    debt.owed = false;
    if (move === "rebound") this.bound(origin, paths);
    return entry;
  }

  // [LAW:nothing-unseen] A rebind is the fact that the target set moved (a
  // candidate appeared, a link was re-pointed), and which directories the
  // origin now hears: a change that fires nothing is read against this line.
  private bound(origin: RenderOrigin, paths: PathsWatch): void {
    const at: Field[] = [
      ["projectDir", origin.projectDir],
      ["cwd", origin.cwd],
    ];
    this.deps.log(
      "info",
      eventLine("config watch bound", [
        ...at,
        ["dirs", paths.targets.dirs.map((d) => d.path).join(",")],
        ["polled", paths.targets.polled.join(",")],
      ]),
    );
    for (const { path, reason } of paths.unresolved)
      this.deps.log(
        "warn",
        eventLine("config watch unresolved", [
          ...at,
          ["path", path],
          ["reason", reason],
        ]),
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
