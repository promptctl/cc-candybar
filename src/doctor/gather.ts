// The doctor's gather and its fix: the facts a run judges, read over the
// edge it is handed, and the one change a fix makes. Shared, so the
// renderer's doctor verbs gather in the renderer over the host's reads of the
// machine, and `cc-candybar doctor` over its own (src/doctor/edge.ts).
//
// [LAW:effects-at-boundaries] What the gather asks of the machine goes
// through the edge; the settings files a session's client hints name, and
// the doctor's stores, it reads itself.

import {
  claudeConfigDir,
  claudeSettingsPath,
  type SettingsChainAt,
} from "../claude-settings.js";
import {
  readClaudeSettingsText,
  readSettingsChain,
} from "../claude-settings-read.js";
import { JSON_DIALECT, setValue } from "../config/json5-edit.js";
import { writeAtomic } from "../utils/atomic-write.js";
import type { ClientHints } from "../daemon/foundations/protocol.js";
import { dataNeeds, type DataNeeds } from "./data-needs.js";
import type {
  RateLimitsSeen,
  TranscriptSaid,
} from "../daemon/foundations/sightings.js";
import { resolveEffectiveGlobals } from "../config/effective-globals.js";
import type {
  Asked,
  Width,
  ConfigFacts,
  DoctorFacts,
  Fix,
  DataNeed,
  SegmentDataFacts,
  SettingsChain,
  TerminalFacts,
  TerminalIdentity,
  TranscriptRead,
  TmuxFacts,
} from "./checks.js";
import type { TerminalEnvHint } from "../terminal-hint.js";
import {
  identifyFromEnv,
  identifyInTmux,
  isBundling,
  isConfigured,
} from "./terminal.js";
import { privateGlyphsIn, stripPrivateGlyphs } from "../render/strip.js";
import type { ConfigTarget, RenderOrigin } from "../config-hint.js";
import {
  laterIdentity,
  type ServingDaemon,
} from "../daemon/foundations/memory-limit.js";
import type { SightedBar, SightingScope } from "./sightings.js";
import type { StoresRead } from "../daemon/foundations/stats-snapshot.js";
import type { DoctorStores, DoctorEdge, ConfigLoad } from "./ports.js";
import { seen } from "./busy.js";

