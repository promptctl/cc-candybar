// The doctor's ports: its reads of the machine and its stores, as the probes
// take them. Shared, so the renderer's doctor verbs hold the edges the host
// hands in.

import type { Outcome } from "../utils/outcome.js";
import type { TmuxHint } from "../tmux-hint.js";
import type { UnusedDecl } from "../config/unused.js";
import type { DslConfig } from "../config/dsl-types.js";
import type {
  Asked,
  DaemonProcess,
  FontInUse,
  ForgeLogin,
  TranscriptWindow,
  TmuxClient,
} from "./checks.js";
import type { TerminalEnvHint } from "../terminal-hint.js";
import type { ConfiguredTerminal } from "./terminal.js";
import type { RenderOrigin } from "../config-hint.js";
import type { StateFile } from "./state-file.js";
import type { DoctorStoreValues } from "../daemon/foundations/stats-snapshot";

// [LAW:effects-at-boundaries] The install check's reads of the machine: a
// path resolved through every link, the checkout a bundle was built in, a
// crate's source digest, and whether a native client ships here.
export interface InstallEdge {
  readonly realpath: (p: string) => Asked<string>;
  readonly checkoutOf: (bundle: string) => string | null;
  readonly digest: (dir: string) => Asked<string>;
  readonly nativeShipped: boolean;
}

// The documents the doctor keeps under the daemon's state directory
// (src/doctor/state-file.ts). [LAW:one-source-of-truth] The daemon is their
// one owner: its click files them, and `cc-candybar doctor` reads what they
// hold in the daemon's own answer (`StoresRead`, src/doctor/daemon-answer.ts).
export type DoctorStores = {
  readonly [K in keyof DoctorStoreValues]: StateFile<DoctorStoreValues[K]>;
};

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
  // The user's home: where Claude Code's default directory is.
  readonly home: string;
  // Every cc-candybar daemon process this user runs (`daemonProcesses`).
  readonly daemons: () => Promise<Asked<readonly DaemonProcess[]>>;
  // Whether the forge CLI the checkout's remote names is installed and logged
  // in to its host — null when it names no forge (`forgeLogin`).
  readonly forge: (cwd: string) => Promise<Asked<ForgeLogin | null>>;
  // The tail of a session's transcript, read as the bar reads it — absent
  // when no file is at the path (`readTranscriptWindow`).
  readonly transcript: (path: string) => Promise<Outcome<TranscriptWindow>>;
}

// [LAW:effects-at-boundaries] The doctor's reads of the machine: what the
// gather asks through its edge, and the install check's reads.
export type DoctorMachineEdge = Pick<
  DoctorEdge,
  "probeTmux" | "remoteLogin" | "fontInUse" | "daemons" | "forge" | "transcript"
> & { readonly install: InstallEdge };

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
