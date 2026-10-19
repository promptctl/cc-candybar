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
import { launchSync } from "../proc/launch.js";
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
import {
  type Asked,
  type ClientFact,
  type InstallFacts,
  type ConfigFacts,
  type DoctorFacts,
  type Fix,
  type FontInUse,
  type PlacementEffectFact,
  type TerminalFacts,
  type TerminalIdentity,
  type TmuxClient,
  type TmuxFacts,
  type UrlHandlerFacts,
} from "./checks.js";
import { PACKAGE_VERSION } from "../version.js";
import type { TerminalEnvHint } from "../terminal-hint.js";
import {
  identifyFromEnv,
  identifyInTmux,
  isBundling,
  isConfigured,
  type ConfiguredTerminal,
} from "./terminal.js";
import { fontInUse } from "./font-edge.js";
import { privateGlyphsIn, stripPrivateGlyphs } from "../render/strip.js";
import { DoctorBusy } from "./busy.js";
import type { ClientSighting } from "../daemon/client-sightings.js";
import { sourceCheckoutOf } from "../daemon/build-currency.js";
import { sourceDigest } from "../source-digest.js";
import { shipsNative } from "../install/platforms.js";
import { fileMarkBook, type MarkBookStore } from "./mark-book.js";
import {
  fileClickedTerminals,
  type ClickedTerminalsStore,
} from "./clicked-terminals.js";

// [LAW:effects-at-boundaries] The install check's reads of the machine: a
// path resolved through every link, the checkout a bundle was built in, a
// directory's source digest, and whether a native client ships here.
export interface InstallEdge {
  readonly realpath: (p: string) => Asked<string>;
  readonly checkoutOf: (bundle: string) => string | null;
  readonly digest: (dir: string) => Asked<string>;
  readonly nativeShipped: boolean;
}

