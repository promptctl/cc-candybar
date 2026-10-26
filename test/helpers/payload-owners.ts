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
// the lanes over the fakes as a view's declaration does.

import type { Holds } from "../../src/utils/holds";
import type { ClaudeHookData } from "../../src/utils/claude";
import { sessionIdOf } from "../../src/daemon/session-id";
import type { GitInfo, GitInfoOptions } from "../../src/segments/git";
import type { TmuxHint } from "../../src/tmux-hint";
import type { ContextInfo } from "../../src/segments/context";
import type { MetricsInfo } from "../../src/segments/metrics";
import type { ActivityInfo } from "../../src/segments/activity";
import type { UsageInfo } from "../../src/segments/session";
import type {
  SpeedObservation,
  TodayInfo,
} from "../../src/daemon/cache/session-usage-store";
import type { AutoCompactWindow } from "../../src/segments/autocompact";
import type { Instant } from "../../src/utils/instant";
import {
  ABSENT,
  ok,
  PENDING,
  type Outcome,
  type Reading,
} from "../../src/utils/outcome";
import { settledLane, type Current, type Lane } from "../../src/utils/reading";
import {
  declareLanes,
  payloadOf,
  settlePayload,
  todayOf,
  type ConfigFileFacts,
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

type Answer<T> = Outcome<T> | Promise<Outcome<T>>;

// What a test's reader answers: a lane's value as far as the test spells it
// (fixtures name only the fields under test), taken as the lane's type.
type Loose = Answer<unknown>;
const lane = <T>(answer: Loose): Answer<T> => answer as Answer<T>;

// One keyed source: its value per key, pending from the key's first read until
// its reader lands.
function keyed<A extends unknown[], T>(
  read: (holds: Holds, ...args: A) => Loose,
) {
  const values = new Map<string, Current<T>>();
  return (holds: Holds, ...args: A): Current<T> => {
    const key = JSON.stringify(args);
    const known = values.get(key);
    if (known !== undefined) return known;
    const landed = Promise.resolve(lane<T>(read(holds, ...args))).then(
      (outcome) => {
        values.set(key, outcome);
      },
    );
    const pending: Current<T> = { kind: "pending", why: "unread", landed };
    values.set(key, pending);
    return pending;
  };
}

// One request lane: what its last refresh's reader answered, per session.
function refreshed<T>() {
  const stored = new Map<string, Outcome<T>>();
  return {
    store: async (sessionId: string, answer: Loose): Promise<Outcome<T>> => {
      const outcome = await lane<T>(answer);
      stored.set(sessionId, outcome);
      return outcome;
    },
    read: (sessionId: string): Reading<T> => stored.get(sessionId) ?? PENDING,
  };
}

export function fakeGit(
  read: (
    holds: Holds,
    workingDir: string,
    options: GitInfoOptions,
    projectDir: string | undefined,
  ) => Loose,
) {
  const current = keyed<[string, GitInfoOptions, string | undefined], GitInfo>(
    read,
  );
  return {
    declare: (
      holds: Holds,
      workingDir: string,
      options: GitInfoOptions = {},
      projectDir?: string,
    ): Lane<GitInfo> => ({
      current: () => current(holds, workingDir, options, projectDir),
    }),
  };
}

export function fakeTmux(read: (holds: Holds, hint: TmuxHint) => Loose) {
  const current = keyed<[TmuxHint], string>(read);
  return {
    declare: (holds: Holds, hint: TmuxHint): Lane<string> => ({
      current: () => current(holds, hint),
    }),
  };
}

// What the fake's `today` lane answers: the directory set it was declared at,
// standing in for that set's day sums.
interface FakeSet {
  readonly claudeConfigDir: string | undefined;
}

export function fakeUsage(
  readers: {
    readonly usage?: (sessionId: string, hookData?: ClaudeHookData) => Loose;
    // The day of the set's sums a draw is at: answered at the draw, as the
    // real store's `todayAt` is.
    readonly today?: (
      hookData: ClaudeHookData | undefined,
      claudeConfigDir: string | undefined,
      at: Instant,
    ) => Outcome<unknown>;
    readonly speed?: (
      sessionId: string,
      transcriptPath: string | undefined,
      nowMs: number,
    ) => Loose;
  } = {},
) {
  const usage = refreshed<UsageInfo>();
  // The sessions whose request refreshed `today`: before one has, a draw
  // reads it as not answered yet.
  const todayRefreshed = new Set<string>();
  const speed = refreshed<SpeedObservation>();
  return {
    getUsageInfo: (sessionId: string, hookData?: ClaudeHookData) =>
      usage.store(sessionId, readers.usage?.(sessionId, hookData) ?? ABSENT),
    usageOf: (sessionId: string): Reading<UsageInfo> => usage.read(sessionId),
    declareToday: (
      _holds: Holds,
      claudeConfigDir: string | undefined,
    ): Lane<FakeSet> => settledLane(ok({ claudeConfigDir })),
    refreshToday: async (
      _today: Lane<FakeSet>,
      hookData: ClaudeHookData | undefined,
    ): Promise<void> => {
      todayRefreshed.add(hookData?.session_id ?? "");
    },
    todayAt: (
      set: FakeSet,
      hookData: ClaudeHookData | undefined,
      at: Instant,
    ): Reading<TodayInfo> =>
      todayRefreshed.has(hookData?.session_id ?? "")
        ? ((readers.today?.(hookData, set.claudeConfigDir, at) ??
            ABSENT) as Outcome<TodayInfo>)
        : PENDING,
    observeSpeed: (
      sessionId: string,
      transcriptPath: string | undefined,
      nowMs: number,
    ) =>
      speed.store(
        sessionId,
        readers.speed?.(sessionId, transcriptPath, nowMs) ?? ABSENT,
      ),
    speedOf: (sessionId: string): Reading<SpeedObservation> =>
      speed.read(sessionId),
  };
}

export function fakeContext(read: (hookData: ClaudeHookData) => Loose) {
  const lane = refreshed<ContextInfo>();
  return {
    getContextInfo: (hookData: ClaudeHookData) =>
      lane.store(hookData.session_id, read(hookData)),
    contextOf: (hookData: ClaudeHookData): Reading<ContextInfo> =>
      lane.read(hookData.session_id),
  };
}

export function fakeMetrics(
  read: (sessionId: string, hookData: ClaudeHookData) => Loose,
) {
  const lane = refreshed<MetricsInfo>();
  return {
    getMetricsInfo: (sessionId: string, hookData: ClaudeHookData) =>
      lane.store(sessionId, read(sessionId, hookData)),
    metricsOf: (sessionId: string): Reading<MetricsInfo> =>
      lane.read(sessionId),
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
  const stored = new Map<string, Outcome<AutoCompactWindow>>();
  return {
    window: (settingsPath: string): Outcome<AutoCompactWindow> => {
      const outcome = read(settingsPath) as Outcome<AutoCompactWindow>;
      stored.set(settingsPath, outcome);
      return outcome;
    },
    stored: (settingsPath: string): Reading<AutoCompactWindow> =>
      stored.get(settingsPath) ?? PENDING,
  };
}

// Every lane answering ABSENT: a payload whose sources have nothing.
export function absentOwners() {
  return {
    // The one lane reading a real file the tests write, as the daemon's does.
    cacheExpiry: new CacheExpiryProvider(),
    gitProvider: fakeGit(() => ABSENT),
    usageStore: fakeUsage(),
    contextProvider: fakeContext(() => ABSENT),
    metricsProvider: fakeMetrics(() => ABSENT),
    activityProvider: fakeActivity(() => ABSENT),
    tmuxService: fakeTmux(() => ABSENT),
    autoCompact: fakeAutoCompact(() => ABSENT),
    faults: new RefreshFaults(),
  };
}

// A request's payload as the daemon draws one: the lanes declared over the
// owners at the request's facts and closure, as the session's view declares
// them (brandon-unfiled-3248.8ro6, 4a), the request's refresh and wait
// (settlePayload), then the view's payload as it stands (payloadOf) with the
// draw's own projections beside it — `today` at `at`, no feeds. The failures
// it projected are logged as the daemon's request logs them.
export async function requestPayload(
  hookData: ClaudeHookData,
  at: Instant,
  deps: Omit<RenderPayloadDeps, "lanes">,
  cwd: string | undefined,
  closure: ReadonlySet<string>,
  effective: EffectiveGlobals,
  hints: ClientHints,
  configFacts: ConfigFileFacts,
): Promise<DrawnPayload> {
  const { lanes } = declareLanes(
    deps as unknown as KeyedOwners,
    new HoldsClass(),
    { sessionId: sessionIdOf(hookData.session_id), hookData, cwd, hints },
    closure,
    new Map(),
  );
  const inputs: PayloadInputs = {
    hookData,
    cwd,
    hints,
    neededInputPaths: closure,
    deps: { ...deps, lanes: () => lanes } as RenderPayloadDeps,
  };
  await settlePayload(inputs, at);
  const { payload, failures } = payloadOf(inputs, {
    effective,
    configFacts,
    history: EMPTY_HISTORY_DEPTH,
    back: 0,
  });
  for (const f of failures) deps.log("warn", `provider fetch failed: ${f}`);
  return {
    ...payload,
    feeds: UNFOLLOWED_FEEDS,
    today: todayOf(deps, lanes.today, hookData, at),
  };
}

// A field of a request's payload, which its wait answered: a request draws
// once every lane it waits on has landed, so one still pending is a bug.
export function settled<T>(value: T | typeof PENDING): T {
  if (value === PENDING) throw new Error("pending after the request settled");
  return value as T;
}

// The lanes a view declared at `facts` over `owners` and every lane read, for
// a test that draws frames over deps it built itself.
export function declaredLanes(
  owners: unknown,
  facts: Parameters<typeof declareLanes>[2],
  closure: ReadonlySet<string>,
): () => ReturnType<typeof declareLanes>["lanes"] {
  const { lanes } = declareLanes(
    owners as KeyedOwners,
    new HoldsClass(),
    facts,
    closure,
    new Map(),
  );
  return () => lanes;
}
