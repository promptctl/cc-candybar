// The doctor's edge: where the facts are GATHERED and a fix is PERFORMED.
//
// [LAW:effects-at-boundaries] Every effect the doctor has — the tmux query,
// the config load, the settings.json read, the settings.json write — lives in
// this module. The tmux query and the config load sit behind the `DoctorEdge`
// record the daemon and the CLI both construct with `productionEdge()` and a
// test fakes; the settings file is the one the session's client hints name,
// so a test points it with a hint. The doctor's stores are `DoctorStores`,
// which only the daemon holds: the CLI reads them in its answer.
// checks.ts never sees an effect; this file never decides a verdict.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lineage, processTable } from "../proc/process-table.js";
import {
  claudeConfigDir,
  claudeManagedSettingsDir,
  claudeSettingsPath,
  readClaudeSettingsText,
  readSettingsChain,
  type SettingsChainAt,
} from "../claude-settings.js";
import { JSON_DIALECT, setValue } from "../config/json5-edit.js";
import { writeAtomic } from "../utils/atomic-write.js";
import type { ClientHints } from "../daemon/protocol.js";
import { runTmuxAsync } from "../proc/tmux.js";
import type { LaunchResult, Launcher } from "../proc/launch.js";
import {
  FORGE_CLI,
  REMOTES_ARGS,
  detectForge,
  forgeRemoteUrl,
  firstLine,
  isMissingCommand,
  launchFailure,
  remoteHost,
  remotesOf,
  type ForgeName,
} from "../segments/git.js";
import { gitRootOf } from "../utils/git-root.js";
import { dataNeeds, type DataNeeds } from "./data-needs.js";
import type {
  RateLimitsSeen,
  RoledSaid,
  TranscriptSaid,
} from "../daemon/render-sightings.js";
import { ok, type Outcome } from "../utils/outcome.js";
import { jsonLine } from "../utils/claude.js";
import { readTailSync } from "../utils/transcript-fs.js";
import type { TmuxHint } from "../tmux-hint.js";
import type { UnusedDecl } from "../config/unused.js";
import type { DslConfig } from "../config/dsl-types.js";
import { resolveEffectiveGlobals } from "../config/effective-globals.js";
import {
  type Asked,
  type Width,
  type ClientFact,
  type InstallFacts,
  type ConfigFacts,
  type DaemonProcess,
  type DoctorFacts,
  type Fix,
  type DataNeed,
  type FontInUse,
  type ForgeLogin,
  type MarkBook,
  type PostMortemsRead,
  type SegmentDataFacts,
  type SettingsChain,
  type TerminalFacts,
  type TerminalIdentity,
  TRANSCRIPT_WINDOW_BYTES,
  type TranscriptRead,
  type TranscriptWindow,
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
import type { ClientHint } from "../client-hint.js";
import type { ConfigTarget, RenderOrigin } from "../config-hint.js";
import { sourceCheckoutOf } from "../daemon/build-currency.js";
import { crateDigest } from "../source-digest.js";
import { shipsNative } from "../install/platforms.js";
import { fileMarkBook } from "./mark-book.js";
import { fileClickedTerminals } from "./clicked-terminals.js";
import { filePostMortemsRead } from "./post-mortems-read.js";
import type { StateFile } from "./state-file.js";
import { laterIdentity, type ServingDaemon } from "../daemon/limits.js";
import type { ClickArrival, SightedBar, SightingScope } from "./sightings.js";

// [LAW:effects-at-boundaries] The install check's reads of the machine: a
// path resolved through every link, the checkout a bundle was built in, a
// crate's source digest, and whether a native client ships here.
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
  digest: (crateDir) => asked(() => crateDigest(crateDir)),
  nativeShipped: shipsNative(process.platform, process.arch),
};

// [LAW:one-source-of-truth] One fold from (the daemon's bundle, the clients
// judged) to the facts, for both surfaces: the click passes its own session's
// latest, the CLI every session's latest from daemon-stats inside the window. Both bundles are
// resolved through every link here, so `bin/../dist/index.mjs` and a symlinked
// checkout name the file they are.
export function installFacts(
  edge: InstallEdge,
  daemonBundle: string,
  // The clients judged; null for one that did not report what it is.
  clients: ReadonlyArray<ClientHint | null>,
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
                rustSource: edge.digest(path.join(root, "rust-client")),
              },
      },
      nativeShipped: edge.nativeShipped,
      clients: clients.map(
        (client): ClientFact =>
          client === null
            ? { kind: "unreported" }
            : {
                kind: "reported",
                client: client.kind,
                bundle: edge.realpath(client.bundle),
                source: client.source,
              },
      ),
    },
  };
}