// Every fs read here throws its own errno text; the facts carry it instead.
function asked<T>(read: () => T): Asked<T> {
  try {
    return { kind: "ok", value: read() };
  } catch (e) {
    return {
      kind: "failed",
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

export const productionInstallEdge: InstallEdge = {
  realpath: (p) => asked(() => fs.realpathSync(p)),
  checkoutOf: sourceCheckoutOf,
  digest: (dir) => asked(() => sourceDigest(dir)),
  nativeShipped: shipsNative(process.platform, process.arch),
};

// [LAW:one-source-of-truth] One fold from (the daemon's bundle, the clients
// seen) to the facts, for both surfaces: the click passes its own render's
// client, the CLI every session's latest from daemon-stats. Both bundles are
// resolved through every link here, so `bin/../dist/index.mjs` and a symlinked
// checkout name the file they are.
export function installFacts(
  edge: InstallEdge,
  daemonBundle: string,
  sightings: readonly ClientSighting[],
): InstallFacts {
  const bundle = edge.realpath(daemonBundle);
  if (bundle.kind === "failed") {
    return {
      kind: "failed",
      reason: `the daemon's bundle ${daemonBundle} cannot be resolved: ${bundle.reason}`,
    };
  }
  const root = edge.checkoutOf(bundle.value);
  return {
    kind: "ok",
    value: {
      daemon: {
        bundle: bundle.value,
        checkout:
          root === null
            ? null
            : {
                root,
                rustSource: edge.digest(path.join(root, "rust-client", "src")),
              },
      },
      nativeShipped: edge.nativeShipped,
      clients: sightings.map(
        ({ client, ago }): ClientFact =>
          client === null
            ? { kind: "unreported", ago }
            : {
                kind: "reported",
                client: client.kind,
                bundle: edge.realpath(client.bundle),
                source: client.source,
                ago,
              },
      ),
    },
  };
}

export interface DoctorEdge {
  // tmux's own word on the attached client's terminal, asked of THE server
  // the hint names — `-S socket` and `-t pane` are why the hint carries them.
  readonly probeTmux: (hint: TmuxHint) => Asked<TmuxClient | null>;
  // The marks the user has made on what the doctor showed them, kept for
  // good (src/doctor/mark-book.ts).
  readonly marks: MarkBookStore;
  // The terminals a doctor click has come back from, kept for good
  // (src/doctor/clicked-terminals.ts).
  readonly clicked: ClickedTerminalsStore;
  // Whether a process came in through a remote login (sshd, mosh-server) —
  // asked of the tmux client attached to the session's pane.
  readonly remoteLogin: (pid: number) => Asked<boolean>;
  // The font a configured terminal draws the bar's glyphs with, read where
  // the terminal reads it (src/doctor/font-edge.ts).
  readonly fontInUse: (
    terminal: {
      readonly name: ConfiguredTerminal;
      readonly version: string | null;
    },
    env: TerminalEnvHint,
    glyphs: string,
  ) => Asked<FontInUse>;
  // What loading the config at an origin finds now — the daemon reloads the
  // render-cache entry the session's bar is drawn from and answers from it
  // (so the doctor and the bar's strip report one load), the CLI runs one
  // load of its own. Both are the one `loadFromDisk`.
  readonly loadConfig: (origin: ConfigOrigin) => ConfigLoad;
  readonly install: InstallEdge;
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
// `#{client_termtype}` is that terminal's XTVERSION reply (`iTerm2 3.7.2`,
// empty from one that does not answer), `#{client_termname}` the TERM it
// was started under, `#{client_pid}` the client's process, and
// `#{client_utf8}` whether tmux writes UTF-8 to it (`1`/`0`). One display
// call, the five tab-separated.
const TMUX_CLIENT_FORMAT =
  "#{client_termfeatures}\t#{client_termtype}\t#{client_termname}\t#{client_pid}\t#{client_utf8}";

// [LAW:parse-dont-validate] tmux's answer, read as the five fields it was
// asked for. Every field is empty when no client is attached to the pane's
// session — an answer, `null`, not a failure; any other line that is not five
// fields with a pid and a 0/1 is a failure naming what came back. The client
// is the one attached to the PANE's session, whatever TMUX_PANE the asker
// carries (measured on tmux 3.6a; the empty line on 3.7b too).
export function parseTmuxClient(stdout: string): Asked<TmuxClient | null> {
  const line = stdout.replace(/\n$/, "");
  if (line === "\t\t\t\t") return { kind: "ok", value: null };
  const fields = line.split("\t");
  const [features, termtype, termname, pid, utf8] = fields;
  if (
    fields.length !== 5 ||
    !/^[1-9]\d*$/.test(pid!) ||
    !/^[01]$/.test(utf8!)
  ) {
    return {
      kind: "failed",
      reason: `tmux answered ${JSON.stringify(stdout)}, not the five fields asked for`,
    };
  }
  return {
    kind: "ok",
    value: {
      features: features!.split(",").filter((f) => f !== ""),
      termtype: termtype!,
      termname: termname!,
      pid: Number(pid),
      utf8: utf8 === "1",
    },
  };
}

// The servers a remote login runs its session under: OpenSSH's `sshd` (and
// the `sshd-session` it hands each login to since 9.8) and mosh's
// `mosh-server`.
const REMOTE_LOGIN = /^(sshd|mosh-server)\b/;

// [LAW:effects-at-boundaries] Pure over `ps -A -o pid=,ppid=,comm=`: whether
// `pid` or any process it descends from is a remote login server. A pid the
// table does not hold is a failure, never "local".
export function descendsFromRemoteLogin(
  table: string,
  pid: number,
): Asked<boolean> {
  const procs = new Map<number, { ppid: number; name: string }>();
  for (const line of table.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m === null) continue;
    const command = m[3]!.trim();
    procs.set(Number(m[1]), {
      ppid: Number(m[2]),
      name: command.slice(command.lastIndexOf("/") + 1),
    });
  }
  if (!procs.has(pid)) {
    return { kind: "failed", reason: `process ${pid} is not running` };
  }
  const seen = new Set<number>();
  for (let p = procs.get(pid); p !== undefined; p = procs.get(p.ppid)) {
    if (REMOTE_LOGIN.test(p.name)) return { kind: "ok", value: true };
    if (seen.has(p.ppid)) break;
    seen.add(p.ppid);
  }
  return { kind: "ok", value: false };
}

function remoteLogin(pid: number): Asked<boolean> {
  const run = launchSync({
    bin: "ps",
    args: ["-A", "-o", "pid=,ppid=,comm="],
    timeoutMs: 2000,
    category: "doctor.process",
  });
  if (!run.ok) {
    if (run.reason === "rate-limited") throw new DoctorBusy("the processes");
    const detail = run.error ?? `${run.reason}: ${run.stderr.trim()}`;
    return { kind: "failed", reason: `ps failed (${detail})` };
  }
  return descendsFromRemoteLogin(run.stdout, pid);
}

function probeTmux(hint: TmuxHint): Asked<TmuxClient | null> {
  const run = runTmux(hint, "doctor.tmux", [
    "display",
    "-p",
    "-t",
    hint.pane,
    TMUX_CLIENT_FORMAT,
  ]);
  if (run.kind === "rate-limited") throw new DoctorBusy("tmux");
  if (run.kind === "failed") return { kind: "failed", reason: run.reason };
  return parseTmuxClient(run.stdout);
}

export function productionEdge(
  loadConfig: DoctorEdge["loadConfig"],
): DoctorEdge {
  return {
    probeTmux,
    remoteLogin,
    fontInUse,
    loadConfig,
    marks: fileMarkBook(),
    clicked: fileClickedTerminals(),
    install: productionInstallEdge,
  };
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
  return { kind: "inside", hint, client: edge.probeTmux(hint) };
}

// [LAW:dataflow-not-control-flow] Which terminal draws the bar: inside tmux
// the client tmux has attached (its answer, or why it gave none), outside it
// what the session's client environment says.
function terminalIdentity(
  tmux: TmuxFacts,
  env: TerminalEnvHint | undefined,
): TerminalIdentity {
  switch (tmux.kind) {
    case "unreported":
      return { kind: "unreported" };
    case "outside":
      return env === undefined
        ? { kind: "unreported" }
        : { kind: "seen", identified: identifyFromEnv(env), tmuxClient: null };
    case "inside": {
      if (tmux.client.kind === "failed") {
        return { kind: "unasked", reason: tmux.client.reason };
      }
      const client = tmux.client.value;
      return client === null
        ? {
            kind: "unasked",
            reason: "tmux has no client attached to the pane's session",
          }
        : {
            kind: "seen",
            identified: identifyInTmux(client),
            tmuxClient: client,
          };
    }
  }
}

// How the terminal drawing the bar gets its glyphs — and for one that draws
// only from its font, that font, read once, exactly when there is one to read.
function terminalFacts(
  edge: DoctorEdge,
  identity: TerminalIdentity,
  hints: Pick<ClientHints, "terminalEnv" | "ssh">,
  glyphs: string,
): TerminalFacts {
  if (identity.kind !== "seen") return identity;
  const { identified, tmuxClient: client } = identity;
  const env = hints.terminalEnv;
  if (identified.kind !== "known") return identified;
  const { name, version } = identified.terminal;
  if (isBundling(name)) return { kind: "bundling", name, version };
  if (!isConfigured(name)) return { kind: "unread", name, version };
  // Inside tmux the session's environment is the one the tmux server was
  // started in, so what it says of the terminal — its iTerm2 profile, whether
  // it came over ssh — is that first window's, not the attached one's: the
  // reader is handed no profile (and reads every one), and whether the
  // terminal is remote is asked of the attached client's own process.
  const { ITERM_PROFILE: startedIn, ...unattached } = env ?? {};
  const remote: Asked<boolean> =
    client === null
      ? { kind: "ok", value: hints.ssh === true }
      : edge.remoteLogin(client.pid);
  return {
    kind: "configured",
    name,
    version,
    // A remote terminal runs on the machine the login came from, so no font
    // on this one says what it draws with.
    font:
      remote.kind === "failed"
        ? {
            kind: "failed",
            reason: `whether the terminal is remote could not be asked: ${remote.reason}`,
          }
        : remote.value
          ? {
              kind: "failed",
              reason:
                "the terminal is on the far side of a remote login, so its font is on the machine it runs on",
            }
          : edge.fontInUse(
              { name, version },
              client === null ? (env ?? {}) : unattached,
              glyphs,
            ),
  };
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
// wait (src/doctor/handler-probe.ts), and each adds them to these — and what
// asked for the run, which only the caller knows.
//
// `sessionPick` reads the session's own picks — the daemon's SessionState for
// the clicking session, `() => null` for the CLI, which has no session.
export function gatherFacts(
  edge: DoctorEdge,
  hints: Pick<
    ClientHints,
    "tmux" | "claudeConfigDir" | "terminalEnv" | "ssh" | "termCols"
  >,
  origin: ConfigOrigin,
  sessionPick: (key: string) => string | null,
): Omit<DoctorFacts, "urlHandler" | "askedBy" | "install"> {
  const load = edge.loadConfig(origin);
  // [LAW:one-source-of-truth] The render's own resolution, so the doctor and
  // the bar cannot disagree about which effect is on, or which joiner draws
  // it. The preset's customization is a fact no field read here depends on.
  const globals = resolveEffectiveGlobals(
    load.config,
    sessionPick,
    () => false,
  );
  const tmux = tmuxFacts(edge, hints.tmux);
  const terminal = terminalIdentity(tmux, hints.terminalEnv);
  // The joiner's glyphs, then every one the config's own text writes — a
  // Nerd icon in a template or a menu glyph is drawn as surely as a cap.
  const glyphs = [
    ...new Set([
      ...stripPrivateGlyphs(globals),
      ...privateGlyphsIn(JSON.stringify(load.config)),
    ]),
  ].join("");
  return {
    tmux,
    termCols: hints.termCols ?? null,
    terminal,
    // [LAW:types-are-the-program] The measured glyphs parsed into the facts'
    // union: none to draw is the arm with no terminal to read.
    nerdFont:
      glyphs === ""
        ? { kind: "none" }
        : {
            kind: "glyphs",
            glyphs,
            terminal: terminalFacts(edge, terminal, hints, glyphs),
          },
    marks: edge.marks.read(),
    clicked: edge.clicked.read(),
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
