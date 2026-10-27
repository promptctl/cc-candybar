<script lang="ts">
  import { Explorer, type NodeId } from './explorer.svelte';
  import Graph from './Graph.svelte';
  import Panel from './Panel.svelte';
  import Bar from './Bar.svelte';
  import { liveTraits, projectById, projects } from './model';
  import { clock, SPEEDS } from './clock.svelte';
  import { bars as barsLoading } from './bars';
  import type { Bars } from './types';

  const explorer = new Explorer();
  // Deep links: the hash names the open node (#p:owner/repo or #t:trait), so a page with a node
  // open can be shared, and opening a node writes the hash. The hash is derived from the
  // selection, never a second record of it. [LAW:one-source-of-truth] Each opened node is a
  // history entry, so the back button walks back through what was opened.
  const fromHash = () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id === explorer.selected) return;
    if (id && (projectById.has(id) || liveTraits.some((t) => `t:${t.id}` === id))) explorer.open(id as NodeId);
    else if (!id) explorer.selected = null;
  };
  fromHash();
  $effect(() => {
    const want = explorer.selected ? '#' + explorer.selected : '';
    // Assigning the hash rather than history.pushState: Safari refuses the latter on file: URLs.
    if (location.hash !== want) location.hash = want;
  });
  $effect(() => {
    addEventListener('hashchange', fromHash);
    return () => removeEventListener('hashchange', fromHash);
  });
  // The selected project's captured bar, drawn where a statusline lives: along the bottom.
  // The frames inflate once after the page is up; until then no bar is drawn.
  let allBars = $state<Record<string, Bars> | null>(null);
  barsLoading.then((b) => (allBars = b));
  const bars = $derived.by(() => {
    const p = explorer.selected === null ? undefined : projectById.get(explorer.selected);
    return p && allBars ? (allBars[p.repo] ?? null) : null;
  });
  let panelOpen = $state(true);
  let textScale = $state(1);
  const PANEL = 470;
  let query = $state('');
  const q = $derived(query.trim().toLowerCase());
  const hits = $derived.by(() => {
    if (q.length < 2) return [];
    const traits = liveTraits.filter((t) => t.label.toLowerCase().includes(q)).map((t) => ({ id: `t:${t.id}`, label: t.label, sub: 'characteristic', live: false }));
    const ps = projects
      .filter((p) => !p.boring && (p.repo + ' ' + p.what + ' ' + p.novel.map((n) => n[0]).join(' ')).toLowerCase().includes(q))
      .slice(0, 40)
      .map((p) => ({ id: p.id, label: p.repo, sub: p.what.slice(0, 90), live: p.live }));
    return [...traits, ...ps];
  });
  function pick(id: string) {
    query = '';
    explorer.open(id as NodeId);
  }
</script>

<main>
  <Graph {explorer} right={panelOpen ? PANEL : 0} {textScale} />
  <button class="toggle" style:right="{panelOpen ? PANEL : 0}px" title={panelOpen ? 'hide the panel' : 'show the panel'} onclick={() => (panelOpen = !panelOpen)}>{panelOpen ? '›' : '‹'}</button>
  <div class="bar">
    <input placeholder="find a project or characteristic…" bind:value={query} />
    <button onclick={() => explorer.reset()}>reset graph</button>
    <label class="scale">text <input type="range" min="1" max="10" step="0.5" bind:value={textScale} /> {textScale}×</label>
    <div class="scale speed" title="how fast the bars play through the mock conversation">play
      {#each SPEEDS as s}<button class:on={clock.speed === s} onclick={() => (clock.speed = s)}>{s}×</button>{/each}
    </div>
    {#if hits.length}
      <div class="hits">
        {#each hits as h}<button onclick={() => pick(h.id)}><b class:live={h.live}>{h.label}</b> <span class="muted small">{h.sub}</span></button>{/each}
      </div>
    {/if}
  </div>
  {#if bars !== null}<div class="strip" style:right="{panelOpen ? PANEL : 0}px">{#key explorer.selected}<Bar {bars} />{/key}</div>{/if}
  {#if panelOpen}<Panel {explorer} />{/if}
</main>

<style>
  main { position: fixed; inset: 0; }
  .toggle { position: absolute; top: 12px; z-index: 4; width: 26px; height: 30px; background: var(--panel); color: var(--dim); border: 1px solid var(--line); border-radius: 6px 0 0 6px; font-size: 18px; line-height: 1; cursor: pointer; }
  .toggle:hover { color: var(--fg); }
  .scale { display: flex; align-items: center; gap: 6px; color: var(--dim); font-size: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; }
  .scale input { width: 140px; }
  .speed button { background: none; border: 0; color: var(--dim); font: inherit; padding: 0 4px; cursor: pointer; }
  .speed button.on { color: var(--live); }
  .bar { position: absolute; left: 14px; top: 12px; display: flex; gap: 8px; z-index: 2; }
  .strip { position: absolute; left: 0; bottom: 0; z-index: 3; padding: 0 14px 12px; pointer-events: none; }
  input { width: 320px; background: var(--panel); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 9px; font: inherit; }
  .bar > button { background: var(--panel); color: var(--dim); border: 1px solid var(--line); border-radius: 6px; padding: 5px 10px; font: inherit; cursor: pointer; }
  .hits { position: absolute; top: 38px; left: 0; width: 460px; max-height: 60vh; overflow: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
  .hits button { display: block; width: 100%; text-align: left; background: none; border: 0; color: var(--fg); font: inherit; padding: 6px 10px; cursor: pointer; }
  .hits button:hover { background: #232730; }
</style>
