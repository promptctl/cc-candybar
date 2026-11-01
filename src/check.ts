// [LAW:verifiable-goals] `cc-candybar check [--render] [path]` — the authoring
// agent's eyes.
// Config diagnostics otherwise surface VISUALLY (an indicator beside the bar's
// settings door, read in its viewer), a channel a blind config author never
// sees.
// This command runs the production pipeline and projects its verdict onto a
// text + exit-code contract a script can close its own loop on:
//   0 — config loads and renders (warnings, if any, on stderr)
//   1 — config is invalid (parse / validate / register / render failure)
//   2 — usage error or a named file could not be read
//
// `--render` adds one thing to that contract: the bar it rendered, on stdout
// beneath the verdict (brandon-check-m2a). The pipeline already computed it, and
// for an author who cannot look at a live bar it is the only place the layout,
// the glyphs and the colours are readable at all.
//
// [LAW:single-enforcer] No parallel validation path: the verdict is reached
// through the exact functions the daemon runs (RenderCache.reloadInto →
// buildState, then the per-request render in draw-bar.ts) — resolveDslConfig →
// detectConfigCollisions → loadConfig → validateRenderable → registerDslConfig →
// deriveActionValidators → drawDsl. "check passes" and "the daemon renders"
// cannot diverge, because they are one code path as far as the Frame, and
// encoding a Frame refuses nothing: it is the print's, so a verdict with no
// `--render` encodes nothing. Check additionally waits, before each pass, for
// the shell/file runs that pass's payload started, under one bounded settle
// window for the whole verdict; the daemon's first cold render does not (its
// next render shows what check showed).

import { linkSignerFromKeyFile } from "./daemon/link-key.js";
import { repoConfigs } from "./daemon/repo-configs.js";
import { repoGateLines } from "./config/loader/repo-gate.js";
import type { ConfigResolution } from "./config/loader/discovery.js";
import fs from "node:fs";
import type { CliPlan } from "./cli-plan.js";
import process from "node:process";
import {
  loadConfigChain,
  resolveDslConfig,
  configResolutionNotice,
  detectConfigCollisions,
  ConfigError,
  refuseDrops,
  type DroppedPlugin,
  type SessionDirs,
  type ConfigLayer,
  homeLayer,
} from "./config/dsl-loader.js";
import { chainName, cliConfigTarget } from "./config-hint.js";
import { explicitConfigPath } from "./utils/user-path.js";
import { autoCompactControls } from "./segments/autocompact.js";
import type { ValidatedConfig } from "./config/dsl-types.js";
import { DEFAULT_DSL_CONFIG } from "./config/default-dsl-config.js";
import { VariableStore } from "./var-system/store.js";
import { processLauncher } from "./proc/launch";
import { SourceRegistry } from "./var-system/sources.js";
import { SessionState } from "./daemon/session-state.js";
import {
  bindPayload,
  drawDsl,
  registerDslConfig,
  type CompiledConfig,
  type RenderWarning,
} from "./dsl/render.js";
import { ansiOf, type Frame } from "./render/frame.js";
import { stateGate } from "./daemon/verbs/state-validators.js";
import { configGate } from "./daemon/verbs/config-validators.js";
import { reserveUpdateKeys } from "./daemon/update-notice.js";
import { resumeCommand } from "./claude-resume.js";
import { instantOf, type Instant } from "./utils/instant.js";
import { perSetting } from "./config/setting-projections.js";
import { effectivePresetName, presetNames } from "./config/presets.js";
import {
  effectiveInputs,
  projectSources,
  renderOptionsOf,
  type RenderPayload,
  type TodayPayload,
  type ViewPayload,
} from "./daemon/render-payload.js";
import { ABSENT } from "./utils/outcome.js";
import {
  resolveEffectiveGlobals,
  type EffectiveGlobals,
} from "./config/effective-globals.js";

// [LAW:no-ambient-temporal-coupling] A fixed width keeps the verdict a function
// of the config alone, not of whichever terminal invoked the check. Templates
// evaluate in full before any width-driven wrap/pagination, so width shapes
// layout, never diagnostics.
//
// It is also the width `--render` prints at, because there is ONE render here
// and the printed bar is it [LAW:one-source-of-truth]. Laying the preview out at
// `process.stdout.columns` instead would bless one bar and show another, and it
// would read a terminal the author this exists for does not have — a piped
// stdout has no columns.
const CHECK_WIDTH = 200;

