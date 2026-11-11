// Fake owners of the payload's lanes (src/daemon/render-payload.ts), each over a
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

import { observable, runInAction } from "mobx";
import type { Holds } from "../../src/utils/holds";
import { HOST } from "./host";
import type { ClaudeHookData } from "../../src/utils/claude";
import { sessionIdOf } from "../../src/daemon/session-id";
import type { GitInfo } from "../../src/segments/git";
import type { TmuxHint } from "../../src/tmux-hint";
import type { MetricsFold } from "../../src/segments/metrics";
import type { ActivityInfo } from "../../src/segments/activity";
import type { TranscriptUsage } from "../../src/segments/session";
import type {
  DaySums,
  SpeedObservation,
} from "../../src/daemon/cache/session-usage-store";
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
import { HostService } from "../../src/segments/host";
import { assembleFacts } from "../../src/daemon/facts-assembly";
import { instantOf } from "../../src/utils/instant";
import {
  composePayload,
  declareLanes,
  readingsOf,
  settleWorld,
  todayOf,
  type ConfigFileFacts,
  type DeclaredLanes,
  type DrawInputs,
  type DrawnPayload,
  type KeyedOwners,
  type PayloadInputs,
  type RenderPayloadDeps,
} from "../../src/daemon/render-payload";
import type { EffectiveGlobals } from "../../src/config/effective-globals";
import type { ClientHints } from "../../src/daemon/protocol";
import { EMPTY_HISTORY_DEPTH } from "../../src/daemon/settings-history";
import { UNFOLLOWED_FEEDS } from "../../src/config/lanes";
import { Holds as HoldsClass } from "../../src/utils/holds";
import { CacheExpiryProvider } from "../../src/segments/cache";
import { RefreshFaults } from "../../src/daemon/refresh-faults";
import { systemTimekeeper } from "../../src/time";

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
    sessionIdOf(inputs.hookData.session_id),
    readingsOf(inputs, inputs.lanes()),
    pendingOf("unread"),
    instantOf(new Date(0)),
  );
}

// The day sums and the session's own days a draw projects `today` from.
export function todayReadingOf(inputs: LanedInputs) {
  return readingsOf(inputs, inputs.lanes()).today;
}

