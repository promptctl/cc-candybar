import { type RegionalSettings } from "../utils/region.js";
import { chainName, originKey, type RenderOrigin } from "../config-hint.js";
import {
  compareShallow,
  makeObservable,
  observable,
  observableRef,
  reaction,
  runInAction,
} from "mobx";
import type {
  DeclaredSources,
  ViewFacts,
} from "../renderer-interface/request-context.js";
import type {
  Subscription,
  Subscriptions,
} from "../renderer-interface/interface.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import { fileHeldSettings } from "./setting-drafts.js";
import {
  layerForRole,
  retainsConfig,
  revisionOf,
  writable,
  type ConfigRevision,
  type ConfigSnapshot,
  type RepoQuestion,
} from "../config/config-snapshot.js";
import type { Drawing, LaneSwitches } from "../config/lanes.js";
import { laneDefaultsAfterReset } from "./lane-handoff.js";
import { PresentedFrames, type FrameCandidate } from "./presented-frames.js";
import type { EffectId } from "../renderer-interface/interface.js";
import {
  loadSnapshot,
  type LoadedChain,
  type LoadedFile,
  ConfigError,
  type Advisory,
  type DroppedFileError,
} from "../config/dsl-loader.js";
import type { LayerRole } from "../config/layer-role.js";
import type {
  DslConfig,
  RawDslConfig,
  ValidatedConfig,
} from "../config/dsl-types.js";
import { DEFAULT_DSL_CONFIG } from "../config/default-dsl-config.js";
import {
  compileAlone,
  compileDslConfig,
  declareDslVariables,
  instantSegments,
  registerCompiled,
  type CompileInput,
  type CompileProvider,
  type CompiledConfig,
  type Registration,
} from "../dsl/render.js";
import { mb, NEAR_LIMIT } from "../daemon/foundations/memory-limit.js";
import { rendererFailureOf } from "../daemon/foundations/verb-error.js";
import { deriveActionGates, type Gates } from "../daemon/foundations/gates.js";
import { presetNames, presetRoot } from "../config/presets.js";
import { resolveEffectiveGlobals } from "../config/effective-globals.js";
import {
  fixedSource,
  NOTHING_READ,
  type ViewSource,
} from "../dsl/view-source.js";
import { bindView } from "../dsl/parts.js";
import { unusedDeclarations, type UnusedDecl } from "../config/unused.js";
import { VariableStore } from "../var-system/store.js";
import { SourceRegistry } from "../var-system/sources.js";
import type { VarScope } from "../dsl/variable-scope.js";
import type { SessionStateRW } from "../renderer-interface/session-state.js";
import { quietLogger, type DaemonLogger } from "../utils/logger.js";
import { valueOf } from "../utils/logfmt.js";
import type { Locations } from "../config/loader/chain-places.js";
import { digestOf, type Projection } from "../utils/plain.js";
import { runEach } from "../utils/run-each.js";
import { pendingOf } from "../utils/outcome.js";
import {
  pluginDataVar,
  type PluginDefinition,
} from "../config/loader/plugins.js";
import { ownedBy, pluginNs } from "../config/loader/plugin-scope.js";
import { projectionsOf } from "../config/loader/projections.js";
import type { TurnClock } from "./turn-time";
import type { RenderCacheStats } from "../renderer-interface/renderer-stats";

// [LAW:one-source-of-truth] Each cache entry owns the live DSL state for a
// (projectDir, cwd) tuple: the parsed config, the variable store +
// registry it was registered against, the compiled segment closures, and
// the resolved base palette. registerDslConfig + drawDsl are the
// single render path — the cache only holds state across calls.
//
// [LAW:one-source-of-truth] Bounded by bytes, out of the daemon's one memory
// budget: an entry is a new one per directory a session renders from (every
// worktree, every `cd`), so a count sized for watchers (it was 256, ~2.4 GB of
// states) let the memory backstop trip long before anything was evicted.
// The heap a state holds beside its compile, and
// the heap one compile holds — measured, and held to by
// test/render-cache-sharing.test.ts, which fails when either is exceeded.
// Measured 2026-10-20 over the bundled default: a rendered entry 1.8 MB (2.4
// MB in a daemon serving a full user config from forty real worktree
// directories); a compile 7.1 MB, counted as an evicted builder leaves it —
// its own heap and the part of that builder's config it still reaches. It was
// 9.3 MB an entry, every one compiling its own.
export const ENTRY_BYTES = 3 * 1024 * 1024;
export const COMPILE_BYTES = 10 * 1024 * 1024;
// A session's view (SessionView): its store of the session's values over the
// entry's, and the parts of every placement it has drawn, kept until it is
// disposed (src/dsl/parts.ts). Measured 2026-10-23 over the bundled default:
// 1.0 MB a view drawn once, and 1.6 MB a view that has opened every list the
// menu hangs and every tab — the most it draws — so the constant charges that,
// with headroom for a user config's further placements.
export const VIEW_BYTES = 2.5 * 1024 * 1024;

// The render cache's share of the memory limit: what is left under the line
// a reading calls near the limit once the rest of the process holding it is
// reserved — so a share full at its charges, which a test holds real heap
// under and so are the most the cache can cost, never puts that process past
// that line, whatever the limit. The limit judges each process alone, and the
// cache lives in its renderer's: a process of its own, or the host's for an
// in-process renderer. The reserve is the ~60 MB one process doing the host's
// work and a renderer's was charged serving one session, and a second
// runtime's copy of the loaded bundle (a bare node is charged ~12 MB), so it
// holds under either. The charges' own headroom over what entries hold is the
// heap's growth room, so reserving more would starve the cache at a lowered
// limit for nothing. At the default limit the share is
// 672 MB: ~120 sessions on one compile, each an entry and a view, against a
// working set of ~20 directories in the production daemon.
// Measured, a full share costs less than its charges: serving 100 sessions,
// the daemon is charged ~430 MB in all with 560 MB of the share accounted.
const RENDER_CACHE_RESERVE_BYTES = 96 * 1024 * 1024;
// Never less than a quarter of the limit, which a small limit has always had:
// there the reserve would leave the cache too little to hold two sessions.
export function renderCacheBudget(memoryLimitBytes: number): number {
  return Math.floor(
    Math.max(
      memoryLimitBytes / 4,
      memoryLimitBytes * NEAR_LIMIT - RENDER_CACHE_RESERVE_BYTES,
    ),
  );
}

// The count ceiling beside the byte budget: every entry holds a
// SourceRegistry (fs watchers, TTL timers), a resource the byte budget does
// not see. At the default memory limit
// the bytes bind just short of it (~230 entries with no view); it is what
// bounds watchers above it, when CC_CANDYBAR_RSS_LIMIT_MB is raised.
export const MAX_ENTRIES = 256;
const MAX_UNPINNED_FAILURES = 256;

// [LAW:single-enforcer] Cache entries compile host-supplied facts. A view
// reads its session's values through the session source.
export interface RenderDeps<
  S extends ViewSource = ViewSource,
  F extends ViewFacts = ViewFacts,
> extends Pick<StateDeps, "region"> {
  // The renderer's turn time (StateDeps).
  clock: TurnClock;
  // Where the user's home is, which a `~` in a plugin's data path names
  // (StateDeps).
  locations: Locations;
  sessionState: SessionStateRW;
  // The session's open edit draft at `origin`, or null when it edits none.
  editRevision: (
    origin: RenderOrigin,
    session: SessionId,
  ) => ConfigRevision | null;
  // The gates a load builds against (StateDeps).
  gates: Gates;
  // What a view draws from (src/renderer/session-source.ts); a test drawing no
  // view's own payload passes SOURCES_NOTHING.
  source: SourceOf<S>;
  // [LAW:one-source-of-truth] Live views read the renderer's session record.
  // A standalone view can own its request in the absence of a session store.
  currentRequest?: (session: SessionId) => F;
  // Where the cache's events go — every load, every teardown. Only the
  // daemon passes its log; a caller passing none logs quietly, like the
  // providers and the usage store.
  log?: DaemonLogger;
}

// What building one config's state needs.
export interface StateDeps {
  readonly region?: RegionalSettings;
  // The clock its variables' ages run on, and its sources' held work: the
  // renderer's turn time, or the clock of a command that draws once.
  readonly clock: TurnClock;
  // Where the user's home is: a `~` in a plugin's data path names it.
  readonly locations: Locations;
  readonly sessionState: SessionStateRW;
  // The gates a config's sessions click through, which a load builds once so a
  // config that cannot gate fails there.
  readonly gates: Gates;
  // The compile for a config's compile key. A cache shares one between every
  // entry whose config compiles alike (RenderCache's table); a one-shot load
  // has no other entry to share with and compiles its own.
  readonly compile?: CompileProvider;
}

// [LAW:no-ambient-temporal-coupling] The cache's outward lifecycle signal. A
// reload is the one event the cache alone knows the completion of — it runs
// when a `config` turn hands in a moved snapshot — so anything that
// must run AFTER a reload (an operator log of its outcome, a test asserting
// on the state it wrote) needs the cache to say so, or it is left betting on
// a clock. [LAW:locality-or-seam] One named bag: a caller states what it passes by name, and a new
// observer is one field here, not a constructor signature every caller
// re-counts.
export interface RenderCacheObservers {
  // Fires once per completed reload of an entry — the initial population in
  // getOrCreate and every snapshot-driven reload alike, success (a fresh
  // `state`) and failure (`lastError` set, prior state preserved) alike —
  // after the entry's fields are settled. The entry is handed
  // over as ReloadedEntry so the observer reads the outcome from the one
  // place it lives and the type, not this comment, keeps it from writing
  // there. `sessions` are those whose views drew from the entry before it
  // loaded: none for an entry just created. `cause` is why it loaded. Trusted
  // non-throwing: an observer that
  // throws is a caller bug surfaced loudly, never absorbed here.
  readonly onReload?: (
    entry: ReloadedEntry,
    sessions: readonly SessionId[],
    cause: LoadCause,
    // What the load did: built a state, kept the one served, or failed.
    settled: Settled,
  ) => void;
  // Fires with a session's id when its view opens and whenever what the view
  // draws from moves (openView's `changed`): what a feed showing the session
  // wakes on.
  readonly onViewChanged?: (sessionId: SessionId) => void;
}

