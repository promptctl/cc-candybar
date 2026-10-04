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
  readClaudeSettings,
  readClaudeSettingsText,
} from "../claude-settings.js";
import { JSON_DIALECT, setValue } from "../config/json5-edit.js";
import { writeAtomic } from "../utils/atomic-write.js";
import type { ClientHints } from "../daemon/protocol.js";
import { runTmux } from "../proc/tmux.js";
import type { TmuxHint } from "../tmux-hint.js";
import { shadowedConfigs } from "../config/dsl-loader.js";
import type { UnusedDecl } from "../config/unused.js";
import type {
  ConfigFacts,
  DoctorFacts,
  Fix,
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
export interface ConfigLoad {
  readonly path: string | null;
  readonly error: string | null;
  readonly warning: string | null;
  readonly unused: readonly UnusedDecl[];
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
// two; the files behind the loaded one are a fact of the same origin, read
// through the search's own enumerator.
function configFacts(edge: DoctorEdge, origin: ConfigOrigin): ConfigFacts {
  const load = edge.loadConfig(origin);
  const base = {
    path: load.path,
    warnings: load.warning === null ? [] : load.warning.split("\n"),
  };
  return load.error !== null
    ? { ...base, kind: "failed", error: load.error }
    : {
        ...base,
        kind: "loaded",
        shadowed: shadowedConfigs(
          origin.projectDir,
          origin.cwd,
          origin.configFile ?? undefined,
        ),
        unused: load.unused,
      };
}

// [LAW:no-silent-failure] The one reading of the settings document
// (readClaudeSettings: missing or blank is empty, anything unparseable throws
// naming the file — never read as empty, because the fix would then splice
// into a file it cannot parse either), and its `env` held to the same rule.
function readClaudeSettingsEnv(
  settingsPath: string,
): DoctorFacts["claudeSettings"] {
  const env = readClaudeSettings(settingsPath).env;
  if (env === undefined) return { path: settingsPath, env: {} };
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new Error(`cannot read ${settingsPath}: \`env\` is not an object`);
  }
  return { path: settingsPath, env: env as Record<string, unknown> };
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

// [LAW:single-enforcer] Every fact comes from what the CLIENT saw: its tmux,
// the Claude Code directory its session runs with, and the origin its config
// resolves from — never the daemon's own env, which answers for whichever
// session spawned it. The URL handler's facts are the caller's: the daemon
// has them in the click it is handling, the CLI has to send a link and wait
// (src/doctor/handler-probe.ts).
export function gatherFacts(
  edge: DoctorEdge,
  hints: Pick<ClientHints, "tmux" | "claudeConfigDir">,
  origin: ConfigOrigin,
  urlHandler: UrlHandlerFacts,
): DoctorFacts {
  return {
    tmux: tmuxFacts(edge, hints.tmux),
    config: configFacts(edge, origin),
    urlHandler,
    claudeSettings: readClaudeSettingsEnv(
      claudeSettingsPath(claudeConfigDir(hints.claudeConfigDir)),
    ),
  };
}

// [LAW:one-source-of-truth] The fix is a SPLICE, not a rewrite: the same
// span-tracking editor the cc-candybar config uses (JSON ⊂ JSON5) replaces one
// value span or appends one entry, creating `env` only when absent, and every
// other byte of the user's file survives — comments, ordering, indentation.
// In the JSON dialect: Claude Code parses settings.json strictly, so a bare
// key or a trailing comma here would break every Claude Code launch.
//
// Returns the facts with the one this fix changed re-read — the performer of
// an effect is the one place that knows what it touched, so a post-fix report
// cannot reuse a stale fact or re-probe an unchanged one.
export function applyFix(fix: Fix, facts: DoctorFacts): DoctorFacts {
  const settingsPath = facts.claudeSettings.path;
  switch (fix.kind) {
    case "claude-settings-env": {
      const text = readClaudeSettingsText(settingsPath);
      const next = setValue(
        text,
        ["env", fix.name],
        JSON.stringify(fix.value),
        JSON_DIALECT,
      );
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      writeAtomic(settingsPath, next);
      return { ...facts, claudeSettings: readClaudeSettingsEnv(settingsPath) };
    }
    default: {
      const _exhaustive: never = fix.kind;
      return _exhaustive;
    }
  }
}