// How long the verdict waits for an async source's runs — a shell or file
// read — before rendering with whatever it holds (and naming the stragglers as
// a warning). Generous against a slow `uptime`, short against a hung command.
const SOURCE_SETTLE_MS = 5000;

// [LAW:no-ambient-temporal-coupling] The one deadline a verdict's waits share:
// the fresh payload's first runs, then the runs each pass's payload starts (a
// `key` or `depends_on` over `.preset.effective` re-reads when the preset
// moves). One window rather than one per wait, so a hung command costs the
// budget once, never once per pass — a wait under a spent window ends at once.
// It is opened where the runs start (the prepared config's first bind), not
// before the load, so compile time is never charged to the sources. `ms` is
// what the straggler warning names.
export interface SettleWindow {
  readonly ms: number;
  readonly signal: AbortSignal;
}

function settleWindow(ms: number): SettleWindow {
  return { ms, signal: AbortSignal.timeout(ms) };
}

// The sources still out when a wait under `settle` ended, named as the
// warning the verdict carries; empty when every run answered. A value not
// answered yet is drawn as pending (its loading cell), never as a default: a
// default stands in for a failure, not a wait.
function stragglers(
  settle: SettleWindow,
  pending: readonly string[],
): readonly string[] {
  return pending.length === 0
    ? []
    : [
        `source${pending.length === 1 ? "" : "s"} still running after ${settle.ms} ms, drawn as pending: ${pending.join(", ")}`,
      ];
}

// [LAW:one-source-of-truth] The one composition of what a check pass binds:
// the representative payload under `effective`, at `width`, through the seam a
// session's view reads. The prepare-time bind and every pass's bind go
// through it, so the first pass's payload is the prepared one and its key
// reactions fire only for inputs the preset actually moved.
function bindPass(
  {
    layers,
    config,
    compiled,
    store,
    registry,
  }: Pick<
    PreparedConfig,
    "layers" | "config" | "compiled" | "store" | "registry"
  >,
  effective: EffectiveGlobals,
  width: number,
  at: Instant,
): { drawn: unknown; opts: ReturnType<typeof renderOptionsOf> } {
  const opts = renderOptionsOf(effective, width);
  const drawn = bindPayload(
    compiled,
    store,
    registry,
    {
      ...checkPayload(config, effective, layers.at(-1) ?? null, at),
      today: CHECK_TODAY,
    },
    opts,
    effective,
  );
  return { drawn, opts };
}

// One faked Claude Code hook event, shaped like the daemon's augmented payload
// (see src/daemon/render-payload.ts) — the `input` vars read out of it by their
// dotted `path`. [LAW:verifiable-goals] It is deliberately RICH (dirty git with
// every worktree count, an upstream, a stash, a recent commit; home set; live
// session/today/context/metrics/rate-limit data) so gated segments actually
// RENDER their content instead of gating off. A minimal payload would let a
// field-name typo in the git/directory/metrics/budget branches slip through —
// those branches only run when their data is present.
//
// `effective` is threaded in exactly as the daemon threads it (draw-bar.ts
// resolves one EffectiveGlobals struct per render and feeds BOTH the
// payload's `*.effective` fields and BuildLineOptions/basePalette below)
// [LAW:one-source-of-truth].
//
// test/example-configs.test.ts asserts rendered content against these literal
// values (780s → "◷ 13m", cost $0.39, version 1.15.0, …); changing one here
// fails that suite loudly rather than drifting silently.
//
// [LAW:types-are-the-program] Typed as the payload a view draws from, less
// `term`, which the draw writes from its width (bindPayload): a field the
// daemon's payload requires — every declared source's reading among them — is
// a compile error here until the fixture carries it.
export type CheckPayload = Omit<ViewPayload, "term">;