// [LAW:types-are-the-program] The observer's view of an entry: an ALLOW-LIST
// of the load's outcome. Nothing that owns a resource — the SourceRegistry, the validator disposers, the render-cell sink — crosses
// this seam, so a handle added to either type later is closed by
// construction, not by remembering to omit it (`Readonly` alone would not:
// it cannot stop a method call such as `dispose()`).
export type ReloadedEntry = Readonly<
  Pick<
    CacheEntry,
    "origin" | "configLayers" | "revision" | "lastError" | "lastWarnings"
  >
> & { readonly state: Readonly<Pick<DslRenderState, "config">> };

// [LAW:types-are-the-program] The DSL render state for an entry is one
// bundle, never null: an entry can ALWAYS render. It is seeded with the
// bundled default's state at creation and
// replaced by each config that loads; a config that fails to load leaves it
// as it was. So the bar under a load error is the best config the entry has
// — the last one that loaded, or the bundled default before any has — and
// the settings menu (the door back to the file) exists from the first
// render, through the same synthesis every config gets.
//
// `store` and `registry` are the entry's DIRECTORY home: the sources no
// session value reaches (variable-scope.ts). A session draws through its own
// view over them (SessionView).
export interface DslRenderState {
  readonly config: ValidatedConfig;
  // [LAW:no-silent-failure] The placements of undeclared segments the load
  // dropped to draw the rest of the bar, one error per file that wrote one.
  readonly dropped: readonly DroppedFileError[];
  // [LAW:one-source-of-truth] The identity of `compiled` (compileKey of what
  // it was compiled from): states carrying one key carry one compile.
  readonly compileKey: string;
  // [LAW:one-source-of-truth] The identity of the inputs it was built from
  // (`ResolvedLoad.key`): a reload that resolves the same key keeps this
  // state, since rebuilding it would reopen every session view for nothing.
  readonly loadKey: string;
  // The advisories its build earned (variables that failed to register or
  // declare), shown for as long as it is served, kept or built.
  readonly buildWarnings: readonly Advisory[];
  readonly store: VariableStore;
  readonly registry: SourceRegistry;
  readonly compiled: CompiledConfig;
  // [LAW:one-source-of-truth] The preset names whose layout tree the config
  // FILE authors at the path presetRoot() reports for them: `root` for a preset staging the config's own root, `presets.<n>.
  // root` otherwise. This is what `.preset.customized` means now — the file
  // declares that tree, whether a hand wrote it or a `+`/`-` click did; the
  // two are indistinguishable by design. Computed from the SAME raw parse
  // that produced `config`, on the SAME reload, so the two never drift.
  readonly authoredRoots: ReadonlySet<string>;
  // The config keys the FILE holds a value for at a layer a reset clears
  // (fileHeldSettings) — from the same raw parse, for the same reason.
  readonly fileHeldSettings: ReadonlySet<string>;
  // The user layer's file (the chain's home), once it exists — what the
  // menu's `↗ config` opens; null while it does not.
  readonly configPath: string | null;
  // The roles of the chain a click can write — what the save offers.
  readonly writable: readonly LayerRole[];
  readonly remainingLanes: ReadonlyMap<string, LaneSwitches>;
  // What the file declares that nothing uses — from the same raw parse, for
  // the same reason. No bar reads it; the retired Doctor's config check did.
  readonly unused: readonly UnusedDecl[];
  // The plugin definitions this load merged, and those it dropped.
  readonly plugins: LoadedPlugins;
  // [LAW:no-ambient-temporal-coupling] Each plugin source the config
  // declares, at its storage folder. The cache holds these folders for as
  // long as it serves the state, so a reload, which holds its successor's
  // first, never closes and reopens a watch, and no view touches one.
  readonly sources: DeclaredSources;
}

// The definitions — installed and listed — merged and dropped.
type LoadedPlugins = LoadedChain["installed"];

// [LAW:one-source-of-truth] Attempt diagnostics name the files whose text
// was supplied, regardless of whether the load used them successfully.
function configPaths(snapshot: ConfigSnapshot): readonly string[] {
  return snapshot.chain.flatMap(({ path, content }) =>
    content.kind === "text" ? [path] : [],
  );
}

// [LAW:dataflow-not-control-flow] Both the loaded config and the fallback
// derive their file facts from the chain used to build them. An absent layer
// can be written, while an empty chain has neither a file nor a write role.
export function configFiles(chain: ConfigSnapshot["chain"]) {
  const textPath = (role: LayerRole) => {
    const layer = layerForRole(chain, role);
    return layer?.content.kind === "text" ? layer.path : null;
  };
  return {
    user: textPath("user"),
    project: textPath("project"),
    writable: chain
      .filter(({ content }) => writable(content))
      .map(({ role }) => role),
  };
}

// [LAW:nothing-unseen] Which plugins a daemon load merged, how many variables
// they declare between them, the data file each merged one reads, the checkout a `{ checkout }` path resolved against —
// `git:<root>`, or `dir:<cwd>` for a directory in no checkout, `-` with no
// session — which it dropped, and how long the load took: a drop is also on
// the bar's message, but the rest is said nowhere else. The daemon's own sink.
export function pluginLoadLine(
  layers: readonly string[],
  {
    plugins,
    config,
    compiled,
  }: Pick<DslRenderState, "plugins" | "config" | "compiled">,
): string {
  const { checkout, loaded, dropped, unreached } = plugins;
  const checkoutField =
    checkout === null
      ? "-"
      : `${checkout.git ? "git" : "dir"}:${checkout.root}`;
  const dataOf = (definition: PluginDefinition): string => {
    const data =
      definition.name === undefined
        ? undefined
        : config.variables[pluginDataVar(pluginNs(definition))];
    return data?.kind === "file" ? data.path : "none";
  };
  // What the merged plugins declare, by kind: a source is synthesized from
  // `sources:`, every other name under a namespace but the data file's came
  // from `variables:`.
  const declared = loaded
    .flatMap((d) => (d.name === undefined ? [] : [pluginNs(d)]))
    .flatMap((ns) =>
      Object.entries(config.variables).filter(
        ([v]) => ownedBy(ns)(v) && v !== pluginDataVar(ns),
      ),
    );
  const sources = declared.filter(([, d]) => d.kind === "source").length;
  const pluginVariables = declared.length - sources;
  return (
    `config load ${chainName(layers, "<default>")}: projections=${[...projectionsOf(config).keys()].join(",") || "-"} instantSegments=${instantSegments(compiled).join(",") || "-"} instantTemplates=${compiled.instant.size} plugins loaded=${loaded.length} sources=${sources} pluginVariables=${pluginVariables} dropped=${dropped.length} unplaced=${unreached.length} checkout=${checkoutField}` +
    loaded.map((p) => ` +${p.path} data=${dataOf(p)}`).join("") +
    dropped.map((d) => ` -${d.path} (${d.reason})`).join("") +
    unreached.map((d) => ` ~${d.path} (${d.reason})`).join("")
  );
}

// [LAW:nothing-unseen] A config's teardown releases every computed's MobX
// subscriptions, and says so: a teardown that released none would otherwise
// show only in a heap snapshot. Why it was torn down,
// how many it released, and how many renders were still drawing with it when
// the cache retired it — those deferred the teardown to the last one's return
// — beside the load line of what replaced it.
export interface Teardown {
  readonly reason: "reload" | "evict" | "close";
  // Renders holding the state when it was retired: 0 is a teardown at
  // retirement, more is one deferred to the last release.
  readonly held: number;
}

// [LAW:types-are-the-program] Why an entry loaded: its first load, or a
// `config` turn that handed in a snapshot that moved.
export interface LoadCause {
  readonly kind: "open" | "config" | "edit";
}

// [LAW:nothing-unseen] Every (re)load's outcome, success and failure alike:
// why it ran, whether it built a state or kept the one served, the files it
// resolved, what failed or warned, the repository the origin's directories
// belong to and how it stands, and why its worktree link could not be proven.
export function configLoadedLine(
  entry: ReloadedEntry,
  cause: LoadCause,
  settled: Settled,
): string {
  const { repo } = entry.revision.snapshot;
  const { projectDir, cwd } = entry.origin;
  return `config loaded projectDir=${valueOf(projectDir)} cwd=${valueOf(cwd)} cause=${cause.kind} state=${settled} files=${valueOf(chainName(entry.configLayers, "<bundled default>"))} repo=${repo === null ? "-" : valueOf(`${repo.standing}:${repo.dir}`)} unproven=${repo?.unproven == null ? "-" : JSON.stringify(repo.unproven)} error=${entry.lastError === null ? "none" : JSON.stringify(entry.lastError)} warnings=${entry.lastWarnings.length === 0 ? "none" : JSON.stringify(entry.lastWarnings)}`;
}

export function configDisposeLine(
  teardown: Teardown,
  released: number,
): string {
  return `config disposed reason=${teardown.reason} released=${released} held=${teardown.held}`;
}

// [LAW:one-source-of-truth] Each entry tracks the last *valid* DSL state +
// the last error AND last warning from a reload attempt. A state is only
// ever replaced by a state — a load failure means "show the error but keep
// rendering with what we had", and what we had is the bundled default until
// a config loads. Errors are scoped to the cache key (which includes cwd /
// projectDir) so a broken config in repo A cannot pollute repo B.
//
// [LAW:one-type-per-behavior] error and warning are distinct severities, so
// they get distinct channels. `lastError` is load-fatal (config didn't
// parse / validate); `lastWarnings` are advisory (e.g., extension collision —
// load succeeded but something the user should know about). The render path
// surfaces both through one diagnostics composer in src/renderer/draw-bar.ts.
// [LAW:types-are-the-program] `projectDir` and `cwd` are required inputs to
// every render request. The wire boundary in render-checkpoint.ts validates the
// underlying hookData and returns BAD_REQUEST when either is absent, so by
// the time a cache entry is built they are real non-empty paths. `configFile`
// is the explicit path a session's render origin names (`--config`, or the
// `configEnv` hint; absolute) — present when
// overriding the standard precedence chain, undefined otherwise.
export interface CacheEntry {
  // [LAW:one-source-of-truth] The origin used for loading, declaring sources
  // and subscribing is the same value.
  readonly origin: RenderOrigin;
  // The file paths in the most recent attempt, including a failed load.
  readonly configLayers: readonly string[];
  // [LAW:one-source-of-truth] The revision the last load taken read: an
  // offer that digests alike reloads nothing while no fault stands. The bar's repository question and
  // what the config's watch cannot hear are read off it.
  revision: ConfigRevision;
  selected: SelectedState;
  lastError: string | null;
  // [LAW:no-silent-failure] What the latest load threw before the entry took
  // it, or null once one is taken. The entry serves what it had, shows the
  // throw to the frames and controls of every session drawing it, and loads
  // again on its next use (`reconcile`). A write that reads no config does
  // not read the load either, so it still lands on the host's offer.
  fault: string | null;
  lastWarnings: readonly Advisory[];
  readonly state: DslRenderState;
}

