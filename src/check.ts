// [LAW:verifiable-goals] `cc-candybar check [path]` — the authoring agent's eyes.
// Config diagnostics otherwise surface VISUALLY (composeWithDiagnostics renders
// error/warning icons into the bar), a channel a blind config author never sees.
// This command runs the production pipeline and projects its verdict onto a
// text + exit-code contract a script can close its own loop on:
//   0 — config loads and renders (warnings, if any, on stderr)
//   1 — config is invalid (parse / validate / register / render failure)
//   2 — usage error or a named file could not be read
//
// [LAW:single-enforcer] No parallel validation path: the verdict is reached
// through the exact functions the daemon runs (RenderCache.reloadInto →
// buildState, then the per-request render in server.ts) — resolveDslConfig →
// detectConfigCollisions → loadConfig → validateConfig → registerDslConfig →
// deriveActionValidators → renderDsl. "check passes" and "the daemon renders"
// cannot diverge, because they are one code path — check additionally waits a
// bounded settle for shell/file sources' first run, which the daemon's first
// cold render does not (its next render shows what check showed).

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  loadConfig,
  validateConfig,
  resolveDslConfig,
  configResolutionNotice,
  detectConfigCollisions,
  ConfigError,
  expandHome,
} from "./config/dsl-loader.js";
import { detectConfigEnv } from "./config-hint.js";
import { DEFAULT_DSL_CONFIG } from "./config/default-dsl-config.js";
import { VariableStore } from "./var-system/store.js";
import { SourceRegistry } from "./var-system/sources.js";
import { SessionState } from "./daemon/session-state.js";
import { registerDslConfig, renderDsl } from "./dsl/render.js";
import { deriveActionValidators } from "./daemon/verbs/state-validators.js";
import { lookKeyByName } from "./themes/policy.js";
import { paletteForThemeName } from "./themes/palette-resolvers.js";
import {
  resolveEffectiveGlobals,
  type EffectiveGlobals,
} from "./daemon/render-payload.js";

// [LAW:no-ambient-temporal-coupling] A fixed width keeps the verdict a function
// of the config alone, not of whichever terminal invoked the check. Templates
// evaluate in full before any width-driven wrap/pagination, so width shapes
// layout, never diagnostics.
const CHECK_WIDTH = 200;

// How long the verdict waits for a shell/file source's first run before
// rendering with whatever it holds (and naming the stragglers as a warning).
// Generous against a slow `uptime`, short against a hung command.
const SOURCE_SETTLE_MS = 5000;