// The documents the doctor keeps under the daemon's state directory
// (src/doctor/state-file.ts). [LAW:one-source-of-truth] The daemon is their
// one owner: its click files them, and `cc-candybar doctor` reads what they
// hold in the daemon's own answer (`StoresRead`, src/doctor/daemon-answer.ts).
export interface DoctorStores {
  // The marks the user has made on what the doctor showed them, kept for
  // good (src/doctor/mark-book.ts).
  readonly marks: StateFile<MarkBook>;
  // The terminals a doctor click has come back from, kept for good
  // (src/doctor/clicked-terminals.ts).
  readonly clicked: StateFile<readonly string[]>;
  // The newest post-mortem the user filed as read
  // (src/doctor/post-mortems-read.ts).
  readonly postMortemsRead: StateFile<PostMortemsRead>;
}

// What each store holds, or why it could not be read.
export type StoresRead = {
  readonly [K in keyof DoctorStores]: ReturnType<DoctorStores[K]["read"]>;
};

export const fileStores = (dir: string): DoctorStores => ({
  marks: fileMarkBook(dir),
  clicked: fileClickedTerminals(dir),
  postMortemsRead: filePostMortemsRead(dir),
});

export const readStores = (stores: DoctorStores): StoresRead => ({
  marks: stores.marks.read(),
  clicked: stores.clicked.read(),
  postMortemsRead: stores.postMortemsRead.read(),
});

export interface DoctorEdge {
  // tmux's own word on the attached client's terminal, asked of THE server
  // the hint names — `-S socket` and `-t pane` are why the hint carries them.
  readonly probeTmux: (hint: TmuxHint) => Promise<Asked<TmuxClient | null>>;
  // Whether a process came in through a remote login (sshd, mosh-server) —
  // asked of the tmux client attached to the session's pane.
  readonly remoteLogin: (pid: number) => Promise<Asked<boolean>>;
  // The font a configured terminal draws the bar's glyphs with, read where
  // the terminal reads it (src/doctor/font-edge.ts).
  readonly fontInUse: (
    terminal: {
      readonly name: ConfiguredTerminal;
      readonly version: string | null;
    },
    env: TerminalEnvHint,
    glyphs: string,
  ) => Promise<Asked<FontInUse>>;
  // What loading the config at an origin finds now — the daemon reloads the
  // render-cache entry the session's bar is drawn from and answers from it
  // (so the doctor and the bar's strip report one load), the CLI runs one
  // load of its own. Both are the one `loadFromDisk`.
  readonly loadConfig: (origin: RenderOrigin) => ConfigLoad;
  // The directory Claude Code's managed settings live in
  // (`claudeManagedSettingsDir`) — a policy every session on the machine
  // reads, so the daemon's own environment may move it, which test/setup.ts
  // does so no test reads the host's policy.
  readonly managedSettingsDir: string;
  readonly install: InstallEdge;
  // Every cc-candybar daemon process this user runs (`daemonProcesses`).
  readonly daemons: () => Promise<Asked<readonly DaemonProcess[]>>;
  // Whether the forge CLI the checkout's remote names is installed and logged
  // in to its host — null when it names no forge (`forgeLogin`).
  readonly forge: (cwd: string) => Promise<Asked<ForgeLogin | null>>;
  // The tail of a session's transcript, read as the bar reads it — absent
  // when no file is at the path (`readTranscriptWindow`).
  readonly transcript: (path: string) => Outcome<TranscriptWindow>;
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
  const procs = processTable(table);
  if (!procs.has(pid)) {
    return { kind: "failed", reason: `process ${pid} is not running` };
  }
  for (const p of lineage(procs, pid)) {
    if (REMOTE_LOGIN.test(p.command.slice(p.command.lastIndexOf("/") + 1))) {
      return { kind: "ok", value: true };
    }
  }
  return { kind: "ok", value: false };
}