export function checkPayload(
  config: Pick<ValidatedConfig, "variables">,
  effective: EffectiveGlobals,
  configPath: string | null,
  // The instant the render this payload feeds is drawn at, so its reset times
  // sit where the render's own countdowns measure them from.
  at: Instant,
): CheckPayload {
  const home = "/home/tester";
  const nowSec = Math.floor(at);
  const sessionId = "test0a1b-2c3d-4e5f-6a7b-8c9d0e1f2a3b";
  const workspace = {
    current_dir: `${home}/code/cc-candybar/src`,
    project_dir: `${home}/code/cc-candybar`,
    added_dirs: [],
  };
  return {
    hook_event_name: "Status",
    session_id: sessionId,
    version: "1.15.0",
    home,
    cwd: `${home}/code/cc-candybar/src`,
    transcript_path: `${home}/.claude/projects/x/test.jsonl`,
    model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
    // An effort level, so the model cell draws its effort gauge and gets that
    // template checked. Not max: max climbs a frame a second, and `check`
    // renders at the wall clock, so its bar (and every doc fence pinned to
    // it) would change from one second to the next. Every level computes
    // max's bubble, so xhigh evaluates it too.
    effort: { level: "xhigh" },
    workspace,
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
      tracking: "tracked",
      stash: 1,
      status: "dirty",
      operation: "rebase",
      committedAt: nowSec - 780,
    },
    session: { cost: 0.39, tokens: 241400 },
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
    tmux: { pane: "%0", session: "work" },
    // `ssh: true` for the same reason `tmux.session` is populated: this
    // fixture deliberately satisfies every gate so a when-gated segment
    // RENDERS and its template gets checked. A local-looking fixture would
    // gate the host segment off and let a typo inside it ship.
    host: { name: "tester-box", user: "tester", ssh: true },
    // A set window with a step each way, through the daemon's own projection,
    // so the when-gated `autocompact` control renders all of its cells.
    autocompact: autoCompactControls(400_000, 1_000_000),
    // [LAW:one-source-of-truth] The daemon's own projection of the resolved
    // globals, so a `.preset.effective`/`.endcaps.effective` label is checked
    // against the value it will actually show, never its declared default.
    ...effectiveInputs(effective),
    // One step each way, one change made since edit mode opened, one unsaved
    // setting and every setting resettable, so every part of the settings
    // menu's save cell, each control's ↺, and edit mode's save and cancel
    // cells, each gated on having something to do, renders and gets its
    // template checked.
    history: { undo: 1, redo: 1, sinceEdit: 1 },
    navigation: { back: 1 },
    unsaved: 1,
    resettable: perSetting(() => true) satisfies RenderPayload["resettable"],
    // The field the theme gear's `⤓ default for <theme>` reads, spelled as the
    // daemon spells it (themeDefaultSave, src/daemon/setting-drafts.ts): the
    // theme in force, whose swatch the cell draws, and no save under a
    // rule-chosen theme. Check opens no trigger, so it never draws the cell; a
    // render that opens the gear over this payload does (settings-menu-seams).
    themeDefault:
      effective.theme.kind === "decided"
        ? { differs: true, theme: effective.theme.name }
        : { differs: false },
    // A resume command (the daemon's own projection) and a config file, so
    // the quick-action tray's value-gated `⎘ resume` and `↗ config` render
    // and get checked. The config file is the one being checked, as the
    // daemon's is the one it loaded, so a template that reads its siblings
    // (the demo configs' switcher) is checked against where it really is;
    // the bundled default has no file, and a stand-in keeps `↗ config` drawn.
    resumeCommand: resumeCommand(workspace, sessionId, undefined),
    configPath: configPath ?? `${home}/.config/cc-candybar/config.json5`,
    // [LAW:one-source-of-truth] Every source the config declares reads
    // absent, through the daemon's own projection: `check` runs no plugin
    // program and has no session, and absent is what a session reads before
    // its program first writes. So a segment gated on `hasKey` is hidden, and
    // an unguarded read fails the check with the missing-field error that
    // session's bar would draw.
    ...projectSources(
      Object.entries(config.variables).flatMap(([name, decl]) =>
        decl.kind === "source" ? [name] : [],
      ),
      () => ABSENT,
    ),
  };
}

// `today` is a fact of the draw's own instant, not of the view's payload
// (DRAW_PROJECTIONS), so the fixture hands it to the draw beside the payload,
// as the demo hands its draws theirs.
export const CHECK_TODAY: TodayPayload = { cost: 12.5, tokens: 3_400_000 };

