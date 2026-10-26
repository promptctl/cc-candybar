<script lang="ts">
  import { Explorer, type NodeId } from './explorer.svelte';
  import Graph from './Graph.svelte';
  import Panel from './Panel.svelte';
  import { liveTraits, projects } from './model';

  const explorer = new Explorer();
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
  <Graph {explorer} />
  <div class="bar">
    <input placeholder="find a project or characteristic…" bind:value={query} />
    <button onclick={() => explorer.reset()}>reset graph</button>
    {#if hits.length}
      <div class="hits">
        {#each hits as h}<button onclick={() => pick(h.id)}><b>{h.label}</b> <span class="muted small">{h.sub}</span></button>{/each}
      </div>
    {/if}
  </div>
  <Panel {explorer} />
</main>

<style>
  main { position: fixed; inset: 0; }
  .bar { position: absolute; left: 14px; top: 12px; display: flex; gap: 8px; z-index: 2; }
  input { width: 320px; background: var(--panel); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 9px; font: inherit; }
  .bar > button { background: var(--panel); color: var(--dim); border: 1px solid var(--line); border-radius: 6px; padding: 5px 10px; font: inherit; cursor: pointer; }
  .hits { position: absolute; top: 38px; left: 0; width: 460px; max-height: 60vh; overflow: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
  .hits button { display: block; width: 100%; text-align: left; background: none; border: 0; color: var(--fg); font: inherit; padding: 6px 10px; cursor: pointer; }
  .hits button:hover { background: #232730; }
</style>
