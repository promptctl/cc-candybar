<script lang="ts">
  // A name in the panel that opens its node in the graph, with the repo link beside a project.
  import { projectById, traitById } from './model';
  import { SECTIONS } from './traits';

  let { id, go }: { id: string; go: (id: string) => void } = $props();
  const project = $derived(id.startsWith('p:') ? projectById.get(id) : undefined);
  const trait = $derived(id.startsWith('t:') ? traitById.get(id.slice(2)) : undefined);
</script>

{#if project}
  {#if project.boring}
    <a href={project.url} target="_blank" rel="noopener">{project.repo}</a>
  {:else}
    <button class="ref" class:live={project.live} onclick={() => go(id)}>{project.repo}</button>
    <a class="out" href={project.url} target="_blank" rel="noopener" title="open on GitHub">↗</a>
  {/if}
{:else if trait}
  <button class="ref chip" style:--c={SECTIONS[trait.section].colour} onclick={() => go(id)}>{trait.label}</button>
{/if}

<style>
  .ref { background: none; border: 0; padding: 0; font: inherit; color: var(--fg); cursor: pointer; border-bottom: 1px dotted var(--dim); }
  .ref:hover { color: var(--idea); }
  .chip { border: 1px solid var(--c); border-radius: 10px; padding: 0 8px; margin: 2px 2px; color: var(--c); font-size: 12px; }
  .out { margin-left: 4px; text-decoration: none; }
</style>