// [LAW:dataflow-not-control-flow] The check result is DATA — a pure function of
// the target file's contents — discriminated into the three outcomes the exit-
// code contract projects. `checkConfig` carries the decision; `checkCommandPlan`
// only maps it to a plan, so the contract is testable without spawning a
// process or stubbing process.exit.
//
// `layers` are the files checked, lowest first; none means the bundled
// default was checked (no config file loaded — the daemon renders the same
// default in that state).
export type CheckOutcome =
  | {
      readonly kind: "clean";
      readonly layers: readonly ConfigLayer[];
      readonly warnings: readonly string[];
      readonly rendered: Frame;
    }
  | {
      readonly kind: "fatal";
      readonly layers: readonly ConfigLayer[];
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
// the projection is the chain's layers — which may carry locations the
// search could not check, and that advisory is the SAME
// notice RenderCache renders ([LAW:one-source-of-truth]): `check` reports
// what the bar would, never a re-derivation of it.
function searchedLayers(
  resolution: ConfigResolution,
  warnings: string[],
): readonly ConfigLayer[] {
  const notice = configResolutionNotice(resolution);
  if (notice !== null) warnings.push(notice);
  return resolution.kind === "chain" ? resolution.layers : [];
}

// Run the daemon's load-and-render pipeline against one config target.
//
// With no target, the path resolves exactly as the daemon resolves it for a
// client with no override (resolveDslConfig: project/cwd → XDG), so the file
// this checks IS the file the daemon would load from this directory. The
// CLI's own `$CC_CANDYBAR_CONFIG` enters as the target (checkCommandPlan), the way
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
  // [LAW:no-ambient-temporal-coupling] The settle budget is an input of the
  // verdict, so a caller that means to see the deadline reached names a
  // budget of its own instead of waiting out the command's.
  settleMs: number = SOURCE_SETTLE_MS,
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
  const configPath = explicitConfigPath(cwd, target) ?? null;
  // [LAW:single-enforcer] The daemon's gate, under the same answers: a
  // repository the bar would not run, `check` names and runs nothing of.
  const resolution = resolveDslConfig(
    repoConfigs().read(),
    cwd,
    cwd,
    configPath ?? undefined,
  );
  warnings.push(...repoGateLines(resolution.repos));
  // An explicit file that is absent or unreadable is still the chain: its
  // read is what names the failure.
  const layers =
    configPath === null
      ? searchedLayers(resolution, warnings)
      : [homeLayer(configPath)];
  if (configPath !== null) {
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
    const rendered = await loadRegisterRender(
      layers,
      { repo: resolution.repos.plugins },
      cwd,
      warnings,
      settleMs,
    );
    return { kind: "clean", layers, warnings, rendered };
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
      typeof errno === "object" &&
      errno !== null &&
      typeof errno.code === "string" &&
      typeof errno.path === "string" &&
      layers.some((l) => l.path === errno.path) &&
      typeof errno.message === "string"
    ) {
      return { kind: "unreadable", path: errno.path, message: errno.message };
    }
    // Same classification RenderCache.reloadInto applies: ConfigError and
    // register/render throws (template parse, MissingFieldError, action arity)
    // are all author-facing diagnostics — the daemon would surface each as
    // the bar's error, so check surfaces each as fatal text.
    if (e instanceof ConfigError) warnings.push(...e.warnings);
    const message =
      e instanceof ConfigError
        ? e.message
        : e instanceof Error
          ? e.message
          : String(e);
    return { kind: "fatal", layers, message, warnings };
  }
}

// A config loaded, validated, registered, and settled under the fresh
// session's payload — the daemon's buildState, in the daemon's order
// [LAW:single-enforcer]. `check` renders its verdict on it and the gallery
// renders every theme on it, so neither can drift into a partial copy of the
// other. The caller owns `registry` and disposes it; the register pass's
// advisory `loadWarnings` (partial declaration failures) land in `warnings` —
// the same channel RenderCache merges them into. A source still running at
// the deadline is named by the pass that draws without it (renderEffective),
// never here, so one straggler is one line however many passes reach it.
// `settle` is the one window every wait on this config shares — opened when
// its sources' runs started, read by each pass — so no caller can give the
// passes a window the prepare did not open.
export interface PreparedConfig {
  readonly settle: SettleWindow;
  readonly layers: readonly string[];
  // Plugins the config lists that did not load; each fails the verdict.
  readonly droppedPlugins: readonly DroppedPlugin[];
  readonly config: ValidatedConfig;
  readonly compiled: CompiledConfig;
  readonly store: VariableStore;
  readonly registry: SourceRegistry;
}

