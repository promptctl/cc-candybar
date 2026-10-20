import type { DaemonProcess, DoctorFacts, MarkBook, PostMortemsRead } from "../../src/doctor/checks";
import type { FrameSeen } from "../../src/daemon/render-sightings";
import { readStores, type DoctorEdge, type DoctorStores, type InstallEdge, type StoresRead } from "../../src/doctor/edge";
import type { DaemonAnswer } from "../../src/doctor/daemon-answer";
import type { ServingDaemon } from "../../src/daemon/limits";
import { memoryStateFile } from "./state-file";
import type { ClientHint } from "../../src/client-hint";

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
  nativeShipped: true,
};

// Its one daemon: well under its budget, never out of memory.
export const HEALTHY_SERVING: ServingDaemon = {
  pid: 4100,
  rss: 120 * 1024 * 1024,
  rssLimit: 512 * 1024 * 1024,
  postMortems: { kind: "ok", value: [] },
};

export const HEALTHY_PROCESS: DaemonProcess = {
  pid: 4100,
  ppid: 1,
  rss: 120 * 1024 * 1024,
  started: "Mon Oct 19 17:59:51 2026",
};

// The edge's reads of that daemon: the one process.
export const healthyDaemonEdge = (): Pick<DoctorEdge, "daemons"> => ({
  daemons: () => ({ kind: "ok", value: [HEALTHY_PROCESS] }),
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
export const NAMED = { kind: "ok", value: [HEALTHY_TRANSCRIPT] } as const;

// What a render request said, by the client that sent it: a payload that
// carried the rate-limit windows, from the default Claude Code directory.
export const renderSaid = (client: ClientHint | null | undefined) => ({
  client: client ?? null,
  termCols: 148,
  rateLimits: "carried" as const,
  claudeConfigDir: "/claude",
  transcript: HEALTHY_TRANSCRIPT,
  frame: "still" as const,
});

// The frames a session's statusline renders drew.
export const drew = (...frames: FrameSeen[]): DoctorFacts["frames"] => ({
  kind: "ok",
  value: frames.map((frame) => ({ role: "statusline", frame })),
});

// A bar whose frame holds still, as a session's renders drew it.
export const STILL = drew("still");

// The rate-limit windows, as a session's renders carried them.
export const CARRIED = { kind: "ok", value: ["carried"] } as const;

// The edge's reads of the outside data segments need and of the session's
// transcript: the checkout's gh logged in, memento installed, the transcript
// all JSON.
// The managed settings directory every test edge reads: test/setup.ts's, a
// directory that holds no policy.
export const noManagedSettings = (): Pick<DoctorEdge, "managedSettingsDir"> => ({
  managedSettingsDir: process.env.CC_CANDYBAR_CLAUDE_MANAGED_DIR!,
});

export const healthyDataEdge = (): Pick<
  DoctorEdge,
  "forge" | "memento" | "transcript"
> => ({
  transcript: () => ({
    kind: "ok",
    value: { lines: 3, unparsed: 0, whole: true },
  }),
  forge: () => ({
    kind: "ok",
    value: { cli: "gh", host: "github.com", status: "ready" },
  }),
  memento: () => ({ kind: "ok", value: "/plugins/memento" }),
});

// That daemon, as `cc-candybar doctor` asks it: one session drawn a second
// ago by the native client beside it, whose payload carried the rate-limit
// windows — a session running with `claudeConfigDir`.
export const healthyDaemonIn = (
  claudeConfigDir: string,
): (() => Promise<DaemonAnswer>) => () =>
  Promise.resolve({
    rateLimits: {
      kind: "ok",
      value: [{ rateLimits: "carried", claudeConfigDir, ago: 1 }],
    },
    transcripts: {
      kind: "ok",
      value: [{ transcript: HEALTHY_TRANSCRIPT, ago: 1 }],
    },
    frames: {
      kind: "ok",
      value: [{ role: "statusline", frame: "still", claudeConfigDir, ago: 1 }],
    },
    widths: {
      kind: "ok",
      value: [{ sessionId: "s1", role: "statusline", termCols: 148 }],
    },
    clients: {
      kind: "ok",
      value: {
        bundle: HEALTHY_BUNDLE,
        clients: [
          {
            client: { kind: "native", bundle: HEALTHY_BUNDLE, source: null },
            ago: 1,
          },
        ],
      },
    },
    serving: { kind: "ok", value: HEALTHY_SERVING },
    stores: EMPTY_STORES,
  });

export const HEALTHY_DAEMON = healthyDaemonIn("/claude");

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
  askedBy: "command",
  config: { kind: "loaded", layers: [], warnings: [], unused: [] },
  frames: STILL,
  data: {
    pullRequests: { kind: "unneeded" },
    rateLimits: { kind: "unneeded" },
    memento: { kind: "unneeded" },
  },
  transcripts: {
    kind: "ok",
    value: [
      {
        ...HEALTHY_TRANSCRIPT,
        read: { kind: "ok", value: { lines: 3, unparsed: 0, whole: true } },
      },
    ],
  },
  urlHandler: { kind: "unsupported" },
  install: {
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
  },
  daemon: {
    serving: { kind: "ok", value: HEALTHY_SERVING },
    processes: { kind: "ok", value: [HEALTHY_PROCESS] },
    read: { kind: "ok", value: { through: null } },
  },
  nerdFont: { kind: "none" },
  marks: { kind: "ok", value: {} },
  clicked: { kind: "ok", value: [] },
  claudeSettings: {
    at: { managedDir: "/managed", projectDir: "/p", userFile: "/s.json" },
    sources: { kind: "ok", value: [] },
  },
};