// [LAW:types-are-the-program] An authored build carries its revision and
// approval through a failed reload. A bundled build follows each current
// observation, with no earlier authored revision or approval to retain.
type SelectedState =
  | {
      readonly kind: "authored";
      readonly state: DslRenderState;
      readonly digest: string;
      readonly repo: RepoQuestion | null;
    }
  | { readonly kind: "bundled"; readonly state: DslRenderState };

// [LAW:no-ambient-temporal-coupling] A state's lifetime is a fact the cache
// owns: the renders holding it across their
// payload await, and the teardown it is due once the cache stopped serving
// it — evicted, or replaced by a reload. Deferred reclamation, RCU-style:
// the map moves at once (the cap stays a bound, a reload swaps at once) and
// a retired state is disposed when its last holder returns, never under a
// render — which otherwise resumed on a disposed store, every chained read
// recomputed untracked.
interface StateHold {
  holders: number;
  retired: Teardown | null;
}

// A render's hold on the state it draws with: the state, the entry it was
// served from, and the release that `using` runs on every exit of the
// holder's scope (return and throw alike). Released exactly once.
export interface Hold extends Disposable {
  readonly entry: CacheEntry;
  readonly state: DslRenderState;
}

// A render's hold on the session's view it draws through, and the state the
// view is of — both released by the one `using`.
export interface SessionHold<
  S extends ViewSource = ViewSource,
  F extends ViewFacts = ViewFacts,
> extends Hold {
  readonly view: SessionView<S, F>;
}

// What opened a view: a request, or a reload's successor. Never a frame
// (`holdView`).
export type ViewOpening = "request" | "reload";

// Why a view stopped being served: its state did (reload, evict, close), its
// session's latest render resolved to another entry (`moved`), or the host
// retired its session (`idle`, src/daemon/collector.ts).
export type ViewClose = Teardown["reason"] | "moved" | "idle";

// A view's lifetime, as a state's (StateHold), and the entry it opened over.
interface ViewHold {
  // [LAW:one-source-of-truth] The entry whose state the view is of: an entry
  // whose state changes or that is dropped retires its views first
  // (`retire`), so a served view's entry is this one.
  readonly entry: CacheEntry;
  holders: number;
  retired: { readonly reason: ViewClose; readonly held: number } | null;
}

// [LAW:one-source-of-truth] The preset names whose layout the raw file
// authors — a root FRAGMENT (a whole tree or a `{ rows }` map, either is
// authorship) at the path presetRoot() reports, the one decision of "where
// does this preset's layout live" (src/config/presets.ts), projected onto
// the raw shape rather than re-derived here.
// [LAW:one-source-of-truth] `config` must be the MERGED tree, before
// validateRenderable: edit chrome materializes an explicit `presets.<n>.root`
// for every preset, so asked of the validated tree presetRoot() never
// reports `root` and a file customizing a root-staging preset reads as
// pristine.
function authoredRoots(
  config: DslConfig,
  raw: RawDslConfig,
): ReadonlySet<string> {
  return new Set(
    presetNames(config.presets).filter((name) =>
      presetRoot(config, name).path === "root"
        ? raw.root !== undefined
        : raw.presets?.[name]?.root !== undefined,
    ),
  );
}

// [LAW:one-source-of-truth] The preset roots a load's user file authors,
// over the chain it tops: the one reading for the daemon's state and for
// anything that draws a load the way the daemon does.
export function userAuthoredRoots(
  layers: LoadedChain["layers"],
  userPath: string | null,
): ReadonlySet<string> {
  return authoredRoots(
    layers.at(-1)?.config ?? DEFAULT_DSL_CONFIG,
    layers.find(({ path }) => path === userPath)?.raw ?? {},
  );
}

// [LAW:types-are-the-program] One attempt at loading a config's snapshot, and
// what became of it: a state `built`, the served state `kept` because the
// resolve named the inputs it was built from, or `failed`, with the error and
// the file to blame. A state XOR an error, never both, never neither.
// `warnings` and `layers` are facts of the attempt regardless of arm
// (collision detection runs on a broken file too).
export type LoadOutcome = {
  readonly layers: readonly string[];
  readonly warnings: readonly Advisory[];
} & (
  | {
      readonly kind: "built" | "kept";
      readonly state: DslRenderState;
      readonly error: null;
    }
  | {
      readonly kind: "failed";
      readonly state: null;
      readonly error: string;
      // What was thrown, its type and stack intact: a defect in the load is
      // told apart from a config the load refused by this, never by its
      // message.
      readonly cause: unknown;
    }
);

// What a load did with what it read, for the `config loaded` line.
export type Settled = LoadOutcome["kind"];

// A load that threw, with the advisories it earned before it did: they go
// out beside the error, never instead of it.
interface Failed {
  readonly kind: "failed";
  readonly cause: unknown;
  readonly warnings: readonly Advisory[];
}

// [LAW:types-are-the-program] The facts a build takes from an origin: its
// working directory, loaded config, file roles and declared source folders.
interface LoadInputs {
  readonly cwd: string;
  readonly files: ReturnType<typeof configFiles>;
  readonly loaded: LoadedChain;
  readonly sources: DeclaredSources;
}

// A chain read and keyed, with the advisories the read earned.
interface ResolvedLoad extends LoadInputs {
  readonly kind: "resolved";
  // [LAW:one-source-of-truth] The identity of everything a build derives a
  // state from: two loads with one key build interchangeable states.
  readonly key: string;
  readonly warnings: readonly Advisory[];
}

// An attempt at a state from a resolved load: the served state `kept` when it
// was built from the same inputs, otherwise one built.
type Attempt =
  | {
      readonly kind: "built" | "kept";
      readonly state: DslRenderState;
    }
  | Failed;

const thrown = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

// [LAW:types-are-the-program] The key covers the whole of a load's inputs:
// each projection names every field of what it projects (`Projection`), and
// the digest takes only plain values, so a field added anywhere fails to
// compile until it is keyed, and no Set or Map is written as `{}`.
function plugins(p: LoadedFile["plugins"]) {
  return {
    loaded: p.loaded,
    dropped: p.dropped,
    reached: [...p.reached].sort(),
    rendering: [...p.rendering].sort(([a], [b]) => (a < b ? -1 : 1)),
  } satisfies Projection<LoadedFile["plugins"]>;
}

function loadKey(inputs: LoadInputs): string {
  const { loaded } = inputs;
  return digestOf({
    cwd: inputs.cwd,
    files: inputs.files,
    loaded: {
      layers: loaded.layers.map(
        (l) =>
          ({
            path: l.path,
            raw: l.raw,
            config: l.config,
            plugins: plugins(l.plugins),
            // Not keyed: positions reach no state, and the resolve redraws
            // its diagnostics on every load, so a whitespace or comment edit
            // keeps the state.
            source: null,
            // Not keyed: the entry's, recomposed on every load.
            warnings: null,
          }) satisfies Projection<LoadedChain["layers"][number]>,
      ),
      base: loaded.base,
      installed: {
        ...plugins(loaded.installed),
        checkout: loaded.installed.checkout,
        unreached: loaded.installed.unreached,
      } satisfies Projection<LoadedChain["installed"]>,
      config: loaded.config,
      // [LAW:one-source-of-truth] Keyed by message: unlike a layer's own
      // diagnostics the drops ride the state, positions and all, so a state
      // kept across an edit that moved a drop would name the old line.
      dropped: loaded.dropped.map((e) => e.message),
      // Not keyed: placed from the layers' own configs and inserts, keyed
      // above.
      placed: null,
    } satisfies Projection<LoadedChain>,
    sources: [...inputs.sources]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, folder]) => [name, folder] as const),
  } satisfies Projection<LoadInputs>);
}

// Each plugin source the config declares, at its storage folder. The render
// path does no I/O for a source: a session's subscription names the folder,
// and the host's storage owner reads it.
function declaredSources(config: DslConfig): DeclaredSources {
  const sources = new Map<string, string>();
  for (const [name, decl] of Object.entries(config.variables))
    if (decl.kind === "source") sources.set(name, decl.storage);
  return sources;
}

// [LAW:single-enforcer] Load a chain from its snapshot: each layer validated
// over the layers it joins, so cross-ref diagnostics name the failing file's
// own paths and lines, and every advisory a layer earns appended before its
// validation, so a cross-ref failure still carries them (a duplicate key
// names its line beside the error).
function resolveLoad(
  cwd: string,
  snapshot: ConfigSnapshot,
  home: string,
): ResolvedLoad | Failed {
  const warnings: Advisory[] = [];
  try {
    const loaded = loadSnapshot(snapshot, home, DEFAULT_DSL_CONFIG, {
      warned: (w) => warnings.push(...w),
    });
    const inputs = {
      cwd,
      files: configFiles(snapshot.chain),
      loaded,
      sources: declaredSources(loaded.config),
    };
    return { kind: "resolved", ...inputs, key: loadKey(inputs), warnings };
  } catch (err) {
    if (err instanceof ConfigError) warnings.push(...err.warnings);
    return { kind: "failed", cause: err, warnings };
  }
}

