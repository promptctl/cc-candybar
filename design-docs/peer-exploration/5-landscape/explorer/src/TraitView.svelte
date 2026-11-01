<script lang="ts">
  import { BANDS, bandSize, members, plainMembers, traitById, traitLinks } from './model';
  import { SECTIONS } from './traits';
  import Ref from './Ref.svelte';
  import type { Explorer } from './explorer.svelte';

  let { id, go, explorer }: { id: string; go: (id: string) => void; explorer: Explorer } = $props();
  const t = $derived(traitById.get(id)!);
  // [LAW:one-source-of-truth] the projects listed are the pool the graph pages through.
  const ps = $derived(explorer.pool(id));
  const plain = $derived(explorer.keep(plainMembers.get(id)!));
  // The band shares describe the characteristic, so they count every member, not the filtered pool.
  const all = $derived(members.get(id)!);
  const allPlain = $derived(plainMembers.get(id)!);
  const share = (b: string) => (all.filter((p) => p.band === b).length + allPlain.filter((p) => p.band === b).length) / bandSize[b];
  // Bars scale to the band where this characteristic is commonest, so small shares still read.
  const top = $derived(Math.max(...BANDS.map(share)));
  const related = $derived(traitLinks.filter((l) => l.a === id || l.b === id).map((l) => (l.a === id ? l.b : l.a)));
</script>

<div class="kind" style:color={SECTIONS[t.section].colour}>{SECTIONS[t.section].label}</div>
<h2>{t.label}</h2>
<p>{ps.length} projects{plain.length ? `, plus ${plain.length} that only print fields` : ''}. Clicking the node again adds the next 20 to the graph.</p>

<h4>Share of each commit band</h4>
<div class="bands">
  {#each BANDS as b}
    <div class="band"><span class="bar" style:height="{Math.max(2, (share(b) / top) * 110)}px"></span><span class="small">{Math.round(share(b) * 100)}%</span><span class="muted small">{b}</span></div>
  {/each}
</div>

{#if related.length}
  <h4>Often found with</h4>
  <div>{#each related as r}<Ref id={'t:' + r} {go} />{/each}</div>
{/if}

<h4>Projects</h4>
{#each ps as p}
  <div class="row">
    <Ref id={p.id} {go} />
    {#if p.novel.length}
      {#each p.novel as [item]}<div class="idea small">{item}</div>{/each}
    {:else}
      <div class="muted small">{p.what}</div>
    {/if}
  </div>
{/each}

{#if plain.length}
  <h4>Only print fields</h4>
  <p class="small">{#each plain as p, i}{i ? ' · ' : ''}<Ref id={p.id} {go} />{/each}</p>
{/if}

<style>
  .kind { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
  .bands { display: flex; gap: 14px; align-items: flex-end; height: 150px; }
  .band { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 2px; height: 100%; }
  .bar { width: 26px; background: var(--idea); border-radius: 2px; }
  .row { margin: 6px 0; }
  .idea { border-left: 2px solid var(--idea); padding-left: 8px; margin-top: 2px; }
</style>
