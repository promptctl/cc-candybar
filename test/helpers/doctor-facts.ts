import type { Asked, DoctorFacts } from "../../src/doctor/checks";
import type { InstallEdge } from "../../src/doctor/edge";
import type { DaemonClients } from "../../src/doctor/daemon-clients";
import { runningBundle, type ClientHint } from "../../src/client-hint";

// The `client` hint a healthy native client records: the bundle beside it is
// the one this process runs, the daemon a click reaches.
export const healthyClient = (): ClientHint => ({
  kind: "native",
  bundle: runningBundle(),
  source: null,
});

// One published install: the daemon's bundle and the native client beside it.
export const HEALTHY_BUNDLE = "/opt/cc/dist/index.mjs";

// The machine of that install: every path resolves to itself, no checkout.
export const HEALTHY_INSTALL_EDGE: InstallEdge = {
  realpath: (p) => ({ kind: "ok", value: p }),
  checkoutOf: () => null,
  digest: () => {
    throw new Error("doctor: no checkout in this test");
  },
  nativeShipped: true,
};

// Its daemon, as `cc-candybar doctor` asks it: one session drawn a second
// ago by the native client beside it.
export const HEALTHY_DAEMON = (): Promise<Asked<DaemonClients>> =>
  Promise.resolve({
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
          ago: 1,
        },
      ],
    },
  },
  nerdFont: { kind: "none" },
  marks: { kind: "ok", value: {} },
  clicked: { kind: "ok", value: [] },
  claudeSettings: { path: "/s.json", env: {}, statusLine: { kind: "absent" } },
};
