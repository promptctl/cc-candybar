// The doctor's edge: where the facts are GATHERED and a fix is PERFORMED.
//
// [LAW:effects-at-boundaries] Every effect the doctor has — the tmux query,
// the config load, the settings.json read, the settings.json write — lives in
// this module. The tmux query and the config load sit behind the `DoctorEdge`
// record the daemon and the CLI both construct with `productionEdge()` and a
// test fakes; the settings file is the one the session's client hints name,
// so a test points it with a hint.
// checks.ts never sees an effect; this file never decides a verdict.

import fs from "node:fs";
import path from "node:path";
import {
  claudeConfigDir,
  claudeSettingsPath,
  isJsonObject,
  readClaudeSettings,
  readClaudeSettingsText,
} from "../claude-settings.js";
import { JSON_DIALECT, setValue } from "../config/json5-edit.js";
import { writeAtomic } from "../utils/atomic-write.js";
import type { ClientHints } from "../daemon/protocol.js";
import { runTmux } from "../proc/tmux.js";
import type { TmuxHint } from "../tmux-hint.js";
import type { UnusedDecl } from "../config/unused.js";
import type { LoopName } from "@promptctl/rich-js";
import {
  EFFECT_SETTING,
  placementId,
  placementSetting,
  settingsOf,
  walkNodes,
  type DslConfig,
} from "../config/dsl-types.js";
import { presetRoot } from "../config/presets.js";
import { EFFECT_FLOOR, FOLLOW_BAR } from "../themes/policy.js";
import { resolveEffectiveGlobals } from "../daemon/render-payload.js";
import type {
  ConfigFacts,
  DoctorFacts,
  Fix,
  PlacementEffectFact,
  TermFeatures,
  TmuxFacts,
  UrlHandlerFacts,
} from "./checks.js";
import { PACKAGE_VERSION } from "../version.js";

export interface DoctorEdge {
  // tmux's own verdict on the attached client's terminal, asked of THE server
  // the hint names — `-S socket` and `-t pane` are why the hint carries them.
  readonly probeTmux: (hint: TmuxHint) => TermFeatures;
  // What loading the config at an origin finds now — the daemon reloads the
  // render-cache entry the session's bar is drawn from and answers from it
  // (so the doctor and the bar's strip report one load), the CLI runs one
  // load of its own. Both are the one `loadFromDisk`.
  readonly loadConfig: (origin: ConfigOrigin) => ConfigLoad;
}

// The three inputs the config search takes (resolveDslConfig) — a session's
// recorded render origin, or the CLI's own cwd and `$CC_CANDYBAR_CONFIG`.
export interface ConfigOrigin {
  readonly projectDir: string;
  readonly cwd: string;
  readonly configFile: string | null;
}

// One load's outcome, as both a cache entry and a fresh load carry it: the
// file it resolved, the error that stopped it, the advisories it earned (one
// per line), and — for the config last loaded — what its file left unused.
// `config` is the config the bar draws from: the one loaded, else what the
// bar falls back to under the error.
export interface ConfigLoad {
  readonly layers: readonly string[];
  readonly error: string | null;
  readonly warning: string | null;
  readonly unused: readonly UnusedDecl[];
  readonly config: DslConfig;
}

// `#{client_termfeatures}` lists terminal-features + overrides + terminfo for
// the client attached to the pane — `RGB` in it is tmux saying both it and the
// outer terminal do truecolor (verified on tmux 3.6a: `…,osc7,RGB,sixel,…`).
function probeTmux(hint: TmuxHint): TermFeatures {
  const run = runTmux(hint, "doctor.tmux", [
    "display",
    "-p",
    "-t",
    hint.pane,
    "#{client_termfeatures}",
  ]);
  if (run.kind !== "ok") return { kind: "failed", reason: run.reason };
  return {
    kind: "ok",
    value: run.stdout
      .trim()
      .split(",")
      .filter((f) => f !== ""),
  };
}

export function productionEdge(
  loadConfig: DoctorEdge["loadConfig"],
): DoctorEdge {
  return { probeTmux, loadConfig };
}

// [LAW:dataflow-not-control-flow] The load's two arms become ConfigFacts'
// two.
function configFacts(load: ConfigLoad): ConfigFacts {
  const base = {
    layers: load.layers,
    warnings: load.warning === null ? [] : load.warning.split("\n"),
  };
  return load.error !== null
    ? { ...base, kind: "failed", error: load.error }
    : {
        ...base,
        kind: "loaded",
        unused: load.unused,
      };
}

// [LAW:no-silent-failure] The one reading of the settings document
// (readClaudeSettings: missing or blank is empty, anything unparseable throws
// naming the file — never read as empty, because the fix would then splice
// into a file it cannot parse either), and its `env` held to the same rule.
// `statusLine` is parsed into its own three arms instead (StatusLineFacts).
function readClaudeSettingsFacts(
  settingsPath: string,
): DoctorFacts["claudeSettings"] {
  const { env, statusLine } = readClaudeSettings(settingsPath);
  if (env !== undefined && !isJsonObject(env)) {
    throw new Error(`cannot read ${settingsPath}: \`env\` is not an object`);
  }
  return {
    path: settingsPath,
    env: env ?? {},
    statusLine:
      statusLine === undefined
        ? { kind: "absent" }
        : isJsonObject(statusLine)
          ? { kind: "present", refreshInterval: statusLine.refreshInterval }
          : { kind: "not-an-object", value: statusLine },
  };
}

