import { HOST } from "./host";
import {
  held,
  type Asked,
  type DaemonProcess,
  type DoctorFacts,
  type MarkBook,
  type PostMortemsRead,
} from "../../src/doctor/checks";
import type {
  FrameSeen,
  FrameSighting,
} from "../../src/daemon/foundations/sightings";
import type { SettingsSource } from "../../src/claude-settings";
import type { SightedBar } from "../../src/doctor/sightings";
import { readStores } from "../../src/doctor/gather";
import {
  type DoctorEdge,
  type DoctorStores,
  type InstallEdge,
} from "../../src/doctor/ports";
import { type StoresRead } from "../../src/daemon/foundations/stats-snapshot";
import type { ServingDaemon } from "../../src/daemon/foundations/memory-limit";
import { memoryStateFile } from "./state-file";
import type { ClientHint } from "../../src/client-hint";
import type { Sighted } from "../../src/doctor/read";

// One published install: the daemon's bundle and the native client beside it.
export const HEALTHY_BUNDLE = "/opt/cc/dist/index.mjs";

// The `client` hint a healthy native client records: the bundle it execs is
// the daemon's (testVerbContext's `bundle`).
export const healthyClient = (): ClientHint => ({
  kind: "native",
  bundle: HEALTHY_BUNDLE,
  source: null,
});

// The machine of that install: every path resolves to itself, no checkout.
export const HEALTHY_INSTALL_EDGE: InstallEdge = {
  realpath: (p) => ({ kind: "ok", value: p }),
  checkoutOf: () => null,
  digest: () => {
    throw new Error("doctor: no checkout in this test");
  },
  nativeShipped: () => true,
};

// Its one daemon: well under its budget, never out of memory.
export const HEALTHY_SERVING: ServingDaemon = {
  pid: 4100,
  memory: {
    kind: "measured",
    charge: {
      kind: "charged",
      measure: "phys_footprint",
      bytes: 120 * 1024 * 1024,
    },
    rss: 160 * 1024 * 1024,
    heapTotal: 90 * 1024 * 1024,
    processes: [
      {
        role: "host",
        pid: 4100,
        sizes: { rss: 160 * 1024 * 1024, heapTotal: 90 * 1024 * 1024 },
      },
    ],
  },
  limit: 512 * 1024 * 1024,
};

export const HEALTHY_PROCESS: DaemonProcess = {
  pid: 4100,
  ppid: 1,
  rss: 120 * 1024 * 1024,
  started: "Mon Oct 19 17:59:51 2026",
};

// The edge's reads of that daemon: the one process, and no post-mortem.
export const healthyDaemonEdge = (): Pick<
  DoctorEdge,
  "daemons" | "postMortems"
> => ({
  daemons: async () => ({ kind: "ok", value: [HEALTHY_PROCESS] }),
  postMortems: () => ({ kind: "ok", value: [] }),
});

// The edge's read of the URL handler on a platform that has none.
export const noUrlHandlerEdge = (): Pick<DoctorEdge, "handler"> => ({
  handler: async () => ({ kind: "unsupported" }),
});

// The doctor's stores on a machine it has never filed anything on.
export const emptyStores = (): DoctorStores => ({
  marks: memoryStateFile<MarkBook>({}),
  clicked: memoryStateFile<readonly string[]>([]),
  postMortemsRead: memoryStateFile<PostMortemsRead>({ through: null }),
});

// What those stores hold, read.
export const EMPTY_STORES: StoresRead = readStores(emptyStores());

// A session's transcript after Claude Code has answered in it.
export const HEALTHY_TRANSCRIPT = {
  path: "/claude/projects/p/s.jsonl",
  answered: true,
} as const;

// That transcript, as the renders named it.
export const NAMED = held([HEALTHY_TRANSCRIPT]);

// What a render request said, by the client that sent it: a payload that
// carried the rate-limit windows, from a session of `projectDir` running with
// the Claude Code directory `claudeConfigDir`.
export const renderSaid = (
  client: ClientHint | null | undefined,
  { projectDir = "/p", claudeConfigDir = "/claude" } = {},
) => ({
  client: client ?? null,
  termCols: 148,
  rateLimits: "carried" as const,
  claudeConfigDir,
  projectDir,
  transcript: HEALTHY_TRANSCRIPT,
  frame: "still" as const,
});

// The bars a session's statusline renders drew.
export const drew = (...frames: FrameSeen[]): readonly FrameSighting[] =>
  frames.map((frame) => ({ role: "statusline", frame }));