async function remoteLogin(
  launcher: Launcher,
  pid: number,
): Promise<Asked<boolean>> {
  const run = await launcher.launch({
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

// The entries a daemon is started from, under the root they sit in: the
// bundle the spawners run (src/daemon/acquire.ts, rust-client/src/launch.rs),
// the source the test harness runs under tsx, and the bin a hand run starts.
const DAEMON_ENTRY =
  /^(.*)\/(?:dist\/index\.mjs|src\/index\.ts|bin\/cc-candybar)$/;

// [LAW:effects-at-boundaries] Pure over `ps -o pid=,ppid=,rss=,lstart=,args=`:
// the processes this user runs whose args end in `<entry> daemon`, with
// `ownsEntry` the edge's word on whether that entry is cc-candybar's — a file
// name is no identity, since any Node tool may have a `dist/index.mjs daemon`.
// The entry is the absolute path before ` daemon`: the last ` /` starts it,
// so a space inside it ("Application Support") needs no tokenizing, and a
// relative entry (a hand run from inside a checkout) is no daemon this can
// name. A daemon whose child is a daemon is that child's launcher (tsx's
// wrapper around the worker that holds the socket), not a second daemon.
export function daemonProcesses(
  table: string,
  ownsEntry: (entry: string) => boolean,
): readonly DaemonProcess[] {
  const found: DaemonProcess[] = [];
  for (const line of table.split("\n")) {
    const m =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ [\d:]{8} \d{4})\s+.* (\/.*) daemon$/.exec(
        line,
      );
    if (m === null || !ownsEntry(m[5]!)) continue;
    found.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rss: Number(m[3]) * 1024,
      // The edge runs ps under TZ=UTC; the zone is said, so the time is
      // not read as local.
      started: `${m[4]!.replace(/\s+/g, " ")} UTC`,
    });
  }
  return found.filter((p) => !found.some((child) => child.ppid === p.pid));
}

// Whether an entry is cc-candybar's: resolved through every link (an npm
// `.bin` launcher), it sits in a root that holds `bin/cc-candybar` — a
// checkout and the staged runtime alike. An entry that no longer resolves
// names no root to check.
export function ownsEntry(entry: string): boolean {
  let real: string;
  try {
    real = fs.realpathSync(entry);
  } catch {
    return false;
  }
  const root = DAEMON_ENTRY.exec(real)?.[1];
  return (
    root !== undefined && fs.existsSync(path.join(root, "bin", "cc-candybar"))
  );
}