// One faked Claude Code hook event, shaped like the daemon's augmented payload
// (see src/daemon/render-payload.ts) — the `input` vars read out of it by their
// dotted `path`. [LAW:verifiable-goals] It is deliberately RICH (dirty git with
// every worktree count, an upstream, a stash, a recent commit; home set; live
// session/today/context/metrics/rate-limit data) so gated segments actually
// RENDER their content instead of gating off. A minimal payload would let a
// field-name typo in the git/directory/metrics/budget branches slip through —
// those branches only run when their data is present.
//
// `effective` is threaded in exactly as the daemon threads it (server.ts
// resolves one EffectiveGlobals struct per render and feeds BOTH the
// payload's `*.effective` fields and BuildLineOptions/basePalette below)
// [LAW:one-source-of-truth].
//
// test/example-configs.test.ts asserts rendered content against these literal
// values (780s → "◷ 13m", cost $0.39, version 1.15.0, …); changing one here
// fails that suite loudly rather than drifting silently.
export function checkPayload(
  effective: EffectiveGlobals,
): Record<string, unknown> {
  const home = "/home/tester";
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    hook_event_name: "Status",
    session_id: "test0a1b-2c3d-4e5f-6a7b-8c9d0e1f2a3b",
    version: "1.15.0",
    home,
    cwd: `${home}/code/cc-candybar/src`,
    transcript_path: `${home}/.claude/projects/x/test.jsonl`,
    model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
    workspace: {
      current_dir: `${home}/code/cc-candybar/src`,
      project_dir: `${home}/code/cc-candybar`,
    },
    git: {
      repoName: "cc-candybar",
      repoUrl: "https://github.com/promptctl/cc-candybar",
      branch: "main",
      sha: "abc1234",
      ahead: 2,
      behind: 1,
      staged: 3,
      unstaged: 2,
      untracked: 1,
      conflicts: 0,
      upstream: "origin/main",
      stash: 1,
      status: "dirty",
      operation: "rebase",
      timeSinceCommit: 780,
    },
    session: { cost: 0.39, tokens: 241400 },
    today: { cost: 12.5, tokens: 3_400_000 },
    context: { totalTokens: 48487, contextLeft: 24 },
    metrics: {
      lastResponseTime: 8.2,
      responseTime: 4.2,
      sessionDuration: 930,
      messageCount: 8,
      linesAdded: 512,
      linesRemoved: 88,
    },
    block: { nativeUtilization: 63, resetsAt: nowSec + 2 * 3600 },
    weekly: { percentage: 21, resetsAt: nowSec + 5 * 86400 },
    cache: { expiresAt: nowSec + 15 * 60 },
    tmux: { session: "work" },
    // `ssh: true` for the same reason `tmux.session` is populated: this
    // fixture deliberately satisfies every gate so a when-gated segment
    // RENDERS and its template gets checked. A local-looking fixture would
    // gate the host segment off and let a typo inside it ship.
    host: { name: "tester-box", user: "tester", ssh: true },
    theme: { effective: effective.theme },
    look: { effective: effective.look },
    // [LAW:one-source-of-truth] Was missing here even though EffectiveGlobals
    // already carried `preset` — a pre-existing gap this ticket's own fixture
    // needs closed: a preset trigger's `.preset.effective` label and
    // brandon-layout-edit-2gc.5's `.preset.customized` gate both silently
    // fell back to their declared defaults ("" / false) rather than the
    // resolved value, exactly the drift the sibling `*.effective` fields
    // already guard against.
    preset: {
      effective: effective.preset,
      customized: effective.presetCustomized,
    },
    style: { effective: effective.style },
    charset: { effective: effective.charset },
    colorCompatibility: { effective: effective.colorCompatibility },
    autoWrap: { effective: effective.autoWrap },
    padding: { effective: effective.padding },
  };
}

// [LAW:dataflow-not-control-flow] The check result is DATA — a pure function of
// the target file's contents — discriminated into the three outcomes the exit-
// code contract projects. `checkConfig` carries the decision; `runCheck` only
// maps it to (streams, exit), so the contract is testable without spawning a
// process or stubbing process.exit.
//
// `configPath` null means the bundled default was checked (no config file
// found — the daemon renders the same default in that state).
export type CheckOutcome =
  | {
      readonly kind: "clean";
      readonly configPath: string | null;
      readonly warnings: readonly string[];
      readonly rendered: string;
    }
  | {
      readonly kind: "fatal";
      readonly configPath: string | null;
      readonly message: string;
      readonly warnings: readonly string[];
    }
  | {
      readonly kind: "unreadable";
      readonly path: string;
      readonly message: string;
    };

// The no-target search: the daemon's own resolver over (cwd, cwd), so the
// file this checks IS the file the daemon would load from this directory.
// It names no explicit file, so `missing`/`unreadable` are unreachable and
// the projection is file-or-default — but either arm may carry chain
// locations the search could not check, and that advisory is the SAME
// notice RenderCache renders ([LAW:one-source-of-truth]): `check` reports
// what the bar would, never a re-derivation of it.
function searchedFile(cwd: string, warnings: string[]): string | null {
  const resolution = resolveDslConfig(cwd, cwd);
  const notice = configResolutionNotice(resolution);
  if (notice !== null) warnings.push(notice);
  return resolution.kind === "file" ? resolution.path : null;
}

