// [LAW:one-type-per-behavior] A stale source checkout and an install behind the
// registry are ONE statement — what is newer, what is running, three clicks —
// through one `Update` and one sentence; only a table of words and a command differ.
// [LAW:effects-at-boundaries] `updateOf`/`updateNotice` are pure; the watch is the edge.

import type { Globals } from "../config/dsl-types";
import {
  effectsUrl,
  VERB_APPLY_UPDATE,
  VERB_SET_CONFIG,
  VERB_SET_STATE,
  VERB_SHOW_CONFIG_WARNING,
} from "../click/wire";
import {
  assessCurrency,
  fetchLatestVersion,
  formatVersion,
  PACKAGE_NAME,
  type Currency,
  type Version,
} from "../install/currency";
import { launch, type LaunchOpts, type LaunchResult } from "../proc/launch";
import {
  diagnosticSpan,
  UPDATE_SEVERITY,
  type DiagnosticChannel,
  type DiagnosticLine,
} from "../render/diagnostic-strip";
import { shortDigest } from "../source-digest";
import { PACKAGE_VERSION } from "../version";
import {
  assessBuild,
  bakedStamp,
  type BuildCurrency,
  type SourceStamp,
} from "./build-currency";
import type { LogLevel } from "./log";
import { BadVerbArgs } from "./verb-error";
import { registerConfigValidator } from "./verbs/config-validators";
import { registerStateValidator } from "./verbs/state-validators";

export type Update =
  | {
      readonly kind: "source";
      readonly root: string;
      readonly newer: SourceStamp;
      readonly running: SourceStamp;
    }
  | {
      readonly kind: "release";
      readonly newer: Version;
      readonly running: Version;
    };

export const UPDATE_DISMISSED_KEY = "update.dismissed";
export const UPDATE_NOTICE_FIELD = "updateNotice" satisfies keyof Globals;

export function updateIdentity(update: Update): string {
  return update.kind === "source"
    ? update.newer.digest
    : formatVersion(update.newer);
}

export const describeStamp = (s: SourceStamp): string =>
  `${s.version} [${shortDigest(s.digest)}]`;

// [LAW:dataflow-not-control-flow] The words and the command as one table; nothing downstream asks which kind it is.
interface UpdateFacts {
  readonly headline: string;
  readonly newer: string;
  readonly running: string;
  readonly act: string;
  readonly busy: string;
  readonly command: Pick<LaunchOpts, "bin" | "args" | "cwd">;
}

export function factsOf(update: Update): UpdateFacts {
  switch (update.kind) {
    case "source":
      return {
        headline: "Newer source",
        newer: describeStamp(update.newer),
        running: describeStamp(update.running),
        act: "rebuild",
        busy: "rebuilding…",
        command: { bin: "pnpm", args: ["build"], cwd: update.root },
      };
    case "release":
      return {
        headline: "Newer release",
        newer: formatVersion(update.newer),
        running: formatVersion(update.running),
        act: "upgrade",
        busy: "upgrading…",
        command: {
          bin: "pnpm",
          args: [
            "dlx",
            `${PACKAGE_NAME}@${formatVersion(update.newer)}`,
            "install",
          ],
        },
      };
  }
}

// [LAW:types-are-the-program] One child at a time — a second click is refused, not queued — and a failure names the identity it was tried on.
export type ActState =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | {
      readonly kind: "failed";
      readonly identity: string;
      readonly reason: string;
    };
const IDLE: ActState = { kind: "idle" };
const RUNNING: ActState = { kind: "running" };

export interface NoticeContext {
  readonly sessionId: string;
  readonly dismissed: string | null;
  readonly enabled: boolean;
}

