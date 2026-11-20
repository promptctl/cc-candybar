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
import { eventLine } from "../../utils/logfmt.js";
import type { WatcherRegistry } from "../cache/watchers.js";
import type { RendererName } from "../foundations/renderer-name.js";
import type {
  FaultSource,
  StandingFaults,
} from "../foundations/standing-faults.js";
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

interface Followed extends ObservedOrigin {
  readonly renderers: Set<RendererName>;
  // [LAW:one-source-of-truth] The digest its holders were last handed. An
  // entry whose digest differs has a change still to hand off, whatever
  // stopped the batch that wrote it.
  handed: string;
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
  // Where an origin that cannot be discovered again, or a batch that could
  // not finish, stands until it does.
  readonly faults: StandingFaults;
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
  // Origins to discover again. One leaves only with the batch that discovered
  // it complete, so a throw anywhere in a batch leaves its work to the next.
  private readonly owed = new Set<string>();
  private readonly texts: ConfigText;
  private closed = false;

  constructor(private readonly deps: ConfigDiscoveryDeps) {
    this.texts = new ConfigText(deps.openText);
    // [LAW:one-source-of-truth] Every origin follows the files it consulted.
    // The shared registry polls each path once across their subscriptions.
    // [LAW:single-enforcer] One watch delivery window for all config origins
    // means one discovery batch for the paths an event made relevant.
    this.watches = deps.watchers.batch(() =>
      this.rediscover("config-watch", null, "observed"),
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
    origins: readonly RenderOrigin[],
  ): void {
    if (this.closed) return;
    const wanted = new Map(origins.map((o) => [originKey(o), o]));
    const fresh = [...wanted].filter(([key]) => !this.followed.has(key));
    if (fresh.length > 0) {
      const shared = this.batch();
      const observed: ObservedConfig[] = [];
      for (const [key, origin] of fresh) {
        const found = this.discovered(origin, shared, null);
        // Its follower reads it as it follows: nothing to hand off.
        this.followed.set(key, {
          ...found,
          renderers: new Set([renderer]),
          selected: new Map(),
          handed: found.digest,
        });
        observed.push(found);
      }
      this.reloaded(observed);
    }
    let released = 0;
    for (const [key, { origin, renderers, selected, watch }] of this.followed) {
      if (wanted.has(key)) {
        renderers.add(renderer);
        continue;
      }
      selected.delete(renderer);
      if (!renderers.delete(renderer) || renderers.size > 0) continue;
      this.followed.delete(key);
      this.owed.delete(key);
      this.deps.faults.clear(originFault(origin), "let go");
      watch.handle.release();
      released++;
    }
    if (fresh.length + released === 0) return;
    this.deps.log(
      "info",
      eventLine("config discovery", [
        ["why", "follow"],
        ["followed", String(this.followed.size)],
        ["discovered", String(fresh.length)],
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
    for (const [key, { landingPaths }] of this.followed)
      if (changed.some((file) => landingPaths.has(file))) this.owed.add(key);
    return this.rediscover("landed", writer, "observed");
  }

  // [LAW:no-silent-failure] Every origin is discovered again, for `why`: what
  // a span of file events the OS did not deliver may have changed.
  again(why: string): void {
    for (const key of this.followed.keys()) this.owed.add(key);
    this.rediscover(why, null, "moved");
  }

  // [LAW:no-silent-failure] Work a batch could not finish is done on the
  // daemon's period, so its fault never waits on an unrelated file event.
  // With nothing owed this costs nothing.
  retry(): void {
    if (this.owed.size > 0) this.rediscover("retry", null, "observed");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.owed.clear();
    for (const { origin, watch } of this.followed.values()) {
      this.deps.faults.clear(originFault(origin), "let go");
      watch.handle.release();
    }
    this.deps.faults.clear(BATCH_FAULT, "let go");
    this.followed.clear();
    this.texts.clear();
  }

  // [LAW:single-enforcer] The one batch, whatever asked for it: discover the
  // owed origins again, recheck their folders, and hand every change not yet
  // handed to its holders. Answers the writer's own changes, which it
  // reloads in its slot.
  // [LAW:no-silent-failure] A throw stands as the batch's fault until a batch
  // completes. What it left undone is still owed or unhanded, so the next
  // batch does it, and nothing is rethrown into whoever asked.
  private rediscover(
    why: string,
    writer: RendererName | null,
    rechecks: "observed" | "moved",
  ): readonly RenderOrigin[] {
    if (this.closed) return [];
    try {
      const { observed, discovered } = this.rediscovered();
      const unhanded = [...this.followed.values()].filter(
        ({ digest, handed }) => digest !== handed,
      );
      this.deps.log(
        "info",
        eventLine("config discovery", [
          ["why", why],
          ["followed", String(this.followed.size)],
          ["discovered", String(discovered.length)],
          ["moved", String(unhanded.length)],
          ["owed", String(this.owed.size - discovered.length)],
        ]),
      );
      // A targeted watch or write can retry even if the snapshot is unchanged.
      // A broad catch-up already has its own storage recovery trigger.
      // [LAW:no-ambient-temporal-coupling] Before the hand-off: an idle
      // holder's config turn starts inside it.
      this.reloaded(rechecks === "observed" ? observed : unhanded);
      for (const entry of unhanded) entry.handed = entry.digest;
      const answered = this.publish(unhanded, writer);
      for (const key of discovered) this.owed.delete(key);
      this.deps.faults.clear(BATCH_FAULT, "recovered");
      return answered;
    } catch (thrown) {
      this.deps.faults.raise(BATCH_FAULT, thrown);
      return [];
    }
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

  // The owed origins discovered again over one read of what they share, each
  // origin's watch following where its config can change now. Answers what
  // was observed and which owed keys were discovered.
  private rediscovered(): {
    readonly observed: readonly ObservedConfig[];
    readonly discovered: readonly string[];
  } {
    const observed: ObservedConfig[] = [];
    const discovered: string[] = [];
    const keys = [...this.owed].filter((key) => {
      if (this.followed.has(key)) return true;
      this.owed.delete(key);
      return false;
    });
    if (keys.length === 0) return { observed, discovered };
    const shared = this.batch();
    for (const key of keys) {
      const was = this.followed.get(key)!;
      // [LAW:no-silent-failure] An origin that cannot be observed keeps its
      // last snapshot, stays owed, and stands as its own fault. Its failure
      // cannot suppress a sibling's change or reverse a successful write.
      let found: ObservedOrigin;
      try {
        found = this.discovered(was.origin, shared, was.watch);
      } catch (thrown) {
        this.deps.faults.raise(originFault(was.origin), thrown);
        continue;
      }
      const now = {
        ...found,
        snapshot: found.digest === was.digest ? was.snapshot : found.snapshot,
        renderers: was.renderers,
        selected: was.selected,
        handed: was.handed,
      };
      this.followed.set(key, now);
      observed.push(now);
      discovered.push(key);
      this.deps.faults.clear(originFault(was.origin), "recovered");
    }
    return { observed, discovered };
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
  // targets that finding names, and what that watch cannot hear in the
  // snapshot.
  private discovered(
    origin: RenderOrigin,
    shared: DiscoveryBatch,
    held: HeldWatch | null,
  ): ObservedOrigin {
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
    const managedFolders = new Set(
      pluginFiles(found.snapshot).flatMap(({ definition }) =>
        definition.kind === "text" ? [definition.storage] : [],
      ),
    );
    const landingPaths = new Set(
      paths.targets.polled.flatMap((file) => [file, shared.landingPath(file)]),
    );
    // [LAW:no-ambient-temporal-coupling] Following the watch is the one
    // effect, after every step that can throw: a rebind releases the held
    // watch, and the entry the caller writes next is what holds the new one.
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
    if (move === "rebound") this.bound(origin, paths);
    const snapshot: ConfigSnapshot = {
      ...found.snapshot,
      watch: watchFault("config watch", { derived: spec, held: watch }, null),
    };
    const observed = {
      origin,
      snapshot,
      digest: digestOf(snapshot),
      managedFolders,
    };
    this.observations.set(snapshot, observed);
    return { ...observed, watch, landingPaths };
  }

  // [LAW:nothing-unseen] A rebind is the fact that the target set moved (a
  // candidate appeared, a link was re-pointed), and which directories the
  // origin now hears: a change that fires nothing is read against this line.
  private bound(origin: RenderOrigin, paths: PathsWatch): void {
    const { projectDir, cwd } = origin;
    this.deps.log(
      "info",
      eventLine("config watch bound", [
        ["projectDir", projectDir],
        ["cwd", cwd],
        ["dirs", paths.targets.dirs.map((d) => d.path).join(",")],
        ["polled", paths.targets.polled.join(",")],
      ]),
    );
    for (const { path: p, reason } of paths.unresolved)
      this.deps.log(
        "warn",
        eventLine("config watch unresolved", [
          ["projectDir", projectDir],
          ["path", p],
          ["reason", reason],
        ]),
      );
  }
}

// [LAW:types-are-the-program] What stands while discovery fails: the batch
// itself, or one origin's discovery.
const BATCH_FAULT: FaultSource = { work: "config discovery", subject: [] };
// The origin's fields as its key tells origins apart, each readable.
const originFault = ({
  projectDir,
  cwd,
  target,
}: RenderOrigin): FaultSource => ({
  work: "config discovery",
  subject: [
    ["projectDir", projectDir],
    ["cwd", cwd],
    ["config", target.path ?? "searched"],
    ...(target.source === "argument-only" ? [["only", "yes"] as const] : []),
  ],
});

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