// The repository a chain loads with: its approved project.
export type RepoSession = Omit<SessionDirs, "cwd">;

// No approved project.
export const NO_REPO: RepoSession = { repo: null };

export async function prepareConfig(
  chain: readonly ConfigLayer[],
  repo: RepoSession,
  cwd: string,
  warnings: string[],
  // The instant the view's first payload is stamped at: the one its renders
  // are drawn at.
  at: Instant,
  settleMs: number = SOURCE_SETTLE_MS,
): Promise<PreparedConfig> {
  // Each file's own advisories (an editability notice naming a duplicate key)
  // land before its validation, so a fatal outcome still carries them.
  const layers = chain.map((l) => l.path);
  const loaded = loadConfigChain(
    chain,
    DEFAULT_DSL_CONFIG,
    { warned: (w) => warnings.push(...w) },
    { ...repo, cwd },
  );
  // [LAW:no-silent-failure] The bar draws past a placement of an undeclared
  // segment; a check refuses it, as the file's author has to fix it.
  refuseDrops(loaded.dropped);
  const { config } = loaded;

  const store = new VariableStore();
  const registry = new SourceRegistry(
    processLauncher,
    store,
    config.globals.default_empty_value ?? "",
    new SessionState(),
  );
  try {
    // [LAW:single-enforcer] check draws `run` links as the daemon does,
    // signed with the one key.
    const compiled = registerDslConfig(config, registry, {
      cwd,
      signer: linkSignerFromKeyFile(),
    });
    warnings.push(...compiled.loadWarnings);
    // A view's inputs are pending until its source answers, and a source
    // whose `key` or `depends_on` reads one first runs when it answers — so
    // the payload a fresh session draws from is bound before the wait, or
    // those sources would not have started: the constant this check draws by,
    // through the seam a session's view reads.
    const effective = resolveEffectiveGlobals(
      config,
      () => null,
      () => false,
    );
    const settle = settleWindow(settleMs);
    bindPass(
      { layers, config, compiled, store, registry },
      effective,
      CHECK_WIDTH,
      at,
    );
    // [LAW:no-ambient-temporal-coupling] An async source's first run — a shell
    // or file read — completes after registration; a prepared config's store
    // holds what the sources YIELDED, not their pre-scan fallbacks (a json
    // document with no default draws its loading cell until it is scanned).
    // The registry owns the "every run complete" state; a source still out at
    // the deadline is left to the pass that draws without it.
    await registry.inFlight(settle.signal);
    return {
      settle,
      layers,
      droppedPlugins: [
        ...loaded.installed.dropped,
        ...loaded.layers.flatMap((l) => l.plugins.dropped),
      ],
      config,
      compiled,
      store,
      registry,
    };
  } catch (e) {
    registry.dispose();
    throw e;
  }
}

