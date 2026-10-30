<script lang="ts">
  import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
  import {
    forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY,
    type SimulationLinkDatum, type SimulationNodeDatum,
  } from 'd3-force';
  import { onMount, untrack } from 'svelte';
  import type { Explorer, GraphEdge, GraphNode, NodeId } from './explorer.svelte';
  import { projectById, traitById } from './model';
  import { SECTIONS } from './traits';

  // The simulation owns positions; cytoscape only draws them. Each frame the simulation's
  // coordinates are written into cytoscape, so a node the user drags pulls its neighbours with it.
  interface SimNode extends SimulationNodeDatum { id: NodeId; kind: 'trait' | 'project' | 'more'; r: number }
  interface SimLink extends SimulationLinkDatum<SimNode> { id: string; kind: GraphEdge['kind']; w: number }
  interface Box { x0: number; x1: number; y0: number; y1: number }

  // [LAW:one-type-per-behavior] one table per force: the kind of edge sets its pull, and the kind of node sets its push.
  const CHARGE: Record<SimNode['kind'], number> = { trait: -1400, project: -170, more: -40 };
  const DISTANCE: Record<GraphEdge['kind'], number> = { related: 180, has: 60, clone: 90 };
  // the zoom a user may reach, and the cap while a selection is framed
  const MAX_ZOOM = 4;
  const FRAME_ZOOM = 1;
  const STRENGTH: Record<GraphEdge['kind'], number> = { related: 0.2, has: 0.6, clone: 0.3 };
  // [LAW:one-source-of-truth] A label's on-screen font size, from its lens boost (0 to 1): the sheet
  // draws with it and the label force measures with it. Both ends scale with the text slider.
  const FONT = { trait: { at: 13, grow: 9 }, other: { at: 10, grow: 10 } };
  const fontOf = (kind: keyof typeof FONT, boost: number, scale: number) => (FONT[kind].at + FONT[kind].grow * boost) * scale;
  // the same size as a cytoscape mapping; s is the slider over the zoom, since cytoscape multiplies by zoom
  const fontMap = (kind: keyof typeof FONT, s: number) => `mapData(boost, 0, 1, ${fontOf(kind, 0, s)}, ${fontOf(kind, 1, s)})`;

  // The px the sidebar takes from the right; the graph fills the rest and resizes when this changes.
  // textScale multiplies every label size; 1 is the size the lens was tuned at.
  let { explorer, right = 470, textScale = 1 }: { explorer: Explorer; right?: number; textScale?: number } = $props();
  let el: HTMLDivElement;
  // Set once mounted; the effects below read it, so they re-run when it appears.
  let graphCore = $state.raw<Core>();

  const simNodes = new Map<NodeId, SimNode>();
  // A link pulls in proportion to how few other links its busier end has, as d3's default does.
  // At full strength, twenty projects each tied to three characteristics drag those
  // characteristics into one knot; shared out over the degree, a crowded node is held, not hauled.
  const degree = new Map<string, number>();
  const endId = (n: SimNode | string | number) => (typeof n === 'object' ? n.id : String(n));
  const linkForce = forceLink<SimNode, SimLink>([])
    .id((d) => d.id)
    .distance((l) => DISTANCE[l.kind])
    .strength((l) => STRENGTH[l.kind] / Math.max(1, Math.min(degree.get(endId(l.source)) ?? 1, degree.get(endId(l.target)) ?? 1)));
  // A low velocity decay lets nodes overshoot and wobble before they settle, which is the bounce.
  // A low alpha decay keeps a change moving for a few seconds instead of freezing at once.
  const sim = forceSimulation<SimNode, SimLink>([])
    .velocityDecay(0.2)
    .alphaDecay(0.015)
    .force('charge', forceManyBody<SimNode>().strength((d) => CHARGE[d.kind]))
    .force('link', linkForce)
    .force('collide', forceCollide<SimNode>((d) => d.r + 6).strength(0.8))
    .force('labels', labelForce)
    .force('x', forceX<SimNode>(0).strength(0.02))
    .force('y', forceY<SimNode>(0).strength(0.02))
    .on('tick', publish)
    .stop();

  function definition(id: NodeId): ElementDefinition {
    if (id.startsWith('t:')) {
      const t = traitById.get(id.slice(2))!;
      // [LAW:one-source-of-truth] the count is the pool the explorer pages through.
      const n = explorer.pool(t.id).length;
      return { data: { id, label: `${t.label} · ${n}`, colour: SECTIONS[t.section].colour, size: 16 + Math.sqrt(n) * 2.2 }, classes: 'trait' };
    }
    if (id.startsWith('more:')) {
      const t = id.slice(5);
      const left = explorer.pool(t).length - (explorer.pages.get(t) ?? 0);
      return { data: { id, label: `+${left} more`, size: 12 }, classes: 'more' };
    }
    const p = projectById.get(id)!;
    return { data: { id, label: p.repo, size: 9 + Math.min(10, p.novel.length * 3) }, classes: ['project', p.novel.length ? 'novel' : '', p.live ? 'live' : ''].join(' ') };
  }

  function shape(id: NodeId): { kind: SimNode['kind']; r: number } {
    const size = definition(id).data.size as number;
    return { kind: id.startsWith('t:') ? 'trait' : id.startsWith('more:') ? 'more' : 'project', r: size / 2 };
  }

  function publish() {
    const cy = graphCore;
    if (!cy) return;
    cy.batch(() => {
      for (const n of simNodes.values()) cy.getElementById(n.id).position({ x: n.x ?? 0, y: n.y ?? 0 });
    });
  }

  // A label's on-screen size, read from cytoscape's classes and data once per wake and reused by every
  // tick until something that changes a label (zoom, lens, hover, selection, a sync) marks it stale.
  // A dot whose label is not shown has none.
  let labelSizes: Map<NodeId, { w: number; h: number }> | null = null;
  const staleLabels = () => { labelSizes = null; };
  function measureLabels(cy: Core): Map<NodeId, { w: number; h: number }> {
    const out = new Map<NodeId, { w: number; h: number }>();
    const width = 160 * textScale;
    for (const id of simNodes.keys()) {
      const c = cy.getElementById(id);
      if (c.empty() || !(c.hasClass('trait') || c.hasClass('more') || c.hasClass('showlabel') || c.hasClass('lens'))) continue;
      const font = fontOf(c.hasClass('trait') ? 'trait' : 'other', c.data('boost') as number, textScale);
      const textWidth = String(c.data('label')).length * 0.6 * font;
      out.set(id, { w: Math.min(textWidth, width), h: Math.max(1, Math.ceil(textWidth / width)) * font * 1.3 });
    }
    return out;
  }

  // Text pushes text: where two label boxes overlap, they move apart along the axis that needs the
  // least movement, and each push lands on the dot the label hangs off, so the dots and text move together.
  // Boxes go into a grid whose cell is as large as the largest box, so two boxes can overlap only when
  // their cells touch, and each box is checked against its own and the eight neighbouring cells.
  function labelForce(alpha: number) {
    const cy = graphCore;
    if (!cy) return;
    const z = cy.zoom();
    labelSizes ??= measureLabels(cy);
    const nodes: SimNode[] = [];
    const boxes: Box[] = [];
    let cell = 0;
    for (const [id, size] of labelSizes) {
      const n = simNodes.get(id);
      if (!n) continue;
      const w = size.w / z;
      const h = size.h / z;
      // text-halign is right, so the text starts just outside the dot.
      const x0 = (n.x ?? 0) + n.r + 4 / z;
      const y0 = (n.y ?? 0) - h / 2;
      nodes.push(n);
      boxes.push({ x0, x1: x0 + w, y0, y1: y0 + h });
      cell = Math.max(cell, w, h);
    }
    if (!cell) return;
    const grid = new Map<string, number[]>();
    const key = (gx: number, gy: number) => `${gx},${gy}`;
    boxes.forEach((b, i) => {
      const k = key(Math.floor(b.x0 / cell), Math.floor(b.y0 / cell));
      const list = grid.get(k);
      if (list) list.push(i);
      else grid.set(k, [i]);
    });
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      const gx = Math.floor(a.x0 / cell);
      const gy = Math.floor(a.y0 / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(key(gx + dx, gy + dy)) ?? []) {
          if (j <= i) continue;
          const b = boxes[j];
          const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
          const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
          if (ox <= 0 || oy <= 0) continue;
          const na = nodes[i];
          const nb = nodes[j];
          if (ox < oy) {
            const dir = (a.x0 + a.x1 < b.x0 + b.x1 ? -1 : 1) * ox * alpha * 0.5;
            na.vx = (na.vx ?? 0) + dir;
            nb.vx = (nb.vx ?? 0) - dir;
          } else {
            const dir = (a.y0 + a.y1 < b.y0 + b.y1 ? -1 : 1) * oy * alpha * 0.5;
            na.vy = (na.vy ?? 0) + dir;
            nb.vy = (nb.vy ?? 0) - dir;
          }
        }
      }
    }
  }

  // A zoom, a cursor move or a size change moves label boxes without moving any dot, so the simulation is
  // woken to push them apart.
  function wake() {
    staleLabels();
    sim.alpha(Math.max(sim.alpha(), 0.1)).restart();
  }

  // Projects get a label only when zoomed in, when they touch the open node, or while hovered.
  // A label on every project is what made the text unreadable.
  function updateLabels() {
    const cy = graphCore;
    if (!cy) return;
    staleLabels();
    const close = cy.zoom() >= 1.3;
    const focus = explorer.selected ? cy.getElementById(explorer.selected) : cy.collection();
    const near = focus.nonempty() ? focus.closedNeighborhood() : cy.collection();
    cy.nodes('.project').forEach((n) => {
      n.toggleClass('showlabel', close || near.contains(n));
    });
  }

  // [LAW:single-enforcer] the explorer decides what is shown; this mirrors it into the simulation and into cytoscape.
  function sync(nodes: GraphNode[], edges: GraphEdge[]) {
    const cy = graphCore;
    if (!cy) return;
    const want = new Set<string>(nodes.map((n) => n.id));
    for (const id of [...simNodes.keys()]) if (!want.has(id)) simNodes.delete(id);
    for (const n of nodes) {
      const known = simNodes.get(n.id);
      if (known) {
        // a characteristic's count, and so its dot, changes with the pool filter; collision follows the dot
        known.r = shape(n.id).r;
        continue;
      }
      // A new node starts where the node that opened it is, so it springs out from there.
      const at = n.parent ? simNodes.get(n.parent) : undefined;
      const jitter = () => (Math.random() - 0.5) * 20;
      simNodes.set(n.id, { ...shape(n.id), id: n.id, x: (at?.x ?? 0) + jitter(), y: (at?.y ?? 0) + jitter() });
    }
    const shown = edges.filter((e) => simNodes.has(e.source) && simNodes.has(e.target));
    // d3 rewrites a link's source and target into node objects, so the simulation gets its own copies.
    const live = shown.map((e) => ({ id: e.id, source: e.source, target: e.target, kind: e.kind, w: e.w }));
    degree.clear();
    for (const e of shown) for (const end of [e.source, e.target]) degree.set(end, (degree.get(end) ?? 0) + 1);
    // d3's link force resolves ids the moment its links are set, against the nodes it already has,
    // so the links are emptied, the nodes replaced, and only then the new links set.
    linkForce.links([]);
    sim.nodes([...simNodes.values()]);
    linkForce.links(live);
    sim.alpha(Math.max(sim.alpha(), 0.6)).restart();

    const keep = new Set<string>([...want, ...shown.map((e) => e.id)]);
    cy.batch(() => {
      cy.elements().filter((x) => !keep.has(x.id())).remove();
      for (const n of simNodes.values()) {
        const have = cy.getElementById(n.id);
        if (have.nonempty()) {
          // a count can change under a node that stays (the pool filter, a page): its label and size follow
          const { label, size } = definition(n.id).data;
          have.data({ label, size });
          continue;
        }
        const def = definition(n.id);
        cy.add({ ...def, data: { ...def.data, boost: 0 }, position: { x: n.x ?? 0, y: n.y ?? 0 } });
      }
      for (const e of shown) {
        if (cy.getElementById(e.id).empty()) cy.add({ data: { id: e.id, source: e.source, target: e.target, w: e.w }, classes: e.kind });
      }
    });
    updateLabels();
  }

  // One stylesheet, with every text size scaled by s. The slider is the only thing that changes s.
  function sheet(s: number): cytoscape.StylesheetJson {
    return [
      { selector: 'node', style: { width: 'data(size)', height: 'data(size)', 'background-color': '#c9ccd2', color: '#f2f3f5', 'font-size': fontMap('other', s), 'text-valign': 'center', 'text-halign': 'right', 'text-margin-x': 5, 'min-zoomed-font-size': 9, 'text-wrap': 'wrap', 'text-max-width': `${160 * s}px`, 'text-background-color': '#101216', 'text-background-opacity': 0.85, 'text-background-padding': '3px', 'text-background-shape': 'roundrectangle' } },
      { selector: 'node.trait', style: { label: 'data(label)', 'background-color': 'data(colour)', 'font-size': fontMap('trait', s), 'font-weight': 600 } },
      { selector: 'node.more', style: { label: 'data(label)', 'background-color': '#3a3f49', color: '#8b919c', 'font-style': 'italic' } },
      { selector: 'node.project', style: { label: '', 'background-color': '#6b717c' } },
      { selector: 'node.project.showlabel', style: { label: 'data(label)' } },
      { selector: 'node.project.lens', style: { label: 'data(label)' } },
      { selector: 'node.novel', style: { 'background-color': '#f0e0c8', 'border-color': '#e8a25c', 'border-width': 2 } },
      // a project whose bar plays along the bottom when opened; the novel border stays, the fill says live
      { selector: 'node.live', style: { 'background-color': '#5fc0a8' } },
      { selector: 'node:selected', style: { 'border-color': '#ffffff', 'border-width': 3 } },
      { selector: 'edge', style: { width: 1, 'line-color': '#2e333c', 'curve-style': 'haystack' } },
      { selector: 'edge.related', style: { width: 'mapData(w, 0, 0.6, 1, 7)', 'line-color': '#4a505b', opacity: 0.6 } },
      { selector: 'edge.clone', style: { width: 'mapData(w, 0.2, 1, 1.5, 5)', 'line-color': '#b58be0', 'line-style': 'dashed', 'curve-style': 'straight' } },
      { selector: '.faded', style: { opacity: 0.12 } },
      { selector: 'edge.lit', style: { 'line-color': '#e8a25c', opacity: 1 } },
    ];
  }

  onMount(() => {
    const core = cytoscape({ container: el, minZoom: 0.1, maxZoom: MAX_ZOOM, style: sheet(textScale) });
    core.on('tap', 'node', (e) => explorer.open(e.target.id() as NodeId));
    core.on('grab', 'node', (e) => {
      const n = simNodes.get(e.target.id() as NodeId);
      if (!n) return;
      n.fx = n.x;
      n.fy = n.y;
      sim.alphaTarget(0.3).restart();
    });
    core.on('drag', 'node', (e) => {
      const n = simNodes.get(e.target.id() as NodeId);
      if (!n) return;
      n.fx = e.target.position().x;
      n.fy = e.target.position().y;
    });
    core.on('free', 'node', (e) => {
      const n = simNodes.get(e.target.id() as NodeId);
      if (n) {
        n.fx = null;
        n.fy = null;
      }
      sim.alphaTarget(0);
    });
    // Cytoscape draws text at the zoom level, so the sizes are divided by zoom to hold them still on screen.
    // A wheel fires many zoom events per frame; the work runs once per frame, for the zoom it ends at.
    let zoomFrame = 0;
    core.on('zoom', () => {
      if (zoomFrame) return;
      zoomFrame = requestAnimationFrame(() => {
        zoomFrame = 0;
        core.style().fromJson(sheet(textScale / core.zoom())).update();
        updateLabels();
        wake();
      });
    });
    // A lens under the cursor: text grows with closeness, and nearby projects show their names.
    // [LAW:dataflow-not-control-flow] the cursor writes one number per node; the style reads it.
    // Full size inside FULL (about the diameter of a large dot), then a ramp to nothing at LENS.
    const FULL = 60;
    const LENS = 600;
    // The lens is computed once per frame for the latest cursor, in tenths, so the label force is
    // woken when a label's size steps, not on every pixel the cursor moves.
    let cursor: { x: number; y: number } | null = null;
    let lensFrame = 0;
    core.on('mousemove', (e) => {
      cursor = e.position;
      if (lensFrame) return;
      lensFrame = requestAnimationFrame(lens);
    });
    function lens() {
      lensFrame = 0;
      const at = cursor;
      if (!at) return;
      let changed = false;
      core.batch(() => {
        core.nodes().forEach((n) => {
          const d = Math.hypot(n.position('x') - at.x, n.position('y') - at.y);
          const b = Math.round(Math.min(1, Math.max(0, (LENS - d) / (LENS - FULL))) * 10) / 10;
          if (b !== n.data('boost')) {
            n.data('boost', b);
            changed = true;
          }
          if (n.hasClass('project')) n.toggleClass('lens', b > 0.3);
        });
      });
      if (changed) wake();
    }
    core.on('mouseout', (e) => {
      if (e.target !== core) return;
      cursor = null;
      core.batch(() => {
        core.nodes().forEach((n) => {
          n.data('boost', 0);
          if (n.hasClass('project')) n.removeClass('lens');
        });
      });
      wake();
    });
    core.on('mouseover', 'node', (e) => {
      const hood = e.target.closedNeighborhood();
      core.elements().not(hood).addClass('faded');
      hood.edges().addClass('lit');
      hood.nodes('.project').addClass('showlabel');
      staleLabels();
    });
    core.on('mouseout', 'node', () => {
      core.elements().removeClass('faded lit');
      updateLabels();
    });
    graphCore = core;
    return () => {
      sim.stop();
      cancelAnimationFrame(zoomFrame);
      cancelAnimationFrame(lensFrame);
      core.destroy();
    };
  });

  $effect(() => {
    right;
    graphCore?.resize();
  });

  $effect(() => {
    const s = textScale;
    const cy = graphCore;
    cy?.style().fromJson(sheet(s / cy.zoom())).update();
    wake();
  });

  $effect(() => {
    const nodes = explorer.nodes;
    const edges = explorer.edges;
    if (!graphCore) return;
    // Only what is shown drives a sync; the selection it reads for labels has its own effect, so
    // selecting a node already on screen relabels without re-energising the layout.
    untrack(() => sync(nodes, edges));
  });

  $effect(() => {
    const id = explorer.selected;
    const cy = graphCore;
    if (!cy) return;
    cy.nodes().unselect();
    if (id) cy.getElementById(id).select();
    updateLabels();
    // Frame what was just opened once its new neighbours have sprung out a little.
    const t = setTimeout(() => {
      const at = id ? cy.getElementById(id) : cy.collection();
      const eles = at.nonempty() ? at.closedNeighborhood() : cy.elements();
      // A small neighbourhood would otherwise zoom until labels fill the screen, so the frame is capped
      // at a readable zoom, and the cap is lifted once the frame lands.
      cy.maxZoom(FRAME_ZOOM);
      cy.animate({ fit: { eles, padding: 80 }, duration: 500, complete: () => cy.maxZoom(MAX_ZOOM) });
    }, 700);
    // A newer selection, or the graph going away, ends this frame wherever it is: the animation is
    // stopped and the cap lifted here, since its completion will never run.
    return () => {
      clearTimeout(t);
      // on unmount the graph may already be destroyed, and there is nothing left to stop
      if (cy.destroyed()) return;
      cy.stop(true, false);
      cy.maxZoom(MAX_ZOOM);
    };
  });
</script>

<div class="graph" bind:this={el} style:right="{right}px"></div>

<style>
  .graph { position: absolute; top: 0; bottom: 0; left: 0; }
</style>
