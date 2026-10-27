// [LAW:verifiable-goals] `cc-candybar check [--render] [path]` — the authoring
// agent's eyes.
// Config diagnostics otherwise surface VISUALLY (composeWithDiagnostics renders
// error/warning icons into the bar), a channel a blind config author never sees.
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
// buildState, then the per-request render in server.ts) — resolveDslConfig →
// detectConfigCollisions → loadConfig → validateConfig → registerDslConfig →
// deriveActionValidators → renderDsl. "check passes" and "the daemon renders"
// cannot diverge, because they are one code path — check additionally waits a
// bounded settle for shell/file sources' first run, which the daemon's first
// cold render does not (its next render shows what check showed).

import { linkSignerFromKeyFile } from "./daemon/link-key.js";
import fs from "node:fs";
import process from "node:process";
import {
  loadConfigChain,
  resolveDslConfig,
  configResolutionNotice,
  detectConfigCollisions,
  ConfigError,
  type DroppedPlugin,
} from "./config/dsl-loader.js";
import { detectConfigEnv } from "./config-hint.js";
import { explicitConfigPath } from "./utils/user-path.js";
import { autoCompactControls } from "./segments/autocompact.js";
import type { ValidatedConfig } from "./config/dsl-types.js";
import { DEFAULT_DSL_CONFIG } from "./config/default-dsl-config.js";
import { VariableStore } from "./var-system/store.js";
import { SourceRegistry } from "./var-system/sources.js";
import { SessionState } from "./daemon/session-state.js";
import {
  registerDslConfig,
  renderDsl,
  type CompiledConfig,
  type RenderWarning,
} from "./dsl/render.js";
import { bindView } from "./dsl/parts.js";
import { fixedSource } from "./dsl/view-source.js";
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