// [LAW:no-silent-failure] A segment whose template THROWS while evaluating
// (an `{{ action }}` display-arity mismatch, a MissingFieldError from a
// partially-declared variable) renders as a visible ⚠ error cell — partial
// rendering, the daemon's channel for a human looking at the bar. The blind
// authoring agent is not looking at the bar; check collects the same errors
// through the render's observer seam — a segment's ⚠, a globals rule the
// render could not honour (brandon-themes-dzl), and a layout `when` that threw
// (brandon-unfiled-3248.ryf) — and fails the verdict, so
// exit 0 never blesses a bar the daemon would render a complaint on.
//
// One pass: the view bound to this pass's payload, the runs that bind started
// (a source keyed on an input the payload moved) awaited under the prepared
// config's window, and the draw over what they yielded
// [LAW:no-ambient-temporal-coupling] — the daemon's request order, where a
// request awaits the refreshes its arrival triggered before it answers. A
// source still out at the deadline is this pass's advisory, so the verdict
// names the preset that drew without it.
export async function renderEffective(
  prepared: PreparedConfig,
  effective: EffectiveGlobals,
  width: number,
  at: Instant,
): Promise<{
  rendered: Frame;
  failures: Map<string, string>;
  advisories: Set<string>;
}> {
  // [LAW:types-are-the-program] Keyed by the failing thing's own LABEL, not
  // appended to a list — each can fail at most once per pass, so this is the
  // strongest true shape (dedupe-by-construction within one pass). The key
  // carries WHAT failed because two different domains report here — a
  // segment, or a globals slot whose rule the render could not honour — and
  // a bare name could not tell them apart
  // (nor stop a segment named `globals.palette` from displacing the slot).
  const failures = new Map<string, string>();
  // What check lists beside its verdict without failing it: a source still
  // running at the pass's deadline, which the bar draws as pending.
  const advisories = new Set<string>();
  // [LAW:types-are-the-program] Exhaustive over every kind a render can warn
  // of, so a new kind is a compile error here until check says what it means.
  const warned = (warning: RenderWarning): void => {
    switch (warning.kind) {
      // [LAW:no-silent-failure] A globals rule the render could not honour —
      // its template threw, or a palette rule named no installed theme — is a
      // real finding for a headless pass: the bar would render that slot's
      // floor with nobody watching the bar. Keyed by its slot so two failing
      // slots are two findings; the message names the path(s) the rule was
      // written at, which may be a preset's globals rather than the config's.
      case "rule":
        failures.set(`${warning.slot} rule`, warning.message);
        return;
      // A layout `when` that threw: the bar hides what it gates, which a
      // headless pass would otherwise bless.
      case "when":
        failures.set(warning.where, warning.error);
        return;
      // A variable that cannot refresh draws its last value; a headless pass
      // would bless a bar that has quietly stopped moving.
      case "refresh":
        failures.set(
          `variable "${warning.variable}"`,
          `cannot refresh: ${warning.error}`,
        );
        return;
      default:
        warning satisfies never;
    }
  };
  const { config, compiled, store, registry, settle } = prepared;
  const { drawn, opts } = bindPass(prepared, effective, width, at);
  for (const line of stragglers(settle, await registry.inFlight(settle.signal)))
    advisories.add(line);
  const { frame } = drawDsl(
    config,
    compiled,
    store,
    registry,
    drawn,
    at,
    opts,
    {
      onSegmentError: (placementId: string, message: string) =>
        failures.set(`segment "${placementId}"`, message),
      onRenderWarning: warned,
    },
    effective,
  );
  return { rendered: frame, failures, advisories };
}

