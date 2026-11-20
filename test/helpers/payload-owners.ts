// Fake owners of the payload's lanes (src/renderer/render-payload.ts), each over a
// reader a test writes: what the lane's source answers for the arguments the
// payload reads it with.
//
// A fake keeps what its reader answered as a real owner keeps its source's
// value: a keyed lane (git, tmux) is declared into a lane that is
// pending from its first read until its reader lands, so a request waits on it
// as on the real one; a request lane (session, today, speed, context, metrics,
// activity, cache, autocompact) stores what its refresh's reader answered, and
// a draw reads that back. So a test says what a lane answers, and the payload
// reads it the way it reads the daemon's. `requestPayload` below declares
// the lanes over the fakes as the collector declares a session's.

import { daemonFactsOf } from "./daemon-facts";
import { observable, runInAction } from "mobx";
import type { Holds } from "../../src/utils/holds";
import type { SessionUsageStore } from "../../src/daemon/cache/session-usage-store";
import { HOST } from "./host";
import type { ManagedStorage } from "../../src/daemon/cache/managed-storage";

// [LAW:no-silent-failure] The storage owner of a rig whose configs declare no
// plugin source: a subscription naming one is a test that needs a real owner.
export const NO_STORAGE: Pick<ManagedStorage, "declare"> = {
  declare: (_holds, folder) => {
    throw new Error(`this rig reads no plugin source (${folder})`);
  },
};
import type { ClaudeHookData } from "../../src/utils/claude";
import type {
  CheckedHookData,
  ViewFacts,
} from "../../src/renderer-interface/request-context";
import type { GitInfo } from "../../src/segments/git";
import type { TmuxHint } from "../../src/tmux-hint";
import type { MetricsFold } from "../../src/segments/metrics";
import type { ActivityInfo } from "../../src/segments/activity";
import type { TranscriptUsage } from "../../src/segments/session";
import type { DaySums } from "../../src/daemon/cache/session-usage-store";
import type { SpeedObservation } from "../../src/facts/world-state";
import type { AutoCompactWindow } from "../../src/segments/autocompact";
import type { Instant } from "../../src/utils/instant";
import {
  ABSENT,
  isPending,
  ok,
  pendingOf,
  type Outcome,
  type PayloadNode,
  type Pending,
  type Reading,
} from "../../src/utils/outcome";
import { settledLane, type Current, type Lane } from "../../src/utils/reading";
import { HostService } from "../../src/daemon/cache/host-identity";
import { assembleFacts } from "../../src/daemon/facts-assembly";
import { instantOf } from "../../src/utils/instant";
import { settledWorld } from "./settled";
import {
  composePayload,
  todayOf,
  type ConfigFileFacts,
  type DrawInputs,
  type DrawnPayload,
} from "../../src/renderer/render-payload";
import {
  declareLanes,
  readingsOf,
  type DeclaredLanes,
  type PayloadInputs,
  type RenderPayloadDeps,
} from "../../src/daemon/readings";
import type { EffectiveGlobals } from "../../src/config/effective-globals";
import type { ClientHints } from "../../src/daemon/foundations/protocol";
import { EMPTY_HISTORY_DEPTH } from "../../src/renderer/settings-history";
import { UNFOLLOWED_FEEDS } from "../../src/config/lanes";
import { Holds as HoldsClass } from "../../src/utils/holds";
import { CacheExpiryProvider } from "../../src/segments/cache";
import { RefreshFaults } from "../../src/daemon/refresh-faults";
import { systemTimekeeper } from "../../src/time";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import { unscriptedRuns } from "./fake-launcher";
import {
  TranscriptLanes,
  type LaneOwners,
} from "../../src/daemon/cache/transcript-lanes";
import { RefreshLedger } from "../../src/utils/refresh-ledger";
import type { DaemonLogger } from "../../src/utils/logger";
import { TEST_ENVIRONMENT } from "./session-environment";

type Answer<T> = Outcome<T> | Promise<Outcome<T>>;

// What a test's reader answers: a lane's value as far as the test spells it
// (fixtures name only the fields under test), taken as the lane's type.
type Loose = Answer<unknown>;
const lane = <T>(answer: Loose): Answer<T> => answer as Answer<T>;

// One keyed source: its value per key, pending from the key's first read until
// its reader lands. The values are observable, as every real owner's are, so a
// derivation over a lane is run again when the reader lands. The first read of
// a key (which stores) is made where the lane is declared, outside any
// derivation, as a real owner's declaration takes its entry: a derivation that
// read a key before it was stored tracks only the key's presence, and never
// hears its landing.
function keyed<A extends unknown[], T>(
  read: (holds: Holds, ...args: A) => Loose,
) {
  const values = observable.map<string, Current<T>>({}, { deep: false });
  return (holds: Holds, ...args: A): Current<T> => {
    const key = JSON.stringify(args);
    const known = values.get(key);
    if (known !== undefined) return known;
    const landed = Promise.resolve(lane<T>(read(holds, ...args))).then(
      (outcome) => {
        runInAction(() => values.set(key, outcome));
      },
    );
    const pending: Current<T> = { kind: "pending", why: "unread", landed };
    runInAction(() => values.set(key, pending));
    return pending;
  };
}

