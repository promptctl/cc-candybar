export interface MockSegment {
  type: string;
  text: string;
}

export interface MockSample {
  name: string;
  segments: MockSegment[];
}

export const MOCK_SAMPLES: MockSample[] = [
  {
    name: "Default Session",
    segments: [
      { type: "directory", text: "~/projects/my-app" },
      { type: "git", text: "main ✗" },
      { type: "model", text: "Claude Sonnet 4" },
      { type: "session", text: "$2.34 · 45k tok" },
      { type: "context", text: "38%" },
    ],
  },
  {
    name: "Heavy Usage",
    segments: [
      { type: "directory", text: "~/work/api-server" },
      { type: "git", text: "feat/auth ✗ +3" },
      { type: "model", text: "Claude Opus 4" },
      { type: "session", text: "$12.87 · 156k tok" },
      { type: "context", text: "72%" },
      { type: "block", text: "blk #3 $4.20" },
      { type: "today", text: "today $18.50" },
    ],
  },
  {
    name: "Critical Context",
    segments: [
      { type: "directory", text: "~/big-project" },
      { type: "git", text: "main ✓" },
      { type: "model", text: "Claude Opus 4" },
      { type: "session", text: "$45.20 · 198k tok" },
      { type: "contextCritical", text: "95% ⚠" },
      { type: "metrics", text: "1.2s 42msg" },
    ],
  },
  {
    name: "Full Segments",
    segments: [
      { type: "directory", text: "~/code/toolkit" },
      { type: "git", text: "fix/bug-123 ↑2 ↓1" },
      { type: "model", text: "Claude Sonnet 4" },
      { type: "session", text: "$5.67 · 78k tok" },
      { type: "block", text: "blk #7 $1.23" },
      { type: "today", text: "today $22.10" },
      { type: "context", text: "45%" },
      { type: "metrics", text: "0.8s 89msg +420 -180" },
      { type: "version", text: "v1.2.3" },
      { type: "weekly", text: "wk $87.30" },
    ],
  },
  {
    name: "Minimal",
    segments: [
      { type: "directory", text: "~" },
      { type: "model", text: "Claude" },
    ],
  },
];