// A request's refresh and wait over the inputs' lanes, as the daemon settles
// one over its world state (settleWorld): the document is stamped again on
// every owner landing the wait hears.
export async function settleLanes(
  inputs: LanedInputs,
  at: Instant,
  refreshed: Parameters<typeof settleWorld>[2] = new Map(),
): Promise<void> {
  await settleWorld(
    inputs,
    at,
    refreshed,
    () => documentOf(inputs),
    new AbortController().signal,
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
    // The day sums of the directory set declared at `claudeConfigDir`, read
    // once, when the first request has refreshed `today`.
    readonly today?: (claudeConfigDir: string | undefined) => Outcome<DaySums>;
    readonly speed?: (
      sessionId: string,
      transcriptPath: string | undefined,
      nowMs: number,
    ) => Loose;
  } = {},
) {
  const usage = refreshed<TranscriptUsage>();
  // The sessions whose request refreshed `today`: before one has, a draw
  // reads it as not answered yet.
  const todayRefreshed = observable.set<string>();
  const speed = refreshed<SpeedObservation>();
  const refreshUsage = (sessionId: string) =>
    usage.store(sessionId, readers.usage?.(sessionId) ?? ABSENT);
  const observeSpeed = (
    sessionId: string,
    transcriptPath: string | undefined,
    nowMs: number,
  ) =>
    speed.store(
      sessionId,
      readers.speed?.(sessionId, transcriptPath, nowMs) ?? ABSENT,
    );
  return {
    // A request's lanes over its session, as the real store's `request`.
    request: (sessionId: string, transcriptPath: string | undefined) => ({
      usage: () => refreshUsage(sessionId),
      speed: (nowMs: number) => observeSpeed(sessionId, transcriptPath, nowMs),
      today: async () => {
        runInAction(() => todayRefreshed.add(sessionId));
      },
    }),
    usageOf: (sessionId: string): Reading<TranscriptUsage> =>
      usage.read(sessionId),
    // Not answered yet until some request has refreshed `today`, then what
    // the reader gave for the set, as the real lane's first scan lands.
    declareToday: (
      _holds: Holds,
      claudeConfigDir: string | undefined,
    ): Lane<DaySums> => {
      let answered: Outcome<DaySums> | undefined;
      return {
        current: (): Current<DaySums> => {
          if (todayRefreshed.size === 0) {
            return {
              kind: "pending",
              why: "unread",
              landed: new Promise<void>(() => {}),
            };
          }
          answered ??= readers.today?.(claudeConfigDir) ?? ABSENT;
          return answered;
        },
      };
    },
    daysOutside: (): Outcome<never> => ABSENT,
    refreshToday: async (
      hookData: ClaudeHookData | undefined,
    ): Promise<void> => {
      runInAction(() => todayRefreshed.add(hookData?.session_id ?? ""));
    },
    observeSpeed,
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
  read: (sessionId: string, hookData: ClaudeHookData) => Loose,
) {
  const lane = refreshed<ActivityInfo>();
  return {
    getActivityInfo: (sessionId: string, hookData: ClaudeHookData) =>
      lane.store(sessionId, read(sessionId, hookData)),
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

// Every lane answering ABSENT: a payload whose sources have nothing.
export function absentOwners() {
  return {
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
    autoCompact: fakeAutoCompact(() => ABSENT),
    faults: new RefreshFaults(),
    clock: systemTimekeeper,
    // The machine's identity, read as the daemon reads it.
    hostService: new HostService({ clock: systemTimekeeper }),
  };
}

// A request's payload as the daemon draws one: the lanes declared over the
// owners at the request's facts, as the collector declares a session's, the
// request's refresh and wait (settleLanes), then the view's payload as it
// stands (payloadOf) with the
// draw's own projections beside it — `today` at `at`, no feeds. The failures
// it projected are logged as the daemon's request logs them. The home lives
// for this one request, where the daemon's view keeps it across requests.
export async function requestPayload(
  hookData: ClaudeHookData,
  at: Instant,
  deps: RenderPayloadDeps,
  cwd: string | undefined,
  effective: EffectiveGlobals,
  hints: ClientHints,
  configFacts: ConfigFileFacts,
): Promise<DrawnPayload> {
  using home = openHome(deps, {
    sessionId: sessionIdOf(hookData.session_id),
    hookData,
    cwd,
    hints,
  });
  const inputs: LanedInputs = {
    hookData,
    cwd,
    hints,
    deps,
    lanes: home.lanes,
  };
  await settleLanes(inputs, at);
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

// The lanes a view declared at `facts` over `owners`; disposing it closes the
// view's home.
function openHome(
  owners: unknown,
  facts: Parameters<typeof declareLanes>[2],
): Disposable & { lanes: () => ReturnType<typeof declareLanes>["lanes"] } {
  const holds = new HoldsClass();
  const { lanes, faults } = declareLanes(
    owners as KeyedOwners,
    holds,
    facts,
    new Map(),
  );
  // [LAW:no-silent-failure] An owner whose declaration throws is a broken
  // fixture, failed here with its stack, as the daemon logs it as an error.
  if (faults.length > 0) {
    holds.close();
    throw new Error(`a lane's declaration threw:\n${faults.join("\n")}`);
  }
  return {
    lanes: () => lanes,
    [Symbol.dispose]: () => void holds.close(),
  };
}

// The lanes a view declared at `facts` over `owners`, for a test that draws
// frames over deps it built itself. [LAW:no-ambient-temporal-coupling] The
// view's home closes with the case's cleanups.
export function declaredLanes(
  owners: unknown,
  facts: Parameters<typeof declareLanes>[2],
  cleanups: Array<() => void>,
): () => ReturnType<typeof declareLanes>["lanes"] {
  const home = openHome(owners, facts);
  cleanups.push(home[Symbol.dispose]);
  return home.lanes;
}
