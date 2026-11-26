// [LAW:single-enforcer] The host's reads of a session's world: the lanes the
// collector declares and reads, over the providers that own each source.

import { inspect } from "node:util";
import {
  environmentOutput,
  isEnvironmentOutput,
} from "./environment-output.js";
import type { ClientHints } from "./foundations/protocol.js";
import type { TranscriptLanes } from "./cache/transcript-lanes.js";
import type { GitInfo } from "../segments/git.js";
import {
  ABSENT,
  failed,
  ok,
  type Outcome,
  type Reading,
} from "../utils/outcome.js";
import type { CacheExpiryProvider } from "../segments/cache.js";
import { settledLane, type Current, type Lane } from "../utils/reading.js";
import type { DaemonLogger } from "../utils/logger.js";
import type {
  DaySums,
  SessionUsageStore,
} from "./cache/session-usage-store.js";
import {
  type SpeedObservation,
  type TodayFacts,
  type RefreshLane,
  shortDigest,
} from "../facts/world-state.js";
import type { TranscriptLoss } from "../utils/transcript-loss.js";
import type { ContextProvider } from "./cache/context-provider.js";
import type { MetricsFold } from "../segments/metrics.js";
import type { MetricsProvider } from "./cache/metrics-provider.js";
import type { TranscriptUsage } from "../segments/session.js";
import type { ActivityInfo, ActivityProvider } from "../segments/activity.js";
import type { TmuxService } from "./cache/tmux.js";
import type { HostService } from "./cache/host-identity.js";
import type { AutoCompactProvider } from "./cache/autocompact.js";
import type { AutoCompactWindow } from "../segments/autocompact.js";
import { claudeConfigDir, claudeSettingsPath } from "../claude-settings.js";
import type { GitDataProvider } from "./cache/git.js";
import type { Holds } from "../utils/holds.js";
import type { RefreshFaults } from "./refresh-faults.js";
import type { SessionId } from "./foundations/session-id.js";
import type { ManagedStorage } from "./cache/managed-storage.js";
import {
  declareRuns,
  type SourceLane,
  type SourceRuns,
} from "./source-runs.js";
import type { JsonValue } from "../var-system/types.js";
import type {
  ViewFacts,
  Subscribed,
} from "../renderer-interface/request-context";
import {
  variableOf,
  type SessionEnvironment,
} from "./foundations/session-env.js";

// What a session's declaration keys on, of the request that named it: its
// keys, and the environment its runs run in, which stays in the host.
export type Locator = ViewFacts & { readonly environment: SessionEnvironment };

// ─── Provider dependencies ────────────────────────────────────────────────────

// [LAW:types-are-the-program] Each owner as far as a session's reads call it:
// a declaration takes its entry, a read takes what it stored. So a world built
// of sample readings types as the daemon's does, with
// no owner it does not need.
export interface RenderPayloadDeps {
  // [LAW:one-source-of-truth] The user's home directory: the one derivation
  // (`Host.home`) the payload's `home`, the default Claude Code directory and
  // the usage store's transcripts share.
  readonly home: string;
  readonly gitProvider: Pick<GitDataProvider, "declare">;
  // [LAW:one-source-of-truth] One store backs BOTH the `session` and `today`
  // projections — they are folds over the same per-session records, not two
  // independent providers that could disagree.
  readonly usageStore: Pick<
    SessionUsageStore,
    "usageOf" | "speedOf" | "declareToday" | "daysOutside" | "lossesOf"
  >;
  readonly contextProvider: Pick<ContextProvider, "tokensOf">;
  readonly metricsProvider: Pick<MetricsProvider, "foldOf">;
  readonly activityProvider: Pick<ActivityProvider, "activityOf">;
  readonly tmuxService: Pick<TmuxService, "declare">;
  // [LAW:single-enforcer] The one owner of every plugin's session files: a
  // session's declaration holds each source its renderer subscribes to there,
  // and a render state's build holds the folders its config declares.
  readonly managedStorage: Pick<ManagedStorage, "declare">;
  // [LAW:single-enforcer] The one owner of every `shell` and `file` run: a
  // session's declaration holds each run its renderer subscribes to there,
  // so one digest is one run however many sessions name it.
  readonly sourceRuns: Pick<SourceRuns, "declare">;
  // Claude Code's auto-compact window, read from the user settings file at
  // the path a render names.
  readonly autoCompact: Pick<AutoCompactProvider, "stored">;
  // Each session's prompt-cache expiry, read off its transcript's tail.
  readonly cacheExpiry: Pick<CacheExpiryProvider, "expiryOf">;
  // The machine's identity: its host name and the daemon's user.
  readonly hostService: Pick<HostService, "declareName" | "declareUser">;
  // [LAW:single-enforcer] The one trigger of every session's transcript
  // lanes: a session's declaration holds its entry, whose watch and period
  // refresh the providers above.
  readonly transcriptLanes: Pick<TranscriptLanes, "declare">;
  // The log for a read that threw: a bug no owner saw.
  readonly log: DaemonLogger;
  // Each session lane whose refresh threw, until one runs clean.
  readonly faults: Pick<RefreshFaults, "of">;
}

