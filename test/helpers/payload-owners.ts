// Fake owners of the payload's lanes (src/daemon/render-payload.ts), each over a
// reader a test writes: what the lane's source answers for the arguments the
// payload reads it with.
//
// A fake keeps what its reader answered as a real owner keeps its source's
// value: a keyed lane (git, tmux, memento) is pending from its first read until
// its reader lands, so a request waits on it as on the real one; a request lane
// (session, today, speed, context, metrics, activity, cache, autocompact)
// stores what its refresh's reader answered, and a draw reads that back. So a
// test says what a lane answers, and the payload reads it the way it reads the
// daemon's.

import type { Holds } from "../../src/utils/holds";
import type { ClaudeHookData } from "../../src/utils/claude";
import type { GitInfo, GitInfoOptions } from "../../src/segments/git";
import type { TmuxHint } from "../../src/tmux-hint";
import type { CeilingReading, CeilingScope } from "../../src/memento/edge";
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
  PENDING,
  type Outcome,
  type Reading,
} from "../../src/utils/outcome";
import { answered, type Current } from "../../src/utils/reading";
import { CacheExpiryProvider } from "../../src/segments/cache";

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
    const pending: Current<T> = { kind: "pending", landed };
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
    current: (
      holds: Holds,
      workingDir: string,
      options: GitInfoOptions = {},
      projectDir?: string,
    ): Current<GitInfo> => current(holds, workingDir, options, projectDir),
    getGitInfo: (
      holds: Holds,
      workingDir: string,
      options: GitInfoOptions = {},
      projectDir?: string,
    ): Promise<Outcome<GitInfo>> =>
      answered(() => current(holds, workingDir, options, projectDir)),
  };
}

export function fakeTmux(read: (holds: Holds, hint: TmuxHint) => Loose) {
  const current = keyed<[TmuxHint], string>(read);
  return {
    sessionName: (holds: Holds, hint: TmuxHint): Current<string> =>
      current(holds, hint),
    getSessionName: (holds: Holds, hint: TmuxHint): Promise<Outcome<string>> =>
      answered(() => current(holds, hint)),
  };
}

export function fakeMemento(
  read: (holds: Holds, scope: CeilingScope) => Loose,
) {
  const current = keyed<[CeilingScope], CeilingReading>(read);
  return {
    ceiling: (holds: Holds, scope: CeilingScope): Current<CeilingReading> =>
      current(holds, scope),
    getCeiling: (
      holds: Holds,
      scope: CeilingScope,
    ): Promise<Outcome<CeilingReading>> =>
      answered(() => current(holds, scope)),
  };
}

export function fakeUsage(
  readers: {
    readonly usage?: (sessionId: string, hookData?: ClaudeHookData) => Loose;
    readonly today?: (
      hookData: ClaudeHookData | undefined,
      claudeConfigDir: string | undefined,
      at: Instant,
    ) => Loose;
    readonly speed?: (
      sessionId: string,
      transcriptPath: string | undefined,
      nowMs: number,
    ) => Loose;
  } = {},
) {
  const usage = refreshed<UsageInfo>();
  const today = refreshed<TodayInfo>();
  const speed = refreshed<SpeedObservation>();
  return {
    getUsageInfo: (sessionId: string, hookData?: ClaudeHookData) =>
      usage.store(sessionId, readers.usage?.(sessionId, hookData) ?? ABSENT),
    usageOf: (sessionId: string): Reading<UsageInfo> => usage.read(sessionId),
    getTodayInfo: (
      _holds: Holds,
      hookData: ClaudeHookData | undefined,
      claudeConfigDir: string | undefined,
      at: Instant,
    ) =>
      today.store(
        hookData?.session_id ?? "",
        readers.today?.(hookData, claudeConfigDir, at) ?? ABSENT,
      ),
    todayOf: (
      _holds: Holds,
      hookData: ClaudeHookData | undefined,
    ): Reading<TodayInfo> =>
      today.read(hookData?.session_id ?? ""),
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
    mementoProvider: fakeMemento(() => ABSENT),
    autoCompact: fakeAutoCompact(() => ABSENT),
  };
}
