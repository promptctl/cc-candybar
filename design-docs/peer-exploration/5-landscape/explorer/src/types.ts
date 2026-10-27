// The shape tools/export.py writes. A project that only prints Claude Code's input fields
// ("boring") carries no long fields: it is listed and linked, never opened.
export type Novel = [item: string, whyUnusual: string, group: string];

export interface RawProject {
  rank: number;
  band: string;
  repo: string;
  url: string;
  commits: number;
  last: string;
  lang: string;
  what: string;
  kind: string;
  shape: string;
  motive: string;
  fams: string[];
  loc: number;
  fam: number | null;
  novel: Novel[];
  boring: boolean;
  copy: [repo: string, percent: number][];
  // The risk tier the capture triage stamped (tools/capture/triage.py), and the bytes the
  // statusline printed in the sandbox at each terminal width it was captured at, keyed by column
  // count. A width whose output matched the next narrower one is left out. Absent when it was not
  // run or failed.
  tier: 'skip' | 'unlocated' | 'safe' | 'review' | 'risky';
  bars?: Record<string, string>;
  created?: string;
  size?: string;
  sources?: string;
  lineage?: string;
  why?: string;
  beyond?: string;
  summary?: string;
  fork?: string;
}

export interface RawData {
  projects: RawProject[];
  families: { size: number; members: string[] }[];
  fnames: Record<string, string>;
  motives: Record<string, string>;
  groups: string[];
}
