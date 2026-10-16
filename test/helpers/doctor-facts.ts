import type { DoctorFacts } from "../../src/doctor/checks";

// A setup every check passes, asked for by the command: the base a doctor
// test spreads the facts it is about over.
export const HEALTHY_FACTS: DoctorFacts = {
  tmux: { kind: "outside" },
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
  nerdFont: { kind: "none" },
  marks: { kind: "ok", value: {} },
  claudeSettings: { path: "/s.json", env: {}, statusLine: { kind: "absent" } },
};