// What every payload function reads of the render it serves: the request's
// facts and the owners they are read from.
export interface PayloadInputs extends ViewFacts {
  readonly deps: RenderPayloadDeps;
}

// The settings file of THIS session's Claude Code, from the client's
// `claudeConfigDir` hint — never the daemon's own env, which answers for
// whichever session spawned it. [LAW:single-enforcer]
function settingsPathOf(hints: ClientHints, home: string): string {
  return claudeSettingsPath(claudeConfigDir(hints.claudeConfigDir, home));
}

// [LAW:nothing-unseen] The repository and usage caches' tallies, as a render
// event's facts show them: what the host's caches answered by the end of a
// render.
export function cacheTallyFacts(deps: {
  readonly gitProvider: Pick<GitDataProvider, "getStats">;
  readonly usageStore: Pick<SessionUsageStore, "getStats">;
}): { readonly git: string; readonly usage: string } {
  const tally = (t: {
    readonly size: number;
    readonly hits: number;
    readonly misses: number;
  }): string => `${t.size}/${t.hits}h/${t.misses}m`;
  return {
    git: tally(deps.gitProvider.getStats()),
    usage: tally(deps.usageStore.getStats()),
  };
}

// Each lane's value as its owner holds it now. The keyed lanes' (git, tmux)
// are `Current`: a value not answered yet carries its landing.
// `today` is no lane of the payload: the day it sums is the draw's
// (`todayOf`).
export interface Lanes {
  readonly git: Current<GitInfo>;
  readonly usage: Reading<TranscriptUsage>;
  readonly context: Reading<number>;
  readonly metrics: Reading<MetricsFold>;
  readonly activity: Reading<ActivityInfo>;
  readonly tmuxSession: Current<string>;
  readonly hostName: Current<string>;
  readonly hostUser: Current<string>;
  readonly cache: Reading<number>;
  readonly speed: Reading<SpeedObservation>;
  readonly autoCompact: Reading<AutoCompactWindow>;
  readonly sources: ReadonlyMap<string, Current<JsonValue>>;
  // Each run the session's renderer subscribes to, by digest: its reading
  // and its watch's fault.
  readonly runs: ReadonlyMap<string, RunReading>;
  // Each variable the session's `env` sources name, from its environment.
  readonly env: ReadonlyMap<string, Current<string>>;
}

export interface RunReading {
  readonly reading: Current<JsonValue>;
  readonly fault: string | null;
}

// [LAW:one-source-of-truth] Everything a session's readers read of its owners
// in one turn: the lanes as the payload folds them (every source the config
// declares among them, each lane whose refresh threw as that failure),
// today's day sums, and what the session's transcripts gave its folds less
// of. The payload and the facts document are both folds of this one record.
export interface Readings {
  readonly lanes: Lanes;
  readonly today: Current<TodayFacts>;
  readonly losses: readonly TranscriptLoss[];
}

// The owners of the keyed lanes, which a declaration takes its holds in.
// [LAW:types-are-the-program] Of the usage store a declaration calls only its
// day's declare, so a fixture of the keyed lanes owes nothing more.
export type KeyedOwners = Pick<
  RenderPayloadDeps,
  | "home"
  | "gitProvider"
  | "tmuxService"
  | "hostService"
  | "transcriptLanes"
  | "managedStorage"
  | "sourceRuns"
> & { readonly usageStore: Pick<SessionUsageStore, "declareToday"> };

// [LAW:types-are-the-program] What a session's declaration hands its stamps:
// one lane per keyed lane, each closed over the entry the declaration took, so
// the key is computed once, by the declaration, and a read takes nothing.
export interface DeclaredLanes {
  readonly git: Lane<GitInfo>;
  readonly tmux: Lane<string>;
  readonly hostName: Lane<string>;
  readonly hostUser: Lane<string>;
  readonly today: Lane<DaySums>;
  // The session's transcript lanes' entry: its readings live with each
  // lane's owner, so it answers only whether the entry is there to refresh
  // them.
  readonly transcript: Lane<null>;
  // [LAW:dataflow-not-control-flow] One lane per plugin source the config
  // declares, by the source variable's name: no fixed list — the set is what
  // the loaded plugins declare.
  readonly sources: ReadonlyMap<string, Lane<JsonValue>>;
  // One lane per run the renderer subscribes to, by digest.
  readonly runs: ReadonlyMap<string, SourceLane>;
  // One lane per variable the renderer's `env` sources name.
  readonly env: ReadonlyMap<string, Lane<string>>;
}