async function daemons(
  launcher: Launcher,
): Promise<Asked<readonly DaemonProcess[]>> {
  const run = await launcher.launch({
    bin: "ps",
    args: [
      "-U",
      String(os.userInfo().uid),
      "-ww",
      "-o",
      "pid=,ppid=,rss=,lstart=,args=",
    ],
    timeoutMs: 2000,
    category: "doctor.daemons",
    // The start time as the table writes it, in one format whatever the
    // user's locale and zone (src/daemon/process-fingerprint.ts).
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  if (!run.ok) {
    const detail = run.error ?? `${run.reason}: ${run.stderr.trim()}`;
    return { kind: "failed", reason: `ps failed (${detail})` };
  }
  return { kind: "ok", value: daemonProcesses(run.stdout, ownsEntry) };
}

async function probeTmux(
  launcher: Launcher,
  hint: TmuxHint,
): Promise<Asked<TmuxClient | null>> {
  const run = await runTmuxAsync(launcher, hint, "doctor.tmux", [
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
  launcher: Launcher,
  loadConfig: DoctorEdge["loadConfig"],
): DoctorEdge {
  return {
    probeTmux: (hint) => probeTmux(launcher, hint),
    remoteLogin: (pid) => remoteLogin(launcher, pid),
    fontInUse: (terminal, env, glyphs) =>
      fontInUse(launcher, terminal, env, glyphs),
    loadConfig,
    managedSettingsDir:
      process.env.CC_CANDYBAR_CLAUDE_MANAGED_DIR ??
      claudeManagedSettingsDir(process.platform),
    install: productionInstallEdge,
    daemons: () => daemons(launcher),
    forge: (cwd) => forgeLogin(launcher, cwd),
    transcript: readTranscriptWindow,
  };
}

// [LAW:effects-at-boundaries] Pure over the bytes read: the window's first
// line is cut short unless the window starts the file, and its last is still
// being written unless a newline ends it, so neither is judged. The bytes
// start one before the window (`readTranscriptWindow`), so a window that
// begins on a line boundary drops only that newline, not a whole line.
export function transcriptWindow(
  bytes: Buffer,
  whole: boolean,
): TranscriptWindow {
  const text = bytes.toString("utf-8");
  const from = whole ? 0 : text.indexOf("\n") + 1;
  const to = text.lastIndexOf("\n") + 1;
  let lines = 0;
  let unparsed = 0;
  for (const line of text.slice(from, to).split("\n")) {
    const read = jsonLine(line);
    if (read.kind === "blank") continue;
    lines++;
    if (read.kind === "unparsed") unparsed++;
  }
  return { lines, unparsed, whole };
}

// The last TRANSCRIPT_WINDOW_BYTES of a transcript, synchronously like every
// doctor probe — bounded, since a transcript grows for as long as its session
// runs and the click holds the daemon's loop while it reads. No file at the
// path is `absent` (a session before its first response has none).
export function readTranscriptWindow(file: string): Outcome<TranscriptWindow> {
  const read = readTailSync(file, TRANSCRIPT_WINDOW_BYTES + 1);
  return read.kind === "ok"
    ? ok(transcriptWindow(read.value.buf, read.value.fromStart))
    : read;
}

// Each distinct transcript the renders named, read once: a statusline and a
// `frames` display drawing one session name one file. A render that saw an
// answer answers for the file.
function transcriptReads(
  edge: DoctorEdge,
  said: Asked<readonly TranscriptSaid[]>,
): Asked<readonly TranscriptRead[]> {
  if (said.kind === "failed") return said;
  const byPath = new Map<string, boolean>();
  for (const { path: file, answered } of said.value) {
    byPath.set(file, answered || (byPath.get(file) ?? false));
  }
  return {
    kind: "ok",
    value: [...byPath].map(([file, answered]) => ({
      path: file,
      answered,
      read: edge.transcript(file),
    })),
  };
}

// [LAW:types-are-the-program] How each forge's CLI is asked whether it can
// answer for a host, LOCALLY — a network check would hold the daemon's loop,
// which every session's render shares, for its whole timeout. `gh auth token`
// reads the stored token (or GH_TOKEN) and exits non-zero when there is none;
// its stdout IS the token, which is never kept or logged. glab has no local
// login question this was verified against, so it is asked only whether it is
// installed; a glab that is logged out already shows on the bar as the PR
// lookup's error (classifyForgePr). `loginHost` is the host the CLI keys its
// login on for the remote's: gh folds every `*.github.com` (an ssh-over-443
// remote names `ssh.github.com`) into `github.com`, and detectForge names
// nothing else github.
const FORGE_PROBE: Readonly<
  Record<
    ForgeName,
    {
      readonly loginHost: (host: string) => string;
      readonly args: (host: string) => readonly string[];
      readonly nonZero: "logged-out" | "failed";
    }
  >
> = {
  github: {
    loginHost: () => "github.com",
    args: (host) => ["auth", "token", "--hostname", host],
    nonZero: "logged-out",
  },
  gitlab: {
    loginHost: (host) => host,
    args: () => ["--version"],
    nonZero: "failed",
  },
};

// The checkout's forge, read the way the PR lookup reads it (REMOTES_ARGS,
// remotesOf, forgeRemoteUrl, detectForge), then its CLI asked about the
// remote's host. Under the daemon's environment for a click — the one the
// bar's lookup runs with — and the shell's for `cc-candybar doctor`.
export async function forgeLogin(
  launcher: Launcher,
  cwd: string,
): Promise<Asked<ForgeLogin | null>> {
  if (gitRootOf(cwd) === undefined) return { kind: "ok", value: null };
  const remotes = remotesOf(
    await launcher.launch({
      bin: "git",
      args: [...REMOTES_ARGS],
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      timeoutMs: 2000,
      category: "doctor.forge",
    }),
  );
  if (remotes.kind === "failed") return remotes;
  const url = forgeRemoteUrl(remotes.value);
  if (url === null) return { kind: "ok", value: null };
  const forge = detectForge(url);
  if (forge === null) return { kind: "ok", value: null };
  const cli = FORGE_CLI[forge];
  const probe = FORGE_PROBE[forge];
  // [LAW:no-defensive-null-guards] detectForge names a forge only by a host.
  const host = probe.loginHost(remoteHost(url)!);
  const run = await launcher.launch({
    bin: cli,
    args: [...probe.args(host)],
    cwd,
    timeoutMs: 2000,
    category: "doctor.forge",
  });
  return forgeLoginOf(cli, host, probe.nonZero, run);
}

// [LAW:effects-at-boundaries] What the CLI's answer means, pure over the
// launch result: ran is ready, not on PATH is missing, a non-zero exit is
// logged out where the forge's probe says so, anything else could not be
// asked.
export function forgeLoginOf(
  cli: string,
  host: string,
  nonZero: "logged-out" | "failed",
  run: LaunchResult,
): Asked<ForgeLogin> {
  const login = (status: ForgeLogin["status"]): Asked<ForgeLogin> => ({
    kind: "ok",
    value: { cli, host, status },
  });
  if (run.ok) return login("ready");
  if (isMissingCommand(run)) return login("missing");
  if (run.reason === "non-zero" && nonZero === "logged-out") {
    return login({ loggedOut: firstLine(run.stderr) });
  }
  return { kind: "failed", reason: launchFailure(cli, run) };
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
  return { kind: "inside", hint, client: await edge.probeTmux(hint) };
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
      : await edge.remoteLogin(client.pid);
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
          : await edge.fontInUse(
              { name, version },
              client === null ? (env ?? {}) : unattached,
              glyphs,
            ),
  };
}

// A click that arrived as a link IS a link that came back through the URL
// handler, carrying the version of the handler that delivered it; one from
// the tmux status line came through tmux, and says nothing of the handler.
export function clickArrived(arrival: ClickArrival): UrlHandlerFacts {
  switch (arrival.via) {
    case "link":
      return {
        kind: "arrived",
        handler: arrival.handler,
        bar: PACKAGE_VERSION,
      };
    case "tmux-status":
      return {
        kind: "unprobed",
        reason:
          "this run was asked from the tmux status line, whose clicks tmux runs rather than the URL handler — run `cc-candybar doctor` to probe the handler",
      };
  }
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

// [LAW:single-enforcer] The width one session's statusline client measured,
// read off that session's latest renders — the click's own, or the sightings
// `cc-candybar doctor` was answered for the session it runs in. The daemon
// holds no such render when it has drawn the session's statusline none since
// it started (the bar on screen is an earlier daemon's), when it has dropped
// it for newer sessions' renders, or when only a `frames` client draws it.
export function sessionWidth(
  sessionId: string,
  said: ReadonlyArray<Pick<RoledSaid, "role" | "termCols">>,
): Asked<Width> {
  const statusline = said.find((s) => s.role === "statusline");
  return statusline === undefined
    ? {
        kind: "failed",
        reason: `the daemon holds no statusline render of session ${sessionId} — none since it started, or dropped for newer sessions' renders, or only a frames display draws it, which reports no width — so no width a statusline client measured is known; run this again once the statusline has redrawn`,
      }
    : {
        kind: "ok",
        value: {
          columns: statusline.termCols,
          of: { kind: "session", sessionId },
        },
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
  return {
    tmux,
    width,
    terminal,
    // [LAW:types-are-the-program] The measured glyphs parsed into the facts'
    // union: none to draw is the arm with no terminal to read.
    nerdFont:
      glyphs === ""
        ? { kind: "none" }
        : {
            kind: "glyphs",
            glyphs,
            terminal: await terminalFacts(edge, terminal, hints, glyphs),
          },
    marks: stores.marks,
    clicked: stores.clicked,
    daemon: {
      serving,
      processes: await edge.daemons(),
      read: stores.postMortemsRead,
    },
    config: configFacts(load, origin.target),
    sighted,
    frames: bars.kind === "failed" ? bars : { kind: "read" },
    data: await segmentDataFacts(
      edge,
      dataNeeds(load.config, globals.preset),
      origin,
      rateLimits,
    ),
    transcripts: transcriptReads(edge, transcripts),
    claudeSettings: settingsChains(
      {
        managedDir: edge.managedSettingsDir,
        projectDir: origin.projectDir,
        userFile: claudeSettingsPath(claudeConfigDir(hints.claudeConfigDir)),
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
