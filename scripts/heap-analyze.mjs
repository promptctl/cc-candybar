#!/usr/bin/env node
// heap-analyze.mjs — V8 heap-snapshot histogram + cross-snapshot diff.
// Usage: node scripts/heap-analyze.mjs <snapshot> [<after>] [--top N] [--match RE] [--json]
// The .heapsnapshot format is V8's flat `nodes`/`edges` arrays described by `snapshot.meta`.

import { readFileSync } from "node:fs";

// [LAW:one-source-of-truth] The single snapshot parser; heap-retainers.mjs imports it.
export function parseSnapshot(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const meta = raw.snapshot.meta;
  const nodeFields = meta.node_fields;
  const edgeFields = meta.edge_fields;
  const s = {
    nodes: raw.nodes,
    edges: raw.edges,
    strings: raw.strings,
    nodeTypes: meta.node_types[0],
    edgeTypes: meta.edge_types[0],
    nodeStride: nodeFields.length,
    edgeStride: edgeFields.length,
    typeIdx: nodeFields.indexOf("type"),
    nameIdx: nodeFields.indexOf("name"),
    selfSizeIdx: nodeFields.indexOf("self_size"),
    edgeCountIdx: nodeFields.indexOf("edge_count"),
    edgeTypeIdx: edgeFields.indexOf("type"),
    edgeNameIdx: edgeFields.indexOf("name_or_index"),
    edgeToIdx: edgeFields.indexOf("to_node"),
  };
  s.nodeCount = s.nodes.length / s.nodeStride;
  return s;
}

export function nodeLabel(s, i) {
  const off = i * s.nodeStride;
  return `${s.nodeTypes[s.nodes[off + s.typeIdx]]} / ${s.strings[s.nodes[off + s.nameIdx]]}`;
}

export function histogram(s) {
  const h = new Map();
  for (let i = 0; i < s.nodeCount; i++) {
    const off = i * s.nodeStride;
    const label = nodeLabel(s, i);
    const cur = h.get(label) ?? { label, count: 0, selfSize: 0 };
    cur.count++;
    cur.selfSize += s.nodes[off + s.selfSizeIdx];
    h.set(label, cur);
  }
  return h;
}

export function countMatching(s, re) {
  let n = 0;
  for (let i = 0; i < s.nodeCount; i++) {
    if (re.test(nodeLabel(s, i))) n++;
  }
  return n;
}

export function diff(before, after) {
  const ha = histogram(before);
  const hb = histogram(after);
  const labels = new Set([...ha.keys(), ...hb.keys()]);
  const rows = [];
  for (const label of labels) {
    const countA = ha.get(label)?.count ?? 0;
    const countB = hb.get(label)?.count ?? 0;
    rows.push({ label, countA, countB, deltaCount: countB - countA });
  }
  rows.sort((a, b) => b.deltaCount - a.deltaCount);
  return rows;
}

function parseArgs(argv) {
  const positional = [];
  const opts = { top: 40, match: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--top") opts.top = Number(argv[++i]);
    else if (a === "--match") opts.match = new RegExp(argv[++i]);
    else if (a === "--json") opts.json = true;
    else positional.push(a);
  }
  return { positional, opts };
}

function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  if (positional.length < 1 || positional.length > 2) {
    process.stderr.write(
      "usage: heap-analyze.mjs <snapshot> [<snapshot2>] [--top N] [--match RE] [--json]\n",
    );
    process.exit(2);
  }

  if (positional.length === 2) {
    const rows = diff(parseSnapshot(positional[0]), parseSnapshot(positional[1]))
      .filter((r) => !opts.match || opts.match.test(r.label))
      .filter((r) => r.deltaCount !== 0);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ diff: rows.slice(0, opts.top) }) + "\n");
      return;
    }
    process.stdout.write(`Δcount  before   after   class\n`);
    for (const r of rows.slice(0, opts.top)) {
      const d = (r.deltaCount > 0 ? "+" : "") + r.deltaCount;
      process.stdout.write(
        `${d.padStart(6)}  ${String(r.countA).padStart(6)}  ${String(r.countB).padStart(6)}   ${r.label}\n`,
      );
    }
    return;
  }

  const rows = [...histogram(parseSnapshot(positional[0])).values()]
    .filter((r) => !opts.match || opts.match.test(r.label))
    .sort((a, b) => b.count - a.count);
  if (opts.json) {
    process.stdout.write(JSON.stringify({ histogram: rows.slice(0, opts.top) }) + "\n");
    return;
  }
  process.stdout.write(` count   self_size  class\n`);
  for (const r of rows.slice(0, opts.top)) {
    process.stdout.write(
      `${String(r.count).padStart(6)}  ${String(r.selfSize).padStart(10)}  ${r.label}\n`,
    );
  }
}

// ESM main-guard: run as CLI only when invoked directly.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
