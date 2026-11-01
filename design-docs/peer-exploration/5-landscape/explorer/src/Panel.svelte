<script lang="ts">
  import type { Explorer, NodeId } from './explorer.svelte';
  import ProjectView from './ProjectView.svelte';
  import TraitView from './TraitView.svelte';
  import Intro from './Intro.svelte';

  let { explorer }: { explorer: Explorer } = $props();
  const go = (id: string) => explorer.open(id as NodeId);
  let scroller: HTMLElement;
  $effect(() => {
    explorer.selected;
    scroller?.scrollTo(0, 0);
  });
</script>

<aside bind:this={scroller}>
  {#if explorer.selected?.startsWith('p:')}
    <ProjectView id={explorer.selected} {go} />
  {:else if explorer.selected?.startsWith('t:')}
    <TraitView id={explorer.selected.slice(2)} {go} {explorer} />
  {:else}
    <Intro {go} {explorer} />
  {/if}
</aside>

<style>
  aside { position: absolute; top: 0; right: 0; bottom: 0; width: 470px; overflow: auto; padding: 18px 22px; background: var(--panel); border-left: 1px solid var(--line); }
</style>
