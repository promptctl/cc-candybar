import raw from './data.json';
import { TRAITS, type Trait } from './traits';
import { traitsOf } from './traits';
import type { RawData, RawProject } from './types';

export interface Project extends RawProject {
  id: string;
  traits: string[];
  url: string;
}

// JSON infers novel items as string[]; export.py writes them as fixed triples, which RawData states.
const data = raw as unknown as RawData;
export const BANDS = ['45+', '20-44', '10-19', '5-9', '2-4', '0-1'] as const;
export const motives = data.motives;
export const families = data.families;

// A project's link is stored only when it is not the GitHub repository of its name [LAW:one-source-of-truth].
export const projects: Project[] = data.projects.map((p) => ({ ...p, id: 'p:' + p.repo.toLowerCase(), traits: traitsOf(p), url: p.url ?? 'https://github.com/' + p.repo }));
export const projectById = new Map(projects.map((p) => [p.id, p]));
export const traitById = new Map(TRAITS.map((t) => [t.id, t]));
export const bandSize = Object.fromEntries(BANDS.map((b) => [b, projects.filter((p) => p.band === b).length]));

// Within a characteristic, projects with a new idea come first, then the bigger ones.
const weight = (p: Project) => p.novel.length * 10000 + Math.min(p.loc, 9999);
export const members = new Map<string, Project[]>(TRAITS.map((t) => [t.id, []]));
export const plainMembers = new Map<string, Project[]>(TRAITS.map((t) => [t.id, []]));
for (const p of projects) for (const t of p.traits) (p.boring ? plainMembers : members).get(t)!.push(p);
members.forEach((ps) => ps.sort((a, b) => weight(b) - weight(a)));

export const plain = projects.filter((p) => p.boring);
export const withIdeas = projects.filter((p) => p.novel.length);
export const liveTraits: Trait[] = TRAITS.filter((t) => members.get(t.id)!.length);

// Each characteristic links to the two it shares the most projects with (Jaccard), so the
// opening graph shows which characteristics travel together.
function jaccard(a: string, b: string): number {
  const x = new Set(members.get(a)!.map((p) => p.id));
  const y = members.get(b)!;
  const both = y.filter((p) => x.has(p.id)).length;
  return both / (x.size + y.length - both);
}
export const traitLinks: { a: string; b: string; w: number }[] = (() => {
  const seen = new Map<string, { a: string; b: string; w: number }>();
  for (const t of liveTraits) {
    liveTraits
      .filter((u) => u.id !== t.id)
      .map((u) => ({ a: t.id, b: u.id, w: jaccard(t.id, u.id) }))
      .sort((x, y) => y.w - x.w)
      .slice(0, 2)
      .forEach((e) => seen.set([e.a, e.b].sort().join('|'), e));
  }
  return [...seen.values()];
})();

// A code overlap of 20% or more to another project that is worth opening.
export function cloneLinks(p: Project): { other: Project; percent: number }[] {
  return p.copy
    .map(([repo, percent]) => ({ other: projectById.get('p:' + repo.toLowerCase()), percent }))
    .filter((c): c is { other: Project; percent: number } => !!c.other && !c.other.boring && c.percent >= 20);
}

export const motiveName = (c: string) => motives[c] ?? (c.startsWith('other') ? c.replace('other: ', '') : 'unclassified');