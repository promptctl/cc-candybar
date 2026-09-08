#!/usr/bin/env node
// heap-retainers.mjs — reverse-BFS retaining paths from a class to a GC root.

import { parseSnapshot, nodeLabel } from "./heap-analyze.mjs";

function edgeLabel(s, rec) {
  const off = rec * s.edgeStride;
  const type = s.edgeTypes[s.edges[off + s.edgeTypeIdx]];
  const nameOrIndex = s.edges[off + s.edgeNameIdx];
  if (type === "element" || type === "hidden") return `[${nameOrIndex}]`;
  return s.strings[nameOrIndex] ?? `#${nameOrIndex}`;
}

// Reverse adjacency, so BFS can walk from a target up toward its retainers.
function buildReverse(s) {
  const firstEdge = new Int32Array(s.nodeCount + 1);
  for (let i = 0; i < s.nodeCount; i++) {
    firstEdge[i + 1] = firstEdge[i] + s.nodes[i * s.nodeStride + s.edgeCountIdx];
  }
  const reverse = Array.from({ length: s.nodeCount }, () => []);
  for (let from = 0; from < s.nodeCount; from++) {
    for (let rec = firstEdge[from]; rec < firstEdge[from + 1]; rec++) {
      const to = s.edges[rec * s.edgeStride + s.edgeToIdx] / s.nodeStride;
      reverse[to].push({ from, rec });
    }
  }
  return reverse;
}

// Root-first path to `target`. Ordinal 0 is V8's synthetic root.
function pathToRoot(s, reverse, target) {
  const parent = new Map();
  parent.set(target, null);
  const queue = [target];
  let root = null;
  while (queue.length) {
    const node = queue.shift();
    if (node === 0) {
      root = node;
      break;
    }
    for (const { from, rec } of reverse[node]) {
      if (!parent.has(from)) {
        parent.set(from, { from: node, rec });
        queue.push(from);
      }
    }
  }
  if (root === null) return null;

  const chain = [];
  let cur = 0;
  while (cur !== target) {
    const step = parent.get(cur);
    chain.push(`${nodeLabel(s, cur)} --${edgeLabel(s, step.rec)}-->`);
    cur = step.from;
  }
  chain.push(nodeLabel(s, target));
  return chain;
}

export function retainerPaths(s, re, limit) {
  const reverse = buildReverse(s);
  const targets = [];
  for (let i = 0; i < s.nodeCount; i++) {
    if (re.test(nodeLabel(s, i))) targets.push(i);
  }
  const traced = targets.slice(0, limit);
  const paths = traced.map((t) => pathToRoot(s, reverse, t)).filter(Boolean);
  return { paths, totalTargets: targets.length, traced: traced.length };
}

function parseArgs(argv) {
  const positional = [];
  const opts = { limit: 5, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") opts.limit = Number(argv[++i]);
    else if (a === "--json") opts.json = true;
    else positional.push(a);
  }
  return { positional, opts };
}

function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  if (positional.length !== 2) {
    process.stderr.write(
      "usage: heap-retainers.mjs <snapshot> <match-RE> [--limit N] [--json]\n",
    );
    process.exit(2);
  }
  const s = parseSnapshot(positional[0]);
  const re = new RegExp(positional[1]);
  const { paths, totalTargets, traced } = retainerPaths(s, re, opts.limit);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ paths, totalTargets, traced }) + "\n");
    return;
  }

  process.stdout.write(`${totalTargets} node(s) match /${re.source}/; tracing ${traced}.\n\n`);
  paths.forEach((chain, i) => {
    process.stdout.write(`#${i + 1}\n`);
    chain.forEach((line, depth) => process.stdout.write(`${"  ".repeat(depth)}${line}\n`));
    process.stdout.write("\n");
  });
  if (totalTargets > traced) {
    process.stdout.write(`(${totalTargets - traced} more matching nodes not traced; raise --limit)\n`);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