// A declaration's lanes, and what threw while it took them.
export interface Declaration {
  readonly lanes: DeclaredLanes;
  readonly faults: readonly string[];
}

// Every lane answering one outcome, one per plugin source and run: a view's
// when its declaration threw whole, or a caller's that declares nothing.
export function settledLanes(
  outcome: Outcome<never>,
  { plugins, runs, env }: Subscribed,
): DeclaredLanes {
  const lane = settledLane(outcome);
  return {
    git: lane,
    tmux: lane,
    hostName: lane,
    hostUser: lane,
    today: lane,
    transcript: lane,
    sources: new Map([...plugins.keys()].map((name) => [name, lane])),
    runs: new Map(
      [...runs.keys()].map((digest) => [
        digest,
        { digest, current: () => lane.current(), fault: () => null },
      ]),
    ),
    env: new Map(env.map((name) => [name, lane])),
  };
}

// [LAW:one-source-of-truth] Where a request says its session runs, as its
// render resolves its config from (src/daemon/render-checkpoint.ts).
// [LAW:one-source-of-truth] The repo a request names.
function gitAt({
  cwd,
  hookData,
}: ViewFacts): readonly [workingDir: string, projectDir: string | undefined] {
  return [
    cwd ?? hookData.workspace?.current_dir,
    hookData.workspace?.project_dir,
  ];
}

// [LAW:single-enforcer] A session's declaration (brandon-unfiled-3248.8ro6,
// steps 3 and 4), the one taker of holds: every keyed entry of the session, at
// the keys its request names, taken in `holds` — an entry not read yet is
// created and its first read started — and handed back as the lanes its stamps
// read. The host's collector runs it on every request and every move of the
// renderer's subscriptions (src/daemon/collector.ts), so a moved key starts
// its read before any draw asks for it, and the key it left is released at
// once (`Holds.declare`).
//
// [LAW:dataflow-not-control-flow] Every lane is a lane: a session outside tmux
// has no pane to name a session by, so its tmux lane answers `ABSENT`, and one
// whose declaration threw answers that failure and takes no hold.
export function declareLanes(
  owners: KeyedOwners,
  holds: Holds,
  facts: Locator,
  sources: Subscribed,
): Declaration {
  const { environment } = facts;
  const pane = facts.hints.tmux ?? null;
  // [LAW:no-silent-failure] A lane whose declaration throws is a bug in its
  // owner, reported to the caller, while every other lane declares.
  const faults: string[] = [];
  const declare = <T>(lane: string, take: () => Lane<T>): Lane<T> => {
    try {
      return take();
    } catch (e) {
      faults.push(`${lane}: ${inspect(e)}`);
      return settledLane(failed(`${lane}: ${String(e)}`, "read"));
    }
  };
  const lanes: DeclaredLanes = {
    git: declare("git", () =>
      owners.gitProvider.declare(holds, ...gitAt(facts)),
    ),
    tmux:
      pane === null
        ? settledLane(ABSENT)
        : declare("tmux", () => owners.tmuxService.declare(holds, pane)),
    hostName: declare("host.name", () => owners.hostService.declareName(holds)),
    hostUser: declare("host.user", () => owners.hostService.declareUser(holds)),
    today: declare("today", () =>
      owners.usageStore.declareToday(holds, facts.hints.claudeConfigDir),
    ),
    transcript: declare("transcript", () =>
      owners.transcriptLanes.declare(holds, {
        session: facts.hookData.session_id,
        transcript: facts.hookData.transcript_path,
        settings: settingsPathOf(facts.hints, owners.home),
      }),
    ),
    // [LAW:one-source-of-truth] Each source's hold at (its storage folder,
    // the session the checkpoint parsed).
    sources: new Map(
      [...sources.plugins].map(([name, folder]) => [
        name,
        declare(name, () =>
          owners.managedStorage.declare(
            holds,
            folder,
            facts.hookData.session_id,
          ),
        ),
      ]),
    ),
    // A run whose declaration threw answers that failure and watches nothing;
    // a declared run's own lane carries its watch's fault.
    runs: declareRuns(
      owners.sourceRuns,
      holds,
      sources.runs,
      environment,
      (digest, take) => ({
        digest,
        fault: () => null,
        ...declare(`run ${shortDigest(digest)}`, take),
      }),
    ),
    // [LAW:one-source-of-truth] Each named variable as the session's
    // environment holds it: set, unset, or why the host holds none.
    env: new Map(
      sources.env.map((name) => [
        name,
        settledLane<string>(
          environment.kind === "failed"
            ? failed(environment.reason, "read")
            : variableOf(environment.value, name),
        ),
      ]),
    ),
  };
  return { lanes, faults };
}

