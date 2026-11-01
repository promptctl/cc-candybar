import fs from "node:fs";
import path from "node:path";
import { nearestWatchTarget } from "../../utils/watch-target.js";
import { chainName } from "../../config-hint.js";
import type { RichText } from "@promptctl/rich-js";
import { compareShallow, observable, reaction, runInAction } from "mobx";
import {
  neededPrefixesByPreset,
  settledLanes,
  sourcesRead,
  type Declaration,
  type DeclaredLanes,
  type DeclaredSources,
  type ViewFacts,
} from "../render-payload.js";
import type { FileEvents } from "./file-events.js";
import type { ManagedStorage, StorageKey } from "./managed-storage.js";
import type { RefreshLedger } from "../../utils/refresh-ledger";
import type { LinkSigner } from "../../click/link-signer.js";
import type { SessionId } from "../session-id.js";
import { fileHeldSettings } from "../setting-drafts.js";
import {
  repoConfigs,
  repoConfigsDir,
  repoConfigsPath,
} from "../repo-configs.js";
import { REPO_PLUGIN_DIR } from "../../config/loader/plugin-folders.js";
import type { Drawing } from "../../config/lanes.js";
import {
  repoUnreadNotice,
  type ApprovedRepo,
  type RepoGate,
} from "../../config/loader/repo-gate.js";
import {
  loadConfigChain,
  type LoadedChain,
  type LoadedFile,
  resolveDslConfig,
  configResolutionNotice,
  dslConfigCandidatePaths,
  detectConfigCollisions,
  ConfigError,
  type DroppedFileError,
  type ConfigLayer,
} from "../../config/dsl-loader.js";
import type {
  DslConfig,
  RawDslConfig,
  ValidatedConfig,
} from "../../config/dsl-types.js";
import { DEFAULT_DSL_CONFIG } from "../../config/default-dsl-config.js";
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
} from "../../dsl/render.js";
import { mb, NEAR_LIMIT } from "../limits.js";
import { stateGate } from "../verbs/state-validators.js";
import { configGate } from "../verbs/config-validators.js";
import { presetNames, presetRoot } from "../../config/presets.js";
import {
  presetOf,
  resolveEffectiveGlobals,
} from "../../config/effective-globals.js";
import { fixedSource, type ViewSource } from "../../dsl/view-source.js";
import { bindView } from "../../dsl/parts.js";
import { unusedDeclarations, type UnusedDecl } from "../../config/unused.js";
import { VariableStore } from "../../var-system/store.js";
import type { Launcher } from "../../proc/launch";
import { SourceRegistry } from "../../var-system/sources.js";
import type { VarScope } from "../../dsl/variable-scope.js";
import type { SessionStateReader, SessionStateRW } from "../session-state.js";
import {
  watchTargetsOf,
  type WatcherRegistry,
  type WatcherHandle,
  type BoundWatch,
  type Invalidation,
  type PathsWatch,
} from "./watchers.js";
import { quietLogger, type DaemonLogger } from "../../utils/logger.js";
import { valueOf } from "../../utils/logfmt.js";
import { digestOf, type Projection } from "../../utils/plain.js";
import { Holds } from "../../utils/holds.js";
import { ABSENT, failed, PENDING } from "../../utils/outcome.js";
import {
  pluginDataVar,
  type PluginDefinition,
} from "../../config/loader/plugins.js";
import { ownedBy, pluginNs } from "../../config/loader/plugin-scope.js";
import { projectionsOf } from "../../config/loader/projections.js";

// [LAW:one-source-of-truth] Each cache entry owns the live DSL state for a
// (projectDir, cwd) tuple: the parsed config, the variable store +
// registry it was registered against, the compiled segment closures, and
// the resolved base palette. registerDslConfig + drawDsl are the
// single render path — the cache only holds state across calls.
//
// [LAW:one-source-of-truth] Bounded by bytes, out of the daemon's one memory
// budget: an entry is a new one per directory a session renders from (every
// worktree, every `cd`), so a count sized for watchers (it was 256, ~2.4 GB of
// states) let the memory backstop trip long before anything was evicted
// (brandon-unfiled-3248.8yp). The heap a state holds beside its compile, and
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

// The render cache's share of the daemon's memory limit: what is left under
// the line the doctor calls near the limit once the rest of the daemon is
// reserved — so a share full at its charges, which a test holds real heap
// under and so are the most the cache can cost, never puts the daemon past
// that line, whatever the limit. The reserve is the ~60 MB a daemon serving
// one session is charged; the charges' own headroom over what entries hold is
// the heap's growth room, so reserving more would starve the cache at a
// lowered limit for nothing. At the default limit the share is 704 MB: ~126
// sessions on one compile, each an entry and a view, against a working set of
// ~20 directories in the production daemon.
// Measured, a full share costs less than its charges: serving 100 sessions,
// the daemon is charged ~430 MB in all with 560 MB of the share accounted.
const RENDER_CACHE_RESERVE_BYTES = 64 * 1024 * 1024;
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
// SourceRegistry (fs watchers, TTL timers) and a config
// watcher, a resource the byte budget does not see. At the default memory limit
// the bytes bind just short of it (~230 entries with no view); it is what
// bounds watchers above it, when CC_CANDYBAR_RSS_LIMIT_MB is raised.
export const MAX_ENTRIES = 256;

// [LAW:single-enforcer] These are the cache-and-registry deps — session state
// (for declareState atoms) and the watcher registry (for hot-reload's config file watcher). Daemon-
// owned data providers like the SessionUsageStore/git provider/etc. live in
// the session source (src/daemon/session-source.ts) a view's payload is
// derived through; they are not part of cache identity or lifecycle.
export interface RenderDeps<S extends ViewSource = ViewSource> {
  // Who its sources' programs belong to (StateDeps).
  launcher: Launcher;
  sessionState: SessionStateRW;
  watchers: WatcherRegistry;
  // The owner of every plugin's managed storage, whose folders a state's
  // build holds (StateDeps).
  storage: PluginStorage;
  // What signs the `run` links its compiles draw (StateDeps).
  signer: LinkSigner;
  // The ledger its states' user sources record their refreshes in
  // (StateDeps).
  ledger?: RefreshLedger;
  // The delivery owner its states' user sources read (StateDeps). Required,
  // so a daemon whose sources cannot hear a stall does not compile.
  fileEvents: FileEvents;
  // What a view declares of the daemon's shared entries
  // (src/daemon/render-payload.ts `declareLanes`); a test reading no built-in
  // source passes DECLARES_NOTHING.
  declare: Declare;
  // What a view draws from (src/daemon/session-source.ts); a test drawing no
  // view's own payload passes SOURCES_NOTHING.
  source: SourceOf<S>;
  // Where the cache's events go — every load, every teardown. Only the
  // daemon passes its log; a caller passing none logs quietly, like the
  // providers and the usage store.
  log?: DaemonLogger;
}

// What a render state's build asks of the managed storage owner: the key of
// each storage folder its config declares (creating the folder), and that
// folder's watch, held from the build to the state's reclaim.
export type PluginStorage = Pick<ManagedStorage, "keyFor" | "watch">;

// [LAW:single-enforcer] The storage of a build outside the daemon (the
// doctor's load, the demo's): it creates, watches and sweeps no folder,
// because only the daemon's owner knows which files its sessions hold, and a
// sweep anywhere else removes theirs. A view reading its keys reads the files
// as they are.
export const UNOWNED_STORAGE: PluginStorage = {
  keyFor: (folder) => ({ folder, generation: 0 }),
  watch: () => () => {},
};

// What building one config's state needs.
export interface StateDeps {
  // Who a source's program belongs to.
  readonly launcher: Launcher;
  readonly sessionState: SessionStateRW;
  readonly storage: PluginStorage;
  // What signs the `run` links a compile draws.
  readonly signer: LinkSigner;
  // Where a state's user sources record their refreshes: the daemon's one
  // ledger. A build outside the daemon (check, the doctor, a test) leaves it
  // out, and its registries keep their own.
  readonly ledger?: RefreshLedger;
  // The daemon's delivery owner, which a state's `watch_file` sources read. A
  // build outside the daemon leaves it out, and measures nothing.
  readonly fileEvents?: FileEvents;
  // The daemon's one watcher registry, which holds a state's `watch_file`
  // watches. A build outside the daemon leaves it out, and its registries
  // keep their own.
  readonly watchers?: WatcherRegistry;
  // The compile for a config's compile key. A cache shares one between every
  // entry whose config compiles alike (RenderCache's table); a one-shot load
  // has no other entry to share with and compiles its own.
  readonly compile?: CompileProvider;
}