// [LAW:single-enforcer] Construct the full new state — store, registry,
// compiled segments, palette — from a resolved load, as one transaction. Any
// failure inside disposes the partially-built registry so we don't leak
// timers/watchers from a half-constructed reload, and is the attempt's
// `failed` arm carrying the advisories the build earned before it, so the
// caller keeps its prior state and shows both.
function buildRenderState(load: ResolvedLoad, deps: StateDeps): Attempt {
  const { cwd, files, loaded } = load;
  // [LAW:dataflow-not-control-flow][LAW:single-enforcer] `validateRenderable`
  // (inside the resolve) is the sole producer of `ValidatedConfig`, and the
  // renderer accepts only `ValidatedConfig`, so the compiler enforces the
  // chain — there is no "skip validate" path that typechecks downstream.
  const { layers, config, installed, dropped } = loaded;
  const userRaw = layers.find(({ path }) => path === files.user)?.raw ?? {};
  const projectRaw = layers.find(({ path }) => path === files.project)?.raw;
  const inserted = layers.flatMap((l) =>
    (l.raw.insert ?? []).map((cell) => cell.seg),
  );
  // [LAW:one-source-of-truth] The advisories the build earns are facts of the
  // state it builds, carried on it, so a reload that keeps the state keeps
  // them too.
  const warnings: Advisory[] = [];

  const store = new VariableStore(deps.clock);
  // The sessionState injection makes `kind: "state"` variables read/write the
  // same per-session store the click verbs mutate. `default_empty_value`
  // is honored from globals — it's the fallback used by input/env/etc.
  // sources when neither the path resolves nor the declaration carries
  // its own `default`. The loader validates it as a string; the registry
  // default ("") matches the historical behavior when omitted.
  const registry = new SourceRegistry(
    store,
    config.globals.default_empty_value ?? "",
    deps.sessionState,
    null,
    deps.region,
  );

  let registration: Registration;
  try {
    // [LAW:one-source-of-truth] The compile holds no store: each render binds
    // its own (drawDsl), so the entry's registry is the store its renders read
    // — and the compile can be one shared by every entry whose config
    // compiles alike.
    registration = registerCompiled(
      config,
      registry,
      cwd,
      deps.compile ?? compileAlone,
      DIRECTORY_SCOPE,
    );
    // [LAW:dataflow-not-control-flow] Partial-load warnings (variable
    // declaration failures that didn't abort the load) flow through the
    // same warning channel as collision warnings; both visible at once —
    // appended before the validator pass so a derive throw still carries
    // them.
    warnings.push(...registration.loadWarnings);
    // [LAW:single-enforcer] A session value that cannot declare (a template
    // that does not parse) is a fact of the config, so the load finds it, as
    // it finds a directory source's: the session values are declared once into
    // a view no session draws, then disposed. Every session's view declares
    // them identically and reports nothing (openView).
    const probe = registry.view();
    warnings.push(...declareDslVariables(config, probe, cwd, VIEW_SCOPE));
    probe.dispose();
    // [LAW:no-silent-failure] The gates this config's sessions click through
    // are derived from its action table on demand (`gates`),
    // so nothing is installed here. They are built once now so an action
    // table that cannot gate — a built-in key re-claimed, two actions that
    // contradict each other on one key — fails this load, never the first
    // click.
    deriveActionGates(deps.gates, config);
  } catch (err) {
    registry.dispose();
    if (err instanceof ConfigError) warnings.push(...err.warnings);
    return { kind: "failed", cause: err, warnings };
  }

  // [LAW:one-source-of-truth] basePalette is NOT frozen here. One cache entry
  // serves many sessions, but the effective theme is per-session SessionState;
  // freezing the palette per entry would let the rendered colors diverge from
  // the session's chosen theme. The server resolves basePalette per render
  // from the effective theme (resolveThemeSelection, settled by the view).
  return {
    kind: "built",
    state: {
      config,
      dropped,
      compileKey: registration.compileKey,
      loadKey: load.key,
      buildWarnings: warnings,
      store,
      registry,
      compiled: registration.compiled,
      // What the menu's resets clear is the user layer's: they name no other.
      authoredRoots: userAuthoredRoots(layers, files.user),
      fileHeldSettings: fileHeldSettings(userRaw),
      configPath: files.user,
      writable: files.writable,
      remainingLanes: laneDefaultsAfterReset(
        config,
        loaded.base,
        projectRaw ?? {},
      ),
      // One entry per declaration, however many layers declare it, judged
      // over the trees as placed and every layer's insert entries, so a
      // segment only an insert entry places is used, here or not.
      unused: [
        ...new Map(
          layers
            .flatMap((l) => unusedDeclarations(l.raw, loaded.placed, inserted))
            .map((u) => [`${u.kind}:${u.name}`, u] as const),
        ).values(),
      ],
      plugins: {
        checkout: installed.checkout,
        // What renders, as the loader decided it: a nearer layer's load or
        // drop replaces a farther one's of the same namespace.
        loaded: [...installed.rendering.values()],
        dropped: [
          ...installed.dropped,
          ...layers.flatMap((l) => l.plugins.dropped),
        ],
        unreached: installed.unreached,
        reached: installed.reached,
        rendering: installed.rendering,
      },
      sources: load.sources,
    },
  };
}

// [LAW:single-enforcer] A load reports discovery's notices, parse advisories
// and the build's warnings together. A failed attempt keeps its own warnings
// beside its error, and a reused state keeps the warnings its build earned.
function settle(
  snapshot: ConfigSnapshot,
  resolveWarnings: readonly Advisory[],
  attempt: Attempt,
): LoadOutcome {
  const layers = configPaths(snapshot);
  // [LAW:dataflow-not-control-flow] Discovery's notices run every load,
  // independent of load success — even if the .json5 fails to parse, the user
  // still wants to know they have a shadowed .json sibling; an explicit path
  // to an absent file is named whatever the default then does. The host's
  // discovery watches every candidate path, so creating/removing a duplicate
  // — or the named file appearing — hands in a snapshot that moved.
  // Each advisory its own, as the bar lists it.
  const warnings = (own: readonly Advisory[]): readonly Advisory[] => [
    ...snapshot.notices,
    ...resolveWarnings,
    ...own,
  ];
  switch (attempt.kind) {
    case "built":
    case "kept":
      return {
        layers,
        kind: attempt.kind,
        warnings: warnings(attempt.state.buildWarnings),
        state: attempt.state,
        error: null,
      };
    case "failed":
      return {
        layers,
        kind: "failed",
        warnings: warnings(attempt.warnings),
        state: null,
        error: thrown(attempt.cause),
        cause: attempt.cause,
      };
  }
}

// [LAW:effects-at-boundaries] The renderer loads from this snapshot alone.
// [LAW:single-enforcer] A reload that resolves the same build inputs keeps
// its served state and its existing views.
export function loadOrigin(
  cwd: string,
  snapshot: ConfigSnapshot,
  deps: StateDeps,
  served: DslRenderState | null = null,
): LoadOutcome {
  const resolved = resolveLoad(cwd, snapshot, deps.locations.home);
  if (resolved.kind === "failed") return settle(snapshot, [], resolved);
  // [LAW:one-source-of-truth] A memo on load identity, as the compile table
  // is on compile identity.
  const attempt: Attempt =
    served?.loadKey === resolved.key
      ? { kind: "kept", state: served }
      : buildRenderState(resolved, deps);
  return settle(snapshot, resolved.warnings, attempt);
}

// [LAW:single-enforcer] Without an allowed last-good build, render the bundled
// default with the currently discovered plugins. The bar carries the authored
// load's diagnostic independently of this fallback.
function fallbackState(
  cwd: string,
  snapshot: ConfigSnapshot,
  deps: StateDeps,
  served: DslRenderState | null,
): DslRenderState {
  const built = loadOrigin(cwd, { ...snapshot, chain: [] }, deps, served);
  // [LAW:no-silent-failure] The default validates by program invariant
  // (test/default-dsl-config.test.ts); a throw is a daemon bug.
  if (built.kind === "failed")
    throw new Error(`bundled default failed to load: ${thrown(built.cause)}`, {
      cause: built.cause,
    });
  return built.state;
}

// The scopes a render cache entry and a session's view declare.
const DIRECTORY_SCOPE: ReadonlySet<VarScope> = new Set(["directory"]);
const VIEW_SCOPE: ReadonlySet<VarScope> = new Set(["view"]);
const NO_WRITABLE_LAYERS: readonly LayerRole[] = [];

// [LAW:types-are-the-program] A view can offer writes or show why its
// current config blocks them, even while it draws an older preview.
export type ConfigAccess =
  | { readonly kind: "available"; readonly roles: readonly LayerRole[] }
  | { readonly kind: "unavailable"; readonly error: string };

export function writableRoles(access: ConfigAccess): readonly LayerRole[] {
  return access.kind === "available" ? access.roles : NO_WRITABLE_LAYERS;
}

// [LAW:one-source-of-truth] A session's view of one entry's state: the
// session's own values — its inputs, its state reads, its derivations, the
// sources keyed on them — in a store over the entry's directory store, which
// it reads through to. Each session renders through its own, so a request
// writes only its own session's values and no other session's render re-runs,
// reads, or reports them.
//
// What the session reads of the daemon's shared entries (a repo, a pane, a
// plugin's session file) is held by the host's collector at the session's
// keys and reaches the view as its world state, so a view holds none.
//
// Each surface keeps its frame record and segment cells together. The debug
// command encodes the delivered cells on demand. A hidden segment has no entry.
export interface SessionView<
  S extends ViewSource = ViewSource,
  F extends ViewFacts = ViewFacts,
> {
  readonly sessionId: SessionId;
  readonly state: DslRenderState;
  readonly store: VariableStore;
  readonly registry: SourceRegistry;
  readonly configAccess: () => ConfigAccess;
  // Standalone views can update the request they hold.
  requested?(facts: F): void;
  // The current request the view draws by.
  facts(): F;
  // What the view draws from: its payload and selections, bound to its
  // store's inputs and slots (`bindView`) when it opened.
  readonly source: S;
  // [LAW:types-are-the-program] A receipt holds only this identity, so the
  // view and its registry cannot be kept alive by the transport.
  readonly presentationTargets: Record<Drawing["by"], symbol>;
  // The view is no session's bar from now on (a successor took it, or it
  // closed): it stops saying what it draws from moved, though a render that
  // holds it still draws from it.
  retire(): void;
  // [LAW:single-enforcer] The view's one teardown: its holds close and its
  // registry is disposed, so no caller of openView can release one and leak
  // the other. Returns how many computeds the registry's store released.
  dispose(): number;
}

// What a view's source is built over: the session, the state it is a view of,
// the view's own store (a source's kept derivations are released with it),
// and the request its renders draw by, observable.
export interface SourcedView {
  readonly sessionId: SessionId;
  readonly state: DslRenderState;
  readonly store: VariableStore;
  readonly requested: () => ViewFacts;
  readonly configAccess: () => ConfigAccess;
}

export type SourceOf<S extends ViewSource> = (view: SourcedView) => S;

// A source answering nothing yet: every input of the view pending, its
// session the view's own (so `state` reads answer), and the selections the
// config declares — what a test's views draw from until it binds a payload of
// its own.
export const SOURCES_NOTHING: SourceOf<ViewSource> = ({ sessionId, state }) =>
  fixedSource(
    pendingOf("unread"),
    resolveEffectiveGlobals(
      state.config,
      () => null,
      (preset) => state.authoredRoots.has(preset),
    ),
    sessionId,
    NOTHING_READ,
  );