// Run the daemon's load-and-render pipeline against one config target.
//
// With no target, the path resolves exactly as the daemon resolves it for a
// client with no override (resolveDslConfig: project/cwd → XDG), so the file
// this checks IS the file the daemon would load from this directory. The
// CLI's own `$CC_CANDYBAR_CONFIG` enters as the target (runCheck), the way
// the statusline client sends it as a hint — a set override always names
// the file, so an absent one is `unreadable` here, never a clean verdict
// about the bundled default.
//
// [LAW:no-silent-failure] With an explicit target, the named file must exist
// and be readable — a missing file is `unreadable`, never a fall-through to the
// bundled default. (The daemon's --config-to-missing-file behavior — render the
// default, watch for the file to appear — is liveness for a long-running
// renderer; a verdict command must not report "clean" about a file it never
// read.)
export async function checkConfig(
  target: string | undefined,
  cwd: string = process.cwd(),
): Promise<CheckOutcome> {
  // Advisories accumulate from the search onward, independent of load
  // success — mirror of RenderCache.reloadInto.
  const warnings: string[] = [];

  // [LAW:one-source-of-truth] No pre-read: the ONE content read of the config
  // file is the readFileSync inside loadConfig. Readability is established by
  // the same read that parses (no double I/O); the catch below classifies its
  // errno failure as `unreadable`. The explicit-target statSync is a metadata
  // probe at the argv trust boundary, not a second read: a directory target
  // (`check .`) fails read() with a path-less EISDIR the catch could not
  // attribute, so the not-a-file usage error is decided here.
  const configPath =
    target !== undefined
      ? path.resolve(expandHome(target))
      : searchedFile(cwd, warnings);
  if (target !== undefined && configPath !== null) {
    // throwIfNoEntry suppresses only ENOENT (left for the content read to
    // classify); EACCES/EPERM on the probe itself is equally "could not read
    // the named file" — same outcome, not an uncaught stack.
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(configPath, { throwIfNoEntry: false });
    } catch (e) {
      return {
        kind: "unreadable",
        path: configPath,
        message: e instanceof Error ? e.message : String(e),
      };
    }
    if (st !== undefined && !st.isFile()) {
      return {
        kind: "unreadable",
        path: configPath,
        message: "not a file",
      };
    }
  }

  // [LAW:dataflow-not-control-flow] Collision detection runs independent of
  // load success: even if the .json5 fails to parse, the author still wants
  // to know a shadowed .json sibling exists.
  const collision = detectConfigCollisions(cwd, cwd);
  if (collision !== null) warnings.push(collision);

  try {
    const rendered = await loadRegisterRender(configPath, cwd, warnings);
    return { kind: "clean", configPath, warnings, rendered };
  } catch (e) {
    // A filesystem error on the config file itself (ENOENT/EACCES from
    // loadConfig's read — errno errors carry the failing `.path`, which is the
    // discriminator against deeper fs failures) is the `unreadable` outcome:
    // the named file could not be read at all, distinct from a file that read
    // but is invalid. [LAW:no-silent-failure] — never a fall-through to the
    // bundled default. Duck-typed, not `instanceof Error`: fs errors can cross
    // a realm boundary (jest/graceful-fs), where instanceof lies.
    const errno = e as Partial<NodeJS.ErrnoException> | null;
    if (
      configPath !== null &&
      typeof errno === "object" &&
      errno !== null &&
      typeof errno.code === "string" &&
      errno.path === configPath &&
      typeof errno.message === "string"
    ) {
      return { kind: "unreadable", path: configPath, message: errno.message };
    }
    // Same classification RenderCache.reloadInto applies: ConfigError and
    // register/render throws (template parse, MissingFieldError, action arity)
    // are all author-facing diagnostics — the daemon would surface each via
    // composeWithDiagnostics, so check surfaces each as fatal text.
    const message =
      e instanceof ConfigError
        ? e.message
        : e instanceof Error
          ? e.message
          : String(e);
    return { kind: "fatal", configPath, message, warnings };
  }
}

