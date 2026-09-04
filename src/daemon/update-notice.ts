// The update notice: something newer exists than the code rendering the bar,
// and here is what to do about it (brandon-build-notice-5d6). Two facts feed
// it — a source checkout whose `src/` digest no longer matches the bundle
// (src/daemon/build-currency.ts) and a published install behind the
// registry's latest release (src/install/currency.ts) — and they are ONE
// statement to the reader: what is newer, what is running, and three clicks:
// act (rebuild / upgrade), dismiss (this session, this identity), disable
// (the config file, durably).
//
// [LAW:one-type-per-behavior] Both facts render through one `Update` and one
// sentence shape; what differs is a table of words and a command. The old
// design gave the checkout its own vocabulary ("stale build: dist/index.mjs
// <date> < src/x.ts <date>", a hint naming `just deploy`) that the user read
// as a puzzle — the ticket's verbatim verdict.
//
// [LAW:effects-at-boundaries] `updateOf` / `updateNotice` are pure: (facts,
// act state, session context) → diagnostic channels. The watch below is the
// edge: the clocks, the registry fetch, the subprocess, the validator
// registrations.

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

// [LAW:types-are-the-program] What is newer than the running code. `source`
// is a checkout whose tree no longer matches the bundle; `release` is an
// install behind the registry. Each carries both sides of the comparison
// under one name pair, so the sentence reads the same fields off either.
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

// [LAW:one-source-of-truth] The session key a dismissal writes and the
// config field a disable writes, spelled once. The field is checked against
// Globals so a rename there fails here at compile time.
export const UPDATE_DISMISSED_KEY = "update.dismissed";
export const UPDATE_NOTICE_FIELD = "updateNotice" satisfies keyof Globals;

// What a dismissal names: the newer thing's identity, so a dismissal lapses
// the moment something newer again appears — the digest for source (the
// version alone would miss every uncommitted edit), the version for a release.
export function updateIdentity(update: Update): string {
  return update.kind === "source"
    ? update.newer.digest
    : formatVersion(update.newer);
}

// How a stamp reads to a person: the version it reports and the short digest
// that tells two builds of one version apart.
export const describeStamp = (s: SourceStamp): string =>
  `${s.version} [${shortDigest(s.digest)}]`;

// [LAW:dataflow-not-control-flow] The words and the command, as one table
// the notice and the act both read. Nothing downstream asks which kind it is.
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

// [LAW:types-are-the-program] The act's lifecycle as a value: idle, running
// (one child at a time — a second click is refused, not queued), or failed
// with the reason the notice shows until the next attempt. A failure names
// the identity it was attempted against: the notice for a DIFFERENT newer
// thing owes the reader no line about a build it never tried.
export type ActState =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | { readonly kind: "failed"; readonly identity: string; readonly reason: string };
const IDLE: ActState = { kind: "idle" };
const RUNNING: ActState = { kind: "running" };

// The per-session facts the notice reads: whose clicks these are, what this
// session dismissed (the identity it wrote, or nothing), and whether the
// session's config allows the notice at all (Globals.updateNotice).
export interface NoticeContext {
  readonly sessionId: string;
  readonly dismissed: string | null;
  readonly enabled: boolean;
}

// [LAW:dataflow-not-control-flow] One update becomes zero or one channel —
// the list IS the answer, so the strip composer folds it beside the error
// and warning channels with no "is there a notice" branch. Line one is the
// sentence and the three affordances; a failed act adds a second line naming
// the failure, and while the act runs its affordance is a busy label.
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
  // The sentence copies itself (the warning verb's clipboard), like every
  // other diagnostic row; the affordances each carry their own effect.
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

// [LAW:dataflow-not-control-flow] The two currency facts folded into one
// Update. A checkout answers with its build; the release check only means
// something for a published install (a checkout's package.json version is
// whatever `main` says, not what is running), so `release` is consulted only
// under the not-source-checkout arm — that discriminator is the domain's own.
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
  // The daemon's `import.meta.url` — the bundle whose checkout is assessed.
  readonly entryUrl: string;
  // How often the source tree is re-digested.
  readonly intervalMs: number;
  // How often the registry is asked for `latest` (published installs only).
  readonly releaseIntervalMs: number;
  readonly registryUrl: string;
  readonly fetchImpl: typeof fetch;
  // Runs after a successful act: the bundle on disk has changed, and the
  // binary watch should notice now rather than at its next tick.
  readonly onApplied: () => void;
  readonly log: (level: LogLevel, msg: string) => void;
}

export interface UpdateWatch {
  arm(): void;
  notice(ctx: NoticeContext): DiagnosticChannel[];
  // The apply-update verb's effect. Throws BadVerbArgs when there is nothing
  // to apply or an act is already running.
  act(): void;
}

// A build or an install is a long child; ten minutes is generous for either
// and bounds a wedged one.
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

// [LAW:one-type-per-behavior] A log line that repeats only on change, one
// per channel — the steady state of a one-minute clock is silence.
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

// The last non-empty line of a stream — where a build tool puts its verdict.
const lastLine = (text: string): string | undefined =>
  text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .at(-1);

// Why the act failed, for the notice's second line: the launch's own
// classification, the exit code when there is one, and the most specific
// text the child left behind.
function failureReason(r: Extract<LaunchResult, { ok: false }>): string {
  const exit = r.exitCode === null ? "" : ` (exit ${r.exitCode})`;
  const detail =
    lastLine(r.stderr) ?? r.error ?? lastLine(r.stdout) ?? "no output";
  return `${r.reason}${exit}: ${detail}`;
}

// [LAW:single-enforcer] The daemon's one owner of "what is newer than me":
// it samples the build on a clock, polls the registry on a slower one when
// the layout is a published install, keeps the act's state, and owns the two
// click gates — the dismiss allow-list (re-registered to the current
// identity whenever it changes, so a stale dismissal simply stops matching)
// and the disable allow-list (registered once; `false` is the only value a
// click writes).
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
  // [LAW:no-ambient-temporal-coupling] Before the first sample the build is
  // honestly unchecked — a notice asked for before arm() renders nothing.
  let build: BuildCurrency = { kind: "unchecked", reason: "not sampled yet" };
  let release: Currency | null = null;
  let act: ActState = IDLE;
  let gate: { readonly identity: string; readonly dispose: () => void } | null =
    null;
  const logBuild = changeLogger(log);
  const logRelease = changeLogger(log);

  const current = (): Update | null => updateOf(build, release);

  // The dismiss gate follows the identity: dispose the old allow-list, register
  // the new one, none when nothing is newer.
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
      // Daemon-lifetime registration: the disposer would only matter to a
      // watch that is torn down, and the daemon exits instead.
      registerConfigValidator(UPDATE_NOTICE_FIELD, {
        kind: "allow-list",
        allowed: ["false"],
      });
      sampleBuild();
      setInterval(sampleBuild, intervalMs).unref();
      // The registry is a question only a published install asks: a checkout
      // rebuilds from the source beside it, whatever npm has.
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
      // The child inherits the daemon's environment (PATH included): no env
      // is passed, so nothing about the command is composed from data.
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