// How long the verdict waits for an async source's first run — a shell or file
// read — before rendering with whatever it holds (and naming the stragglers as
// a warning). Generous against a slow
// `uptime`, short against a hung command.
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
//
// [LAW:types-are-the-program] Typed as the payload a view draws from, less
// `term`, which the draw writes from its width (drawPayload): a field the
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
    // max's bubble, colours and frames, so xhigh evaluates them too.
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
    plugins: projectSources(
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
// code contract projects. `checkConfig` carries the decision; `runCheck` only
// maps it to (streams, exit), so the contract is testable without spawning a
// process or stubbing process.exit.
//
// `layers` are the files checked, lowest first; none means the bundled
// default was checked (no config file found — the daemon renders the same
// default in that state).
export type CheckOutcome =
  | {
      readonly kind: "clean";
      readonly layers: readonly string[];
      readonly warnings: readonly string[];
      readonly rendered: string;
    }
  | {
      readonly kind: "fatal";
      readonly layers: readonly string[];
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
function searchedLayers(cwd: string, warnings: string[]): readonly string[] {
  const resolution = resolveDslConfig(cwd, cwd);
  const notice = configResolutionNotice(resolution);
  if (notice !== null) warnings.push(notice);
  return resolution.kind === "chain" ? resolution.layers : [];
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
  const layers =
    configPath === null ? searchedLayers(cwd, warnings) : [configPath];
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
    const rendered = await loadRegisterRender(layers, cwd, warnings, settleMs);
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
      layers.includes(errno.path) &&
      typeof errno.message === "string"
    ) {
      return { kind: "unreadable", path: errno.path, message: errno.message };
    }
    // Same classification RenderCache.reloadInto applies: ConfigError and
    // register/render throws (template parse, MissingFieldError, action arity)
    // are all author-facing diagnostics — the daemon would surface each via
    // composeWithDiagnostics, so check surfaces each as fatal text.
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

// A config loaded, validated, registered, and settled — the daemon's
// buildState, in the daemon's order [LAW:single-enforcer]. `check` renders its
// verdict on it and the gallery renders every theme on it, so neither can
// drift into a partial copy of the other. The caller owns `registry` and
// disposes it; the register pass's advisory `loadWarnings` (partial
// declaration failures) and any source still running at the deadline land in
// `warnings` — the same channel RenderCache merges them into.
export interface PreparedConfig {
  readonly layers: readonly string[];
  // Plugins the config lists that did not load; each fails the verdict.
  readonly droppedPlugins: readonly DroppedPlugin[];
  readonly config: ValidatedConfig;
  readonly compiled: CompiledConfig;
  readonly store: VariableStore;
  readonly registry: SourceRegistry;
}

export async function prepareConfig(
  layers: readonly string[],
  cwd: string,
  warnings: string[],
  // The instant the view's first payload is stamped at: the one its renders
  // are drawn at.
  at: Instant,
  settleMs: number = SOURCE_SETTLE_MS,
): Promise<PreparedConfig> {
  // Each file's own advisories (an editability notice naming a duplicate key)
  // land before its validation, so a fatal outcome still carries them.
  const loaded = loadConfigChain(
    layers,
    DEFAULT_DSL_CONFIG,
    { entered: () => {}, warned: (w) => warnings.push(...w) },
    { projectDir: cwd, cwd },
  );
  const { config } = loaded;

  const store = new VariableStore();
  const registry = new SourceRegistry(
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
    bindView(
      compiled,
      store,
      registry,
      fixedSource(
        {
          ...checkPayload(config, effective, layers.at(-1) ?? null, at),
          today: CHECK_TODAY,
        },
        effective,
      ),
    );
    // [LAW:no-ambient-temporal-coupling] An async source's first run — a shell
    // or file read — completes after registration; the verdict renders what
    // the sources YIELDED, not their pre-scan fallbacks (a json document with
    // no default draws its loading cell until it is scanned). The registry owns
    // the "every run complete" state; a source still out at the deadline is
    // named and the render proceeds on what it holds.
    const pending = await registry.settled(settleMs);
    if (pending.length > 0) {
      warnings.push(
        `source${pending.length === 1 ? "" : "s"} still running after ${settleMs} ms, rendered with fallback values: ${pending.join(", ")}`,
      );
    }
    return {
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
export function renderEffective(
  { layers, config, compiled, store, registry }: PreparedConfig,
  effective: EffectiveGlobals,
  width: number,
  at: Instant,
): {
  rendered: string;
  failures: Map<string, string>;
  advisories: Set<string>;
} {
  // [LAW:types-are-the-program] Keyed by the failing thing's own LABEL, not
  // appended to a list — each can fail at most once per pass, so this is the
  // strongest true shape (dedupe-by-construction within one pass). The key
  // carries WHAT failed because two different domains report here — a
  // segment, or a globals slot whose rule the render could not honour — and
  // a bare name could not tell them apart
  // (nor stop a segment named `globals.palette` from displacing the slot).
  const failures = new Map<string, string>();
  // What the daemon shows on the bar as a warning and check lists beside its
  // verdict, without failing it: a fact about the look the config chose.
  const advisories = new Set<string>();
  // [LAW:types-are-the-program] Exhaustive over every kind a render can warn
  // of, so a new kind is a compile error here until check says what it means.
  const warned = (warning: RenderWarning): void => {
    switch (warning.kind) {
      // [LAW:no-silent-failure] A globals rule the render could not honour —
      // its template threw, or a palette rule named no installed theme — is a
      // real finding for a headless pass: the bar would render that slot's
      // floor with nobody watching the strip. Keyed by its slot so two failing
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
      // An open band the chosen look leaves short of a floor: the bar draws it
      // as near as it comes, and the message names what clears it.
      case "band-floor":
        advisories.add(warning.message);
        return;
      default:
        warning satisfies never;
    }
  };
  const rendered = renderDsl(
    config,
    compiled,
    store,
    registry,
    {
      ...checkPayload(config, effective, layers.at(-1) ?? null, at),
      today: CHECK_TODAY,
    },
    at,
    renderOptionsOf(effective, width),
    {
      onSegmentError: (placementId: string, message: string) =>
        failures.set(`segment "${placementId}"`, message),
      onRenderWarning: warned,
    },
    effective,
  );
  return { rendered, failures, advisories };
}

// The verdict: the prepared config rendered under every preset, every render
// error a failure. Returns the line a fresh session renders.
async function loadRegisterRender(
  layers: readonly string[],
  cwd: string,
  warnings: string[],
  settleMs: number,
): Promise<string> {
  // [LAW:effects-at-boundaries] One instant for every pass, so the passes
  // differ only in the preset they render.
  const at = instantOf(new Date());
  const prepared = await prepareConfig(layers, cwd, warnings, at, settleMs);
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
    const render = (preset: string, customized: boolean) => {
      const effective = resolveEffectiveGlobals(
        config,
        (key) => (key === "preset" ? preset : null),
        () => customized,
      );
      let pass: {
        rendered?: string;
        failures: Map<string, string>;
        advisories: ReadonlySet<string>;
      };
      try {
        pass = renderEffective(prepared, effective, CHECK_WIDTH, at);
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
    const primary = render(freshPreset, false);
    const outs = [
      primary,
      render(freshPreset, true),
      ...presetNames(config.presets)
        .filter((p) => p !== freshPreset)
        .flatMap((p) => [render(p, false), render(p, true)]),
    ];

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

// `--render` (brandon-check-m2a): the bar beneath the verdict line, for an
// author who cannot look at a live one. [LAW:one-source-of-truth] It is
// `o.rendered` — the very string the verdict's fresh-session pass reached —
// so the bar an author reads and the bar `check` blessed cannot differ; re-rendering here
// (at a terminal width, say) would be two clocks, and the audience this exists
// for reads a pipe, which has no width at all. The flag adds a VALUE to one
// stream rather than selecting a code path: runCheck's two writes are
// unconditional either way, and the arms that never rendered have no bar to
// print because `rendered` lives on the clean arm alone
// [LAW:types-are-the-program].
export function checkPlan(o: CheckOutcome, render = false): CliPlan {
  switch (o.kind) {
    case "clean": {
      const where =
        o.layers.join(" < ") || "bundled default (no config file found)";
      const count =
        o.warnings.length > 0
          ? ` (${o.warnings.length} warning${o.warnings.length === 1 ? "" : "s"})`
          : "";
      return {
        stdout:
          `✓ ${where}: config OK${count}\n` + (render ? `${o.rendered}\n` : ""),
        stderr: warningLines(o.warnings),
        code: EXIT_CLEAN,
      };
    }
    case "fatal":
      return {
        stdout: "",
        stderr:
          warningLines(o.warnings) +
          `✗ ${o.layers.join(" < ") || "<default>"}\n${o.message}\n`,
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
// `runCheck` used to inspect them inline and write+exit from the middle of
// itself, which put the usage contract out of reach of everything but a
// spawned process — the same reason `checkPlan` is a value: a misspelled
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
  // An empty string is not "no argument": `target: undefined` means "resolve
  // like the daemon", while `""` is a malformed target (the likeliest cause is
  // an unquoted or mis-expanded shell variable) that would otherwise EISDIR on
  // the cwd.
  if (paths.length > 1 || paths[0] === "") {
    return {
      kind: "usage",
      message: `check: expected at most one non-empty path\n${USAGE}`,
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
export async function runCheck(args: readonly string[]): Promise<never> {
  const parsed = parseCheckArgs(args);
  const plan: CliPlan =
    parsed.kind === "usage"
      ? { stdout: "", stderr: parsed.message, code: EXIT_USAGE }
      : checkPlan(
          await checkConfig(
            parsed.target ?? detectConfigEnv(process.env, process.cwd()),
          ),
          parsed.render,
        );
  process.stdout.write(plan.stdout);
  process.stderr.write(plan.stderr);
  process.exit(plan.code);
}