// What a view draws from, and whom it tells that what it draws from moved.
export interface ViewDeclaring<S extends ViewSource = ViewSource> {
  readonly source: SourceOf<S>;
  readonly changed: (sessionId: SessionId) => void;
  readonly log: DaemonLogger;
  readonly configAccess?: () => ConfigAccess;
}

function standaloneRequest<F>(facts: F) {
  const requested = observable.box(facts, { deep: false });
  return {
    read: () => requested.get(),
    update: (next: F) => {
      if (next !== requested.get()) runInAction(() => requested.set(next));
    },
  };
}

// [LAW:single-enforcer] The one way a view is built: the state's directory
// registry opens a view registry, and the config's view-scoped variables are
// declared into it, in `cwd` — the entry's, where its shells run. What the
// session reads of the world is the host's: its collector declares the
// session's keys and hands in its world state (src/daemon/collector.ts), so a
// view holds no lane.
export function openView<S extends ViewSource, F extends ViewFacts>(
  state: DslRenderState,
  cwd: string,
  facts: F,
  {
    source: sourceOf,
    changed,
    log,
    configAccess = () => ({ kind: "available", roles: state.writable }),
  }: ViewDeclaring<S>,
  currentRequest?: () => F,
): SessionView<S, F> {
  // [LAW:one-source-of-truth] The session is the one the request's checkpoint
  // parsed: a later request of the view's names the same one.
  const sessionId = facts.hookData.session_id;
  const request =
    currentRequest === undefined
      ? standaloneRequest(facts)
      : { read: currentRequest, update: undefined };
  const registry = state.registry.view();
  // [LAW:no-ambient-temporal-coupling] A failed declaration, source or bind
  // releases this opening's registry before the session can try again.
  let source: S;
  try {
    // The load probes the same declarations and reports their warnings.
    declareDslVariables(state.config, registry, cwd, VIEW_SCOPE);
    source = sourceOf({
      sessionId,
      state,
      store: registry.variableStore,
      requested: request.read,
      configAccess,
    });
    // [LAW:single-enforcer] Inputs and slots read this source at draw time.
    bindView(state.compiled, registry.variableStore, registry, source);
  } catch (e) {
    registry.dispose();
    throw e;
  }
  // [LAW:single-enforcer] The view's one say that what it draws from moved:
  // its payload (a fold of its session's world state, its request, its picks
  // and the depths of its histories), its selections, or what its own or its
  // directory's sources published. Told as it opens, since a view opening is
  // what its session's bar draws from changing. The draw writes none of these
  // (step 4e), so no frame wakes the next one.
  // [LAW:no-silent-failure] A tracked read that throws is logged: a reaction
  // that let it go would reach only the console MobX prints to.
  const stopChanged = reaction(
    () => [
      source.payload(),
      source.selections(),
      registry.published(),
      state.registry.published(),
    ],
    () => changed(sessionId),
    {
      equals: compareShallow,
      fireImmediately: true,
      onError: (e) =>
        log(
          "error",
          `session view change threw sid=${JSON.stringify(sessionId)}: ${String(e)}`,
        ),
    },
  );
  return {
    sessionId,
    state,
    store: registry.variableStore,
    registry,
    configAccess,
    source,
    requested: request.update,
    facts: request.read,
    presentationTargets: { request: Symbol(), feed: Symbol() },
    retire: stopChanged,
    dispose: () => {
      stopChanged();
      return registry.dispose();
    },
  };
}

// What a view needs read: each plugin source its config declares, at its
// storage folder, then each run its registry names, in digest order, then each
// variable of the session's environment its `env` sources read, sorted.
const subscriptionsOf = ({
  state,
  registry,
}: Pick<SessionView, "state" | "registry">): Subscription[] => [
  ...[...state.sources].map(
    ([source, folder]): Subscription => ({ kind: "plugin", source, folder }),
  ),
  ...registrySubscriptions(registry),
];

// [LAW:single-enforcer] What a registry needs read: each run it names, in
// digest order, then each variable its `env` sources read, sorted.
export const registrySubscriptions = (
  registry: Pick<SourceRegistry, "subscriptions" | "envSubscriptions">,
): Subscription[] => [
  ...registry
    .subscriptions()
    .map((run): Subscription => ({ kind: "run", run })),
  ...registry
    .envSubscriptions()
    .map((name): Subscription => ({ kind: "env", name })),
];

const draftKey = (sessionId: SessionId): string => `edit:${sessionId}`;

// [LAW:no-ambient-temporal-coupling] A failed opening belongs to its exact
// cache entry. A retry reads the live session's request through its owner.
interface OpenFailure<F> {
  readonly entry: CacheEntry;
  readonly requestOf: (session: SessionId) => F;
  readonly error: unknown;
}

export class RenderCache<
  S extends ViewSource = ViewSource,
  F extends ViewFacts = ViewFacts,