// [LAW:effects-at-boundaries] No I/O, and no write: every read takes what its
// owner stored, so the world state stamped over it (src/daemon/collector.ts)
// is stamped again in the turn an owner stores a new value. `lanes` are the
// ones the session's declaration took, read at each read: a read takes
// nothing, so the session holds exactly what its latest declaration took.
export function readingsOf(
  inputs: PayloadInputs,
  lanes: DeclaredLanes,
): Readings {
  const { deps } = inputs;
  const sessionId = inputs.hookData.session_id;
  // [LAW:no-silent-failure] A read that throws is a bug in its owner: logged
  // here, by the read that met it — a frame's included, whose failures go
  // nowhere else — and that lane's failure, so it costs its own cells, never
  // the bar. A lane whose refresh threw is that failure (RefreshFaults), and
  // every lane is the failure of an entry that cannot refresh them (its
  // declaration threw, its source closed).
  const entry = lanes.transcript.current();
  // `name` is what the read is of, which is its lane but for `today`.
  const read = <T>(
    lane: RefreshLane,
    value: () => T,
    name: string = lane,
  ): T | Outcome<never> => {
    if (entry.kind === "failed") return entry;
    const fault = deps.faults.of(sessionId, lane);
    if (fault !== undefined) return fault;
    try {
      return value();
    } catch (e) {
      deps.log("error", `${name} read threw: ${inspect(e)}`);
      return failed(`${name}: ${String(e)}`, "read");
    }
  };
  const laneReadings: Lanes = {
    git: lanes.git.current(),
    usage: read("session", () => deps.usageStore.usageOf(sessionId)),
    context: read("context", () => deps.contextProvider.tokensOf(sessionId)),
    metrics: read("metrics", () => deps.metricsProvider.foldOf(sessionId)),
    activity: read("activity", () =>
      deps.activityProvider.activityOf(sessionId),
    ),
    tmuxSession: lanes.tmux.current(),
    hostName: lanes.hostName.current(),
    hostUser: lanes.hostUser.current(),
    cache: read("cache", () => deps.cacheExpiry.expiryOf(sessionId)),
    speed: read("speed", () => deps.usageStore.speedOf(sessionId)),
    autoCompact: read("autocompact", () =>
      deps.autoCompact.stored(settingsPathOf(inputs.hints, deps.home)),
    ),
    sources: new Map(
      [...lanes.sources].map(([name, lane]) => [name, lane.current()]),
    ),
    runs: new Map(
      [...lanes.runs].map(([digest, lane]) => {
        const reading = lane.current();
        return [
          digest,
          environmentOutput(
            { reading, fault: lane.fault() },
            (reading.kind === "ok" || reading.kind === "failed") &&
              isEnvironmentOutput(lane),
          ),
        ];
      }),
    ),
    env: new Map([...lanes.env].map(([name, lane]) => [name, lane.current()])),
  };
  return {
    lanes: laneReadings,
    // The session's own days are its record's, so its lane's failure is
    // today's.
    today: read(
      "session",
      () => todayReading(lanes.today, deps.usageStore, sessionId),
      "today",
    ),
    // [LAW:single-enforcer] The usage store's folds alone report what a
    // transcript could not give: every fold reads a line through the one line
    // reading, so the context, metrics and activity folds of the main
    // transcript drop the lines its fold drops, and only the usage store
    // folds the sidechains.
    losses: deps.usageStore.lossesOf(sessionId),
  };
}

// [LAW:single-enforcer] Today's facts as the session reads them: the directory
// set's day sums with the session's own days beside them, failing if the
// session's last ingest did. The draw's projection (`todayOf`) and the facts
// document read through this one definition, behind `readingsOf`'s `read`
// (the refresh's fault, a throw).
export function todayReading(
  lane: Lane<DaySums>,
  usage: Pick<SessionUsageStore, "daysOutside">,
  sessionId: SessionId,
): Current<TodayFacts> {
  const set = lane.current();
  if (set.kind !== "ok") return set;
  const own = usage.daysOutside(sessionId, set.value.roots);
  if (own.kind === "failed") return own;
  return ok({ sums: set.value.sums, own: own.kind === "ok" ? own.value : {} });
}
