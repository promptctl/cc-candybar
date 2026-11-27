#!/usr/bin/env node
// heap-retainers.mjs — retaining paths from a root to instances of a class.
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
//   node scripts/heap-retainers.mjs <snapshot.heapsnapshot> <match-RE> [--limit N] [--json] [--strong] [--from root-RE]
//
//   <match-RE>   JS regexp matched against "<type> / <name>"; instances of
//                matching nodes are the BFS targets.
//   --limit N    trace at most N target instances (default 5). The cap is
//                LOUD, not silent: a "(N more matching nodes not traced)" line
//                is printed so truncation is never mistaken for completeness.
//   --from RE    trace from a matching holder instead of the synthetic GC root.
//   --json       emit { paths: [[ "<root>", ..., "<target>" ], ...] }.
//   --strong     follow only edges that keep their target alive. A weak edge
//                (a WeakRef's) holds nothing, so a path through one names the
//                observer as the holder; with --strong a target no strong path
//                reaches has no path, and so is absent from `paths`.
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

// A breadth-first walk from the requested holders. V8 stores each node's
// outgoing edges contiguously; the incoming edge recorded at discovery is
// enough to reconstruct the first path, with no reverse graph per instance.
/** @param {{strong?: boolean, fromRoot?: RegExp}} options */
export function retainerPaths(s, re, limit, options = {}) {
  const { strong = false, fromRoot } = options;
  const first = new Uint32Array(s.nodeCount + 1);
  const parent = new Int32Array(s.nodeCount).fill(-1);
  const via = new Uint32Array(s.nodeCount);
  const queue = [];
  const targets = [];
  for (let i = 0; i < s.nodeCount; i++) {
    const label = nodeLabel(s, i);
    first[i + 1] = first[i] + s.nodes[i * s.nodeStride + s.edgeCountIdx];
    if (re.test(label)) targets.push(i);
    if (fromRoot ? fromRoot.test(label) : i === 0) {
      parent[i] = i;
      queue.push(i);
    }
  }

  // [LAW:types-are-the-program] WeakMap values have two prerequisites:
  // reachability of the table AND its key. V8 gives both internal edges
  // the same pair name. An owner of the table alone cannot keep its key
  // alive via a value that points back at that key.
  const awaitingOtherHalf = new Map();
  for (let i = 0; i < queue.length; i++) {
    const from = queue[i];
    const start = first[from], end = first[from + 1];
    if (start === undefined || end === undefined) throw new Error(`invalid heap node ${from}`);
    for (let rec = start; rec < end; rec++) {
      const off = rec * s.edgeStride;
      const to = s.edges[off + s.edgeToIdx] / s.nodeStride;
      if (parent[to] !== -1) continue;
      if (strong) {
        const type = s.edgeTypes[s.edges[off + s.edgeTypeIdx]];
        if (type === "weak" || type === "shortcut") continue;
        const name = s.strings[s.edges[off + s.edgeNameIdx]];
        if (type === "internal" && name?.includes(" pair in WeakMap (table @")) {
          const prior = awaitingOtherHalf.get(name);
          if (prior === undefined || prior === from) {
            awaitingOtherHalf.set(name, from);
            continue;
          }
          awaitingOtherHalf.delete(name);
        }
      }
      parent[to] = from;
      via[to] = rec;
      queue.push(to);
    }
  }

  const paths = [];
  let traced = 0;
  for (const target of targets) {
    if (paths.length === limit) break;
    traced++;
    if (parent[target] === -1) continue;
    const chain = [nodeLabel(s, target)];
    let to = target;
    for (;;) {
      const owner = parent[to];
      if (owner === to) break;
      if (owner === undefined || owner < 0) throw new Error(`missing parent for heap node ${to}`);
      chain.push(`${nodeLabel(s, owner)} --${edgeLabel(s, via[to])}-->`);
      to = owner;
    }
    paths.push(chain.reverse());
  }
  return { paths, totalTargets: targets.length, traced };
}

function parseArgs(argv) {
  const positional = [];
  const opts = { limit: 5, json: false, strong: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") opts.limit = Number(argv[++i]);
    else if (a === "--from") {
      const pattern = argv[++i];
      if (!pattern) throw new Error("--from requires a holder pattern");
      opts.fromRoot = new RegExp(pattern);
    } else if (a === "--json") opts.json = true;
    else if (a === "--strong") opts.strong = true;
    else positional.push(a);
  }
  return { positional, opts };
}

function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  if (positional.length !== 2) {
    process.stderr.write(
      "usage: heap-retainers.mjs <snapshot> <match-RE> [--limit N] [--json] [--strong] [--from root-RE]\n",
    );
    process.exit(2);
  }
  const s = parseSnapshot(positional[0]);
  const re = new RegExp(positional[1]);
  const { paths, totalTargets, traced } = retainerPaths(s, re, opts.limit, opts);

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
