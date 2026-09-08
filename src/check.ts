// [LAW:verifiable-goals] `cc-candybar check [path]` — the authoring agent's eyes: diagnostics that otherwise surface only VISUALLY, projected onto a text + exit-code contract (0 renders, 1 invalid, 2 usage or unreadable).
// [LAW:single-enforcer] No parallel validation path — the verdict runs the exact functions the daemon runs, so "check passes" and "the daemon renders" cannot diverge.

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

// [LAW:no-ambient-temporal-coupling] A fixed width keeps the verdict a function of the config alone, not of whichever terminal invoked the check.
const CHECK_WIDTH = 200;

// How long the verdict waits for a shell/file source's first run — generous against a slow `uptime`, short against a hung command.
const SOURCE_SETTLE_MS = 5000;

// [LAW:verifiable-goals] One faked hook event, deliberately RICH so gated segments actually RENDER: a minimal payload would let a field-name typo in a git/directory/metrics/budget branch slip through, since those branches run only when their data is present.
// [LAW:one-source-of-truth] `effective` is threaded in exactly as the daemon threads it. test/example-configs.test.ts asserts against these literal values, so changing one fails that suite loudly.
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
    // `ssh: true` for the same reason `tmux.session` is populated: the fixture satisfies every gate, so a when-gated segment RENDERS and its template gets checked.
    host: { name: "tester-box", user: "tester", ssh: true },
    theme: { effective: effective.theme },
    look: { effective: effective.look },
    // [LAW:one-source-of-truth] Without this, `.preset.effective` and `.preset.customized` fall back to their declared defaults rather than the resolved value.
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

// [LAW:dataflow-not-control-flow] The result is DATA: `checkConfig` carries the decision and `runCheck` only maps it to (streams, exit), so the contract is testable without spawning a process.
// `configPath` null means the bundled default was checked — the state in which the daemon renders that same default.
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

// [LAW:one-source-of-truth] The daemon's own resolver over (cwd, cwd), so this checks the file the daemon would load here; unchecked chain locations ride the SAME notice RenderCache renders.
function searchedFile(cwd: string, warnings: string[]): string | null {
  const resolution = resolveDslConfig(cwd, cwd);
  const notice = configResolutionNotice(resolution);
  if (notice !== null) warnings.push(notice);
  return resolution.kind === "file" ? resolution.path : null;
}

