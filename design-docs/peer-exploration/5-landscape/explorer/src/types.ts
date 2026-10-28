// The shape tools/export.py writes. A project that only prints Claude Code's input fields
// ("boring") carries no long fields: it is listed and linked, never opened.
export type Novel = [item: string, whyUnusual: string, group: string];

export interface RawProject {
  rank: number;
  band: string;
  repo: string;
  // Absent when the project's link is its GitHub repository; the page derives that link.
  url?: string;
  commits: number;
  last: string;
  lang: string;
  what: string;
  shape: string;
  motive: string;
  fams: string[];
  loc: number;
  fam: number | null;
  novel: Novel[];
  boring: boolean;
  copy: [repo: string, percent: number][];
  // The risk tier the capture triage stamped (tools/capture/triage.py), and whether its bar was
  // captured: ran in the sandbox and printed something. The frames themselves live in bars.ts.
  tier: 'skip' | 'unlocated' | 'safe' | 'review' | 'risky';
  live: boolean;
  // The bundles holding this project's frames and its long text, or null when it has neither.
  bar: number | null;
  detail: number | null;
  created?: string;
  size?: string;
  sources?: string;
  lineage?: string;
  why?: string;
  beyond?: string;
  summary?: string;
  fork?: string;
}

// What a statusline printed in the sandbox through the fixture's 120-second conversation, keyed
// by terminal width: a frame for each tick at which the output changed. A width whose frames
// matched the next narrower one is left out.
export type Bars = Record<string, [tick: number, out: string][]>;

export interface RawData {
  projects: RawProject[];
  families: { size: number; members: string[] }[];
  fnames: Record<string, string>;
  motives: Record<string, string>;
  groups: string[];
}