// The verdict: the prepared config rendered under every preset, every render
// error a failure. Returns the line a fresh session renders.
async function loadRegisterRender(
  chain: readonly ConfigLayer[],
  repo: RepoSession,
  cwd: string,
  warnings: string[],
  settleMs: number,
): Promise<Frame> {
  // [LAW:effects-at-boundaries] One instant for every pass, so the passes
  // differ only in the preset they render; one settle window for every wait.
  const at = instantOf(new Date());
  const prepared = await prepareConfig(
    chain,
    repo,
    cwd,
    warnings,
    at,
    settleMs,
  );
  const { config } = prepared;
  try {
    // The gates the daemon derives when it loads this config, over the keys
    // its own links hold: an action table that cannot gate fails here as it
    // fails that load.
    const releaseUpdateKeys = reserveUpdateKeys();
    try {
      stateGate(config);
      configGate(config);
    } finally {
      releaseUpdateKeys();
    }

    // [LAW:verifiable-goals] Every preset a session can switch to is a bar
    // the daemon renders, so every one is a pass: a segment only one preset
    // places, or a rule in one preset's globals, is otherwise compiled and
    // never evaluated, and exit 0 blesses a bar that throws on the first
    // switch (brandon-check-ew8j). Each preset renders twice — once as a
    // fresh session sees it, once with `.preset.customized` true, the one
    // gate the rich fixture cannot drive on its own (it is a daemon-resolved
    // fact about session state, not a hookData field). The resolution is THE
    // daemon's (resolveEffectiveGlobals) with the session's preset pick as
    // the only input that varies, so each pass renders what a session on
    // that preset would — edit mode off, nothing else clicked.
    // The preset a session that has picked none opens in.
    const freshPreset = effectivePresetName(
      null,
      config.globals.preset,
      config.presets,
    );
    // [LAW:no-silent-failure] Nothing a config authors makes a render throw
    // — every fault it can hold is a ⚠ cell or a warning — so a throw is the
    // renderer's own bug, and one pass's throw must neither lose the
    // failures the other passes find nor drop the preset that reached it: it
    // is caught here and becomes that pass's one failure. `rendered` is
    // absent exactly then.
    const render = async (preset: string, customized: boolean) => {
      const effective = resolveEffectiveGlobals(
        config,
        (key) => (key === "preset" ? preset : null),
        () => customized,
      );
      let pass: {
        rendered?: Frame;
        failures: Map<string, string>;
        advisories: ReadonlySet<string>;
      };
      try {
        pass = await renderEffective(prepared, effective, CHECK_WIDTH, at);
      } catch (e) {
        pass = {
          failures: new Map([
            ["render", e instanceof Error ? e.message : String(e)],
          ]),
          advisories: new Set(),
        };
      }
      return { preset, customized, ...pass };
    };
    // [LAW:one-source-of-truth] The passes run one after another: they share
    // the one view, and each binds it to its own payload before it draws.
    const primary = await render(freshPreset, false);
    const outs = [primary, await render(freshPreset, true)];
    for (const p of presetNames(config.presets)) {
      if (p === freshPreset) continue;
      outs.push(await render(p, false), await render(p, true));
    }

    // [LAW:one-source-of-truth] One line per (what, why) — the line's text —
    // however many passes reach it, for failures and advisories alike: an
    // unconditional error fires in every pass, and reporting it once per
    // preset would count one bug N times; the same segment failing for two
    // different reasons is two lines. A line the fresh session's own pass
    // shows is reported bare — that is the bar a session opens on; any other
    // is tagged with the presets that reach it, and
    // `.preset.customized = true` only where that preset's plain pass did
    // not, so the reader knows which switch exposes it.
    const reported = (
      linesOf: (out: (typeof outs)[number]) => Iterable<string>,
    ): string[] => {
      const found = new Map<string, Map<string, Set<boolean>>>();
      for (const out of outs) {
        for (const line of linesOf(out)) {
          const reached = found.get(line) ?? new Map<string, Set<boolean>>();
          reached.set(
            out.preset,
            (reached.get(out.preset) ?? new Set()).add(out.customized),
          );
          found.set(line, reached);
        }
      }
      return [...found].map(([line, reached]) => {
        if (reached.get(freshPreset)?.has(false)) return line;
        const where = [...reached].map(([preset, passes]) =>
          [
            ...(preset === freshPreset ? [] : [`preset "${preset}"`]),
            ...(passes.has(false) ? [] : [".preset.customized = true"]),
          ].join(", "),
        );
        return `${line} (under ${where.join("; ")})`;
      });
    };
    warnings.push(...reported((out) => out.advisories));
    const errors = reported((out) =>
      [...out.failures].map(([label, message]) => `${label}: ${message}`),
    );
    const bar = primary.rendered;
    // [LAW:no-silent-failure] A dropped plugin leaves a bar that renders, so
    // only the verdict can say the config asked for something it did not get.
    // Each drop is already a warning line; the verdict counts them.
    const drops = prepared.droppedPlugins.length;
    const failures = [
      ...(drops > 0
        ? [
            `${drops} plugin${drops === 1 ? "" : "s"} did not load (named in the warnings)`,
          ]
        : []),
      ...(errors.length > 0 || bar === undefined
        ? [
            `config renders with ${errors.length} render error${
              errors.length === 1 ? "" : "s"
            } (the daemon would show them on the bar):\n` +
              errors.map((m) => `  ${m}`).join("\n"),
          ]
        : []),
    ];
    if (failures.length > 0 || bar === undefined) {
      throw new Error(failures.join("\n"));
    }
    return bar;
  } finally {
    // [LAW:single-enforcer] The registry owns every async handle the config
    // declared (timers, fs watchers); a one-shot check must
    // not leak them past the verdict.
    prepared.registry.dispose();
  }
}

const EXIT_CLEAN = 0;
const EXIT_FATAL = 1;
const EXIT_USAGE = 2;

// [LAW:dataflow-not-control-flow] The outcome → (streams, exit-code) mapping is
// DATA: a total fold over CheckOutcome returning one plan (src/cli-plan.ts),
// which the entry delivers. Verdict on stdout, every diagnostic (warnings
// included) on stderr — so `check` in a pipeline yields a parseable verdict
// while a human still sees the advisories.

