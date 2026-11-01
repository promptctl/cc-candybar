import type { RawProject } from './types';

// [LAW:dataflow-not-control-flow] Every functional characteristic is one row here: a test over the
// classifier labels already on each project (feature families F01–F34, motive M01–M16, novelty
// group, and the reader's "what it is"). Adding a characteristic is adding a row.

export type Section = 'what' | 'unusual' | 'shows' | 'where' | 'fun' | 'plumbing';

export const SECTIONS: Record<Section, { label: string; colour: string }> = {
  what: { label: 'What it is', colour: '#c9ccd2' },
  unusual: { label: 'Unusual ideas', colour: '#e8a25c' },
  fun: { label: 'Fun and looks', colour: '#e07fb0' },
  shows: { label: 'What it shows', colour: '#6f9be8' },
  where: { label: 'Where and for whom', colour: '#7cc4a8' },
  plumbing: { label: 'How it is built', colour: '#9a8be0' },
};

interface Labels {
  f: Set<string>;
  m: string;
  g: Set<string>;
  kind: string;
}

export interface Trait {
  id: string;
  label: string;
  section: Section;
  test: (l: Labels) => boolean;
}

const G = {
  feeds: "feeds the bar's numbers back to Claude or gates it",
  llm: 'LLM-written text about the session',
  mood: 'reads mood, fatigue or personality',
  grades: 'grades the prompt or the reply',
  failure: 'detects a failure mode in the session',
  medium: 'turns the bar into another medium (game, reader)',
  study: 'practice or study in the bar (flashcards, language drills)',
  patches: 'patches Claude Code itself or its traffic',
  eta: 'predicts how long the work will take',
  friends: 'shows friends or other users',
};
const anyF = (...c: string[]) => (l: Labels) => c.some((x) => l.f.has(x));

