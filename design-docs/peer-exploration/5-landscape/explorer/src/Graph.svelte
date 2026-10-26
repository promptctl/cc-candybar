<script lang="ts">
  import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
  import fcose from 'cytoscape-fcose';
  import { onMount } from 'svelte';
  import type { Explorer, NodeId } from './explorer.svelte';
  import { members, projectById, traitById } from './model';
  import { SECTIONS } from './traits';

  cytoscape.use(fcose);
  let { explorer }: { explorer: Explorer } = $props();
  let el: HTMLDivElement;
  // Set once mounted; the effects below read it, so they re-run when it appears.
  let graphCore = $state.raw<Core>();

  function definition(id: NodeId): ElementDefinition {
    if (id.startsWith('t:')) {
      const t = traitById.get(id.slice(2))!;
      const n = members.get(t.id)!.length;
      return { data: { id, label: `${t.label} · ${n}`, colour: SECTIONS[t.section].colour, size: 14 + Math.sqrt(n) * 2.2 }, classes: 'trait' };
    }
    if (id.startsWith('more:')) {
      const t = id.slice(5);
      const left = members.get(t)!.length - (explorer.pages.get(t) ?? 0);
      return { data: { id, label: `+${left} more`, size: 12 }, classes: 'more' };
    }
    const p = projectById.get(id)!;
    return { data: { id, label: p.repo, size: 8 + Math.min(10, p.novel.length * 3) }, classes: p.novel.length ? 'project novel' : 'project' };
  }

  onMount(() => {
    const core = cytoscape({
      container: el,
      minZoom: 0.1,
      maxZoom: 4,
      style: [
        { selector: 'node', style: { width: 'data(size)', height: 'data(size)', 'background-color': '#c9ccd2', label: 'data(label)', color: '#e4e6ea', 'font-size': 10, 'text-valign': 'center', 'text-halign': 'right', 'text-margin-x': 4, 'min-zoomed-font-size': 7 } },
        { selector: 'node.trait', style: { 'background-color': 'data(colour)', 'font-size': 13, 'font-weight': 600, 'text-outline-color': '#101216', 'text-outline-width': 2 } },
        { selector: 'node.project', style: { 'background-color': '#6b717c', 'font-size': 10, 'text-opacity': 0.75 } },
        { selector: 'node.novel', style: { 'background-color': '#f0e0c8', 'border-color': '#e8a25c', 'border-width': 2, 'text-opacity': 1 } },
        { selector: 'node.more', style: { 'background-color': '#3a3f49', color: '#8b919c', 'font-style': 'italic' } },
        { selector: 'node:selected', style: { 'border-color': '#ffffff', 'border-width': 3 } },
        { selector: 'edge', style: { width: 1, 'line-color': '#2e333c', 'curve-style': 'haystack' } },
        { selector: 'edge.related', style: { width: 'mapData(w, 0, 0.6, 1, 7)', 'line-color': '#4a505b', opacity: 0.6 } },
        { selector: 'edge.clone', style: { width: 'mapData(w, 0.2, 1, 1.5, 5)', 'line-color': '#b58be0', 'line-style': 'dashed', 'curve-style': 'straight' } },
        { selector: '.faded', style: { opacity: 0.12 } },
        { selector: 'edge.lit', style: { 'line-color': '#e8a25c', opacity: 1 } },
      ],
    });
    core.on('tap', 'node', (e) => explorer.open(e.target.id() as NodeId));
    core.on('mouseover', 'node', (e) => {
      const hood = e.target.closedNeighborhood();
      core.elements().not(hood).addClass('faded');
      hood.edges().addClass('lit');
    });
    core.on('mouseout', 'node', () => core.elements().removeClass('faded lit'));
    graphCore = core;
    return () => core.destroy();
  });

  // [LAW:single-enforcer] the explorer decides what is shown; this effect only mirrors it into cytoscape.
  $effect(() => {
    const nodes = explorer.nodes;
    const edges = explorer.edges;
    const cy = graphCore;
    if (!cy) return;
    const want = new Set<string>([...nodes.map((n) => n.id), ...edges.map((e) => e.id)]);
    let added = 0;
    cy.batch(() => {
      cy.elements().filter((x) => !want.has(x.id())).remove();
      for (const n of nodes) {
        const have = cy.getElementById(n.id);
        if (have.nonempty()) {
          if (n.id.startsWith('more:')) have.data('label', definition(n.id).data.label);
          continue;
        }
        const from = n.parent ? cy.getElementById(n.parent) : null;
        const at = from?.nonempty() ? from.position() : { x: 0, y: 0 };
        cy.add({ ...definition(n.id), position: { x: at.x + (Math.random() - 0.5) * 80, y: at.y + (Math.random() - 0.5) * 80 } });
        added++;
      }
      for (const e of edges) {
        if (cy.getElementById(e.id).empty()) cy.add({ data: { id: e.id, source: e.source, target: e.target, w: e.w }, classes: e.kind });
      }
    });
    if (!added) return;
    const first = added === cy.nodes().length;
    cy.layout({
      name: 'fcose', randomize: first, fit: first, animate: !first, animationDuration: 600, quality: 'proof',
      nodeRepulsion: () => 60000, idealEdgeLength: (e: cytoscape.EdgeSingular) => (e.hasClass('related') ? 220 : 110),
      nodeSeparation: 120, gravity: 0.15,
      // Frame what was just opened, so its new neighbours are readable without zooming by hand.
      stop: () => {
        const at = explorer.selected && cy.getElementById(explorer.selected);
        if (at && at.nonempty()) cy.animate({ fit: { eles: at.closedNeighborhood(), padding: 60 }, duration: 400 });
      },
    } as cytoscape.LayoutOptions).run();
  });

  $effect(() => {
    const id = explorer.selected;
    const cy = graphCore;
    if (!cy) return;
    cy.nodes().unselect();
    if (id) cy.getElementById(id).select();
  });
</script>

<div class="graph" bind:this={el}></div>

<style>
  .graph { position: absolute; inset: 0 470px 0 0; }
</style>