// [LAW:dataflow-not-control-flow] The three wire states of the recorded hint
// become the three arms of TmuxFacts — a total projection, and the ONLY place
// the tmux query runs: once, exactly when there is a server to ask.
function tmuxFacts(edge: DoctorEdge, hint: ClientHints["tmux"]): TmuxFacts {
  if (hint === undefined) return { kind: "unreported" };
  if (hint === null) return { kind: "outside" };
  return { kind: "inside", hint, termfeatures: edge.probeTmux(hint) };
}

// A click the daemon is handling IS a link that came back through the URL
// handler, carrying the version of the handler that delivered it.
export function clickArrived(handler: string | null): UrlHandlerFacts {
  return { kind: "arrived", handler, bar: PACKAGE_VERSION };
}

// Each placement of `preset`'s tree wearing a moving effect of its own, read
// as the render reads it (placementSetting) — the session's unsaved pick over
// the file's value. A name label holds its placement's draft slot and wears
// what it wears, so it reports under that placement, once.
function placementEffects(
  config: DslConfig,
  preset: string,
  sessionPick: (key: string) => string | null,
): PlacementEffectFact[] {
  const moving = new Map<string, LoopName>();
  for (const node of walkNodes(presetRoot(config, preset).node)) {
    if (node.kind !== "segment") continue;
    // [LAW:no-defensive-null-guards] cross-ref proved every placed segment is
    // declared, and settingsOf declares `effect` for every one.
    const decl = settingsOf(config.segments[node.name]!)[EFFECT_SETTING]!;
    const effect = placementSetting(node, EFFECT_SETTING, decl, (draft) =>
      sessionPick(draft.key),
    );
    if (effect === FOLLOW_BAR || effect === EFFECT_FLOOR) continue;
    // The setting's domain is the placement effects, so what is left is a loop.
    moving.set(
      node.drafts?.[EFFECT_SETTING]?.id ?? placementId(node),
      effect as LoopName,
    );
  }
  return [...moving].map(([placement, effect]) => ({ placement, effect }));
}

// [LAW:single-enforcer] Every fact comes from what the CLIENT saw: its tmux,
// the Claude Code directory its session runs with, and the origin its config
// resolves from — never the daemon's own env, which answers for whichever
// session spawned it. The URL handler's facts are not gathered here: the
// daemon has them in the click it is handling, the CLI has to send a link and
// wait (src/doctor/handler-probe.ts), and each adds them to these.
//
// `sessionPick` reads the session's own picks — the daemon's SessionState for
// the clicking session, `() => null` for the CLI, which has no session.
export function gatherFacts(
  edge: DoctorEdge,
  hints: Pick<ClientHints, "tmux" | "claudeConfigDir">,
  origin: ConfigOrigin,
  sessionPick: (key: string) => string | null,
): Omit<DoctorFacts, "urlHandler"> {
  const load = edge.loadConfig(origin);
  // [LAW:one-source-of-truth] The render's own resolution, so the doctor and
  // the bar cannot disagree about which effect is on. The preset's
  // customization is a fact no field read here depends on.
  const globals = resolveEffectiveGlobals(
    load.config,
    sessionPick,
    () => false,
  );
  return {
    tmux: tmuxFacts(edge, hints.tmux),
    config: configFacts(load),
    effect: globals.effect,
    placementEffects: placementEffects(
      load.config,
      globals.preset,
      sessionPick,
    ),
    transitions: globals.transitions,
    claudeSettings: readClaudeSettingsFacts(
      claudeSettingsPath(claudeConfigDir(hints.claudeConfigDir)),
    ),
  };
}

// [LAW:one-source-of-truth] The fix is a SPLICE, not a rewrite: the same
// span-tracking editor the cc-candybar config uses (JSON ⊂ JSON5) replaces one
// value span or appends one entry, creating the parent object only when
// absent, and every other byte of the user's file survives — comments,
// ordering, indentation.
// In the JSON dialect: Claude Code parses settings.json strictly, so a bare
// key or a trailing comma here would break every Claude Code launch.
//
// Returns the facts with the one this fix changed re-read — the performer of
// an effect is the one place that knows what it touched, so a post-fix report
// cannot reuse a stale fact or re-probe an unchanged one.
export function applyFix(fix: Fix, facts: DoctorFacts): DoctorFacts {
  const settingsPath = facts.claudeSettings.path;
  switch (fix.kind) {
    case "claude-settings": {
      const text = readClaudeSettingsText(settingsPath);
      const next = setValue(
        text,
        fix.path,
        JSON.stringify(fix.value),
        JSON_DIALECT,
      );
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      writeAtomic(settingsPath, next);
      return {
        ...facts,
        claudeSettings: readClaudeSettingsFacts(settingsPath),
      };
    }
    default: {
      const _exhaustive: never = fix.kind;
      return _exhaustive;
    }
  }
}
