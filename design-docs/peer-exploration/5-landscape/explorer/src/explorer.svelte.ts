import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { cloneLinks, liveTraits, members, projectById, traitLinks, type Project } from './model';

// The graph on screen is a set of shown node ids. Every edge is derived from that set, so an
// edge can never outlive or miss one of its ends. [LAW:one-source-of-truth]
export type NodeId = `t:${string}` | `p:${string}` | `more:${string}`;
export interface GraphNode { id: NodeId; parent?: NodeId }
export interface GraphEdge { id: string; source: NodeId; target: NodeId; kind: 'related' | 'has' | 'clone'; w: number }

const PAGE = 20;
const traitNode = (id: string) => `t:${id}` as NodeId;

export class Explorer {
  shown = new SvelteSet<NodeId>();
  parent = new Map<NodeId, NodeId>();
  pages = new SvelteMap<string, number>();
  selected = $state<NodeId | null>(null);
  // When on, a characteristic lists only the projects whose bar was captured. [LAW:one-source-of-truth] every list of members goes through pool().
  barsOnly = $state(false);

  keep<P extends { live: boolean }>(ps: P[]): P[] {
    return this.barsOnly ? ps.filter((p) => p.live) : ps;
  }

  pool(t: string): Project[] {
    return this.keep(members.get(t)!);
  }

  constructor() {
    this.reset();
  }

  reset() {
    this.shown.clear();
    this.pages.clear();
    this.parent.clear();
    liveTraits.forEach((t) => this.shown.add(traitNode(t.id)));
    this.selected = null;
  }

  private show(id: NodeId, parent?: NodeId) {
    if (!this.shown.has(id) && parent) this.parent.set(id, parent);
    this.shown.add(id);
  }

  // Opening a characteristic pulls in its next page of projects; opening a project pulls in its
  // characteristics and the projects it shares code with.
  open(id: NodeId): void {
    if (id.startsWith('more:')) return this.open(traitNode(id.slice(5)));
    this.show(id);
    this.selected = id;
    if (id.startsWith('t:')) {
      const t = id.slice(2);
      const ps = this.pool(t);
      const page = Math.min(ps.length, (this.pages.get(t) ?? 0) + PAGE);
      this.pages.set(t, page);
      ps.slice(0, page).forEach((p) => this.show(p.id as NodeId, id));
    } else {
      const p = projectById.get(id)!;
      p.traits.forEach((t) => this.show(traitNode(t), id));
      cloneLinks(p).forEach((c) => this.show(c.other.id as NodeId, id));
    }
  }

  nodes = $derived.by((): GraphNode[] => {
    const out: GraphNode[] = [...this.shown].map((id) => ({ id, parent: this.parent.get(id) }));
    this.pages.forEach((page, t) => {
      if (page < this.pool(t).length) out.push({ id: `more:${t}`, parent: traitNode(t) });
    });
    return out;
  });

  edges = $derived.by((): GraphEdge[] => {
    const on = this.shown;
    const out: GraphEdge[] = [];
    for (const l of traitLinks) {
      const [a, b] = [traitNode(l.a), traitNode(l.b)];
      if (on.has(a) && on.has(b)) out.push({ id: `r:${l.a}|${l.b}`, source: a, target: b, kind: 'related', w: l.w });
    }
    for (const id of on) {
      if (!id.startsWith('p:')) continue;
      const p = projectById.get(id)!;
      for (const t of p.traits) if (on.has(traitNode(t))) out.push({ id: `h:${id}|${t}`, source: id, target: traitNode(t), kind: 'has', w: 1 });
      for (const c of cloneLinks(p)) {
        if (on.has(c.other.id as NodeId) && p.id < c.other.id) out.push({ id: `c:${p.id}|${c.other.id}`, source: id, target: c.other.id as NodeId, kind: 'clone', w: c.percent / 100 });
      }
    }
    for (const [t, page] of this.pages) {
      if (page < this.pool(t).length) out.push({ id: `m:${t}`, source: traitNode(t), target: `more:${t}`, kind: 'has', w: 1 });
    }
    return out;
  });
}