> {
  private readonly entries = observable.map<string, CacheEntry>(undefined, {
    deep: false,
  });
  // [LAW:one-source-of-truth] What the host last offered for each retained
  // origin, digested once as it arrived; an origin absent here is pending. It
  // records the offer and nothing about how a load of it went: that is each
  // entry's own (`reconcile`). It gates admission and writes, including
  // controls on an already live view.
  private readonly configDeliveries = observable.map<string, ConfigRevision>(
    undefined,
    { deep: false },
  );
  // [LAW:one-source-of-truth] Whether the cache has closed, and the signal a
  // wait over one of its views ends at: one fact, so a render waiting as the
  // close drops its view ends then, not at its deadline.
  private readonly lifetime = new AbortController();
  readonly closing: AbortSignal = this.lifetime.signal;
  private get closed(): boolean {
    return this.closing.aborted;
  }
  // Every state the map serves or served, until reclaimed.
  private readonly holds = observable.map<DslRenderState, StateHold>(
    undefined,
    {
      deep: false,
    },
  );
  // [LAW:one-source-of-truth] Each session's ONE view: of the entry its latest
  // render resolved to. A render from another entry replaces it.
  private readonly views = observable.map<SessionId, SessionView<S, F>>(
    undefined,
    { deep: false },
  );
  readonly presentations = new PresentedFrames((session) => {
    const view = this.views.get(session);
    if (view !== undefined) {
      view.presentationTargets.request = Symbol();
      view.presentationTargets.feed = Symbol();
    }
  });
  // Every view the cache serves or served, until reclaimed.
  private readonly viewHolds = new Map<SessionView<S, F>, ViewHold>();
  // [LAW:no-ambient-temporal-coupling] The sessions an open feed draws, by
  // how many pins each holds: their entries are never evicted (`fit`), for as
  // long as the feed is open. The collector asks the feeds themselves whether
  // a session is watched before it retires one.
  private readonly pins = new Map<SessionId, number>();
  // [LAW:no-silent-failure] A frame sees the opening's error while the view
  // is absent. An open feed keeps the entry eligible for a config retry.
  private readonly openFailures = new Map<SessionId, OpenFailure<F>>();
  // [LAW:one-source-of-truth] One compile per compile key, shared by every
  // state carrying that key, and dropped with the last of them (reclaim).
  private readonly compiles = new Map<string, CompiledConfig>();
  private readonly deps: RenderDeps<S, F> & StateDeps;
  private readonly log: DaemonLogger;
  // Read when an eviction is decided: the budget is a boot-time fact.
  private readonly budgetBytes: () => number;
  private readonly maxEntries: number;
  private readonly observers: RenderCacheObservers;

  constructor(
    deps: RenderDeps<S, F>,
    opts: {
      budgetBytes: () => number;
      maxEntries?: number;
      observers?: RenderCacheObservers;
    },
  ) {
    this.deps = {
      ...deps,
      compile: (key, input) => this.compileOf(key, input),
    };
    this.log = deps.log ?? quietLogger;
    this.budgetBytes = opts.budgetBytes;
    this.maxEntries = opts.maxEntries ?? MAX_ENTRIES;
    this.observers = opts.observers ?? {};
  }

  // A `config` turn: what discovery found at `origin` now. The offer is
  // recorded before its entry, when it has one, reconciles with it, so a load
  // that throws leaves the offer for the next event that uses the entry.
  configure(origin: RenderOrigin, snapshot: ConfigSnapshot): void {
    if (this.closed) throw new Error("render cache used after close");
    const key = originKey(origin);
    const revision = revisionOf(snapshot);
    runInAction(() => {
      this.configDeliveries.set(key, revision);
      const entry = this.entries.get(key);
      if (entry !== undefined)
        this.reconcile(entry, revision, { kind: "config" });
    });
  }

  // [LAW:single-enforcer] The one test of whether an entry loads: the
  // revision offered to it (its session's draft, or else the host's
  // delivery) is not the one it holds a load of: it digests differently, or
  // the entry's latest load threw. Every event that draws or reads config
  // through an entry (`getOrCreate`) offers it, so an entry a throwing load
  // left behind catches up on the next such event, with no resend from the
  // host. Frames and the lane declaration read what the entry holds and
  // offer nothing. A reload whose load inputs did not move keeps the state
  // it serves (`loadOrigin`).
  private reconcile(
    entry: CacheEntry,
    offered: ConfigRevision,
    cause: LoadCause,
  ): void {
    if (entry.fault !== null || entry.revision.digest !== offered.digest)
      this.reloadInto(entry, offered, cause);
  }

  // Whether the host handed in `origin`'s config and the renderer still
  // names it: what an event that needs it waits for.
  holdsConfig(origin: RenderOrigin): boolean {
    return this.configDeliveries.has(originKey(origin));
  }

  // [LAW:one-source-of-truth] The deliveries the renderer still names, by
  // `originKey`: every other one goes, as the host lets its origin go. The
  // renderer's declaration names every origin an entry loads from
  // (`origins`), so an entry is never left without its delivery.
  prune(keep: ReadonlySet<string>): void {
    runInAction(() => {
      for (const key of [...this.configDeliveries.keys()])
        if (!keep.has(key)) this.configDeliveries.delete(key);
    });
  }

  // The compile a served state carries for `key`, else a new one — which the
  // table learns only when a state carrying it is served, so a load that fails
  // after compiling leaves nothing behind.
  private compileOf(key: string, input: CompileInput): CompiledConfig {
    return this.compiles.get(key) ?? compileDslConfig(input);
  }

  // [LAW:one-source-of-truth] Read off the map the cache serves: an entry's
  // own heap, plus each compile its entries carry once, however many share it.
  private accountedBytes(): number {
    const keys = new Set(
      [...this.entries.values()].map((e) => e.state.compileKey),
    );
    return (
      this.entries.size * ENTRY_BYTES +
      keys.size * COMPILE_BYTES +
      this.views.size * VIEW_BYTES
    );
  }

  // [LAW:dataflow-not-control-flow] One uniform shape: every entry has the
  // same fields and a renderable state. The renderer reads the data; no
  // special-case branches between "first load", "reload",
  // "reload-after-error".
  getOrCreate(origin: RenderOrigin, editing?: SessionId): CacheEntry {
    // [LAW:one-source-of-truth] The shared entry is still keyed by origin.
    // An active draft branches that input for one session inside the renderer.
    let key = originKey(origin);
    let draft: ConfigRevision | null = null;
    if (editing !== undefined) {
      draft = this.deps.editRevision(origin, editing);
      if (draft !== null) key = draftKey(editing);
    }
    const offered = draft ?? this.held(origin);
    const cause: LoadCause = { kind: draft === null ? "config" : "edit" };
    const existing = this.entries.get(key);
    if (
      existing !== undefined &&
      originKey(existing.origin) === originKey(origin)
    ) {
      runInAction(() => {
        this.entries.delete(key);
        this.entries.set(key, existing);
      });
      this.reconcile(existing, offered, cause);
      return existing;
    }
    if (existing !== undefined) this.drop(key, existing, "evict");

    const { projectDir, cwd } = origin;
    const { loaded, selected } = this.enter(origin, offered, null);
    const entry: CacheEntry = {
      origin,
      get configLayers() {
        return configPaths(this.revision.snapshot);
      },
      revision: offered,
      selected,
      lastError: loaded.error,
      fault: null,
      lastWarnings: loaded.warnings,
      get state() {
        return this.selected.state;
      },
    };
    // [LAW:one-source-of-truth] The current load's failure gates writes even
    // when the view keeps rendering its previous compiled configuration.
    makeObservable(entry, {
      revision: observableRef,
      selected: observableRef,
      lastError: observable,
      fault: observable,
      lastWarnings: observableRef,
    });
    // [LAW:single-enforcer] Hold, insert, then bound and notify. From the
    // moment the entry is in the map it is reachable for eviction and
    // dispose, so no later step can strand a registry outside it, and a
    // reentrant getOrCreate for this key finds the entry rather than building
    // a duplicate. The hold precedes the bound: an eviction there releases
    // another state's folders, which this one may name too. Every step after
    // the insertion runs whatever another throws, so a throwing log line
    // cannot skip the bound.
    // [LAW:dataflow-not-control-flow]
    runInAction(() => this.entries.set(key, entry));
    runEach([
      () => {
        if (loaded.state !== null)
          this.log("info", pluginLoadLine(loaded.layers, loaded.state));
      },
      () => this.fit(entry),
      () =>
        this.log(
          "info",
          `render-cache entry projectDir=${projectDir} cwd=${cwd} compile=${entry.state.compileKey.slice(0, 12)} entries=${this.entries.size} compiles=${this.compiles.size} accounted=${mb(this.accountedBytes())}/${mb(this.budgetBytes())}MB`,
        ),
      // An entry just created was drawn by no session.
      () => this.observers.onReload?.(entry, [], { kind: "open" }, loaded.kind),
    ]);

    return entry;
  }

  // [LAW:no-ambient-temporal-coupling] A render holds the state it draws
  // with for as long as it runs — across the payload await, where another
  // session's first render can evict its entry and a saved file can reload
  // it. Either retires the state; the cache disposes it when this hold is
  // released, so the render finishes on the state it resolved its payload
  // from. `using` at the call site releases on
  // every exit, a throw included.
  hold(origin: RenderOrigin): Hold {
    const entry = this.getOrCreate(origin);
    return this.holdState(entry, entry.state);
  }

  // The hold on `entry`'s state that `hold` and `holdView` hand out.
  private holdState(entry: CacheEntry, state: DslRenderState): Hold {
    const hold = this.holdOf(state);
    hold.holders++;
    let released = false;
    return {
      entry,
      state,
      [Symbol.dispose]: () => {
        // [LAW:no-silent-failure] A second release would count a render that
        // is not there, and a later render's hold would then read as none.
        if (released) throw new Error("render-cache hold released twice");
        released = true;
        hold.holders--;
        this.reclaim(state, hold);
      },
    };
  }

  // [LAW:no-ambient-temporal-coupling] A render's hold on the session's view
  // of the state it draws with, for the same reason as `hold`: a move, a
  // reload, an eviction or the host's retire retires the view, and the cache
  // disposes it when this hold is released.
  //
  // [LAW:single-enforcer] `facts` is the request the render is drawn for: the
  // view draws by it from here, opened (openView) or kept (`requested`), so
  // no view is drawn for another request.
  holdSession(origin: RenderOrigin, facts: F): SessionHold<S, F> {
    const entry = this.getOrCreate(origin, facts.hookData.session_id);
    const held = this.holdState(entry, entry.state);
    let view: SessionView<S, F>;
    let lease: ViewHold;
    try {
      view = this.viewOf(held.entry, held.state, facts, "request");
      lease = this.leaseOf(view);
    } catch (err) {
      // [LAW:no-ambient-temporal-coupling] The state hold is this call's
      // until the returned hold carries it: a throw before then releases it,
      // or the state could never be reclaimed.
      held[Symbol.dispose]();
      throw err;
    }
    return this.holdViewOf(held, view, lease);
  }

  // The edit turn switched the session's config input. Move its existing
  // view now so pushed frames and click validation see the same draft.
  refreshEditedView(sessionId: SessionId): void {
    const view = this.views.get(sessionId);
    const previous =
      view !== undefined
        ? { entry: this.leaseOf(view).entry, requestOf: view.facts }
        : this.pinnedFailure(sessionId);
    if (previous === undefined) return;
    const { origin } = previous.entry;
    const requested = previous.requestOf(sessionId);
    const entry = this.getOrCreate(origin, sessionId);
    // getOrCreate reloads an existing owner in place. Only moving to a
    // different owner needs another opening here.
    if (entry !== previous.entry)
      this.viewOf(entry, entry.state, requested, "reload");
    if (this.deps.editRevision(origin, sessionId) === null)
      this.dropDraft(sessionId);
    this.observers.onViewChanged?.(sessionId);
  }

  private dropDraft(sessionId: SessionId): void {
    const key = draftKey(sessionId);
    const entry = this.entries.get(key);
    if (entry !== undefined) this.drop(key, entry, "evict");
  }

  // [LAW:single-enforcer] The door to a session's current view, held for a
  // synchronous read as `holdSession` holds one, or none: a frame's draw and
  // the lane declaration's read of each view. It creates nothing — no entry,
  // no view, no declaration — so a frame performs no I/O; only an event opens
  // a view (ViewOpening).
  holdView(sessionId: SessionId): SessionHold<S, F> | null {
    const view = this.views.get(sessionId);
    if (view === undefined) return null;
    // Taken before the state hold, so a throw leaves nothing held.
    const lease = this.leaseOf(view);
    // [LAW:one-source-of-truth] The state held is the one the view is of.
    return this.holdViewOf(
      this.holdState(lease.entry, view.state),
      view,
      lease,
    );
  }

  // The shared committed state, without changing the cache's use order.
  committedState(origin: RenderOrigin): DslRenderState | null {
    return this.entries.get(originKey(origin))?.state ?? null;
  }

  // `held` with `lease` on `view` beside it, both released by the one
  // `using`. Nothing in it throws, so `held` is never stranded.
  private holdViewOf(
    held: Hold,
    view: SessionView<S, F>,
    lease: ViewHold,
  ): SessionHold<S, F> {
    lease.holders++;
    let released = false;
    return {
      entry: held.entry,
      state: held.state,
      view,
      [Symbol.dispose]: () => {
        if (released) throw new Error("render-cache view hold released twice");
        released = true;
        lease.holders--;
        this.reclaimView(view, lease);
        held[Symbol.dispose]();
      },
    };
  }

  // Why the session has no view, when its last opening threw: what a frame
  // draws in place of the view `holdView` found none of.
  openFailure(sessionId: SessionId): { readonly error: unknown } | null {
    return this.openFailures.get(sessionId) ?? null;
  }

  private pinnedFailure(sessionId: SessionId): OpenFailure<F> | undefined {
    return this.pins.has(sessionId)
      ? this.openFailures.get(sessionId)
      : undefined;
  }

  // [LAW:carrying-cost] Open feeds own their failures. Inactive errors keep
  // only the latest bounded set, including after the last feed unpins.
  private trimOpenFailures(): void {
    if (this.openFailures.size <= MAX_UNPINNED_FAILURES) return;
    const idle = [...this.openFailures.keys()].filter(
      (sid) => !this.pins.has(sid),
    );
    for (const sid of idle.slice(0, -MAX_UNPINNED_FAILURES))
      this.openFailures.delete(sid);
  }

  // [LAW:no-ambient-temporal-coupling] An open feed's pin on its session,
  // from the feed's open to its close (src/daemon/frame-feed.ts). Keyed by
  // session, so it follows the view wherever a request or a reload moves it.
  pin(sessionId: SessionId): () => void {
    this.pins.set(sessionId, (this.pins.get(sessionId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) throw new Error("render-cache pin released twice");
      released = true;
      const left = (this.pins.get(sessionId) ?? 0) - 1;
      if (left > 0) this.pins.set(sessionId, left);
      else {
        this.pins.delete(sessionId);
        this.trimOpenFailures();
      }
    };
  }

  // The session's view of `state`: the one it has, or a new one replacing it.
  private viewOf(
    entry: CacheEntry,
    state: DslRenderState,
    facts: F,
    by: ViewOpening,
  ): SessionView<S, F> {
    const sessionId = facts.hookData.session_id;
    const current = this.views.get(sessionId);
    if (current?.state === state) {
      // Move to end (most recently used), as getOrCreate does an entry.
      runInAction(() => {
        this.views.delete(sessionId);
        this.views.set(sessionId, current);
      });
      // A request is the one the view draws by from here.
      current.requested?.(facts);
      return current;
    }
    // [LAW:no-ambient-temporal-coupling] The new view opens before the old one
    // is retired, as a reload's successor does, and enters at the end, the
    // most recently used, as a kept view moves there. The old view is retired
    // whether or not the new one opens: the session's render resolved to
    // another entry either way.
    runInAction(() => this.views.delete(sessionId));
    let view: SessionView<S, F>;
    try {
      view = this.opened(entry, state, facts, by);
    } finally {
      if (current !== undefined) this.retireView(current, "moved");
    }
    // A view is charged to the budget like an entry.
    this.fit(entry);
    return view;
  }

  // [LAW:single-enforcer] The one way the cache opens a view: drawn by
  // `facts` from this turn (openView) and entered. Its caller charges it to
  // the budget, once however many it opens.
  private opened(
    entry: CacheEntry,
    state: DslRenderState,
    facts: F,
    by: ViewOpening,
  ): SessionView<S, F> {
    const sessionId = facts.hookData.session_id;
    const { cwd } = entry.origin;
    const { currentRequest } = this.deps;
    let view: SessionView<S, F>;
    try {
      view = openView(
        state,
        cwd,
        facts,
        {
          source: this.deps.source,
          changed: (sid) => this.observers.onViewChanged?.(sid),
          log: this.log,
          configAccess: () => this.accessTo(entry, state),
        },
        currentRequest === undefined
          ? undefined
          : () => currentRequest(sessionId),
      );
    } catch (error) {
      this.openFailures.delete(sessionId);
      this.openFailures.set(sessionId, {
        entry,
        requestOf: currentRequest ?? (() => facts),
        error,
      });
      this.trimOpenFailures();
      throw error;
    }
    this.openFailures.delete(sessionId);
    runInAction(() => this.views.set(sessionId, view));
    this.viewHolds.set(view, { entry, holders: 0, retired: null });
    this.log(
      "info",
      `session view opened sid=${JSON.stringify(sessionId)} by=${by} cwd=${cwd} views=${this.views.size}`,
    );
    return view;
  }

  // [LAW:one-source-of-truth] A draft holds its original file content for
  // preview. Only the current host observation says if it can write through.
  private accessTo(entry: CacheEntry, state: DslRenderState): ConfigAccess {
    const held = this.configDeliveries.get(originKey(entry.origin));
    if (held === undefined)
      return {
        kind: "unavailable",
        error: "No current config is held for this session",
      };
    // [LAW:one-source-of-truth] The load of the entry the view draws gates
    // its writes: a draft that loads can save over a committed file that
    // does not. An entry whose latest load threw holds no load of what it
    // was offered, whatever it last loaded.
    const error = entry.fault ?? entry.lastError;
    if (error !== null) return { kind: "unavailable", error };
    for (const { role, path, content } of held.snapshot.chain)
      if (content.kind === "unreadable")
        return {
          kind: "unavailable",
          error: `The ${role} config layer at ${path} could not be read: ${content.error}`,
        };
    return { kind: "available", roles: state.writable };
  }

  private leaseOf(view: SessionView<S, F>): ViewHold {
    const lease = this.viewHolds.get(view);
    // [LAW:no-silent-failure] As holdOf: every view handed out was entered.
    if (lease === undefined) throw new Error("render-cache view never served");
    return lease;
  }

  // The cache stopped serving `view`; its teardown is due now, or when the
  // last render holding it returns.
  private retireView(view: SessionView<S, F>, reason: ViewClose): void {
    if (this.views.get(view.sessionId) === view)
      runInAction(() => this.views.delete(view.sessionId));
    const successor = this.views.has(view.sessionId);
    this.presentations.retireView(
      view.sessionId,
      view.presentationTargets,
      successor,
    );
    view.retire();
    const lease = this.leaseOf(view);
    lease.retired = { reason, held: lease.holders };
    this.reclaimView(view, lease);
  }

  // [LAW:single-enforcer] The one place a view is disposed: retired and unheld.
  private reclaimView(view: SessionView<S, F>, lease: ViewHold): void {
    if (lease.retired === null || lease.holders > 0) return;
    this.viewHolds.delete(view);
    this.log(
      "info",
      `session view closed sid=${JSON.stringify(view.sessionId)} reason=${lease.retired.reason} released=${view.dispose()} held=${lease.retired.held} views=${this.views.size}`,
    );
  }

  // [LAW:single-enforcer] The host ended the session (its collector's
  // sweep): its view closes, and the failure no feed shows goes with it.
  retireSession(sessionId: SessionId): void {
    this.openFailures.delete(sessionId);
    const view = this.views.get(sessionId);
    if (view !== undefined) this.retireView(view, "idle");
    this.presentations.retire(sessionId);
    this.dropDraft(sessionId);
  }

  // [LAW:one-source-of-truth] What every session's open view needs read: the
  // plugin sources its config declares, at their storage folders, the runs
  // its `shell` and `file` sources name, and the variables of the session's
  // environment its `env` sources read. A declaration observes the current
  // views and what each sources from the host.
  // [LAW:one-source-of-truth] The origins the entries load from. An origin's
  // config is held as long as an entry at it lives, not as long as a session:
  // a session retires when idle while its entry stays to draw it again.
  origins(): readonly RenderOrigin[] {
    return [
      ...new Map(
        [...this.entries.values()].map(
          ({ origin }) => [originKey(origin), origin] as const,
        ),
      ).values(),
    ];
  }

  // [LAW:one-source-of-truth] A retired state can still serve an in-flight
  // draw. Its folders go with its last holder, just like its compile.
  managedFolders(): readonly string[] {
    const folders = new Set<string>();
    for (const state of this.holds.keys())
      for (const folder of state.sources.values()) folders.add(folder);
    return [...folders].sort();
  }

  configSelections() {
    return [...this.entries]
      .filter(([key, entry]) => key === originKey(entry.origin))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, { origin, selected }]) => ({
        origin,
        digest: selected.kind === "authored" ? selected.digest : null,
      }));
  }

  subscriptions(): Pick<Subscriptions, "sources"> {
    return {
      sources: Object.fromEntries(
        [...this.views].map(([session, view]) => [
          session,
          subscriptionsOf(view),
        ]),
      ),
    };
  }

  // The cache's teardown: every entry is dropped, so its state is disposed now
  // or when the render holding it returns. The entries' registries would
  // otherwise keep the cache, and every compile it serves, alive for as long
  // as the process runs.
  close(): void {
    if (this.closed) return;
    this.lifetime.abort(new Error("the render cache closed"));
    const entries = this.entries.size;
    for (const [key, entry] of this.entries) this.drop(key, entry, "close");
    runInAction(() => this.configDeliveries.clear());
    // [LAW:one-source-of-truth] Every state left in `holds` is retired and
    // waits on a render, so `retired` is the count of teardowns deferred.
    this.log(
      "info",
      `render-cache closed entries=${entries} deferred=${this.stats.retired}`,
    );
  }

  // [LAW:single-enforcer] Opening an entry, reloading a committed config,
  // and rebuilding a draft all choose the served state here.
  // [LAW:no-silent-failure] A closed cache disposed every state it built; one
  // built after would hold timers and watchers nothing tears down.
  private selectState(
    origin: RenderOrigin,
    { snapshot, digest }: ConfigRevision,
    previous: SelectedState | null,
  ): { readonly loaded: LoadOutcome; readonly selected: SelectedState } {
    if (this.closed) throw new Error("render cache used after close");
    const retained =
      previous?.kind === "authored" &&
      retainsConfig(origin.target, previous.repo, snapshot.repo)
        ? previous
        : null;
    const bundled = previous?.kind === "bundled" ? previous : null;
    const { cwd } = origin;
    const { repo } = snapshot;
    const loaded = loadOrigin(
      cwd,
      snapshot,
      this.deps,
      (retained ?? bundled)?.state ?? null,
    );
    if (loaded.state !== null)
      return {
        loaded,
        selected: { kind: "authored", state: loaded.state, digest, repo },
      };
    if (retained !== null) return { loaded, selected: retained };
    // [LAW:carrying-cost] The same load identity keeps the bundled state and
    // views when an authored edit only changes the diagnostic.
    const state = fallbackState(
      cwd,
      snapshot,
      this.deps,
      bundled?.state ?? null,
    );
    return {
      loaded,
      selected: bundled?.state === state ? bundled : { kind: "bundled", state },
    };
  }

  // [LAW:no-silent-failure] An entry loads, and a click writes, only from the
  // snapshot the host handed in for its origin. None is an event the renderer
  // did not park until its origin's `config` came: a bug, said with the
  // origin.
  snapshotFor(origin: RenderOrigin): ConfigSnapshot {
    return this.held(origin).snapshot;
  }

  private held(origin: RenderOrigin): ConfigRevision {
    if (this.closed) throw new Error("render cache used after close");
    const held = this.configDeliveries.get(originKey(origin));
    if (held === undefined)
      throw new Error(
        `no config is held for origin projectDir=${valueOf(origin.projectDir)} cwd=${valueOf(origin.cwd)} configFile=${valueOf(origin.target.path ?? "-")}: an event that needs it was not parked for its config`,
      );
    return held;
  }

  // [LAW:single-enforcer] The one way an entry leaves the map: the map stops
  // serving it, and its state is retired.
  private drop(
    key: string,
    entry: CacheEntry,
    reason: Teardown["reason"],
  ): void {
    runInAction(() => this.entries.delete(key));
    for (const [session, failure] of this.openFailures)
      if (failure.entry === entry) this.openFailures.delete(session);
    this.retire(entry.state, reason, null);
  }

  get stats(): RenderCacheStats {
    let held = 0;
    let retired = 0;
    for (const hold of this.holds.values()) {
      if (hold.holders > 0) held++;
      if (hold.retired !== null) retired++;
    }
    let retiredViews = 0;
    for (const lease of this.viewHolds.values()) {
      if (lease.retired !== null) retiredViews++;
    }
    return {
      size: this.entries.size,
      held,
      retired,
      compiles: this.compiles.size,
      views: this.views.size,
      pinned: this.pins.size,
      retiredViews,
      passages: this.presentations.stats().passages,
      accountedBytes: this.accountedBytes(),
      budgetBytes: this.budgetBytes(),
    };
  }

  // [LAW:single-enforcer] The one place the cache's bounds are enforced — its
  // bytes and its count — run after every change to what the map serves (an
  // insertion, a reload): least recently used first, until the map fits both
  // — never `served`, the entry the change was for, which a render is about
  // to draw.
  private fit(served: CacheEntry): void {
    const fits = (): boolean =>
      this.entries.size <= this.maxEntries &&
      this.accountedBytes() <= this.budgetBytes();
    // [LAW:no-ambient-temporal-coupling] An open feed protects the entry its
    // view draws or will retry. A frame never rebuilds it (`holdView`).
    const pinned = new Set(
      [...this.pins.keys()].flatMap((sessionId) => {
        const state =
          this.views.get(sessionId)?.state ??
          this.openFailures.get(sessionId)?.entry.state;
        return state === undefined ? [] : [state];
      }),
    );
    for (const [key, evicted] of this.entries) {
      if (fits()) return;
      if (evicted === served || pinned.has(evicted.state)) continue;
      this.drop(key, evicted, "evict");
    }
    // [LAW:no-silent-failure] Nothing left to evict: the entry served, the
    // entries open feeds draw, and their sessions' views alone exceed the
    // budget.
    if (!fits())
      this.log(
        "warn",
        `render-cache over budget entries=${this.entries.size} views=${this.views.size} pinned=${pinned.size} accounted=${mb(this.accountedBytes())}/${mb(this.budgetBytes())}MB`,
      );
  }

  // [LAW:single-enforcer] `selectState`, entered: a state the selection built
  // is served, or disposed when serving it throws, so no build is left with
  // no owner to tear down its watchers and timers.
  private enter(
    origin: RenderOrigin,
    revision: ConfigRevision,
    previous: SelectedState | null,
  ): { readonly loaded: LoadOutcome; readonly selected: SelectedState } {
    const chosen = this.selectState(origin, revision, previous);
    const { state } = chosen.selected;
    if (state === previous?.state) return chosen;
    try {
      this.serve(state);
    } catch (error) {
      state.registry.dispose();
      throw error;
    }
    return chosen;
  }

  // The cache starts serving `state`: unheld, and not yet retired — and the
  // compile it carries is the table's for its key. Whatever can throw runs
  // before the cache holds it, so a throw leaves nothing entered.
  private serve(state: DslRenderState): void {
    const held = this.compiles.get(state.compileKey);
    // [LAW:no-silent-failure] compileOf hands a build the table's compile for
    // its key, so a second compile under one key is a cache bug: overwriting
    // it would leave the first alive and uncounted.
    if (held !== undefined && held !== state.compiled)
      throw new Error(
        `render cache: a second compile for key ${state.compileKey.slice(0, 12)}`,
      );
    if (held === undefined)
      this.log(
        "info",
        `render-cache compile built key=${state.compileKey.slice(0, 12)} compiles=${this.compiles.size + 1}`,
      );
    runInAction(() => this.holds.set(state, { holders: 0, retired: null }));
    this.compiles.set(state.compileKey, state.compiled);
  }

  private holdOf(state: DslRenderState): StateHold {
    const hold = this.holds.get(state);
    // [LAW:no-silent-failure] Every state the map serves was entered at its
    // creation or its reload; one that was not is a cache bug, not a miss.
    if (hold === undefined) throw new Error("render-cache state never served");
    return hold;
  }

  // The cache stopped serving `state`: it left the map, or a reload
  // replaced it with `successor`. Its teardown is due — now, or at its last
  // holder's return.
  private retire(
    state: DslRenderState,
    reason: Teardown["reason"],
    successor: CacheEntry | null,
  ): void {
    // [LAW:single-enforcer] A view is a child of its state: the state going
    // retires every view of it first, so each is disposed before or with it.
    // [LAW:no-ambient-temporal-coupling] A reload opens each view's successor
    // over the new state first, drawn by the request the old one drew by, so
    // the next frame draws the successor or its opening's failure, never the
    // retired view.
    for (const view of [...this.views.values()]) {
      if (view.state !== state) continue;
      if (successor !== null)
        this.reopen(successor, view.sessionId, view.facts);
      this.retireView(view, reason);
    }
    const hold = this.holdOf(state);
    hold.retired = { reason, held: hold.holders };
    this.reclaim(state, hold);
  }

  // [LAW:single-enforcer] A reload opens a successor once. A failed opening
  // remains visible to its feed and leaves the other sessions recoverable.
  private reopen(
    entry: CacheEntry,
    session: SessionId,
    requestOf: (session: SessionId) => F,
  ): void {
    try {
      this.opened(entry, entry.state, requestOf(session), "reload");
    } catch (error) {
      this.log(
        "error",
        `session view reopen failed sid=${JSON.stringify(session)}: ${String(error)}`,
      );
    }
  }

  // [LAW:single-enforcer] The one place a state is disposed: once it is
  // retired AND unheld, from whichever of the two transitions came last. The
  // registry owns timers, fs watchers and MobX reactions — dropping it
  // without dispose leaks every handle the config declared.
  private reclaim(state: DslRenderState, hold: StateHold): void {
    if (hold.retired === null || hold.holders > 0) return;
    runInAction(() => this.holds.delete(state));
    this.log("info", configDisposeLine(hold.retired, state.registry.dispose()));
    // [LAW:one-source-of-truth] `holds` lists every state not yet reclaimed,
    // so a compile no state left there carries has no render to draw it.
    if (![...this.holds.keys()].some((s) => s.compileKey === state.compileKey))
      this.compiles.delete(state.compileKey);
  }

  // [LAW:one-source-of-truth] The sessions whose views draw from `entry`'s
  // state.
  private sessionsOn(entry: CacheEntry): SessionId[] {
    return [...this.views.values()]
      .filter((view) => view.state === entry.state)
      .map((view) => view.sessionId);
  }

  // Re-populate `entry` from `snapshot`, for `cause`.
  //
  // - Load success: swap the fresh state in, retire the prior one.
  // - Load failure: keep the prior state if still approved, otherwise serve
  //   the current snapshot's bundled default. Both report the load error.
  //
  // [LAW:single-enforcer] hot-reload contract: any reload that produces a
  // new DslConfig retires the old state, and `reclaim` disposes its
  // SourceRegistry — at once when no render holds it, else when the last
  // one returns. Dropping the reference without that would leak every
  // timer, watcher and MobX reaction it owns.
  //
  // [LAW:single-enforcer] One publish point for "this reload completed":
  // straight-line, so the signal structurally cannot be skipped by whichever
  // arm the load took.
  private reloadInto(
    entry: CacheEntry,
    revision: ConfigRevision,
    cause: LoadCause,
  ): void {
    // [LAW:no-ambient-temporal-coupling] Retry only the failures held before
    // this observation. A successor that fails here waits for a new one.
    const retry = [...this.openFailures].filter(
      ([session, failed]) => failed.entry === entry && this.pins.has(session),
    );
    const sessions = [
      ...this.sessionsOn(entry),
      ...retry.map(([session]) => session),
    ];
    // A reload whose build inputs did not move keeps its state and live views.
    const served = entry.state;
    // [LAW:no-ambient-temporal-coupling] The entry takes the load once the
    // cache serves its build. A throw before leaves the entry on the revision
    // it had, holding the throw as its fault, and the next use loads again
    // (`reconcile`).
    let chosen: ReturnType<typeof this.enter>;
    try {
      chosen = this.enter(entry.origin, revision, entry.selected);
    } catch (error) {
      // [LAW:one-source-of-truth] The bar says what the turn's failure says.
      const fault = rendererFailureOf(error).message;
      runInAction(() => {
        entry.fault = fault;
      });
      // [LAW:nothing-unseen] Every attempt that throws is a line, so a fault
      // that persists shows how often it was retried and when it cleared.
      this.log(
        "error",
        `config load threw projectDir=${valueOf(entry.origin.projectDir)} cwd=${valueOf(entry.origin.cwd)} cause=${cause.kind} error=${JSON.stringify(fault)}`,
      );
      throw error;
    }
    const { loaded, selected } = chosen;
    const replaced = selected.state !== served;
    runInAction(() => {
      entry.revision = revision;
      entry.selected = selected;
      entry.lastError = loaded.error;
      entry.fault = null;
      entry.lastWarnings = loaded.warnings;
    });
    // Every step after the take runs whatever another throws, and their
    // throws are raised together: a step one throw skipped would stay
    // skipped, since the entry's revision says the load is done.
    runEach([
      () => {
        if (loaded.state !== null)
          this.log("info", pluginLoadLine(loaded.layers, loaded.state));
      },
      () => {
        if (replaced) this.retire(served, "reload", entry);
      },
      ...(replaced || loaded.state !== null ? retry : []).map(
        ([session, failure]) =>
          () =>
            this.reopen(entry, session, failure.requestOf),
      ),
      // A reload can move the entry onto a compile no other entry carries,
      // and charges the views it reopened, once their predecessors are
      // retired.
      () => this.fit(entry),
      () => this.observers.onReload?.(entry, sessions, cause, loaded.kind),
    ]);
  }

  get size(): number {
    return this.entries.size;
  }

  // [LAW:single-enforcer] One read path for "any session's view" used by
  // the debug protocol's introspection (`debug vars` / `segments` / `config`).
  // Reads existing views — does NOT open one, so debug introspection never
  // has the side effect of creating a fresh cache entry (with its own
  // SourceRegistry timers/watchers) tied to the daemon's own `process.cwd()`.
  // The most recently rendered session's, since `views` is kept in use order.
  // Null while no session's view is open; debug responses are empty in that
  // case by construction.
  latestView(): SessionView<S, F> | null {
    return [...this.views.values()].at(-1) ?? null;
  }

  // [LAW:single-enforcer] Receipt targets live as long as their view and
  // surface do. The owner accepts only an observation from the current one.
  acceptFrame(id: EffectId, candidate: FrameCandidate) {
    const { session, by, target } = candidate;
    return this.views.get(session)?.presentationTargets[by] === target
      ? this.presentations.accept(id, candidate)
      : null;
  }

  // What the diagnostic under `key` copies in the frame renderer `by` last
  // delivered for the session; undefined while that renderer's last frame
  // did not list it. Reads, never opens, like latestView.
  drawnCopy(
    sessionId: SessionId,
    by: Drawing["by"],
    key: string,
  ): string | undefined {
    return this.presentations.copy(sessionId, by, key);
  }

  // Closing a feed retires that surface's presentation and the receipts
  // still on their way to it.
  stopDrawing(sessionId: SessionId, by: Drawing["by"]): void {
    const view = this.views.get(sessionId);
    if (view !== undefined) view.presentationTargets[by] = Symbol();
    this.presentations.stopDrawing(sessionId, by);
  }
}