// One request lane: what its last refresh's reader answered, per session. The
// store is observable, as the real owners' are.
function refreshed<T>() {
  const stored = observable.map<string, Outcome<T>>({}, { deep: false });
  return {
    store: async (sessionId: string, answer: Loose): Promise<Outcome<T>> => {
      const outcome = await lane<T>(answer);
      runInAction(() => stored.set(sessionId, outcome));
      return outcome;
    },
    read: (sessionId: string): Reading<T> =>
      stored.get(sessionId) ?? pendingOf("unread"),
  };
}

export function fakeGit(
  read: (
    holds: Holds,
    workingDir: string,
    projectDir: string | undefined,
  ) => Loose,
) {
  const current = keyed<[string, string | undefined], GitInfo>(read);
  return {
    declare: (
      holds: Holds,
      workingDir: string,
      projectDir?: string,
    ): Lane<GitInfo> => {
      current(holds, workingDir, projectDir);
      return { current: () => current(holds, workingDir, projectDir) };
    },
  };
}

// A request's inputs with the lanes a session's declaration took for it, as
// the collector reads them (src/daemon/collector.ts).
export interface LanedInputs extends PayloadInputs {
  readonly lanes: () => DeclaredLanes;
}

// The world state the collector stamps from what the owners hold over the
// inputs' lanes.
export function documentOf(inputs: LanedInputs) {
  return assembleFacts(
    undefined,
    inputs.hookData.session_id,
    readingsOf(inputs, inputs.lanes()),
    daemonFactsOf(),
    instantOf(new Date(0)),
  );
}

// The day sums and the session's own days a draw projects `today` from.
export function todayReadingOf(inputs: LanedInputs) {
  return readingsOf(inputs, inputs.lanes()).today;
}

// A request's wait over the inputs' lanes, as the daemon settles one over its
// world state (`settledWorld`): the document is stamped again on every owner
// landing the wait hears.
export async function settleLanes(inputs: LanedInputs): Promise<void> {
  await settledWorld(
    () => documentOf(inputs),
    () => [],
  );
}

// The payload a view's source derives, over the owners and lanes the inputs
// name: the world state stamped from what the owners hold, and the payload
// composed from it, over the sources its lanes declare.
export function payloadOf(
  inputs: LanedInputs,
  draw: Omit<DrawInputs, "sources">,
) {
  return composePayload(
    documentOf(inputs),
    {
      hookData: inputs.hookData,
      hints: inputs.hints,
      home: inputs.deps.home,
    },
    { ...draw, sources: [...inputs.lanes().sources.keys()] },
  );
}

export function fakeTmux(read: (holds: Holds, hint: TmuxHint) => Loose) {
  const current = keyed<[TmuxHint], string>(read);
  return {
    declare: (holds: Holds, hint: TmuxHint): Lane<string> => {
      current(holds, hint);
      return { current: () => current(holds, hint) };
    },
  };
}

export function fakeUsage(
  readers: {
    readonly usage?: (sessionId: string) => Loose;
    // The day sums of the directory set declared at `claudeConfigDir`, as its
    // scan answered them.
    readonly today?: (claudeConfigDir: string | undefined) => Outcome<DaySums>;
    readonly speed?: (
      sessionId: string,
      transcriptPath: string | undefined,
      nowMs: number,
    ) => Loose;
  } = {},
): Pick<
  SessionUsageStore,
  "refresh" | "usageOf" | "declareToday" | "daysOutside" | "speedOf"
> {
  const usage = refreshed<TranscriptUsage>();
  const speed = refreshed<SpeedObservation>();
  // A directory set's scans: not answered until the first lands.
  const scans = keyed<[string | undefined], DaySums>(
    (_holds, claudeConfigDir) => readers.today?.(claudeConfigDir) ?? ABSENT,
  );
  return {
    // A refresh's lanes over its session, as the real store's `refresh`.
    refresh: (sessionId: string, transcriptPath: string | undefined) => ({
      usage: () => usage.store(sessionId, readers.usage?.(sessionId) ?? ABSENT),
      speed: (nowMs: number) =>
        speed.store(
          sessionId,
          readers.speed?.(sessionId, transcriptPath, nowMs) ?? ABSENT,
        ),
    }),
    usageOf: (sessionId: string): Reading<TranscriptUsage> =>
      usage.read(sessionId),
    // What the reader gave for the set, once its first scan lands.
    declareToday: (
      holds: Holds,
      claudeConfigDir: string | undefined,
    ): Lane<DaySums> => {
      scans(holds, claudeConfigDir);
      return { current: () => scans(holds, claudeConfigDir) };
    },
    daysOutside: (): Outcome<never> => ABSENT,
    speedOf: (sessionId: string): Reading<SpeedObservation> =>
      speed.read(sessionId),
  };
}

