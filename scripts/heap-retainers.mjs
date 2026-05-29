#!/usr/bin/env node
// heap-retainers.mjs — reverse-BFS retaining paths from a class to a GC root.
//
// WHY THIS EXISTS
// ---------------
// A histogram (heap-analyze.mjs) tells you WHAT grew; it does not tell you WHO
// is holding it. That second question is what overturned the a-priori suspect
// ranking for the daemon RSS leak: this script showed that ALL ~3046
// FSReqPromise were retained DIRECTLY by `synthetic / (Global handles)` —
// libuv's pending-request table — not by any JS cache, watcher, or MobX
// reaction. The leak was held from the BOTTOM (pending syscalls), not the top.
// See ticket brandon-daemon-memory-leak-5qh. Committed so that finding is
// reproducible: `node scripts/heap-retainers.mjs snap.heapsnapshot FSReqPromise`.
//
// USAGE
//   node scripts/heap-retainers.mjs <snapshot.heapsnapshot> <match-RE> [--limit N] [--json]
//
//   <match-RE>   JS regexp matched against "<type> / <name>"; instances of
//                matching nodes are the BFS targets.
//   --limit N    trace at most N target instances (default 5). The cap is
//                LOUD, not silent: a "(N more matching nodes not traced)" line
//                is printed so truncation is never mistaken for completeness.
//   --json       emit { paths: [[ "<root>", ..., "<target>" ], ...] }.
//
// A retaining path is printed root-first: the GC root, then each retaining
// edge's owner down to the target instance. Edge labels (.field / [index])
// annotate how each step holds the next.

import { parseSnapshot, nodeLabel } from "./heap-analyze.mjs";

// Edge label for edge record `rec`: property/internal/context edges name a
// string; element/hidden edges carry a numeric index.
function edgeLabel(s, rec) {
  const off = rec * s.edgeStride;
  const type = s.edgeTypes[s.edges[off + s.edgeTypeIdx]];
  const nameOrIndex = s.edges[off + s.edgeNameIdx];
  if (type === "element" || type === "hidden") return `[${nameOrIndex}]`;
  return s.strings[nameOrIndex] ?? `#${nameOrIndex}`;
}

// Build reverse adjacency: for every directed edge from→to, record (from, edgeRec)
// under `to`, so BFS can walk from a target up toward its retainers.
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

// Shortest retaining path (root-first list of labels) from any GC root to
// `target`, found by BFS over reverse edges. Ordinal 0 is V8's synthetic root.
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