// Run the daemon's load-and-render pipeline against one config target. The CLI's own `$CC_CANDYBAR_CONFIG` enters as the target, the way the statusline client sends it as a hint.
// [LAW:no-silent-failure] An explicit target must exist and be readable — a missing file is `unreadable`, never a fall-through to the bundled default, because a verdict command must not report "clean" about a file it never read.
export async function checkConfig(
  target: string | undefined,
  cwd: string = process.cwd(),
): Promise<CheckOutcome> {
  // Advisories accumulate from the search onward, independent of load success.
  const warnings: string[] = [];

  // [LAW:one-source-of-truth] No pre-read: the ONE content read is the readFileSync inside loadConfig, and the catch below classifies its errno as `unreadable`.
  // The statSync is a metadata probe, not a second read: a directory target fails read() with a path-less EISDIR the catch could not attribute.
  const configPath =
    target !== undefined
      ? path.resolve(expandHome(target))
      : searchedFile(cwd, warnings);
  if (target !== undefined && configPath !== null) {
    // throwIfNoEntry suppresses only ENOENT; EACCES/EPERM on the probe is equally "could not read the named file".
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

  // [LAW:dataflow-not-control-flow] Collision detection runs independent of load success: a shadowed .json sibling is worth knowing even when the .json5 fails to parse.
  const collision = detectConfigCollisions(cwd, cwd);
  if (collision !== null) warnings.push(collision);

  try {
    const rendered = await loadRegisterRender(configPath, cwd, warnings);
    return { kind: "clean", configPath, warnings, rendered };
  } catch (e) {
    // [LAW:no-silent-failure] An fs error on the config file itself (the errno's `.path` is the discriminator) is `unreadable` — the file could not be read at all, distinct from one that read but is invalid, and never a fall-through to the default.
    // Duck-typed rather than `instanceof Error`: fs errors can cross a realm boundary (jest/graceful-fs), where instanceof lies.
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
    // The same classification RenderCache.reloadInto applies: ConfigError and register/render throws are all author-facing diagnostics, so check surfaces each as fatal text.
    const message =
      e instanceof ConfigError
        ? e.message
        : e instanceof Error
          ? e.message
          : String(e);
    return { kind: "fatal", configPath, message, warnings };
  }
}

// [LAW:single-enforcer] Every call below is the function the daemon calls, in the daemon's order; the register pass's advisory `loadWarnings` join the same channel RenderCache merges them into.
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
    // Registered before the validator pass so a derive throw still carries the partial-load warnings into the fatal outcome.
    warnings.push(...compiled.loadWarnings);
    // [LAW:no-ambient-temporal-coupling] The verdict renders what the sources YIELDED, not their pre-scan fallbacks; a source still out at the deadline is named and the render proceeds.
    const pending = await registry.settled(SOURCE_SETTLE_MS);
    if (pending.length > 0) {
      warnings.push(
        `source${pending.length === 1 ? "" : "s"} still running after ${SOURCE_SETTLE_MS} ms, rendered with fallback values: ${pending.join(", ")}`,
      );
    }
    // Derivation only; the daemon additionally registers the results in its global validator registry, which a one-shot check has no wire to serve.
    deriveActionValidators(config);

    // [LAW:one-source-of-truth] The preset resolves first and its globals feed every field below, the SAME order the daemon resolves in, so check renders the arrangement a fresh session opens in.
    const effective: EffectiveGlobals = resolveEffectiveGlobals(
      config,
      // A fresh session: the resolution is THE daemon's, not a copy that agrees with it today.
      () => null,
      // [LAW:no-silent-failure] check renders the file as the bundled default's peer, never as a customization OF it, so `.preset.customized` is false for this returned render; the pass below exercises `true`.
      () => false,
    );
    // [LAW:no-silent-failure] A throwing template renders as a visible ⚠ cell — a channel the blind authoring agent never sees, so check collects the same errors through the render's observer seam and fails the verdict.
    const renderOnce = (
      payloadEffective: EffectiveGlobals,
    ): { rendered: string; segmentErrors: Map<string, string> } => {
      // [LAW:types-are-the-program] Keyed by segment NAME: a segment errors at most once per pass, which makes deduping ACROSS the two passes a key check rather than a message comparison.
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
    // [LAW:verifiable-goals] `.preset.customized` is the ONE gate a rich fixture can never drive true on its own: it is a daemon-resolved FACT about session state, not a payload field, so without this pass broken content behind that gate would check clean.
    // Second pass only — the RETURNED rendering stays the realistic fresh-session default.
    const customizedCheck = renderOnce({
      ...effective,
      presetCustomized: true,
    });

    // [LAW:no-silent-failure] An unconditional segment error fires identically in both passes, which share config/store/registry and differ only in `presetCustomized`.
    // Deduped by segment NAME: reporting it twice would double-count one bug, and the "(under .preset.customized = true)" tag would misdirect the reader.
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
    // [LAW:single-enforcer] The registry owns every async handle the config declared; a one-shot check must not leak them past the verdict.
    registry.dispose();
  }
}

const EXIT_CLEAN = 0;
const EXIT_FATAL = 1;
const EXIT_USAGE = 2;

// [LAW:dataflow-not-control-flow] The outcome → (streams, exit-code) mapping is DATA. Verdict on stdout, every diagnostic on stderr, so a pipeline gets a parseable verdict while a human still sees the advisories.
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

// Extra arguments and an empty path are usage errors: `checkConfig(undefined)` means "resolve like the daemon", while `""` is a malformed target that would otherwise EISDIR on the cwd.
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