// The transcript's context tokens, as the context owner folds them; the
// payload lays the hook's window over them.
export function fakeContext(
  read: (sessionId: string, transcriptPath: string) => Loose,
) {
  const lane = refreshed<number>();
  return {
    refresh: (sessionId: string, transcriptPath: string) =>
      lane.store(sessionId, read(sessionId, transcriptPath)),
    tokensOf: (sessionId: string): Reading<number> => lane.read(sessionId),
  };
}

// The transcript's metrics fold; the payload lays the hook's durations and
// lines over it.
export function fakeMetrics(
  read: (sessionId: string, transcriptPath: string) => Loose,
) {
  const lane = refreshed<MetricsFold>();
  return {
    refresh: (sessionId: string, transcriptPath: string) =>
      lane.store(sessionId, read(sessionId, transcriptPath)),
    foldOf: (sessionId: string): Reading<MetricsFold> => lane.read(sessionId),
  };
}

export function fakeActivity(
  read: (sessionId: string, transcriptPath: string) => Loose,
) {
  const lane = refreshed<ActivityInfo>();
  return {
    refresh: (sessionId: string, transcriptPath: string) =>
      lane.store(sessionId, read(sessionId, transcriptPath)),
    activityOf: (sessionId: string): Reading<ActivityInfo> =>
      lane.read(sessionId),
  };
}

export function fakeCacheExpiry(
  read: (sessionId: string, transcriptPath: string) => Loose,
) {
  const lane = refreshed<number>();
  return {
    refresh: (sessionId: string, transcriptPath: string) =>
      lane.store(sessionId, read(sessionId, transcriptPath)),
    expiryOf: (sessionId: string): Reading<number> => lane.read(sessionId),
  };
}

export function fakeAutoCompact(
  read: (settingsPath: string) => Outcome<unknown>,
) {
  const stored = observable.map<string, Outcome<AutoCompactWindow>>(
    {},
    { deep: false },
  );
  return {
    window: (settingsPath: string): Outcome<AutoCompactWindow> => {
      const outcome = read(settingsPath) as Outcome<AutoCompactWindow>;
      runInAction(() => stored.set(settingsPath, outcome));
      return outcome;
    },
    stored: (settingsPath: string): Reading<AutoCompactWindow> =>
      stored.get(settingsPath) ?? pendingOf("unread"),
  };
}

// What a test composes its owners as: every owner a session's reads call,
// with the refreshes its transcript lanes' trigger calls, and no trigger yet:
// `withTranscriptLanes` builds it over them.
export type FixtureOwners = Omit<RenderPayloadDeps, "transcriptLanes"> &
  LaneOwners;

// `owners` with the trigger of their transcript lanes built over them, as the
// daemon builds its own over its providers (createPayloadProviders): built
// where a test composes its owners, so it reads the owners the test chose, and
// logs to their log, as the daemon's both log to one. No watch hears anything
// here, and its period runs on the real clock, so a declaration's first read
// is what lands a lane.
// The clock the trigger reads: it arms the period and stamps the speed sample.
type TranscriptClock = ConstructorParameters<
  typeof TranscriptLanes
>[0]["clock"];

export function withTranscriptLanes<O extends FixtureOwners>(
  owners: O,
  clock: TranscriptClock = systemTimekeeper,
): O & { readonly transcriptLanes: TranscriptLanes } {
  // The trigger reads the owners of the object it returns, so a case that
  // swaps an owner on it after composing swaps the one the trigger reads.
  const laned: O = { ...owners };
  return Object.assign(laned, {
    transcriptLanes: new TranscriptLanes({
      owners: laned,
      watchers: {
        acquire: () => ({ release: () => {}, observed: () => {}, deaf: [], ridesStream: false }),
      },
      clock,
      logger: owners.log,
      ledger: new RefreshLedger(),
    }),
  });
}

// A log nobody reads.
const NO_LOG: DaemonLogger = () => {};