// [LAW:dataflow-not-control-flow] Zero or one channel — the list IS the answer, so the composer needs no "is there a notice" branch.
export function updateNotice(
  update: Update | null,
  act: ActState,
  ctx: NoticeContext,
): DiagnosticChannel[] {
  if (update === null) return [];
  const identity = updateIdentity(update);
  if (!ctx.enabled || ctx.dismissed === identity) return [];
  const facts = factsOf(update);
  const sentence = `${facts.headline}: ${facts.newer}. You're on ${facts.running}.`;
  const failure =
    act.kind === "failed" && act.identity === identity
      ? [`${facts.act} failed: ${act.reason}`]
      : [];
  const message = [sentence, ...failure].join("\n");
  const copy = effectsUrl([
    { verb: VERB_SHOW_CONFIG_WARNING, args: [message] },
  ]);
  const actSpan =
    act.kind === "running"
      ? diagnosticSpan(`[${facts.busy}]`, copy)
      : diagnosticSpan(
          `[${facts.act}]`,
          effectsUrl([{ verb: VERB_APPLY_UPDATE, args: [ctx.sessionId] }]),
        );
  const first: DiagnosticLine = [
    diagnosticSpan(sentence, copy),
    actSpan,
    diagnosticSpan(
      "[dismiss]",
      effectsUrl([
        {
          verb: VERB_SET_STATE,
          args: [ctx.sessionId, UPDATE_DISMISSED_KEY, identity],
        },
      ]),
    ),
    diagnosticSpan(
      "[disable]",
      effectsUrl([
        {
          verb: VERB_SET_CONFIG,
          args: [ctx.sessionId, UPDATE_NOTICE_FIELD, "false"],
        },
      ]),
    ),
  ];
  const rest = failure.map((f): DiagnosticLine => [diagnosticSpan(f, copy)]);
  return [{ severity: UPDATE_SEVERITY, message, lines: [first, ...rest] }];
}

// [LAW:dataflow-not-control-flow] `release` is consulted only under not-source-checkout:
// a checkout's package.json version is whatever `main` says, not what is running.
export function updateOf(
  build: BuildCurrency,
  release: Currency | null,
): Update | null {
  if (build.kind === "stale") {
    return {
      kind: "source",
      root: build.root,
      newer: build.source,
      running: build.running,
    };
  }
  if (
    build.kind === "not-source-checkout" &&
    release !== null &&
    release.kind === "stale"
  ) {
    return {
      kind: "release",
      newer: release.latest,
      running: release.installed,
    };
  }
  return null;
}

export interface UpdateWatchOptions {
  readonly entryUrl: string;
  readonly intervalMs: number;
  readonly releaseIntervalMs: number;
  readonly registryUrl: string;
  readonly fetchImpl: typeof fetch;
  // Runs after a successful act, so the binary watch notices now, not at its next tick.
  readonly onApplied: () => void;
  readonly log: (level: LogLevel, msg: string) => void;
}

export interface UpdateWatch {
  arm(): void;
  notice(ctx: NoticeContext): DiagnosticChannel[];
  act(): void;
}

const ACT_TIMEOUT_MS = 10 * 60 * 1000;

function describeBuild(b: BuildCurrency): [LogLevel, string] {
  switch (b.kind) {
    case "current":
      return ["info", `build: current ${describeStamp(b.stamp)}`];
    case "stale":
      return [
        "info",
        `build: stale — source ${describeStamp(b.source)}, running ${describeStamp(b.running)}`,
      ];
    case "not-source-checkout":
      return ["info", "build: not a source checkout"];
    case "unchecked":
      return ["warn", `build: unchecked: ${b.reason}`];
  }
}

function describeRelease(c: Currency): [LogLevel, string] {
  switch (c.kind) {
    case "current":
      return ["info", `release: current ${formatVersion(c.installed)}`];
    case "stale":
      return [
        "info",
        `release: stale — latest ${formatVersion(c.latest)}, running ${formatVersion(c.installed)}`,
      ];
    case "ahead":
      return [
        "info",
        `release: ahead — running ${formatVersion(c.installed)}, latest ${formatVersion(c.latest)}`,
      ];
    case "unchecked":
      return ["warn", `release: unchecked: ${c.reason}`];
  }
}

