<script lang="ts">
  import { cloneLinks, families, motiveName, projectById } from './model';
  import { traitOfGroup } from './traits';
  import { bundle } from './bundles';
  import type { RawProject } from './types';
  import Ref from './Ref.svelte';

  let { id, go }: { id: string; go: (id: string) => void } = $props();
  const base = $derived(projectById.get(id)!);
  // The long text arrives with its bundle, once this project is opened; until then the page shows
  // what the graph already has.
  let detail = $state<Partial<RawProject>>({});
  $effect(() => {
    const b = base;
    detail = {};
    if (b.detail === null) return;
    let current = true;
    bundle<Partial<RawProject>>('detail', b.detail).then((g) => { if (current) detail = g[b.repo] ?? {}; });
    return () => { current = false; };
  });
  const p = $derived({ ...base, ...detail });
  // The reader wrote "beyond baseline" as `item (file:symbol); item (file:symbol)`; split at the
  // semicolons that sit outside parentheses.
  const beyond = $derived((p.beyond ?? '').split(/;\s+(?![^(]*\))/).filter(Boolean));
  const family = $derived(p.fam === null ? null : families[p.fam]);
</script>

<div class="kind">{p.what.split(/[(:;,]/)[0]}</div>
<h2>{p.repo}</h2>
<p><a class="repo" href={p.url} target="_blank" rel="noopener">{p.url.replace('https://', '')} ↗</a></p>
<p>{p.what}</p>
{#if p.live}<p class="muted small">Its bar plays along the bottom of the graph, as it printed in a sandbox through a two-minute mock conversation: a feature branch, edits, a commit, a push.</p>{/if}
<p class="muted small">{p.loc} statusline lines{p.lang ? ` · ${p.lang}` : ''} · {p.commits} commits · last {p.last}{p.created ? ` · created ${p.created}` : ''}</p>

{#if p.novel.length}
  <h4>What makes it new</h4>
  {#each p.novel as [item, why, group]}
    <div class="idea"><div>{item}</div><div class="muted small">{why}</div><div class="small"><Ref id={'t:' + traitOfGroup(group).id} {go} /></div></div>
  {/each}
{/if}

<h4>Characteristics</h4>
<div>{#each p.traits as t}<Ref id={'t:' + t} {go} />{/each}</div>

{#if p.why}
  <h4>Why it exists</h4>
  <p><b>{motiveName(p.motive)}.</b> {p.why}</p>
{/if}

{#if beyond.length}
  <h4>What it does beyond the basics</h4>
  <ul>{#each beyond as b}<li>{b}</li>{/each}</ul>
{/if}

{#if p.summary}
  <h4>How it works</h4>
  <p>{p.summary}</p>
{/if}

<h4>Lineage</h4>
{#if p.lineage}<p>{p.lineage}{#if p.fork}<br />fork of {p.fork}{/if}</p>{/if}
{#if cloneLinks(p).length}
  <p>Shares code with: {#each cloneLinks(p) as c, i}{i ? ' · ' : ''}<Ref id={c.other.id} {go} /> {c.percent}%{/each}</p>
{/if}
{#if family}<p class="muted small">One of a clone family of {family.size} projects.</p>{/if}

{#if p.sources}
  <h4>Reads from</h4>
  <p class="small">{p.sources}</p>
  <p class="muted small">{p.size}</p>
{/if}

<style>
  .kind { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dim); }
  .repo { font-size: 13px; }
  .idea { border-left: 3px solid var(--idea); padding: 2px 10px; margin: 8px 0; }
</style>