// The buildState + per-request-render mirror: every call below is the function
// the daemon calls, in the daemon's order [LAW:single-enforcer]. Returns the
// rendered line; appends the register pass's advisory `loadWarnings` (partial
// declaration failures) to `warnings` — the same channel RenderCache merges
// them into.
async function loadRegisterRender(
  configPath: string | null,
  cwd: string,
  warnings: string[],
): Promise<string> {
  const { config: merged, source } = loadConfig(configPath, DEFAULT_DSL_CONFIG);
  const config = validateConfig(merged, configPath ?? "<default>", source);

  const store = new VariableStore();
  const registry = new SourceRegistry(
    store,
    config.globals.default_empty_value ?? "",
    undefined,
    new SessionState(),
  );
  try {
    const compiled = registerDslConfig(config, registry, { cwd });
    // Registered before the validator pass so a derive throw (a key-kind
    // clash) still carries the partial-load warnings into the fatal outcome.
    warnings.push(...compiled.loadWarnings);
    // [LAW:no-ambient-temporal-coupling] A shell/file source's first run is
    // async; the verdict renders what the sources YIELDED, not their pre-scan
    // fallbacks (a json document with no default is an error cell until it is
    // scanned — exactly what an author must see). The registry owns the
    // "every run complete" state; a source still out at the deadline is named
    // and the render proceeds on what it holds.
    const pending = await registry.settled(SOURCE_SETTLE_MS);
    if (pending.length > 0) {
      warnings.push(
        `source${pending.length === 1 ? "" : "s"} still running after ${SOURCE_SETTLE_MS} ms, rendered with fallback values: ${pending.join(", ")}`,
      );
    }
    // Derivation only (the throw-on-clash coherence pass over the action
    // table); the daemon additionally registers the results in its global
    // validator registry, which a one-shot check has no wire to serve.
    deriveActionValidators(config);

    // Fresh session (no clicked theme/style/look), so the session half of
    // each resolution is null — the config default over the floor, exactly
    // what the daemon renders for a session that has never clicked.
    // [LAW:one-source-of-truth] The preset resolves first and its fragment's
    // globals feed every field below, the SAME order the daemon resolves in
    // (server.ts) — so `check` renders the arrangement a fresh session actually
    // opens in, not the config's un-presetted root.
    const effective: EffectiveGlobals = resolveEffectiveGlobals(
      config,
      // A fresh session: no clicked theme/style/look, and edit mode off. The
      // resolution is THE daemon's (resolveEffectiveGlobals), not a copy that
      // agrees with it today — which is the whole reason check renders what the
      // daemon would render rather than something adjacent.
      () => null,
      // [LAW:no-silent-failure] `check` renders the file as the bundled
      // default's peer, never as a customization OF it — a root the file
      // authors is simply the bar `check` verifies, so `.preset.customized`
      // is false for THIS (primary, returned) render. A second render pass below also
      // exercises `true`, so a `.preset.customized`-gated segment still
      // gets checked — just not through this value.
      () => false,
    );
    // [LAW:no-silent-failure] A segment whose template THROWS while evaluating
    // (an `{{ action }}` display-arity mismatch, a MissingFieldError from a
    // partially-declared variable) renders as a visible ⚠ error cell — partial
    // rendering, the daemon's channel for a human looking at the bar. The blind
    // authoring agent is not looking at the bar; check collects the same errors
    // through the render's observer seam and fails the verdict, so exit 0 never
    // blesses a bar that renders ⚠.
    const renderOnce = (
      payloadEffective: EffectiveGlobals,
    ): { rendered: string; segmentErrors: Map<string, string> } => {
      // [LAW:types-are-the-program] Keyed by segment NAME, not appended to a
      // list — a segment errors at most once per pass, so this is the
      // strongest true shape (dedupe-by-construction within one pass) and
      // what makes deduping ACROSS the two passes below a plain key check
      // rather than a message-text comparison.
      const segmentErrors = new Map<string, string>();
      const rendered = renderDsl(
        config,
        compiled,
        store,
        registry,
        checkPayload(payloadEffective),
        paletteForThemeName(payloadEffective.theme),
        {
          style: payloadEffective.style,
          separator: payloadEffective.separator,
          width: CHECK_WIDTH,
          colorCompatibility: payloadEffective.colorCompatibility,
          wrap: payloadEffective.autoWrap,
          padding: payloadEffective.padding,
          charset: payloadEffective.charset,
        },
        {
          onSegmentError: (segName, message) =>
            segmentErrors.set(segName, message),
        },
        {
          look: lookKeyByName(config.looks, payloadEffective.look),
          preset: payloadEffective.preset,
        },
      );
      return { rendered, segmentErrors };
    };

    const primary = renderOnce(effective);
    // [LAW:verifiable-goals] `.preset.customized` is the ONE gate this
    // config surface adds that a rich, data-driven fixture (checkPayload's
    // own stated design one comment up) can never drive true on its own —
    // every OTHER field a segment might gate on is a VALUE checkPayload can
    // just supply richly; this one is a daemon-resolved FACT about session
    // state, not a hookData field a config author's own file ever carries.
    // Without a second pass, a typo or MissingFieldError inside a user's
    // OWN `when: '{{ .preset.customized }}'`-gated content (docs/
    // interaction-authoring.md's own documented pattern) would pass check
    // clean and only surface later as a live ⚠ error cell. Second pass
    // only — the RETURNED rendering stays the realistic default (a fresh
    // session has never customized anything); this pass exists purely to
    // catch broken content behind the one gate the first pass can't reach.
    const customizedCheck = renderOnce({
      ...effective,
      presetCustomized: true,
    });

    // [LAW:no-silent-failure] An UNCONDITIONAL segment error (one whose
    // `when`, if any, is true in both passes — the two renders share the
    // same config/store/registry and differ only in `presetCustomized`)
    // fires in BOTH passes identically. Deduped by segment NAME rather than
    // concatenated: a customizedCheck error is only genuinely NEW
    // information when primary didn't already report that same segment —
    // reporting it twice would double-count one bug and the "(under
    // .preset.customized = true)" tag would misdirect the reader into
    // thinking it's specific to that gate when it isn't.
    const errors = [
      ...[...primary.segmentErrors].map(
        ([segName, message]) => `segment "${segName}": ${message}`,
      ),
      ...[...customizedCheck.segmentErrors]
        .filter(([segName]) => !primary.segmentErrors.has(segName))
        .map(
          ([segName, message]) =>
            `segment "${segName}": ${message} (under .preset.customized = true)`,
        ),
    ];
    if (errors.length > 0) {
      throw new Error(
        `config renders with ${errors.length} segment error${
          errors.length === 1 ? "" : "s"
        } (the daemon would render ⚠ error cells):\n` +
          errors.map((m) => `  ${m}`).join("\n"),
      );
    }
    return primary.rendered;
  } finally {
    // [LAW:single-enforcer] The registry owns every async handle the config
    // declared (timers, fs watchers, git subscriptions); a one-shot check must
    // not leak them past the verdict.
    registry.dispose();
  }
}