function changeLogger(
  log: UpdateWatchOptions["log"],
): (entry: [LogLevel, string]) => void {
  let last: string | null = null;
  return ([level, msg]) => {
    if (msg === last) return;
    last = msg;
    log(level, msg);
  };
}

const lastLine = (text: string): string | undefined =>
  text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .at(-1);

function failureReason(r: Extract<LaunchResult, { ok: false }>): string {
  const exit = r.exitCode === null ? "" : ` (exit ${r.exitCode})`;
  const detail =
    lastLine(r.stderr) ?? r.error ?? lastLine(r.stdout) ?? "no output";
  return `${r.reason}${exit}: ${detail}`;
}

// [LAW:single-enforcer] The daemon's one owner of "what is newer than me", and of the
// two click gates: dismiss (re-registered per identity, so a stale one stops matching)
// and disable (registered once; `false` is the only value a click writes).
export function makeUpdateWatch(opts: UpdateWatchOptions): UpdateWatch {
  const {
    entryUrl,
    intervalMs,
    releaseIntervalMs,
    registryUrl,
    fetchImpl,
    onApplied,
    log,
  } = opts;
  // [LAW:no-ambient-temporal-coupling] Before the first sample the build is honestly unchecked.
  let build: BuildCurrency = { kind: "unchecked", reason: "not sampled yet" };
  let release: Currency | null = null;
  let act: ActState = IDLE;
  let gate: { readonly identity: string; readonly dispose: () => void } | null =
    null;
  const logBuild = changeLogger(log);
  const logRelease = changeLogger(log);

  const current = (): Update | null => updateOf(build, release);

  function syncGate(): void {
    const update = current();
    const identity = update === null ? null : updateIdentity(update);
    if ((gate === null ? null : gate.identity) === identity) return;
    gate?.dispose();
    gate =
      identity === null
        ? null
        : {
            identity,
            dispose: registerStateValidator(UPDATE_DISMISSED_KEY, {
              kind: "allow-list",
              allowed: [identity],
            }),
          };
  }

  function sampleBuild(): void {
    build = assessBuild(entryUrl, bakedStamp);
    logBuild(describeBuild(build));
    syncGate();
  }

  async function pollRelease(): Promise<void> {
    const latest = await fetchLatestVersion(
      PACKAGE_NAME,
      fetchImpl,
      registryUrl,
    );
    release = assessCurrency(PACKAGE_VERSION, latest);
    logRelease(describeRelease(release));
    syncGate();
  }

  return {
    arm() {
      // Daemon-lifetime registration: the disposer matters only to a watch that is torn down.
      registerConfigValidator(UPDATE_NOTICE_FIELD, {
        kind: "allow-list",
        allowed: ["false"],
      });
      sampleBuild();
      setInterval(sampleBuild, intervalMs).unref();
      if (build.kind === "not-source-checkout") {
        void pollRelease();
        setInterval(() => void pollRelease(), releaseIntervalMs).unref();
      }
    },
    notice: (ctx) => updateNotice(current(), act, ctx),
    act() {
      const update = current();
      if (update === null) {
        throw new BadVerbArgs("apply-update: nothing newer is known to apply");
      }
      const facts = factsOf(update);
      if (act.kind === "running") {
        throw new BadVerbArgs(`apply-update: already ${facts.busy}`);
      }
      act = RUNNING;
      log(
        "info",
        `apply-update: ${facts.act} — ${facts.command.bin} ${facts.command.args?.join(" ") ?? ""}`,
      );
      // The child inherits the daemon's env; nothing about the command is composed from data.
      void launch({
        ...facts.command,
        category: "update.apply",
        timeoutMs: ACT_TIMEOUT_MS,
      }).then((result) => {
        if (result.ok) {
          act = IDLE;
          log("info", `apply-update: ${facts.act} succeeded`);
          sampleBuild();
          onApplied();
          return;
        }
        const reason = failureReason(result);
        act = { kind: "failed", identity: updateIdentity(update), reason };
        log("error", `apply-update: ${facts.act} failed: ${reason}`);
      });
    },
  };
}