// Every fs read here throws its own errno text; the facts carry it instead.
export function asked<T>(read: () => T): Asked<T> {
  try {
    return { kind: "ok", value: read() };
  } catch (e) {
    return {
      kind: "failed",
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

export const readStores = (stores: DoctorStores): StoresRead => ({
  marks: stores.marks.read(),
  clicked: stores.clicked.read(),
  postMortemsRead: stores.postMortemsRead.read(),
});

// [LAW:no-ambient-temporal-coupling] An edge that answers each rate-limited
// question once: a click that gathers again for a new config is one click, and
// its second gather would otherwise fall inside the limiter's window for
// questions that config does not change. What it does change (a font asked
// about other glyphs) is a new question, and the limiter's to refuse.
export function oneAskPerClick(edge: DoctorEdge): DoctorEdge {
  const asked = new Map<string, Promise<unknown>>();
  const once = <T>(question: unknown, ask: () => Promise<T>): Promise<T> => {
    const key = JSON.stringify(question);
    const answer = asked.get(key) ?? ask();
    asked.set(key, answer);
    return answer as Promise<T>;
  };
  return {
    ...edge,
    probeTmux: (hint) => once(["tmux", hint], () => edge.probeTmux(hint)),
    remoteLogin: (pid) => once(["remote", pid], () => edge.remoteLogin(pid)),
    fontInUse: (terminal, env, glyphs) =>
      once(["font", terminal, env, glyphs], () =>
        edge.fontInUse(terminal, env, glyphs),
      ),
  };
}

// Each distinct transcript the renders named, read once: a statusline and a
// `frames` display drawing one session name one file. A render that saw an
// answer answers for the file.
async function transcriptReads(
  edge: DoctorEdge,
  said: Asked<readonly TranscriptSaid[]>,
): Promise<Asked<readonly TranscriptRead[]>> {
  if (said.kind === "failed") return said;
  const byPath = new Map<string, boolean>();
  for (const { path: file, answered } of said.value) {
    byPath.set(file, answered || (byPath.get(file) ?? false));
  }
  return {
    kind: "ok",
    value: await Promise.all(
      [...byPath].map(async ([file, answered]) => ({
        path: file,
        answered,
        read: await edge.transcript(file),
      })),
    ),
  };
}

// [LAW:dataflow-not-control-flow] The load's two arms become ConfigFacts'
// two.
function configFacts(load: ConfigLoad, target: ConfigTarget): ConfigFacts {
  const base = {
    layers: load.layers,
    target,
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

// [LAW:no-silent-failure] A settings chain, read: a file that does not read
// (`readSettingsChain` throws naming it) fails the rows that read the chain,
// never the whole run — a broken settings.json committed in some project
// concerns two checks, not every one.
const readSettings = (at: SettingsChainAt): SettingsChain["sources"] =>
  asked(() => readSettingsChain(at));

// [LAW:one-source-of-truth] The settings chains a run reads, each location
// once: the run's own, and each other one a bar's session reads its settings
// at — its project's files, and its Claude Code directory's user file — with
// every bar placed in the chain that redraws it (brandon-doctor-v62x.y5d).
function settingsChains(
  originAt: SettingsChainAt,
  bars: readonly SightedBar[],
): DoctorFacts["claudeSettings"] {
  const keyOf = (at: SettingsChainAt): string =>
    JSON.stringify([at.managedDir, at.projectDir, at.userFile]);
  const originKey = keyOf(originAt);
  const atOrigin: SightedBar[] = [];
  const others = new Map<string, { at: SettingsChainAt; bars: SightedBar[] }>();
  for (const bar of bars) {
    const at = {
      managedDir: originAt.managedDir,
      projectDir: bar.projectDir,
      userFile: claudeSettingsPath(bar.claudeConfigDir),
    };
    const key = keyOf(at);
    if (key === originKey) {
      atOrigin.push(bar);
    } else {
      const chain = others.get(key) ?? { at, bars: [] };
      chain.bars.push(bar);
      others.set(key, chain);
    }
  }
  const chain = (
    at: SettingsChainAt,
    its: readonly SightedBar[],
  ): SettingsChain => ({
    at,
    sources: readSettings(at),
    bars: its.map(({ role, frame }) => ({ role, frame })),
  });
  return {
    origin: chain(originAt, atOrigin),
    elsewhere: [...others.values()].map(({ at, bars: its }) => chain(at, its)),
  };
}

// [LAW:dataflow-not-control-flow] The three wire states of the recorded hint
// become the three arms of TmuxFacts — a total projection, and the ONLY place
// the tmux query runs: once, exactly when there is a server to ask.
async function tmuxFacts(
  edge: DoctorEdge,
  hint: ClientHints["tmux"],
): Promise<TmuxFacts> {
  if (hint === undefined) return { kind: "unreported" };
  if (hint === null) return { kind: "outside" };
  return { kind: "inside", hint, client: await seen(edge.probeTmux(hint)) };
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
async function terminalFacts(
  edge: DoctorEdge,
  identity: TerminalIdentity,
  hints: Pick<ClientHints, "terminalEnv" | "ssh">,
  glyphs: string,
): Promise<TerminalFacts> {
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
      : await seen(edge.remoteLogin(client.pid));
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
          : await seen(
              edge.fontInUse(
                { name, version },
                client === null ? (env ?? {}) : unattached,
                glyphs,
              ),
            ),
  };
}

// [LAW:dataflow-not-control-flow] A source is asked exactly when a segment
// needs it: the segments are the arm's discriminator, and a source no segment
// needs is never probed.
async function need<T>(
  segments: readonly string[],
  fact: () => T | Promise<T>,
): Promise<DataNeed<T>> {
  const [first, ...rest] = segments;
  return first === undefined
    ? { kind: "unneeded" }
    : { kind: "needed", segments: [first, ...rest], fact: await fact() };
}

async function segmentDataFacts(
  edge: DoctorEdge,
  needs: DataNeeds,
  origin: RenderOrigin,
  rateLimits: Asked<readonly RateLimitsSeen[]>,
): Promise<SegmentDataFacts> {
  return {
    pullRequests: await need(needs.pullRequests, () => edge.forge(origin.cwd)),
    rateLimits: await need(needs.rateLimits, () => rateLimits),
  };
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
export async function gatherFacts(
  edge: DoctorEdge,
  hints: Pick<ClientHints, "tmux" | "claudeConfigDir" | "terminalEnv" | "ssh">,
  origin: RenderOrigin,
  sessionPick: (key: string) => string | null,
  // The daemon that serves the bar, as it reports itself: the click's own
  // process, or the one `cc-candybar doctor` asked.
  serving: Asked<ServingDaemon>,
  // What the recent renders of this Claude Code's sessions said of the
  // rate-limit windows (src/daemon/render-sightings.ts): the click's own
  // session, or every session `cc-candybar doctor` sees in its directory.
  rateLimits: Asked<readonly RateLimitsSeen[]>,
  // The transcripts those renders named: the click's own session's, or every
  // session `cc-candybar doctor` sees.
  transcripts: Asked<readonly TranscriptSaid[]>,
  // Whose bars those renders are (src/doctor/sightings.ts).
  sighted: SightingScope,
  // What those renders drew — whether each bar moves — and where each one's
  // session reads its settings.
  bars: Asked<readonly SightedBar[]>,
  // [LAW:one-source-of-truth] The width the session's statusline client
  // measured, as its last render said (RenderSightings) — the click's own
  // session, or the one `cc-candybar doctor` runs in; outside any session,
  // the command's own terminal, standing in for the client one would spawn.
  width: Asked<Width>,
  // What the doctor's stores hold: the click's daemon's own, or the ones
  // `cc-candybar doctor` was answered.
  stores: StoresRead,
): Promise<Omit<DoctorFacts, "urlHandler" | "install">> {
  const load = edge.loadConfig(origin);
  // [LAW:one-source-of-truth] The render's own resolution, so the doctor and
  // the bar cannot disagree about which preset is placed, or which joiner
  // draws it. The preset's customization is a fact no field read here depends on.
  const globals = resolveEffectiveGlobals(
    load.config,
    sessionPick,
    () => false,
  );
  const tmux = await tmuxFacts(edge, hints.tmux);
  const terminal = terminalIdentity(tmux, hints.terminalEnv);
  // The joiner's glyphs, then every one the config's own text writes — a
  // Nerd icon in a template or a menu glyph is drawn as surely as a cap.
  const glyphs = [
    ...new Set([
      ...stripPrivateGlyphs(globals),
      ...privateGlyphsIn(JSON.stringify(load.config)),
    ]),
  ].join("");
  // Independent stages, together, so they cost a click the slowest stage's
  // bound, not their sum.
  const [nerdFont, processes, data] = await Promise.all([
    // [LAW:types-are-the-program] The measured glyphs parsed into the facts'
    // union: none to draw is the arm with no terminal to read.
    glyphs === ""
      ? ({ kind: "none" } as const)
      : terminalFacts(edge, terminal, hints, glyphs).then((read) => ({
          kind: "glyphs" as const,
          glyphs,
          terminal: read,
        })),
    edge.daemons(),
    segmentDataFacts(
      edge,
      dataNeeds(load.config, globals.preset),
      origin,
      rateLimits,
    ),
  ]);
  return {
    tmux,
    width,
    terminal,
    nerdFont,
    marks: stores.marks,
    clicked: stores.clicked,
    daemon: {
      serving,
      processes,
      read: stores.postMortemsRead,
    },
    config: configFacts(load, origin.target),
    sighted,
    frames: bars.kind === "failed" ? bars : { kind: "read" },
    data,
    transcripts: await transcriptReads(edge, transcripts),
    claudeSettings: settingsChains(
      {
        managedDir: edge.managedSettingsDir,
        projectDir: origin.projectDir,
        userFile: claudeSettingsPath(
          claudeConfigDir(hints.claudeConfigDir, edge.home),
        ),
      },
      bars.kind === "ok" ? bars.value : [],
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
// cannot reuse a stale fact or re-probe an unchanged one — or the reason the
// fix was refused, with nothing written.
export function applyFix(
  stores: DoctorStores,
  fix: Fix,
  facts: DoctorFacts,
): Asked<DoctorFacts> {
  switch (fix.kind) {
    case "claude-settings": {
      const settingsPath = fix.file.path;
      const text = readClaudeSettingsText(settingsPath);
      const next = setValue(
        text,
        fix.path,
        JSON.stringify(fix.value),
        JSON_DIALECT,
      );
      writeAtomic(settingsPath, next);
      // Every chain is re-read, each keeping its bars: the file written may
      // sit in any of them (a user file is in every chain of its Claude Code
      // directory), and a re-read of a few small files costs less than
      // deciding which.
      const reread = (chain: SettingsChain): SettingsChain => ({
        ...chain,
        sources: readSettings(chain.at),
      });
      const { origin, elsewhere } = facts.claudeSettings;
      return {
        kind: "ok",
        value: {
          ...facts,
          claudeSettings: {
            origin: reread(origin),
            elsewhere: elsewhere.map(reread),
          },
        },
      };
    }
    case "post-mortems-read": {
      // Filing only ever moves forward: a fix computed before another run
      // filed a newer breach leaves that one filed.
      const read = stores.postMortemsRead.update((current) =>
        current.through === null || laterIdentity(fix.through, current.through)
          ? { through: fix.through }
          : current,
      );
      return read.kind === "failed"
        ? read
        : {
            kind: "ok",
            value: { ...facts, daemon: { ...facts.daemon, read } },
          };
    }
    default: {
      const _exhaustive: never = fix;
      return _exhaustive;
    }
  }
}
