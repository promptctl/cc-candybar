// The doctor's reading of the machine: every fact a run judges but the
// config's and the stores', read for one ask (src/doctor/gather.ts) over the
// edge it is handed. The host's, so no renderer reads Claude Code's settings
// or spawns a probe: the host reads it for a session's doctor subscription
// (src/daemon/cache/doctor.ts), the daemon and `cc-candybar doctor` alike.
//
// [LAW:effects-at-boundaries] What the read asks of the machine goes through
// the edge; the settings files a session's client hints name it reads itself.

import { claudeConfigDir, claudeSettingsPath } from "../claude-settings.js";
import type { SettingsChainAt } from "../claude-settings.js";
import { readSettingsChain } from "../claude-settings-read.js";
import type { ClientHints } from "../daemon/foundations/protocol.js";
import type { DataNeeds } from "./data-needs.js";
import type { RepoVariables } from "../proc/repo-variables.js";
import type {
  RateLimitsSeen,
  TranscriptSaid,
} from "../daemon/foundations/sightings.js";
import type {
  Asked,
  Width,
  DoctorFacts,
  DataNeed,
  Held,
  SegmentDataFacts,
  SettingsChain,
  TerminalFacts,
  TerminalIdentity,
  TranscriptRead,
  TmuxFacts,
  UrlHandlerFacts,
} from "./checks.js";
import type { ClientHint } from "../client-hint.js";
import type { TerminalEnvHint } from "../terminal-hint.js";
import {
  identifyFromEnv,
  identifyInTmux,
  isBundling,
  isConfigured,
} from "./terminal.js";
import type { ServingDaemon } from "../daemon/foundations/memory-limit.js";
import {
  handlerProvenBy,
  type ClickArrival,
  type SightedBar,
} from "./sightings.js";
import type { DoctorEdge } from "./ports.js";
import { seen } from "./busy.js";
import {
  asked,
  type DoctorAsk,
  type DoctorOrigin,
  type MachineFacts,
} from "./gather.js";

// Each distinct transcript the renders named, read once: a statusline and a
// `frames` display drawing one session name one file. A render that saw an
// answer answers for the file.
async function transcriptReads(
  edge: DoctorEdge,
  said: Held<readonly TranscriptSaid[]>,
): Promise<Held<readonly TranscriptRead[]>> {
  if (said.kind === "not-held") return said;
  const byPath = new Map<string, boolean>();
  for (const { path: file, answered } of said.value) {
    byPath.set(file, answered || (byPath.get(file) ?? false));
  }
  return {
    kind: "held",
    value: await Promise.all(
      [...byPath].map(async ([file, answered]) => ({
        path: file,
        answered,
        read: await edge.transcript(file),
      })),
    ),
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
  cwd: string,
  rateLimits: Held<readonly RateLimitsSeen[]>,
): Promise<SegmentDataFacts> {
  return {
    pullRequests: await need(needs.pullRequests, () => edge.forge(cwd)),
    rateLimits: await need(needs.rateLimits, () => rateLimits),
  };
}

// What a read is told besides its ask, by the host it runs in: what the
// session's renders said (src/daemon/render-sightings.ts) and the daemon that
// serves the bar, as it reports itself — each held only by a running daemon —
// and the bars the session drew, with the width its client measured. The
// daemon tells what it saw; `cc-candybar doctor`, the host of a bar of its
// own, tells the bar it drew and the terminal it runs in, and holds nothing
// else.
export interface Sighted {
  readonly serving: Held<ServingDaemon>;
  readonly repoVariables: Held<RepoVariables>;
  readonly rateLimits: Held<readonly RateLimitsSeen[]>;
  readonly transcripts: Held<readonly TranscriptSaid[]>;
  // The clients that drew the session's bars, and the bundle the daemon
  // runs, which the install check judges them against.
  readonly clients: Held<{
    readonly bundle: string;
    readonly clients: ReadonlyArray<ClientHint | null>;
  }>;
  // What the session's bars drew — whether each moves — and where each
  // one's session reads its settings.
  readonly bars: readonly SightedBar[];
  // [LAW:one-source-of-truth] The width the session's statusline client
  // measured, as its last render said, or the command's own terminal, which
  // its bar is laid out for.
  readonly width: Asked<Width>;
}

// [LAW:dataflow-not-control-flow] What the run knows of the URL handler, by
// how its click arrived: a link proves it, and a run asked any other way
// reads what is registered for the scheme.
const urlHandlerOf = async (
  edge: DoctorEdge,
  arrival: ClickArrival,
): Promise<UrlHandlerFacts> =>
  handlerProvenBy(arrival, async ({ via }): Promise<UrlHandlerFacts> => {
    const registration = await edge.handler();
    return registration.kind === "unsupported"
      ? registration
      : { kind: "registered", via, opener: registration.opener };
  });

// [LAW:single-enforcer] Every fact comes from what the CLIENT saw: its tmux,
// the Claude Code directory its session runs with, and the origin its config
// resolves from — never the daemon's own env, which answers for whichever
// session spawned it. A probe the rate limit refuses throws `DoctorBusy`, so
// no reading is made of facts the doctor did not see.
export async function readDoctor(
  edge: DoctorEdge,
  hints: Pick<ClientHints, "tmux" | "claudeConfigDir" | "terminalEnv" | "ssh">,
  ask: DoctorAsk,
  origin: DoctorOrigin,
  sighted: Sighted,
): Promise<MachineFacts> {
  const tmux = await tmuxFacts(edge, hints.tmux);
  const terminal = terminalIdentity(tmux, hints.terminalEnv);
  // Independent stages, together, so they cost a run the slowest stage's
  // bound, not their sum.
  const [nerdFont, processes, data, urlHandler] = await Promise.all([
    // [LAW:types-are-the-program] The asked glyphs parsed into the facts'
    // union: none to draw is the arm with no terminal to read.
    ask.glyphs === ""
      ? ({ kind: "none" } as const)
      : terminalFacts(edge, terminal, hints, ask.glyphs).then((read) => ({
          kind: "glyphs" as const,
          glyphs: ask.glyphs,
          terminal: read,
        })),
    edge.daemons(),
    segmentDataFacts(edge, ask.needs, origin.cwd, sighted.rateLimits),
    urlHandlerOf(edge, ask.arrival),
  ]);
  return {
    tmux,
    width: sighted.width,
    terminal,
    nerdFont,
    urlHandler,
    daemon: {
      serving: sighted.serving,
      repoVariables: sighted.repoVariables,
      processes,
      postMortems: edge.postMortems(),
    },
    data,
    transcripts: await transcriptReads(edge, sighted.transcripts),
    claudeSettings: settingsChains(
      {
        managedDir: edge.managedSettingsDir,
        projectDir: origin.projectDir,
        userFile: claudeSettingsPath(
          claudeConfigDir(hints.claudeConfigDir, edge.home),
        ),
      },
      sighted.bars,
    ),
  };
}