export const TRAITS: Trait[] = [
  { id: 'not-sl', label: 'Not a statusline', section: 'what', test: (l) => l.kind === 'not a statusline' || l.m === 'M16' },
  { id: 'inside', label: 'Part of a bigger tool', section: 'what', test: (l) => l.kind === 'statusline inside a larger tool' || l.m === 'M02' },
  { id: 'dotfiles', label: "Someone's own setup", section: 'what', test: (l) => l.kind === 'personal dotfiles' || l.m === 'M01' },
  { id: 'framework', label: 'Framework for others to configure', section: 'what', test: (l) => anyF('F21', 'F22')(l) || l.m === 'M13' },
  { id: 'port', label: 'Faster rewrite or port', section: 'what', test: (l) => l.m === 'M07' },
  { id: 'variant', label: 'Fork or variant of another', section: 'what', test: (l) => l.m === 'M08' },
  { id: 'wraps', label: 'Wraps another statusline', section: 'what', test: (l) => l.f.has('F34') || l.kind === 'config or wrapper for another statusline' },

  { id: 'feeds', label: 'Feeds data back into Claude', section: 'unusual', test: (l) => l.g.has(G.feeds) },
  { id: 'llm', label: 'Asks a model to write the bar', section: 'unusual', test: (l) => l.g.has(G.llm) },
  { id: 'judges', label: 'Reads mood or grades prompts', section: 'unusual', test: (l) => l.g.has(G.mood) || l.g.has(G.grades) },
  { id: 'failure', label: 'Spots the session going wrong', section: 'unusual', test: (l) => l.g.has(G.failure) },
  { id: 'patches', label: 'Patches Claude Code itself', section: 'unusual', test: (l) => l.g.has(G.patches) },
  { id: 'eta', label: 'Predicts how long work will take', section: 'unusual', test: (l) => l.g.has(G.eta) },
  { id: 'friends', label: 'Shows other people', section: 'unusual', test: (l) => l.g.has(G.friends) },
  { id: 'odd', label: 'Other unusual ideas', section: 'unusual', test: (l) => l.g.has('unsorted') },

  { id: 'games', label: 'Games, reading, study', section: 'fun', test: (l) => l.g.has(G.medium) || l.g.has(G.study) },
  { id: 'pets', label: 'Pets, mascots, animation', section: 'fun', test: (l) => l.f.has('F12') || l.m === 'M12' },
  { id: 'themes', label: 'Themes and styling', section: 'fun', test: (l) => l.f.has('F32') || l.m === 'M06' },
  { id: 'tips', label: 'Tips, coaching, rotating messages', section: 'fun', test: anyF('F28') },
  { id: 'ambient', label: 'Weather, clocks, markets', section: 'fun', test: anyF('F18') },

  { id: 'quota', label: 'Plan quota and limits', section: 'shows', test: (l) => l.f.has('F01') || l.m === 'M03' },
  { id: 'cost', label: 'Cost and spend history', section: 'shows', test: (l) => anyF('F03', 'F04')(l) || l.m === 'M04' },
  { id: 'burn', label: 'Burn rate and run-out forecast', section: 'shows', test: anyF('F02') },
  { id: 'context', label: 'Context window and compaction', section: 'shows', test: (l) => l.f.has('F07') || l.m === 'M05' },
  { id: 'cache', label: 'Prompt cache', section: 'shows', test: anyF('F06') },
  { id: 'activity', label: 'Live tools, agents, todos', section: 'shows', test: anyF('F05') },
  { id: 'git', label: 'Git beyond the branch, PRs, CI', section: 'shows', test: anyF('F08', 'F29') },
  { id: 'env', label: 'Project and environment', section: 'shows', test: anyF('F30') },
  { id: 'machine', label: 'Machine metrics', section: 'shows', test: anyF('F17') },
  { id: 'health', label: 'Anthropic service status', section: 'shows', test: anyF('F16') },
  { id: 'controls', label: 'Claude Code modes and effort', section: 'shows', test: anyF('F27') },
  { id: 'time', label: 'Timers, idle, streaks', section: 'shows', test: anyF('F31') },

  { id: 'fleet', label: 'Many sessions at once', section: 'where', test: (l) => l.f.has('F09') || l.m === 'M10' },
  { id: 'clis', label: 'Other AI CLIs too', section: 'where', test: (l) => l.f.has('F10') || l.m === 'M11' },
  { id: 'accounts', label: 'Several accounts', section: 'where', test: anyF('F11') },
  { id: 'outside', label: 'Outside the terminal', section: 'where', test: (l) => l.f.has('F20') || l.m === 'M14' },
  { id: 'tmux', label: 'tmux', section: 'where', test: anyF('F24') },
  { id: 'locale', label: 'Other languages and regions', section: 'where', test: (l) => l.f.has('F25') || l.m === 'M09' },
  { id: 'alerts', label: 'Sounds and notifications', section: 'where', test: anyF('F19') },

  { id: 'daemon', label: 'Background refresh', section: 'plumbing', test: anyF('F13') },
  { id: 'width', label: 'Fits the terminal width', section: 'plumbing', test: anyF('F14') },
  { id: 'links', label: 'Clickable links', section: 'plumbing', test: anyF('F15') },
  { id: 'telemetry', label: 'Telemetry export', section: 'plumbing', test: anyF('F26') },
  { id: 'update', label: 'Self-update', section: 'plumbing', test: anyF('F23') },
  { id: 'install', label: 'Installers and doctors', section: 'plumbing', test: anyF('F33') },
];

// The characteristic a novelty group belongs to, found by asking the rows above rather than
// keeping a second mapping.
export function traitOfGroup(group: string): Trait {
  return TRAITS.find((t) => t.test({ f: new Set(), m: '', g: new Set([group]), kind: '' }))!;
}

// The kind is the description up to its first punctuation; the survey no longer stores it per project [LAW:one-source-of-truth].
export function traitsOf(p: RawProject): string[] {
  const kind = p.what.split(/[(:;,]/)[0].trim();
  const l: Labels = { f: new Set(p.fams), m: p.motive, g: new Set(p.novel.map((n) => n[2])), kind };
  return TRAITS.filter((t) => t.test(l)).map((t) => t.id);
}