// [LAW:no-ambient-temporal-coupling] The cache's outward lifecycle signal. A
// reload is the one event the cache alone knows the completion of — it runs
// from a debounced fs watcher, on the cache's own schedule — so anything that
// must run AFTER a reload (an operator log of its outcome, a test asserting
// on the state it wrote) needs the cache to say so, or it is left betting on
// a clock. The same named-bag idiom as drawDsl's RenderObservers
// [LAW:locality-or-seam]: a caller states what it passes by name, and a new
// observer is one field here, not a constructor signature every caller
// re-counts.
export interface RenderCacheObservers {
  // Fires once per completed reload of an entry — the initial population in
  // getOrCreate and every watcher-driven reload alike, success (a fresh
  // `state`) and failure (`lastError` set, prior state preserved) alike —
  // after the entry's fields and watcher are settled. The entry is handed
  // over as ReloadedEntry so the observer reads the outcome from the one
  // place it lives and the type, not this comment, keeps it from writing
  // there. `sessions` are those whose views drew from the entry before it
  // loaded: none for an entry just created. `cause` is why it loaded. Trusted
  // non-throwing (the same contract as onSegmentError): an observer that
  // throws is a caller bug surfaced loudly, never absorbed here.
  readonly onReload?: (
    entry: ReloadedEntry,
    sessions: readonly string[],
    cause: LoadCause,
    // What the load did: built a state, kept the one served, or failed.
    settled: Settled,
  ) => void;
  // Fires with a session's id when its view opens and whenever what the view
  // draws from moves (openView's `changed`): what a feed showing the session
  // wakes on.
  readonly onViewChanged?: (sessionId: string) => void;
}

// [LAW:types-are-the-program] The observer's view of an entry: an ALLOW-LIST
// of the load's outcome. Nothing that owns a resource — the watcher handle,
// the SourceRegistry, the validator disposers, the render-cell sink — crosses
// this seam, so a handle added to either type later is closed by
// construction, not by remembering to omit it (`Readonly` alone would not:
// it cannot stop a method call such as `dispose()`).
export type ReloadedEntry = Readonly<
  Pick<
    CacheEntry,
    | "projectDir"
    | "cwd"
    | "configFile"
    | "configLayers"
    | "repos"
    | "lastError"
    | "lastWarning"
  >
> & { readonly state: Readonly<Pick<DslRenderState, "config">> };

// [LAW:types-are-the-program] The DSL render state for an entry is one
// bundle, never null: an entry can ALWAYS render. It is seeded with the
// bundled default's state at creation (candybar-settings-ui-0gz) and
// replaced by each config that loads; a config that fails to load leaves it
// as it was. So the bar under a load error is the best config the entry has
// — the last one that loaded, or the bundled default before any has — and
// the settings menu (the door back to the file) exists from the first
// render, through the same synthesis every config gets.
//
// `neededInputPaths` is the layout-reachable closure of input paths for a
// preset, computed once per preset. The daemon's payload builder reads the
// active preset's to gate provider invocation.
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
  readonly buildWarnings: readonly string[];
  readonly store: VariableStore;
  readonly registry: SourceRegistry;
  readonly compiled: CompiledConfig;
  readonly neededInputPaths: (preset: string) => ReadonlySet<string>;
  // [LAW:one-source-of-truth] The preset names whose layout tree the config
  // FILE authors at the path presetRoot() reports for them (candybar-config-
  // dqe): `root` for a preset staging the config's own root, `presets.<n>.
  // root` otherwise. This is what `.preset.customized` means now — the file
  // declares that tree, whether a hand wrote it or a `+`/`-` click did; the
  // two are indistinguishable by design. Computed from the SAME raw parse
  // that produced `config`, on the SAME reload, so the two never drift.
  readonly authoredRoots: ReadonlySet<string>;
  // The config keys the FILE holds a value for at a layer a reset clears
  // (fileHeldSettings) — from the same raw parse, for the same reason.
  readonly fileHeldSettings: ReadonlySet<string>;
  // The file this load's durable clicks edit (the chain's home), once it
  // exists — what the menu's `↗ config` opens; null while it does not.
  readonly configPath: string | null;
  // What the file declares that nothing uses (the doctor's config check) —
  // from the same raw parse, for the same reason.
  readonly unused: readonly UnusedDecl[];
  // The plugin definitions this load merged, and those it dropped.
  readonly plugins: LoadedPlugins;
  // [LAW:no-ambient-temporal-coupling] Each plugin source the config
  // declares, at the key its build took for the source's folder. The build
  // holds each folder's watch until the state is reclaimed (its registry's
  // teardown), so a reload — which builds its successor first — never closes
  // and reopens one, and no view touches a watch.
  readonly sources: DeclaredSources;
}

// The installed roots searched (every one watched), and the definitions —
// installed and listed — merged and dropped.
type LoadedPlugins = LoadedChain["installed"];

// The files a config is merged from, lowest first, and the one durable
// clicks write — `resolveDslConfig`'s chain, or the bundled default's empty
// one.
export interface ConfigChain {
  readonly layers: readonly ConfigLayer[];
  readonly home: string;
  // The session's project, once approved: where the plugins it ships live.
  readonly repo: ApprovedRepo | null;
}

// [LAW:nothing-unseen] Which plugins a daemon load merged, how many variables
// they declare between them, the data file each merged one reads, the checkout a `{ checkout }` path resolved against —
// `git:<root>`, or `dir:<cwd>` for a directory in no checkout, `-` with no
// session — which it dropped, and how long the load took: a drop is also on
// the bar's message, but the rest is said nowhere else. The daemon's own sink —
// buildRenderState is shared with the demo.
export function pluginLoadLine(
  layers: readonly string[],
  {
    plugins,
    config,
    compiled,
  }: Pick<DslRenderState, "plugins" | "config" | "compiled">,
  ms: number,
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
    `config load ${chainName(layers, "<default>")}: projections=${[...projectionsOf(config).keys()].join(",") || "-"} instantSegments=${instantSegments(compiled).join(",") || "-"} instantTemplates=${compiled.instant.size} plugins loaded=${loaded.length} sources=${sources} pluginVariables=${pluginVariables} dropped=${dropped.length} unplaced=${unreached.length} checkout=${checkoutField} ms=${ms}` +
    loaded.map((p) => ` +${p.path} data=${dataOf(p)}`).join("") +
    dropped.map((d) => ` -${d.path} (${d.reason})`).join("") +
    unreached.map((d) => ` ~${d.path} (${d.reason})`).join("")
  );
}

// [LAW:nothing-unseen] A config's teardown releases every computed's MobX
// subscriptions (brandon-unfiled-3248.t14 was a teardown that released none,
// found in a heap snapshot because nothing said so). Why it was torn down,
// how many it released, and how many renders were still drawing with it when
// the cache retired it — those deferred the teardown to the last one's return
// (brandon-unfiled-3248.6rc) — beside the load line of what replaced it.
export interface Teardown {
  readonly reason: "reload" | "evict" | "close";
  // Renders holding the state when it was retired: 0 is a teardown at
  // retirement, more is one deferred to the last release.
  readonly held: number;
}

// [LAW:types-are-the-program] Why an entry loaded: its first load; a re-read
// a caller asked for, after a click's durable write or before a doctor
// verdict; a watch that heard something, the entry's own config watch or
// the repo-config answers watch every entry shares, carrying what it heard;
// or file events resuming after a span, starting `since`, in which an edit
// may have gone unheard.
export type LoadCause =
  | { readonly kind: "open" }
  | ExplicitLoad
  | { readonly kind: "config-watch"; readonly heard: Invalidation }
  | EveryEntryLoad;

// What reloads every entry at once: the answers on disk moved, or file events
// resumed after a span in which an edit may have gone unheard.
export type EveryEntryLoad =
  | { readonly kind: "answers-watch"; readonly heard: Invalidation }
  | { readonly kind: "events-resumed"; readonly since: number };

export interface ExplicitLoad {
  readonly kind: "write" | "doctor";
}

const heardField = (heard: Invalidation): string => {
  switch (heard.kind) {
    case "changed":
      return [...heard.paths].join(",");
    case "unknown":
      return "unknown";
    case "failed":
      return `failed:${heard.reason}`;
  }
};

const causeField = (cause: LoadCause): string => {
  switch (cause.kind) {
    case "open":
    case "write":
    case "doctor":
      return cause.kind;
    case "config-watch":
    case "answers-watch":
      return `${cause.kind}:${heardField(cause.heard)}`;
    case "events-resumed":
      return `${cause.kind}:${new Date(cause.since).toISOString()}`;
  }
};

