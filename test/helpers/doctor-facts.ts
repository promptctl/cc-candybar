import type { DaemonProcess, DoctorFacts } from "../../src/doctor/checks";
import type { DoctorEdge, InstallEdge } from "../../src/doctor/edge";
import type { DaemonAnswer } from "../../src/doctor/daemon-answer";
import type { ServingDaemon } from "../../src/daemon/limits";
import type { PostMortemsReadStore } from "../../src/doctor/post-mortems-read";
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

// The read record as memory, starting from `initial`.
export function memoryPostMortemsRead(
  initial: string | null = null,
): PostMortemsReadStore {
  let through = initial;
  return {
    read: () => ({ kind: "ok", value: through }),
    record: (identity) => {
      through = identity;
    },
  };
}

// The edge's reads of that daemon: the one process, nothing filed read.
export const healthyDaemonEdge = (): Pick<
  DoctorEdge,
  "daemons" | "postMortemsRead"
> => ({
  daemons: () => ({ kind: "ok", value: [HEALTHY_PROCESS] }),
  postMortemsRead: memoryPostMortemsRead(),
});

// That daemon, as `cc-candybar doctor` asks it: one session drawn a second
// ago by the native client beside it.
export const HEALTHY_DAEMON = (): Promise<DaemonAnswer> =>
  Promise.resolve({
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
  });

// A setup every check passes, asked for by the command: the base a doctor
// test spreads the facts it is about over.
export const HEALTHY_FACTS: DoctorFacts = {
  tmux: { kind: "outside" },
  termCols: 120,
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
  effect: { kind: "decided", name: "none", value: "none" },
  placementEffects: [],
  transitions: false,
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
    read: { kind: "ok", value: null },
  },
  nerdFont: { kind: "none" },
  marks: { kind: "ok", value: {} },
  clicked: { kind: "ok", value: [] },
  claudeSettings: { path: "/s.json", env: {}, statusLine: { kind: "absent" } },
};
