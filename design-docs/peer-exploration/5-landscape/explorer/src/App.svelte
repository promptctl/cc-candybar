<script lang="ts">
  import { Explorer, type NodeId } from './explorer.svelte';
  import Graph from './Graph.svelte';
  import Panel from './Panel.svelte';
  import { liveTraits, projects } from './model';

  const explorer = new Explorer();
  let panelOpen = $state(true);
  let textScale = $state(1);
  const PANEL = 470;
  let query = $state('');
  const q = $derived(query.trim().toLowerCase());
  const hits = $derived.by(() => {
    if (q.length < 2) return [];
    const traits = liveTraits.filter((t) => t.label.toLowerCase().includes(q)).map((t) => ({ id: `t:${t.id}`, label: t.label, sub: 'characteristic' }));
    const ps = projects
      .filter((p) => !p.boring && (p.repo + ' ' + p.what + ' ' + p.novel.map((n) => n[0]).join(' ')).toLowerCase().includes(q))
      .slice(0, 40)
      .map((p) => ({ id: p.id, label: p.repo, sub: p.what.slice(0, 90) }));
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
    {#if hits.length}
      <div class="hits">
        {#each hits as h}<button onclick={() => pick(h.id)}><b>{h.label}</b> <span class="muted small">{h.sub}</span></button>{/each}
      </div>
    {/if}
  </div>
  {#if panelOpen}<Panel {explorer} />{/if}
</main>

<style>
  main { position: fixed; inset: 0; }
  .toggle { position: absolute; top: 12px; z-index: 4; width: 26px; height: 30px; background: var(--panel); color: var(--dim); border: 1px solid var(--line); border-radius: 6px 0 0 6px; font-size: 18px; line-height: 1; cursor: pointer; }
  .toggle:hover { color: var(--fg); }
  .scale { display: flex; align-items: center; gap: 6px; color: var(--dim); font-size: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; }
  .scale input { width: 140px; }
  .bar { position: absolute; left: 14px; top: 12px; display: flex; gap: 8px; z-index: 2; }
  input { width: 320px; background: var(--panel); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 9px; font: inherit; }
  .bar > button { background: var(--panel); color: var(--dim); border: 1px solid var(--line); border-radius: 6px; padding: 5px 10px; font: inherit; cursor: pointer; }
  .hits { position: absolute; top: 38px; left: 0; width: 460px; max-height: 60vh; overflow: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
  .hits button { display: block; width: 100%; text-align: left; background: none; border: 0; color: var(--fg); font: inherit; padding: 6px 10px; cursor: pointer; }
  .hits button:hover { background: #232730; }
</style>