// [LAW:nothing-unseen] Every (re)load's outcome, success and failure alike:
// why it ran, whether it built a state or kept the one served, the files it
// resolved, what failed or warned, which
// repositories it left out awaiting the user's answer or declined by it, and
// which directories claimed a worktree their repository does not vouch for,
// and why.
export function configLoadedLine(
  entry: ReloadedEntry,
  cause: LoadCause,
  settled: Settled,
): string {
  const dirs = (ds: readonly string[]): string => valueOf(ds.join(",") || "-");
  return `config loaded projectDir=${valueOf(entry.projectDir)} cwd=${valueOf(entry.cwd)} cause=${valueOf(causeField(cause))} state=${settled} files=${valueOf(chainName(entry.configLayers, "<bundled default>"))} awaiting=${dirs(entry.repos.awaiting)} declined=${dirs(entry.repos.declined)} unproven=${entry.repos.unproven.length === 0 ? "-" : JSON.stringify(entry.repos.unproven)} error=${entry.lastError === null ? "none" : JSON.stringify(entry.lastError)} warning=${entry.lastWarning === null ? "none" : JSON.stringify(entry.lastWarning)}`;
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
// parse / validate); `lastWarning` is advisory (e.g., extension collision —
// load succeeded but something the user should know about). The render path
// surfaces both through one diagnostics composer in src/daemon/draw-bar.ts.
// [LAW:types-are-the-program] `projectDir` and `cwd` are required inputs to
// every render request. The wire boundary in render-checkpoint.ts validates the
// underlying hookData and returns BAD_REQUEST when either is absent, so by
// the time a cache entry is built they are real non-empty paths. `configFile`
// is the explicit path a session's render origin names (a load-config pick,
// `--config`, or the `configEnv` hint; absolute) — present when
// overriding the standard precedence chain, undefined otherwise.
export interface CacheEntry {
  projectDir: string;
  cwd: string;
  configFile: string | undefined;
  // The files the state was merged from, lowest first, as the last load
  // resolved them (empty: the bundled default), and the one whose load
  // failed when the last load did.
  configLayers: readonly string[];
  // The file durable clicks write (resolveDslConfig's home).
  configHome: string;
  // What the session's repositories contribute, as the last load's answers
  // decided it: the bar asks for each one awaiting.
  repos: RepoGate;
  lastError: string | null;
  lastWarning: string | null;
  state: DslRenderState;
  // [LAW:one-source-of-truth] The entry's watch: where its config can change,
  // as the last load derived it, and the watch the registry holds for it, set
  // as one on every load. While a directory the derive names is briefly gone
  // the held watch is the one bound before, and both still state what is so:
  // the disk's chains, and the directories actually heard. Null until the
  // first bind.
  watch: BoundWatch | null;
}

// [LAW:no-ambient-temporal-coupling] A state's lifetime is a fact the cache
// owns (brandon-unfiled-3248.6rc): the renders holding it across their
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

// What opened a view: a request, a reload's successor, or a click that moved
// the session's origin (`follow`). Never a frame (`holdView`).
export type ViewOpening = "request" | "reload" | "click";

// Why a view stopped being served: its state did (reload, evict, close), its
// session's latest render resolved to another entry (`moved`), or no request
// read it across a whole sweep while no feed pinned its session (`idle`).
export type ViewClose = Teardown["reason"] | "moved" | "idle";

// A view's lifetime, as a state's (StateHold), the entry it opened over, and
// whether a request read it since the last sweep.
interface ViewHold {
  // [LAW:one-source-of-truth] The entry whose state the view is of: an entry
  // whose state changes or that is dropped retires its views first
  // (`retire`), so a served view's entry is this one.
  readonly entry: CacheEntry;
  holders: number;
  retired: { readonly reason: ViewClose; readonly held: number } | null;
  read: boolean;
}

// [LAW:nothing-unseen] The states renders are drawing with now, and those
// retired but not yet reclaimed because one still is (`daemon-stats`):
// `retired` climbing while `size` holds is a render that never returned.
export interface RenderCacheStats {
  readonly size: number;
  readonly held: number;
  readonly retired: number;
  // Distinct compiles the cache holds — below `size` exactly when entries
  // share them.
  readonly compiles: number;
  // Sessions' views served now: one per session at most.
  readonly views: number;
  // Sessions an open feed pins (`pin`).
  readonly pinned: number;
  // Views retired but not yet disposed because a render still holds one: as
  // `retired` is for states, climbing while `views` holds is a render that
  // never returned.
  readonly retiredViews: number;
  // What the entries the map serves are charged against the budget.
  readonly accountedBytes: number;
  readonly budgetBytes: number;
}

// [LAW:one-source-of-truth] Cache key includes every input that affects DSL
// resolution: projectDir, cwd, and the session's explicit config path (if any).
// `projectDir`/`cwd` are real strings by construction (validated upstream);
// `configFile` collapses absent → empty in the key, distinct from any real path.
function cacheKey(
  projectDir: string,
  cwd: string,
  configFile: string | undefined,
): string {
  return projectDir + "\0" + cwd + "\0" + (configFile ?? "");
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

// [LAW:single-enforcer] Same enumerator the resolver uses, so the watcher
// covers the exact set of paths the next reload would consult — an explicit
// `configFile` collapses to one candidate; absent, the precedence chain unfolds
// in full. Where each of those paths can change is the watch rule every file
// watcher shares (`watchTargetsOf`): a dotfiles-managed config is heard
// wherever a link in its chain is re-pointed.
//
// [LAW:no-silent-failure] A candidate whose chain the kernel stopped walking
// (a loop, an unreadable component) is watched as far as the walk got and
// reported in `unresolved` with the reason, so the caller can say which path
// hears less than it should.
function watchTargetsFor(entry: CacheEntry): PathsWatch {
  // A plugin definition is part of the config it is listed in: installing,
  // fixing or editing one reloads the config as an edit to the file would.
  const { loaded, dropped, unreached } = entry.state.plugins;
  // The project's plugin folder is consulted whatever its answer: a plugin
  // dropped there is a question to ask. The answers are the cache's own watch.
  const roots = [
    ...new Set([
      ...entry.state.plugins.roots,
      path.join(entry.projectDir, REPO_PLUGIN_DIR),
    ]),
  ];
  return watchTargetsOf({
    named: [
      ...dslConfigCandidatePaths(entry.projectDir, entry.cwd, entry.configFile),
      ...roots,
      ...loaded.map((d) => d.path),
      ...[...dropped, ...unreached].map((d) => d.path),
      // [LAW:single-enforcer] A declared storage folder is watched by name in
      // its plugin folder, by the follower that already watches the
      // definition: its removal, recreation or replacement reloads the
      // config, whose build recreates the folder and takes a new generation
      // from the storage owner — which never re-arms a watch itself.
      ...new Set([...entry.state.sources.values()].map((k) => k.folder)),
    ],
    // An existing root is watched for every child: a folder created in it is
    // a plugin installed.
    whole: roots,
  });
}

// The load's warning is ONE message (the bar's diagnostics show it whole);
// absent advisories are nulls in the list, an empty list is null.
function joinWarnings(parts: ReadonlyArray<string | null>): string | null {
  return parts.filter(Boolean).join("\n") || null;
}

// [LAW:types-are-the-program] One attempt at loading a config from disk, and
// what became of it: a state `built`, the served state `kept` because the
// resolve named the inputs it was built from, or `failed`, with the error and
// the file to blame. A state XOR an error, never both, never neither.
// `warning` and `layers` are facts of the attempt regardless of arm
// (collision detection runs on a broken file too).
export type LoadOutcome = {
  readonly layers: readonly string[];
  readonly home: string;
  readonly repos: RepoGate;
  readonly warning: string | null;
  // How long the attempt took, resolution to built state or to its error:
  // the one number that shows a load getting slower or faster.
  readonly ms: number;
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
  readonly warnings: readonly string[];
}

// [LAW:types-are-the-program] What a build reads, all of it read from disk
// before the build starts: the chain as it resolved, the loaded chain, and the
// storage key of every plugin source the config declares. `keyFor` moves a
// folder's generation on a loss or a changed identity, so a key is an input
// to the build, never something it finds out.
interface LoadInputs {
  readonly cwd: string;
  readonly chain: ConfigChain;
  readonly loaded: LoadedChain;
  readonly sources: DeclaredSources;
}

// A chain read and keyed, with the advisories the read earned.
export interface ResolvedLoad extends LoadInputs {
  readonly kind: "resolved";
  // [LAW:one-source-of-truth] The identity of everything a build derives a
  // state from: two loads with one key build interchangeable states.
  readonly key: string;
  readonly warnings: readonly string[];
}

// An attempt at a state from a resolved load: the served state `kept` when it
// was built from the same inputs, otherwise one built.
export type Attempt =
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
    rendering: [...p.rendering].sort(([a], [b]) => a.localeCompare(b)),
  } satisfies Projection<LoadedFile["plugins"]>;
}

function loadKey(inputs: LoadInputs): string {
  const { loaded, chain } = inputs;
  return digestOf({
    cwd: inputs.cwd,
    chain: {
      layers: chain.layers,
      home: chain.home,
      repo: chain.repo,
    } satisfies Projection<ConfigChain>,
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
        roots: loaded.installed.roots,
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
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, key]) => [name, key.folder, key.generation] as const),
  } satisfies Projection<LoadInputs>);
}

// [LAW:single-enforcer] The storage owner's one ask per load: for each folder
// the config's sources name, its key. The owner creates the folder, so its
// program has somewhere to write before any session reads it. The render path
// does no I/O for a source: a view's declaration takes the key from here.
function declaredSources(
  config: DslConfig,
  storage: PluginStorage,
): DeclaredSources {
  const keys = new Map<string, StorageKey>();
  const sources = new Map<string, StorageKey>();
  for (const [name, decl] of Object.entries(config.variables)) {
    if (decl.kind !== "source") continue;
    const key = keys.get(decl.storage) ?? storage.keyFor(decl.storage);
    keys.set(decl.storage, key);
    sources.set(name, key);
  }
  return sources;
}

