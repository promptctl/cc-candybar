<script lang="ts">
  import { liveTraits, plain, projects, withIdeas } from './model';
  import { SECTIONS, type Section } from './traits';
  import Ref from './Ref.svelte';
  import type { Explorer } from './explorer.svelte';

  let { go, explorer }: { go: (id: string) => void; explorer: Explorer } = $props();
  const sections = Object.keys(SECTIONS) as Section[];
</script>

<h2>{projects.length.toLocaleString()} Claude Code statuslines, by what they do</h2>
<p>
  Each coloured node is a characteristic. Its size is how many projects have it, and the grey
  lines join characteristics that often appear together. Click one to pull its projects into the
  graph, then click a project to read about it and see what it connects to. Orange-ringed projects
  have an idea a screening pass marked unusual. Purple dashed lines join projects that share code.
</p>
<p class="muted small">
  {withIdeas.length} projects have an unusual idea. {plain.length.toLocaleString()} only print fields
  from Claude Code's input and are listed, not opened. The characteristics come from haiku
  classifiers reading each project's write-up, so treat a count as approximate.
</p>
{#each sections as s}
  <h4 style:color={SECTIONS[s].colour}>{SECTIONS[s].label}</h4>
  {#each liveTraits.filter((t) => t.section === s) as t}
    <div class="row"><Ref id={'t:' + t.id} {go} /> <span class="muted small">{explorer.pool(t.id).length}</span></div>
  {/each}
{/each}

<style>
  .row { margin: 2px 0; }
</style>
