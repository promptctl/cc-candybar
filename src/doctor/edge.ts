// The doctor's edge: its reads of the machine, which the gather
// (src/doctor/gather.ts) asks through.
//
// [LAW:effects-at-boundaries] The tmux query, the process table, the font, the
// forge's login, the transcript and the install's files are read here, behind
// the `DoctorEdge` record the daemon and the CLI both construct with
// `productionEdge()` and a test fakes. The doctor's stores are files under the
// state directory (`fileStores`). checks.ts never sees an effect; this file
// never decides a verdict.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lineage, processTable } from "../proc/process-table.js";
import { claudeManagedSettingsDirIn } from "../claude-settings.js";
import { runTmuxAsync } from "../proc/tmux.js";
import type { Host } from "../host.js";
import {
  failureText,
  type LaunchResult,
  type Launcher,
} from "../proc/launcher.js";
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
import { ok, type Outcome } from "../utils/outcome.js";
import { jsonLine } from "../utils/claude.js";
import { readTailSync } from "../utils/transcript-fs.js";
import type { TmuxHint } from "../tmux-hint.js";
import {
  type Asked,
  type ClientFact,
  type InstallFacts,
  type DaemonProcess,
  type ForgeLogin,
  TRANSCRIPT_WINDOW_BYTES,
  type TranscriptWindow,
  type TmuxClient,
} from "./checks.js";
import { fontInUse } from "./font-edge.js";
import { busy, type Probed } from "./busy.js";
import type { ClientHint } from "../client-hint.js";
import { sourceCheckoutOf } from "../daemon/build-currency.js";
import { crateDigest } from "../source-digest.js";
import { shipsNative } from "../install/platforms.js";
import { fileMarkBook } from "./mark-book.js";
import { fileClickedTerminals } from "./clicked-terminals.js";
import { filePostMortemsRead } from "./post-mortems-read.js";
import type { InstallEdge, DoctorStores, DoctorMachineEdge } from "./ports";
import { asked } from "./gather.js";

export const productionInstallEdge: InstallEdge = {
  realpath: (p) => asked(() => fs.realpathSync(p)),
  checkoutOf: sourceCheckoutOf,
  digest: (crateDir) => asked(() => crateDigest(crateDir)),
  // Asked when a check runs, so importing the edge reads nothing of the host.
  nativeShipped: () => shipsNative(process.platform, process.arch),
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
      nativeShipped: edge.nativeShipped(),
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

export const fileStores = (dir: string): DoctorStores => ({
  marks: fileMarkBook(dir),
  clicked: fileClickedTerminals(dir),
  postMortemsRead: filePostMortemsRead(dir),
});

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
): Promise<Probed<boolean>> {
  const run = await launcher.launch({
    bin: "ps",
    args: ["-A", "-o", "pid=,ppid=,comm="],
    timeoutMs: 2000,
    category: "doctor.process",
  });
  if (!run.ok) {
    if (run.reason === "rate-limited") return busy("the processes");
    const detail = failureText(run);
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
    envOverlay: { LC_ALL: "C", TZ: "UTC" },
  });
  if (!run.ok) {
    const detail = failureText(run);
    return { kind: "failed", reason: `ps failed (${detail})` };
  }
  return { kind: "ok", value: daemonProcesses(run.stdout, ownsEntry) };
}

async function probeTmux(
  launcher: Launcher,
  hint: TmuxHint,
): Promise<Probed<TmuxClient | null>> {
  const run = await runTmuxAsync(launcher, hint, "doctor.tmux", [
    "display",
    "-p",
    "-t",
    hint.pane,
    TMUX_CLIENT_FORMAT,
  ]);
  if (run.kind === "rate-limited") return busy("tmux");
  if (run.kind === "failed") return { kind: "failed", reason: run.reason };
  return parseTmuxClient(run.stdout);
}

export function productionMachineEdge(
  launcher: Launcher,
  host: Host,
): DoctorMachineEdge {
  return {
    probeTmux: (hint) => probeTmux(launcher, hint),
    remoteLogin: (pid) => remoteLogin(launcher, pid),
    fontInUse: (terminal, env, glyphs) =>
      fontInUse(launcher, terminal, env, glyphs, host.home),
    daemons: () => daemons(launcher),
    forge: (cwd) => forgeLogin(launcher, cwd),
    transcript: async (file) => readTranscriptWindow(file),
    install: productionInstallEdge,
    home: host.home,
    managedSettingsDir: claudeManagedSettingsDirIn(host.env),
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
      envOverlay: { GIT_OPTIONAL_LOCKS: "0" },
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