// The location every fact-level test's own settings chain is read at.
export const ORIGIN_AT = {
  managedDir: "/managed",
  projectDir: "/p",
  userFile: "/s.json",
} as const;

// A run whose bars all read their settings at the run's own location: the
// one chain, holding `sources` and `bars`, and nothing elsewhere.
export const onOrigin = (
  bars: readonly FrameSighting[],
  sources: Asked<readonly SettingsSource[]> = { kind: "ok", value: [] },
  at: DoctorFacts["claudeSettings"]["origin"]["at"] = ORIGIN_AT,
): Pick<DoctorFacts, "claudeSettings"> => ({
  claudeSettings: { origin: { at, sources, bars }, elsewhere: [] },
});

// Bars as the host reports them to `gatherFacts`: each session's settings
// read in `projectDir`, under the Claude Code directory `claudeConfigDir`.
export const sightedIn = (
  projectDir: string,
  claudeConfigDir: string,
  bars: readonly FrameSighting[],
): readonly SightedBar[] =>
  bars.map((bar) => ({ ...bar, projectDir, claudeConfigDir }));

// A bar whose frame holds still, as a session's renders drew it.
export const STILL = drew("still");

// The rate-limit windows, as a session's renders carried them.
export const CARRIED = held(["carried" as const]);

// The edge's reads of the outside data segments need and of the session's
// transcript: the checkout's gh logged in, the transcript all JSON.
// The managed settings directory every test edge reads: test/setup.ts's, a
// directory that holds no policy.
export const noManagedSettings = (): Pick<
  DoctorEdge,
  "managedSettingsDir" | "home"
> => ({
  managedSettingsDir: process.env.CC_CANDYBAR_CLAUDE_MANAGED_DIR!,
  home: HOST.home,
});

export const healthyDataEdge = (): Pick<
  DoctorEdge,
  "forge" | "transcript"
> => ({
  transcript: async () => ({
    kind: "ok",
    value: { lines: 3, unparsed: 0, whole: true },
  }),
  forge: async () => ({
    kind: "ok",
    value: { cli: "gh", host: "github.com", status: "ready" },
  }),
});

// What the daemon tells a read of one healthy session: itself, its bundle and
// the native client beside it, a render that carried the rate-limit windows
// and named a transcript, and `bars`, read in `projectDir` under
// `claudeConfigDir`.
export const healthySighted = (
  projectDir: string,
  claudeConfigDir: string,
  bars: readonly FrameSighting[] = STILL,
): Sighted => ({
  serving: held(HEALTHY_SERVING),
  rateLimits: CARRIED,
  transcripts: NAMED,
  clients: held({ bundle: HEALTHY_BUNDLE, clients: [healthyClient()] }),
  bars: sightedIn(projectDir, claudeConfigDir, bars),
  width: { kind: "ok", value: { columns: 148, of: { kind: "command" } } },
});

// A setup every check passes, asked for by the command: the base a doctor
// test spreads the facts it is about over.
export const HEALTHY_FACTS: DoctorFacts = {
  tmux: { kind: "outside" },
  width: { kind: "ok", value: { columns: 120, of: { kind: "command" } } },
  terminal: {
    kind: "seen",
    identified: {
      kind: "known",
      terminal: { name: "ghostty", version: "1.3.1" },
    },
    tmuxClient: null,
  },
  config: {
    kind: "loaded",
    layers: [],
    target: { source: "search" },
    warnings: [],
    unused: [],
  },
  ...onOrigin(STILL),
  data: {
    pullRequests: { kind: "unneeded" },
    rateLimits: { kind: "unneeded" },
  },
  transcripts: held([
    {
      ...HEALTHY_TRANSCRIPT,
      read: { kind: "ok", value: { lines: 3, unparsed: 0, whole: true } },
    },
  ]),
  urlHandler: { kind: "unsupported" },
  install: held({
    kind: "ok",
    value: {
      daemon: { bundle: HEALTHY_BUNDLE, checkout: null },
      nativeShipped: true,
      clients: [
        {
          kind: "reported",
          client: "native",
          bundle: { kind: "ok", value: HEALTHY_BUNDLE },
          source: null,
        },
      ],
    },
  }),
  daemon: {
    serving: held(HEALTHY_SERVING),
    processes: { kind: "ok", value: [HEALTHY_PROCESS] },
    postMortems: { kind: "ok", value: [] },
    read: { kind: "ok", value: { through: null } },
  },
  nerdFont: { kind: "none" },
  marks: { kind: "ok", value: {} },
  clicked: { kind: "ok", value: [] },
};