const EXIT_CLEAN = 0;
const EXIT_FATAL = 1;
const EXIT_USAGE = 2;

// [LAW:dataflow-not-control-flow] The outcome → (streams, exit-code) mapping is
// DATA: a total fold over CheckOutcome returning one descriptor; runCheck runs
// the two unconditional writes + exit against it. Verdict on stdout, every
// diagnostic (warnings included) on stderr — so `check` in a pipeline yields a
// parseable verdict while a human still sees the advisories.
export interface CliPlan {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

function warningLines(warnings: readonly string[]): string {
  return warnings.map((w) => `warning: ${w}\n`).join("");
}

export function checkPlan(o: CheckOutcome): CliPlan {
  switch (o.kind) {
    case "clean": {
      const where = o.configPath ?? "bundled default (no config file found)";
      const count =
        o.warnings.length > 0
          ? ` (${o.warnings.length} warning${o.warnings.length === 1 ? "" : "s"})`
          : "";
      return {
        stdout: `✓ ${where}: config OK${count}\n`,
        stderr: warningLines(o.warnings),
        code: EXIT_CLEAN,
      };
    }
    case "fatal":
      return {
        stdout: "",
        stderr:
          warningLines(o.warnings) +
          `✗ ${o.configPath ?? "<default>"}\n${o.message}\n`,
        code: EXIT_FATAL,
      };
    case "unreadable":
      return {
        stdout: "",
        stderr: `check: cannot read ${o.path}: ${o.message}\n`,
        code: EXIT_USAGE,
      };
  }
}

// `cc-candybar check [path]` — the argv binding. Extra arguments and an empty
// path argument are usage errors (loud, not silently ignored — the likeliest
// cause is an unquoted or mis-expanded shell variable). An empty string is not
// "no argument": `checkConfig(undefined)` means "resolve like the daemon",
// while `""` is a malformed target that would otherwise EISDIR on the cwd.
export async function runCheck(args: readonly string[]): Promise<never> {
  if (args.length > 1 || args[0] === "") {
    process.stderr.write(
      "check: expected at most one non-empty path\nUsage: cc-candybar check [config-file]\n",
    );
    process.exit(EXIT_USAGE);
  }
  const plan = checkPlan(
    await checkConfig(args[0] ?? detectConfigEnv(process.env)),
  );
  process.stdout.write(plan.stdout);
  process.stderr.write(plan.stderr);
  process.exit(plan.code);
}