function warningLines(warnings: readonly string[]): string {
  return warnings.map((w) => `warning: ${w}\n`).join("");
}

// `--render` (brandon-check-m2a): the bar beneath the verdict line, for an
// author who cannot look at a live one. [LAW:one-source-of-truth] It is
// `o.rendered` — the very frame the verdict's fresh-session pass reached —
// so the bar an author reads and the bar `check` blessed cannot differ; re-rendering here
// (at a terminal width, say) would be two clocks, and the audience this exists
// for reads a pipe, which has no width at all. The flag adds a VALUE to one
// stream rather than selecting a code path: the plan's two streams are
// unconditional either way, and the arms that never rendered have no bar to
// print because `rendered` lives on the clean arm alone
// [LAW:types-are-the-program].
export function checkPlan(o: CheckOutcome, render = false): CliPlan {
  switch (o.kind) {
    case "clean": {
      const where = chainName(o.layers.map((l) => l.path));
      const count =
        o.warnings.length > 0
          ? ` (${o.warnings.length} warning${o.warnings.length === 1 ? "" : "s"})`
          : "";
      return {
        stdout:
          `✓ ${where}: config OK${count}\n` +
          (render ? `${ansiOf(o.rendered)}\n` : ""),
        stderr: warningLines(o.warnings),
        code: EXIT_CLEAN,
      };
    }
    case "fatal":
      return {
        stdout: "",
        stderr:
          warningLines(o.warnings) +
          `✗ ${chainName(
            o.layers.map((l) => l.path),
            "<default>",
          )}\n${o.message}\n`,
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

const RENDER_FLAG = "--render";
const USAGE = `Usage: cc-candybar check [${RENDER_FLAG}] [config-file]\n`;

// [LAW:parse-dont-validate] argv crosses one checkpoint and becomes a request
// the rest of the command reads by field; nothing inland re-reads `args`.
// Inspecting them inline and exiting from the middle of the command would
// put the usage contract out of reach of everything but a spawned process — the same reason `checkPlan` is a value: a misspelled
// option is now observable exactly like every other outcome.
type CheckArgs =
  | {
      readonly kind: "run";
      readonly target: string | undefined;
      readonly render: boolean;
    }
  | { readonly kind: "usage"; readonly message: string };

function parseCheckArgs(args: readonly string[]): CheckArgs {
  const options = args.filter((a) => a.startsWith("--"));
  const paths = args.filter((a) => !a.startsWith("--"));
  // [LAW:no-silent-failure] An unrecognised option is named, never taken for a
  // path — read as one it would be reported as an unreadable file, a
  // diagnostic about the wrong thing entirely.
  const unknown = options.filter((o) => o !== RENDER_FLAG);
  if (unknown.length > 0) {
    return {
      kind: "usage",
      message: `check: unknown option ${unknown.join(" ")}\n${USAGE}`,
    };
  }
  // [LAW:single-enforcer] Arity only. What the path means — including that an
  // empty one, a statusline's `--config "$CFG"` with CFG unset, resolves like
  // no argument — is `cliConfigTarget`'s to say in `checkCommandPlan`, the one
  // reading `doctor` runs under and the bar renders under.
  if (paths.length > 1) {
    return {
      kind: "usage",
      message: `check: expected at most one path\n${USAGE}`,
    };
  }
  return {
    kind: "run",
    target: paths[0],
    render: options.includes(RENDER_FLAG),
  };
}

// `cc-candybar check [--render] [path]` — the argv binding, and the one place
// the command touches the process: two unconditional writes and the exit code
// its plan carries.
export async function checkCommandPlan(
  args: readonly string[],
): Promise<CliPlan> {
  const parsed = parseCheckArgs(args);
  const cwd = process.cwd();
  return parsed.kind === "usage"
    ? { stdout: "", stderr: parsed.message, code: EXIT_USAGE }
    : checkPlan(
        // [LAW:one-source-of-truth] The target the doctor would check under
        // the same argument, already absolute — `checkConfig`'s own
        // resolution, the seam for its direct callers, passes it through.
        await checkConfig(
          cliConfigTarget(parsed.target, process.env, cwd).path,
          cwd,
        ),
        parsed.render,
      );
}
