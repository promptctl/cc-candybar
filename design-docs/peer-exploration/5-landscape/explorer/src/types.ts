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