// Every lane answering ABSENT: a payload whose sources have nothing.
export function absentOwners() {
  return {
    // No plugin source, and a log nobody reads.
    managedStorage: NO_STORAGE,
    log: NO_LOG,
    // The user's home, which the payload's `home` and the default Claude Code
    // directory come from.
    home: HOST.home,
    // The one lane reading a real file the tests write, as the daemon's does.
    cacheExpiry: new CacheExpiryProvider(systemTimekeeper),
    gitProvider: fakeGit(() => ABSENT),
    usageStore: fakeUsage(),
    contextProvider: fakeContext(() => ABSENT),
    metricsProvider: fakeMetrics(() => ABSENT),
    activityProvider: fakeActivity(() => ABSENT),
    tmuxService: fakeTmux(() => ABSENT),
    // An owner whose runs fail to start, as a missing program does: a case
    // that subscribes one says what it runs.
    sourceRuns: unscriptedRuns(),
    autoCompact: fakeAutoCompact(() => ABSENT),
    faults: new RefreshFaults(),
    // The machine's identity, read as the daemon reads it.
    hostService: new HostService({ clock: systemTimekeeper }),
  };
}

// A request's payload as the daemon draws one: the lanes declared over the
// owners at the request's facts, as the collector declares a session's, the
// request's wait (settleLanes), then the view's payload as it
// stands (payloadOf) with the
// draw's own projections beside it — `today` at `at`, no feeds. The failures
// it projected are logged as the daemon's request logs them. The home lives
// for this one request, where the daemon's view keeps it across requests.
export async function requestPayload(
  rawHookData: ClaudeHookData,
  at: Instant,
  deps: FixtureOwners,
  cwd: string | undefined,
  effective: EffectiveGlobals,
  hints: ClientHints,
  configFacts: ConfigFileFacts,
): Promise<DrawnPayload> {
  // [LAW:one-source-of-truth] The hook's session id is parsed by the checkpoint
  // once here; the inputs read it from the checked hook alone.
  const hookData: CheckedHookData = {
    ...rawHookData,
    session_id: sessionIdOf(rawHookData.session_id),
  };
  using home = openHome(deps, {
    hookData,
    cwd,
    hints,
  });
  const inputs: LanedInputs = {
    hookData,
    cwd,
    hints,
    deps: home.owners,
    lanes: home.lanes,
  };
  await settleLanes(inputs);
  const payload = payloadOf(inputs, {
    effective,
    configFacts,
    history: EMPTY_HISTORY_DEPTH,
    back: 0,
  });
  return {
    ...payload,
    feeds: UNFOLLOWED_FEEDS,
    today: todayOf(todayReadingOf(inputs), at),
  };
}

// A field of a request's payload, which its wait answered: a request draws
// once every lane it waits on has landed, so one still pending is a bug.
export function settled<T extends PayloadNode>(value: T | Pending): T {
  if (isPending(value)) throw new Error("pending after the request settled");
  return value;
}

// The lanes a view declared at `facts` over `owners`, the transcript lanes'
// trigger built over them here as the daemon builds its own over its
// providers; disposing it closes the view's home.
function openHome(
  owners: FixtureOwners,
  facts: ViewFacts,
  clock: TranscriptClock = systemTimekeeper,
): Disposable & {
  owners: RenderPayloadDeps;
  lanes: () => ReturnType<typeof declareLanes>["lanes"];
} {
  const holds = new HoldsClass();
  const keyed = withTranscriptLanes(owners, clock);
  const { lanes, faults } = declareLanes(
    keyed,
    holds,
    { ...facts, environment: TEST_ENVIRONMENT },
    {
      plugins: new Map(),
      runs: new Map(),
      env: [],
    },
  );
  // [LAW:no-silent-failure] An owner whose declaration throws is a broken
  // fixture, failed here with its stack, as the daemon logs it as an error.
  // The home ends what it built: its holds, and the trigger whose period a
  // hold arms.
  const close = (): void => {
    holds.close();
    keyed.transcriptLanes.close();
  };
  if (faults.length > 0) {
    close();
    throw new Error(`a lane's declaration threw:\n${faults.join("\n")}`);
  }
  return {
    owners: keyed,
    lanes: () => lanes,
    [Symbol.dispose]: close,
  };
}

// One read of every transcript lane over `owners` at a request's facts, as the
// transcript's watch or period makes one, landed.
export async function readTranscriptLanes(
  owners: FixtureOwners,
  facts: ViewFacts,
  clock: TranscriptClock = systemTimekeeper,
): Promise<void> {
  using home = openHome(owners, facts, clock);
  const read = home.lanes().transcript.current();
  if (read.kind === "pending") await read.landed;
}

// The lanes a view declared at `facts` over `owners`, for a test that draws
// frames over deps it built itself. [LAW:no-ambient-temporal-coupling] The
// view's home closes with the case's cleanups.
export function declaredLanes(
  owners: FixtureOwners,
  facts: ViewFacts,
  cleanups: Array<() => void>,
): () => ReturnType<typeof declareLanes>["lanes"] {
  const home = openHome(owners, facts);
  cleanups.push(home[Symbol.dispose]);
  return home.lanes;
}