// [LAW:single-enforcer] Read a chain from disk: each layer validated over the
// layers it joins, so cross-ref diagnostics name the failing file's own paths
// and lines, and every advisory a layer earns appended before its validation,
// so a cross-ref failure still carries them (a duplicate key names its line
// beside the error).
export function resolveLoad(
  cwd: string,
  chain: ConfigChain,
  storage: PluginStorage,
): ResolvedLoad | Failed {
  const warnings: string[] = [];
  try {
    const loaded = loadConfigChain(
      chain.layers,
      DEFAULT_DSL_CONFIG,
      { warned: (w) => warnings.push(...w) },
      { repo: chain.repo, cwd },
    );
    const inputs = {
      cwd,
      chain,
      loaded,
      sources: declaredSources(loaded.config, storage),
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
export function buildRenderState(load: ResolvedLoad, deps: StateDeps): Attempt {
  const { cwd, chain, loaded } = load;
  // [LAW:dataflow-not-control-flow][LAW:single-enforcer] `validateRenderable`
  // (inside the resolve) is the sole producer of `ValidatedConfig`, and the
  // renderer accepts only `ValidatedConfig`, so the compiler enforces the
  // chain — there is no "skip validate" path that typechecks downstream.
  const { layers, config, installed, dropped } = loaded;
  const merged = layers.at(-1)?.config ?? DEFAULT_DSL_CONFIG;
  const homeRaw = layers.find((l) => l.path === chain.home)?.raw ?? {};
  const inserted = layers.flatMap((l) =>
    (l.raw.insert ?? []).map((cell) => cell.seg),
  );
  // [LAW:one-source-of-truth] The advisories the build earns are facts of the
  // state it builds, carried on it, so a reload that keeps the state keeps
  // them too.
  const warnings: string[] = [];

  const store = new VariableStore();
  // The sessionState injection makes `kind: "state"` variables read/write the
  // same per-session store the click verbs mutate. `default_empty_value`
  // is honored from globals — it's the fallback used by input/env/etc.
  // sources when neither the path resolves nor the declaration carries
  // its own `default`. The loader validates it as a string; the registry
  // default ("") matches the historical behavior when omitted.
  const registry = new SourceRegistry(
    deps.launcher,
    store,
    config.globals.default_empty_value ?? "",
    deps.sessionState,
    null,
    deps.ledger,
    deps.fileEvents,
    deps.watchers,
  );

  let registration: Registration;
  try {
    // [LAW:one-source-of-truth] The compile holds no store: each render binds
    // its own (drawDsl), so the entry's registry is the store its renders read
    // — and the compile can be one shared by every entry whose config
    // compiles alike (brandon-unfiled-3248.8yp).
    registration = registerCompiled(
      config,
      registry,
      cwd,
      deps.compile ?? compileAlone(deps.signer),
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
    // are derived from its action table on demand (stateGate / configGate),
    // so nothing is installed here. They are built once now so an action
    // table that cannot gate — a built-in key re-claimed, two actions that
    // contradict each other on one key — fails this load, never the first
    // click.
    stateGate(config);
    configGate(config);
    // [LAW:no-ambient-temporal-coupling] Each folder's watch, held by the
    // registry until the state's teardown.
    for (const key of new Set(load.sources.values()))
      registry.own(deps.storage.watch(key));
  } catch (err) {
    registry.dispose();
    if (err instanceof ConfigError) warnings.push(...err.warnings);
    return { kind: "failed", cause: err, warnings };
  }

  // [LAW:one-source-of-truth] basePalette is NOT frozen here. One cache entry
  // serves many sessions, but the effective theme is per-session SessionState;
  // freezing the palette per entry would let the rendered colors diverge from
  // the session's chosen theme. The server resolves basePalette per render
  // from the effective theme (resolveThemeSelection, settled by drawDsl).
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
      neededInputPaths: neededPrefixesByPreset(config),
      // What a reset clears is the home's: resets write nowhere else.
      authoredRoots: authoredRoots(merged, homeRaw),
      fileHeldSettings: fileHeldSettings(homeRaw),
      configPath: chain.layers.some((l) => l.path === chain.home)
        ? chain.home
        : null,
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
        roots: installed.roots,
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

// What every load of one chain shares, whatever its attempt: the advisories
// its resolution earned, and when it started.
export interface LoadFrame {
  readonly repos: RepoGate;
  readonly advisories: ReadonlyArray<string | null>;
  readonly started: number;
}

// [LAW:single-enforcer] The one place a load's outcome is composed, for every
// reader (the render cache, the doctor, the demo). The warning is the
// resolution's advisories, the resolve's, then the attempt's: a built or kept
// state's own build warnings, or what a failed attempt earned before it threw,
// so warnings earned before a failure reach the bar beside the error, and a
// kept state never drops a line its build earned.
export function settle(
  frame: LoadFrame,
  chain: ConfigChain,
  resolveWarnings: readonly string[],
  attempt: Attempt,
): LoadOutcome {
  const common = {
    // [LAW:one-source-of-truth] The files reported are the chain loaded.
    layers: chain.layers.map((l) => l.path),
    home: chain.home,
    repos: frame.repos,
    ms: Math.round(performance.now() - frame.started),
  };
  const warning = (own: readonly string[]): string | null =>
    joinWarnings([...frame.advisories, ...resolveWarnings, ...own]);
  switch (attempt.kind) {
    case "built":
    case "kept":
      return {
        ...common,
        kind: attempt.kind,
        warning: warning(attempt.state.buildWarnings),
        state: attempt.state,
        error: null,
      };
    case "failed":
      return {
        ...common,
        kind: "failed",
        warning: warning(attempt.warnings),
        state: null,
        error: thrown(attempt.cause),
        cause: attempt.cause,
      };
  }
}

// [LAW:single-enforcer] Resolve a chain, attempt a state from it, settle: the
// one load every reader shares. `served` is the state the caller serves, if
// any (the render cache's reload): inputs that resolve to the key it was built
// from keep it, since rebuilding it would reopen every session view and
// restart its sources for nothing.
export function loadChain(
  frame: LoadFrame,
  cwd: string,
  chain: ConfigChain,
  deps: StateDeps,
  served: DslRenderState | null = null,
): LoadOutcome {
  const resolved = resolveLoad(cwd, chain, deps.storage);
  if (resolved.kind === "failed") return settle(frame, chain, [], resolved);
  // [LAW:one-source-of-truth] A memo on load identity, as the compile table
  // is on compile identity.
  const attempt: Attempt =
    served?.loadKey === resolved.key
      ? { kind: "kept", state: served }
      : buildRenderState(resolved, deps);
  return settle(frame, chain, resolved.warnings, attempt);
}

// [LAW:effects-at-boundaries] One attempt at the disk: read the user's
// answers for repositories, resolve the path, detect collisions, resolve the
// chain and attempt a state. It touches no entry — the cache folds the
// outcome onto a new entry (getOrCreate) or an existing one (reloadInto), so
// the state it built is never constructed-then-discarded and the no-file
// default is built once, not twice; `cc-candybar doctor`, which has no cache,
// reads the outcome and disposes the state it was handed.
export function loadFromDisk(
  projectDir: string,
  cwd: string,
  configFile: string | undefined,
  deps: StateDeps,
  served: DslRenderState | null = null,
): LoadOutcome {
  const started = performance.now();
  const resolution = resolveDslConfig(
    repoConfigs().read(),
    projectDir,
    cwd,
    configFile,
  );
  const { repos } = resolution;
  // `chain` loads its layers; `missing`/`unreadable` build the bundled
  // default — what distinguishes them is a notice, below, not a load path.
  const chain: ConfigChain = {
    layers: resolution.kind === "chain" ? resolution.layers : [],
    home: resolution.home,
    repo: repos.plugins,
  };
  // [LAW:dataflow-not-control-flow] Advisories run every load, independent
  // of load success — even if the .json5 fails to parse, the user still
  // wants to know they have a shadowed .json sibling; an explicit path to
  // an absent file is named whatever the default then does. Pure
  // file-existence checks, so cheap. The watcher already monitors every
  // candidate path, so creating/removing a duplicate — or the named file
  // appearing — triggers reload and re-detection automatically; nothing
  // else needs to invalidate this.
  const advisories = [
    detectConfigCollisions(projectDir, cwd),
    configResolutionNotice(resolution),
    repoUnreadNotice(repos),
  ];
  // [LAW:dataflow-not-control-flow] A failure at any step — parse,
  // registration, palette resolution — is the `failed` arm; the caller's
  // prior state stays untouched, so the daemon keeps rendering the
  // last-known-good config — the bundled default until one has loaded —
  // and its diagnostics count `lastError` and `lastWarning`.
  return loadChain({ repos, advisories, started }, cwd, chain, deps, served);
}

// [LAW:single-enforcer] What a config that fails its FIRST load renders: the
// bundled default. The render cache seeds an entry with it, and
// `cc-candybar doctor`, which has no cache, reads the same bar from it. The
// seed's own advisories go nowhere: the bar already carries the failed
// load's, and the default earns none by program invariant.
export function fallbackState(
  cwd: string,
  repo: ApprovedRepo | null,
  deps: StateDeps,
): DslRenderState {
  // The failed load's approved project: the seed draws the plugins it ships,
  // as the load would have.
  const resolved = resolveLoad(
    cwd,
    { layers: [], home: "", repo },
    deps.storage,
  );
  const built =
    resolved.kind === "failed" ? resolved : buildRenderState(resolved, deps);
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

// [LAW:one-source-of-truth] A session's view of one entry's state
// (brandon-unfiled-3248.8ro6, step 2): the session's own values — its inputs,
// its state reads, its derivations, the sources keyed on them — in a store
// over the entry's directory store, which it reads through to. Each session
// renders through its own, so a request writes only its own session's values
// and no other session's render re-runs, reads, or reports them.
//
// `holds` is what the session's renders read of the daemon's shared entries (a
// repo, a pane, a plugin's session file), as the view's declaration takes them
// (openView), so their owners' periods visit them while the view's preset and
// request name them and stop when it is disposed; the directory home reads
// none itself, so it holds none (brandon-unfiled-3248.8ro6).
//
// `lastRenderCellsBySegment` is the per-segment StripCell sink that drawDsl
// writes on each render — pre-layout cells, NOT serialized ANSI. Storing cells
// (not strings) keeps the hot path free of the per-segment renderStripCells
// call: the debug projection serializes on demand only when a `debug segments`
// request actually arrives. The map identity is stable for the view's
// lifetime; drawDsl clears + repopulates it in place. A segment hidden by
// `when` is absent from the map — its presence in the keys is the "this
// segment rendered" signal.
export interface SessionView<
  S extends ViewSource = ViewSource,
  F extends ViewFacts = ViewFacts,
> {
  readonly sessionId: SessionId;
  readonly state: DslRenderState;
  readonly store: VariableStore;
  readonly registry: SourceRegistry;
  readonly holds: Holds;
  // The request the view's renders draw by — the keys its declaration takes
  // its holds at. A render of the same request changes nothing.
  requested(facts: F): void;
  // The request the view draws by now: the one it opened with, or a later
  // one `requested` named.
  facts(): F;
  // The lanes the view's latest declaration handed it: what its draws read
  // of the daemon's shared entries.
  lanes(): DeclaredLanes;
  // What the view draws from: its payload and selections, bound to its
  // store's inputs and slots (`bindView`) when it opened.
  readonly source: S;
  readonly lastRenderCellsBySegment: Map<string, readonly RichText[]>;
  // The view is no session's bar from now on (a successor took it, or it
  // closed): it stops saying what it draws from moved, though a render that
  // holds it still draws from it.
  retire(): void;
  // [LAW:single-enforcer] The view's one teardown: its holds close and its
  // registry is disposed, so no caller of openView can release one and leak
  // the other. Returns how many computeds the registry's store released.
  dispose(): number;
}

// What a view declares into its holds: every keyed entry `closure` reads, at
// the keys `facts` name, and each of the config's `sources` it reads. Returns
// the lanes it took, and what threw.
export type Declare = (
  holds: Holds,
  facts: ViewFacts,
  closure: ReadonlySet<string>,
  sources: DeclaredSources,
) => Declaration;

export const DECLARES_NOTHING: Declare = (
  _holds,
  _facts,
  closure,
  sources,
) => ({
  lanes: settledLanes(ABSENT, sourcesRead(closure, sources)),
  faults: [],
});

// [LAW:one-source-of-truth] What a view is declared for, as it stands: the
// request its renders draw by, the preset its declaration resolved, and the
// lanes that declaration handed it — one record, written whole by each
// declaration, so a reader never joins one declaration's facts to another's
// lanes.
export interface ViewDeclared<F extends ViewFacts = ViewFacts> {
  readonly facts: F;
  readonly preset: string;
  readonly lanes: DeclaredLanes;
}

// What a view's source is built over: the session, the state it is a view of,
// the view's own store (a source's kept derivations are released with it),
// and its declaration, observable.
export interface SourcedView {
  readonly sessionId: string;
  readonly state: DslRenderState;
  readonly store: VariableStore;
  readonly declared: () => ViewDeclared;
}

export type SourceOf<S extends ViewSource> = (view: SourcedView) => S;

// A source answering nothing yet: every input of the view pending, and the
// selections the config declares — what a test's views draw from until it
// draws them through drawDsl, which binds a payload of its own.
export const SOURCES_NOTHING: SourceOf<ViewSource> = ({ state }) =>
  fixedSource(
    PENDING,
    resolveEffectiveGlobals(
      state.config,
      () => null,
      (preset) => state.authoredRoots.has(preset),
    ),
  );

// What a view reads to keep its declaration current, what it draws from, and
// whom it tells that what it draws from moved.
export interface ViewDeclaring<S extends ViewSource = ViewSource> {
  readonly sessionState: SessionStateReader;
  readonly declare: Declare;
  readonly source: SourceOf<S>;
  readonly changed: (sessionId: string) => void;
  readonly log: DaemonLogger;
}

// [LAW:single-enforcer] The one way a view is built: the state's directory
// registry opens a view registry, and the config's view-scoped variables are
// declared into it, in `cwd` — the entry's, where its shells run.
//
// [LAW:no-ambient-temporal-coupling] Its holds are declared by one reaction,
// over the request its renders draw by and the preset the session's picks
// resolve to (brandon-unfiled-3248.8ro6, step 3): a request naming other keys,
// or a click moving the preset, declares again in the turn it lands, so the
// sources a preset newly places are read before any draw asks for them, and
// those it stops placing are released at once.
//
// [LAW:types-are-the-program] A view is never undeclared (step 4): it opens
// with the request it is drawn for and declares in its opening turn, so its
// lanes always hold its latest declaration's.
export function openView<S extends ViewSource, F extends ViewFacts>(
  state: DslRenderState,
  cwd: string,
  facts: F,
  { sessionState, declare, source: sourceOf, changed, log }: ViewDeclaring<S>,
): SessionView<S, F> {
  // [LAW:one-source-of-truth] The session is the one the request's checkpoint
  // parsed: a later request of the view's names the same one.
  const { sessionId } = facts;
  const registry = state.registry.view();
  const holds = new Holds();
  // What fails to declare here failed in the load's probe (buildRenderState),
  // which reported it: a declaration reads only the config.
  declareDslVariables(state.config, registry, cwd, VIEW_SCOPE);
  const presetNow = () =>
    presetOf(state.config, (key) => sessionState.get(sessionId, key));
  // [LAW:no-silent-failure] The closure is computed here, beside the
  // declaration, where a throw is logged — a reaction's tracked expression
  // that throws reaches only the console MobX prints to, which nobody reads in
  // a detached daemon. A declaration that throws keeps the holds it had, and
  // its lanes answer its failure, naming the cause.
  const lanesFor = (facts: ViewFacts, preset: string): DeclaredLanes => {
    try {
      const reads = state.neededInputPaths(preset);
      const {
        result: { lanes: taken, faults },
        acquired,
        released,
      } = holds.declare(() => declare(holds, facts, reads, state.sources));
      for (const fault of faults) {
        log(
          "error",
          `session view declaration threw sid=${JSON.stringify(sessionId)} ${fault}`,
        );
      }
      // [LAW:verifiable-goals] A declaration that moved a hold — a preset
      // click, a request naming another key — says so; one that kept what
      // the view held, every other request's, writes nothing.
      if (acquired + released > 0) {
        log(
          "info",
          `session view declared sid=${JSON.stringify(sessionId)} acquired=${acquired} released=${released} held=${holds.size}`,
        );
      }
      return taken;
    } catch (e) {
      log(
        "error",
        `session view declaration threw sid=${JSON.stringify(sessionId)}: ${String(e)}`,
      );
      return settledLanes(failed(`view declaration threw: ${String(e)}`), [
        ...state.sources.keys(),
      ]);
    }
  };
  // [LAW:no-ambient-temporal-coupling] The opening declaration, and each
  // request's, runs in its own call, never as a reaction's run: MobX holds a
  // reaction inside a batch (a reaction's effect, an action) until the batch
  // ends, and a frame drawn in that batch would read a view declared for a
  // request it is not drawn for.
  //
  // [LAW:one-source-of-truth] The view's one record of what it is declared
  // for, and the lanes that declaration handed it (ViewDeclared): observable,
  // so the view's payload is derived again in the turn a declaration lands.
  const declaration = (facts: F, preset: string): ViewDeclared<F> => ({
    facts,
    preset,
    lanes: lanesFor(facts, preset),
  });
  const declared = observable.box(declaration(facts, presetNow()), {
    deep: false,
  });
  // [LAW:single-enforcer] A (request, preset) pair is declared once.
  const redeclare = (facts: F, preset: string): void => {
    const now = declared.get();
    if (facts === now.facts && preset === now.preset) return;
    const next = declaration(facts, preset);
    runInAction(() => declared.set(next));
  };
  // The preset moves with the session's picks, which the reaction tracks: its
  // first run, whenever it comes, declares only a preset moved since.
  const stop = reaction(
    presetNow,
    (preset) => redeclare(declared.get().facts, preset),
    { fireImmediately: true },
  );
  // [LAW:single-enforcer] The view's inputs and slots read its source from
  // here on (src/dsl/parts.ts): no draw writes one.
  const source = sourceOf({
    sessionId,
    state,
    store: registry.variableStore,
    declared: () => declared.get(),
  });
  bindView(state.compiled, registry.variableStore, registry, source);
  // [LAW:single-enforcer] The view's one say that what it draws from moved:
  // its payload (its request, its picks), every lane it declared, plugin
  // sources included (`today`'s day sums, which only a draw's projection
  // reads, among them), its
  // selections, or what its own or its directory's sources published. Told
  // as it opens, since a view opening is what its session's bar draws from
  // changing. The draw writes none of these (step 4e), so no frame wakes the
  // next one.
  // [LAW:no-silent-failure] A tracked read that throws is logged: a reaction
  // that let it go would reach only the console MobX prints to.
  const stopChanged = reaction(
    () => {
      const { sources, ...keyed } = declared.get().lanes;
      return [
        source.payload(),
        source.selections(),
        registry.published(),
        state.registry.published(),
        ...[...Object.values(keyed), ...sources.values()].map((lane) =>
          lane.current(),
        ),
      ];
    },
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
    holds,
    source,
    requested: (next) => redeclare(next, presetNow()),
    facts: () => declared.get().facts,
    lanes: () => declared.get().lanes,
    lastRenderCellsBySegment: new Map<string, readonly RichText[]>(),
    retire: stopChanged,
    dispose: () => {
      stop();
      stopChanged();
      holds.close();
      return registry.dispose();
    },
  };
}

// [LAW:no-ambient-temporal-coupling] The cache's one timer, armed by the first
// render and stopped with the last entry: every interval it closes each view
// no request read since the interval before and no open feed pins, which
// releases the view's holds, so an owner's period stops visiting a repo, pane
// or session file 2.5 to 5 minutes after the session's last request. A view
// still drawn holds what its declaration takes (openView), and a period
// resumed after a gap reads at once.
export const HOLD_SWEEP_MS = 150_000;

export class RenderCache<
  S extends ViewSource = ViewSource,
  F extends ViewFacts = ViewFacts,
> {
  private readonly entries = new Map<string, CacheEntry>();
  // [LAW:one-source-of-truth] The user's answers for repositories are one
  // fact for the whole daemon, so one watch follows them, never one per
  // entry. The book has a folder of its own, made here so the watch never
  // falls back to the state directory, where the daemon's log writes on every
  // request.
  private readonly answersWatch: WatcherHandle;
  private sweep: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  // Every state the map serves or served, until reclaimed.
  private readonly holds = new Map<DslRenderState, StateHold>();
  // [LAW:one-source-of-truth] Each session's ONE view: of the entry its latest
  // render resolved to. A render from another entry replaces it.
  private readonly views = new Map<string, SessionView<S, F>>();
  // [LAW:one-source-of-truth] What each diagnostic a session's renderers last
  // delivered copies, by the key its copy click names (src/render/
  // diagnostics.ts), one map per renderer, since a request and a feed frame
  // list different messages and a click names the surface it came from. Held
  // by session, not by view, because a frame on screen outlives the view it
  // was drawn from (a reload's successor); dropped when the session has no
  // view. No link carries the text it copies.
  private readonly copies = new Map<
    string,
    Map<Drawing["by"], ReadonlyMap<string, string>>
  >();
  // Every view the cache serves or served, until reclaimed.
  private readonly viewHolds = new Map<SessionView<S, F>, ViewHold>();
  // [LAW:no-ambient-temporal-coupling] The sessions an open feed draws, by
  // how many pins each holds: their views are never closed idle and their
  // entries never evicted (`fit`), for as long as the feed is open — the fact
  // itself, not frames happening to read the view within each sweep.
  private readonly pins = new Map<string, number>();
  // [LAW:no-silent-failure] Each session whose view last failed to open, by
  // the error and the request the opening was for, until a view opens for
  // it: a frame draws that error, never the last bar it pushed, and a click
  // that moves the origin retries by that request (`follow`). Written only by
  // `opened`, which sets either this or the session's view, never both.
  private readonly openFailures = new Map<
    string,
    { readonly error: unknown; readonly facts: F }
  >();
  // [LAW:one-source-of-truth] One compile per compile key, shared by every
  // state carrying that key, and dropped with the last of them (reclaim).
  private readonly compiles = new Map<string, CompiledConfig>();
  private readonly deps: RenderDeps<S> & StateDeps;
  private readonly log: DaemonLogger;
  // Read when an eviction is decided: the budget is a boot-time fact.
  private readonly budgetBytes: () => number;
  private readonly maxEntries: number;
  private readonly observers: RenderCacheObservers;

  constructor(
    deps: RenderDeps<S>,
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
    fs.mkdirSync(repoConfigsDir(), { recursive: true });
    const { dir, name } = nearestWatchTarget(repoConfigsPath());
    this.answersWatch = deps.watchers.acquire(
      `repo-configs:${dir}/${name}`,
      { dirs: [{ path: dir, filenames: [name] }] },
      (heard) => this.reloadEvery({ kind: "answers-watch", heard }),
    );
  }

  // The compile a served state carries for `key`, else a new one — which the
  // table learns only when a state carrying it is served, so a load that fails
  // after compiling leaves nothing behind.
  private compileOf(key: string, input: CompileInput): CompiledConfig {
    return this.compiles.get(key) ?? compileDslConfig(input, this.deps.signer);
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
  getOrCreate(
    projectDir: string,
    cwd: string,
    configFile: string | undefined,
  ): CacheEntry {
    const key = cacheKey(projectDir, cwd, configFile);
    const existing = this.entries.get(key);
    if (existing) {
      // Move to end (most recently used) for LRU eviction.
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }

    const loaded = this.load(projectDir, cwd, configFile, null);
    if (loaded.state !== null)
      this.log("info", pluginLoadLine(loaded.layers, loaded.state, loaded.ms));
    // [LAW:no-silent-failure] A config that fails its FIRST load still yields
    // a bar: the bundled default, built exactly here and only then — the error
    // is counted by the indicator beside its settings door, loud, and the
    // settings menu is the door back to the file. The default validates by program invariant
    // (test/default-dsl-config.test.ts); a throw is a daemon bug and surfaces
    // as the request's failure, never a half-built entry.
    const entry: CacheEntry = {
      projectDir,
      cwd,
      configFile,
      configLayers: [],
      configHome: "",
      repos: loaded.repos,
      lastError: loaded.error,
      lastWarning: loaded.warning,
      state:
        loaded.state ?? fallbackState(cwd, loaded.repos.plugins, this.deps),
      watch: null,
    };
    this.serve(entry.state);
    // [LAW:single-enforcer] Insert, bound, watch, then notify — in that
    // order. From the moment the entry is in the map it is reachable for
    // eviction and dispose, so a throwing observer cannot strand a registry
    // outside it, and a reentrant getOrCreate for this key finds the entry
    // rather than building a duplicate. The bound runs first because it is a
    // fact about the MAP, complete at insertion: nothing later (including an
    // observer throwing) can skip it. [LAW:dataflow-not-control-flow]
    this.entries.set(key, entry);
    this.fit(entry);
    this.log(
      "info",
      `render-cache entry projectDir=${projectDir} cwd=${cwd} compile=${entry.state.compileKey.slice(0, 12)} entries=${this.entries.size} compiles=${this.compiles.size} accounted=${mb(this.accountedBytes())}/${mb(this.budgetBytes())}MB`,
    );
    this.refreshWatcher(entry, loaded);
    // An entry just created was drawn by no session.
    this.observers.onReload?.(entry, [], { kind: "open" }, loaded.kind);

    return entry;
  }

  // [LAW:no-ambient-temporal-coupling] A render holds the state it draws
  // with for as long as it runs — across the payload await, where another
  // session's first render can evict its entry and a saved file can reload
  // it. Either retires the state; the cache disposes it when this hold is
  // released, so the render finishes on the state it resolved its payload
  // from (brandon-unfiled-3248.6rc). `using` at the call site releases on
  // every exit, a throw included.
  hold(projectDir: string, cwd: string, configFile: string | undefined): Hold {
    const entry = this.getOrCreate(projectDir, cwd, configFile);
    return this.holdState(entry, entry.state);
  }

  // The hold on `entry`'s state that `hold` and `holdView` hand out.
  private holdState(entry: CacheEntry, state: DslRenderState): Hold {
    const hold = this.holdOf(state);
    hold.holders++;
    this.armSweep();
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
  // reload, an eviction or an idle sweep retires the view, and the cache
  // disposes it when this hold is released.
  //
  // [LAW:single-enforcer] `facts` is the request the render is drawn for: the
  // view is declared with it here, opened (openView) or kept (`requested`),
  // so no view is drawn declared for another request.
  holdSession(
    projectDir: string,
    cwd: string,
    configFile: string | undefined,
    facts: F,
  ): SessionHold<S, F> {
    const held = this.hold(projectDir, cwd, configFile);
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
    lease.read = true;
    return this.holdViewOf(held, view, lease);
  }

  // [LAW:single-enforcer] A frame's door: the session's current view, held
  // for its synchronous draw as `holdSession` holds one, or none. It creates
  // nothing — no entry, no view, no declaration — so a frame performs no I/O
  // (brandon-unfiled-3248.8ro6, 5a); only an event opens a view
  // (ViewOpening). A frame is no request, so it leaves the view's `read`
  // alone: an open feed keeps its view by its pin.
  holdView(sessionId: string): SessionHold<S, F> | null {
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
  openFailure(sessionId: string): { readonly error: unknown } | null {
    return this.openFailures.get(sessionId) ?? null;
  }

  // [LAW:single-enforcer] A click that moved the session's origin — a
  // load-config pick, or a history step restoring one — moves its view to the
  // origin's entry, declared with the request the view draws by, as a
  // request from there would (`journaled`, src/daemon/verbs/index.ts). A
  // session whose last opening failed opens by the request that opening was
  // for, so a pick that fixes it shows with no request after it. A session
  // with neither has nothing to move: no feed draws it, and its next request
  // opens one. A click that left the origin alone finds the view already on
  // its entry and changes nothing, its use order included, so the latest
  // rendered session stays the one that rendered.
  follow(
    sessionId: string,
    projectDir: string,
    cwd: string,
    configFile: string | undefined,
  ): void {
    const current = this.views.get(sessionId);
    // Read before the hold: building the origin's entry may evict the one
    // the current view is of, which retires the view.
    const facts = current?.facts() ?? this.openFailures.get(sessionId)?.facts;
    if (facts === undefined) return;
    const origin = this.entries.get(cacheKey(projectDir, cwd, configFile));
    if (current !== undefined && origin?.state === current.state) return;
    using held = this.hold(projectDir, cwd, configFile);
    this.viewOf(held.entry, held.state, facts, "click");
  }

  // [LAW:no-ambient-temporal-coupling] An open feed's pin on its session,
  // from the feed's open to its close (src/daemon/frame-feed.ts). Keyed by
  // session, so it follows the view wherever a request, a reload or a click
  // moves it.
  pin(sessionId: string): () => void {
    this.pins.set(sessionId, (this.pins.get(sessionId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) throw new Error("render-cache pin released twice");
      released = true;
      const left = (this.pins.get(sessionId) ?? 0) - 1;
      if (left > 0) this.pins.set(sessionId, left);
      else this.pins.delete(sessionId);
    };
  }

  // The session's view of `state`: the one it has, or a new one replacing it.
  private viewOf(
    entry: CacheEntry,
    state: DslRenderState,
    facts: F,
    by: ViewOpening,
  ): SessionView<S, F> {
    const { sessionId } = facts;
    const current = this.views.get(sessionId);
    if (current?.state === state) {
      // Move to end (most recently used), as getOrCreate does an entry.
      this.views.delete(sessionId);
      this.views.set(sessionId, current);
      // A request declares again before its refresh.
      current.requested(facts);
      return current;
    }
    // [LAW:no-ambient-temporal-coupling] The new view is declared before the
    // old one is retired, as a reload's successor is, so a move between two
    // directories of one repo keeps the repo held across it. It enters at the
    // end, the most recently used, as a kept view moves there.
    // The old view is retired whether or not the new one opens: the session's
    // render resolved to another entry either way.
    // The successor is the session's view going on, as a reload's is: a
    // session no request read since the last sweep is still closed by the
    // next.
    this.views.delete(sessionId);
    const read = current !== undefined && this.leaseOf(current).read;
    let view: SessionView<S, F>;
    try {
      view = this.opened(entry, state, facts, read, by);
    } finally {
      if (current !== undefined) this.retireView(current, "moved");
    }
    // A view is charged to the budget like an entry.
    this.fit(entry);
    return view;
  }

  // [LAW:single-enforcer] The one way the cache opens a view: declared with
  // `facts` in this turn (openView) and entered — `read` whether a render
  // read the session's view since the last sweep. Its caller charges it to
  // the budget, once however many it opens.
  private opened(
    entry: CacheEntry,
    state: DslRenderState,
    facts: F,
    read: boolean,
    by: ViewOpening,
  ): SessionView<S, F> {
    const { sessionId } = facts;
    let view: SessionView<S, F>;
    try {
      view = openView(state, entry.cwd, facts, {
        sessionState: this.deps.sessionState,
        declare: this.deps.declare,
        source: this.deps.source,
        changed: (sid) => this.observers.onViewChanged?.(sid),
        log: this.log,
      });
    } catch (error) {
      this.openFailures.set(sessionId, { error, facts });
      throw error;
    }
    this.openFailures.delete(sessionId);
    this.views.set(sessionId, view);
    this.viewHolds.set(view, { entry, holders: 0, retired: null, read });
    this.log(
      "info",
      `session view opened sid=${JSON.stringify(sessionId)} by=${by} cwd=${entry.cwd} views=${this.views.size}`,
    );
    return view;
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
      this.views.delete(view.sessionId);
    // A session left with no view is closed, and its frames with it; a
    // successor opened first keeps what is on screen copyable.
    if (!this.views.has(view.sessionId)) this.copies.delete(view.sessionId);
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

  private armSweep(): void {
    if (this.sweep !== null) return;
    this.sweep = setInterval(() => this.releaseIdle(), HOLD_SWEEP_MS);
    this.sweep.unref?.();
  }

  // One sweep. Public so a test can run it at an instant it chose.
  releaseIdle(): void {
    // A view no request read across the whole interval, whose session no
    // open feed pins, is closed: its session ended, or draws from another
    // daemon's bar no more.
    for (const [view, lease] of this.viewHolds) {
      if (lease.retired !== null || this.pins.has(view.sessionId)) continue;
      if (lease.read) lease.read = false;
      else this.retireView(view, "idle");
    }
    // A failure no open feed shows has no frame to draw it in: the session's
    // next request reports its own.
    for (const sessionId of this.openFailures.keys())
      if (!this.pins.has(sessionId)) this.openFailures.delete(sessionId);
    if (this.entries.size === 0 && this.sweep !== null) {
      clearInterval(this.sweep);
      this.sweep = null;
    }
  }

  // The cache's teardown: the sweep stops, and every entry is dropped, so its
  // state is disposed now or when the render holding it returns. The sweep and
  // the entries' watchers would otherwise keep the cache, and every compile it
  // serves, alive for as long as the process runs.
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.sweep !== null) clearInterval(this.sweep);
    this.sweep = null;
    this.answersWatch.release();
    const entries = this.entries.size;
    for (const [key, entry] of this.entries) this.drop(key, entry, "close");
    // [LAW:one-source-of-truth] Every state left in `holds` is retired and
    // waits on a render, so `retired` is the count of teardowns deferred.
    this.log(
      "info",
      `render-cache closed entries=${entries} deferred=${this.stats.retired}`,
    );
  }

  // [LAW:single-enforcer] The one place the cache loads a state, so a closed
  // cache refuses every way one would be built — a new entry, a reload, a
  // config watch firing after the close.
  // [LAW:no-silent-failure] A closed cache disposed every state it built; one
  // built after would hold timers and watchers nothing tears down.
  private load(
    projectDir: string,
    cwd: string,
    configFile: string | undefined,
    served: DslRenderState | null,
  ): LoadOutcome {
    if (this.closed) throw new Error("render cache used after close");
    return loadFromDisk(projectDir, cwd, configFile, this.deps, served);
  }

  // [LAW:single-enforcer] The one way an entry leaves the map: its watcher
  // goes, the map stops serving it, and its state is retired.
  private drop(
    key: string,
    entry: CacheEntry,
    reason: Teardown["reason"],
  ): void {
    entry.watch?.held.handle.release();
    this.entries.delete(key);
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
    // [LAW:no-ambient-temporal-coupling] An entry a pinned session's view is
    // of is drawn by an open feed, which a frame never rebuilds (`holdView`).
    const pinned = new Set(
      [...this.pins.keys()].flatMap((sessionId) => {
        const view = this.views.get(sessionId);
        return view === undefined ? [] : [view.state];
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

  // The cache starts serving `state`: unheld, and not yet retired — and the
  // compile it carries is the table's for its key.
  private serve(state: DslRenderState): void {
    const held = this.compiles.get(state.compileKey);
    // [LAW:no-silent-failure] compileOf hands a build the table's compile for
    // its key, so a second compile under one key is a cache bug: overwriting
    // it would leave the first alive and uncounted.
    if (held !== undefined && held !== state.compiled)
      throw new Error(
        `render cache: a second compile for key ${state.compileKey.slice(0, 12)}`,
      );
    this.holds.set(state, { holders: 0, retired: null });
    this.compiles.set(state.compileKey, state.compiled);
    if (held === undefined)
      this.log(
        "info",
        `render-cache compile built key=${state.compileKey.slice(0, 12)} compiles=${this.compiles.size}`,
      );
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
    successor: {
      readonly entry: CacheEntry;
      readonly state: DslRenderState;
    } | null,
  ): void {
    // [LAW:single-enforcer] A view is a child of its state: the state going
    // retires every view of it first, so each is disposed before or with it.
    // [LAW:no-ambient-temporal-coupling] A reload opens each view's successor
    // over the new state first, declared with the request the old one drew by,
    // so the session's repo, pane and session files stay held across it and
    // the next frame draws a declared view (brandon-unfiled-3248.8ro6, 4a).
    for (const view of [...this.views.values()]) {
      if (view.state !== state) continue;
      if (successor !== null) {
        // [LAW:no-silent-failure] A successor that fails to open is said, and
        // the old view is still retired, so the reload never leaves a state
        // half torn down; the session's next render opens its view.
        try {
          // The successor is the session's view going on: a session no
          // render read since the last sweep is still closed by the next.
          this.opened(
            successor.entry,
            successor.state,
            view.facts(),
            this.leaseOf(view).read,
            "reload",
          );
        } catch (e) {
          this.log(
            "error",
            `session view reopen failed sid=${JSON.stringify(view.sessionId)}: ${String(e)}`,
          );
        }
      }
      this.retireView(view, reason);
    }
    const hold = this.holdOf(state);
    hold.retired = { reason, held: hold.holders };
    this.reclaim(state, hold);
  }

  // [LAW:single-enforcer] The one place a state is disposed: once it is
  // retired AND unheld, from whichever of the two transitions came last. The
  // registry owns timers, fs watchers and MobX reactions — dropping it
  // without dispose leaks every handle the config declared.
  private reclaim(state: DslRenderState, hold: StateHold): void {
    if (hold.retired === null || hold.holders > 0) return;
    this.holds.delete(state);
    this.log("info", configDisposeLine(hold.retired, state.registry.dispose()));
    // [LAW:one-source-of-truth] `holds` lists every state not yet reclaimed,
    // so a compile no state left there carries has no render to draw it.
    if (![...this.holds.keys()].some((s) => s.compileKey === state.compileKey))
      this.compiles.delete(state.compileKey);
  }

  // [LAW:one-source-of-truth] The sessions whose views draw from `entry`'s
  // state.
  private sessionsOn(entry: CacheEntry): string[] {
    return [...this.views.values()]
      .filter((view) => view.state === entry.state)
      .map((view) => view.sessionId);
  }

  // Re-read an entry from disk NOW, for a caller that must not act on the old
  // config until the reload has landed (a save releasing the picks the file
  // now holds, a doctor verdict on the files as they are). The watcher still
  // fires after a write, and its reload of the same bytes keeps the state.
  reload(
    projectDir: string,
    cwd: string,
    configFile: string | undefined,
    cause: ExplicitLoad,
  ): void {
    this.reloadInto(this.getOrCreate(projectDir, cwd, configFile), cause);
  }

  // Re-populate `entry` from the current state of disk, for `cause`.
  //
  // - Load success: swap the fresh state in, retire the prior one.
  // - Load failure: keep the prior state (the bundled default before any
  //   config has loaded), set lastError.
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
  private reloadInto(entry: CacheEntry, cause: LoadCause): void {
    // Taken before the reload, so a session whose view fails to reopen over
    // the new state is still among those it changed.
    const sessions = this.sessionsOn(entry);
    // A save's watch reload of the bytes the save just loaded keeps the
    // state the entry serves, so it reopens no view and restarts no source.
    const served = entry.state;
    const loaded = this.load(
      entry.projectDir,
      entry.cwd,
      entry.configFile,
      served,
    );
    entry.lastWarning = loaded.warning;
    entry.lastError = loaded.error;
    if (loaded.state !== null)
      this.log("info", pluginLoadLine(loaded.layers, loaded.state, loaded.ms));
    if (loaded.kind === "built") {
      entry.state = loaded.state;
      this.serve(loaded.state);
      this.retire(served, "reload", { entry, state: loaded.state });
    }
    // A reload can move the entry onto a compile no other entry carries, and
    // charges the views it reopened, once their predecessors are retired.
    this.fit(entry);
    // Rebinds to the broken file (and its sibling candidates) too, so an
    // in-place save OR a higher-precedence file appearing recovers.
    this.refreshWatcher(entry, loaded);
    this.observers.onReload?.(entry, sessions, cause, loaded.kind);
  }

  // Every entry, re-read for `cause`: the answers on disk moved, and any
  // entry may draw from a repository; or file events resumed, and an edit to
  // any entry's files may have gone unheard. The live map is walked, so an
  // entry a reload's `fit` evicts is skipped, never reloaded back to life.
  // [LAW:one-source-of-truth] Each entry's load names the cause; the batch
  // has no record of its own.
  reloadEvery(cause: EveryEntryLoad): void {
    for (const entry of this.entries.values()) this.reloadInto(entry, cause);
  }

  // [LAW:single-enforcer] One watcher-rebind decision per reload: the watch
  // target set is DERIVED from disk (which candidate resolved, which
  // ancestor directories exist right now), and the entry rebinds exactly when
  // that derived set differs from the one it holds. A resolved-path change
  // (including null↔non-null) is one way the set changes; a candidate's
  // parent directory appearing is another — the same rule covers both, so
  // there is no separate "did the path change" test to drift from it.
  //
  // A kept watch's deaf directories are the registry's period to retry,
  // never a reload's: a reload that retried would answer the failed window
  // its own handle's error told.
  private refreshWatcher(entry: CacheEntry, loaded: LoadOutcome): void {
    entry.configLayers = loaded.layers;
    entry.configHome = loaded.home;
    entry.repos = loaded.repos;
    const paths = watchTargetsFor(entry);
    const { targets, unresolved } = paths;
    // [LAW:one-source-of-truth] The key names the target set and the folders
    // it binds, so the registry's `follow` rebinds exactly when either moved.
    const key = `config:${entry.projectDir}:${entry.cwd}:${entry.configFile ?? ""}:${paths.key}`;
    // [LAW:single-enforcer] One reload dispatcher per cache entry: any
    // change the entry's watch hears re-resolves its whole chain (so a
    // higher-precedence file appearing supersedes a lower one) and reloads.
    // It does not filter by which path changed, because the (projectDir,
    // cwd) tuple already scopes the entry's watch set; what was heard rides
    // on the reload's cause.
    const { watch, move } = this.deps.watchers.follow(
      entry.watch?.held ?? null,
      { ...paths, key },
      (heard) => this.reloadInto(entry, { kind: "config-watch", heard }),
    );
    // Re-derived on every load, kept or rebound, so what the bar says the
    // watch cannot hear is what the disk says now.
    entry.watch = { derived: { ...paths, key }, held: watch };
    if (move === "kept") return;
    // [LAW:nothing-unseen] A rebind is the fact that the target set moved (a
    // candidate appeared, a link was re-pointed), and which directories the
    // entry now hears: a change that fires nothing is read against this line.
    this.log(
      "info",
      `config watch bound projectDir=${entry.projectDir} cwd=${entry.cwd} dirs=${targets.dirs.map((d) => d.path).join(",")} deaf=${watch.handle.deaf.length}`,
    );
    for (const { path: at, reason } of unresolved)
      this.log(
        "warn",
        `config watch unresolved projectDir=${entry.projectDir} path=${at} reason=${reason}`,
      );
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

  // The renderer `by` delivered a frame of the session's bar listing
  // `copies`. A session with no view is closed: nothing it delivers is kept.
  delivered(
    sessionId: string,
    by: Drawing["by"],
    copies: ReadonlyMap<string, string>,
  ): void {
    if (!this.views.has(sessionId)) return;
    const drawn = this.copies.get(sessionId) ?? new Map();
    this.copies.set(sessionId, drawn.set(by, copies));
  }

  // What the diagnostic under `key` copies in the frame renderer `by` last
  // delivered for the session; undefined while that renderer's last frame
  // did not list it. Reads, never opens, like latestView.
  drawnCopy(
    sessionId: string,
    by: Drawing["by"],
    key: string,
  ): string | undefined {
    return this.copies.get(sessionId)?.get(by)?.get(key);
  }

  // The renderer no longer draws the session's bar (its feed closed): what
  // its last frame listed is on no surface now, so a click naming it is
  // refused rather than copying a list gone stale.
  stopDrawing(sessionId: string, by: Drawing["by"]): void {
    this.copies.get(sessionId)?.delete(by);
  }
}
