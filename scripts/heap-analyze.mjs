#!/usr/bin/env node
// heap-analyze.mjs — V8 heap-snapshot histogram + cross-snapshot diff.
//
// WHY THIS EXISTS
// ---------------
// The daemon RSS leak (epic brandon-daemon-memory-leak-gn4) was diagnosed
// not by speculation but by reading the heap snapshots written by limits.ts
// at the RSS-limit trigger. This script is the reproducible form of that
// triage: open a snapshot, see what's growing. It produced the evidence on
// ticket brandon-daemon-memory-leak-5qh ("+3046 Node/FSReqPromise,
// +15253 Promise, +15207 PromiseReaction ..."). Committed so the next
// triage is `node scripts/heap-analyze.mjs a.heapsnapshot b.heapsnapshot`,
// not "reinvent a snapshot parser under deadline".
//
// USAGE
//   node scripts/heap-analyze.mjs <snapshot.heapsnapshot> [--top N] [--match RE]
//       Histogram of node count + retained self_size by "<type> / <name>",
//       most-numerous first.
//
//   node scripts/heap-analyze.mjs <before.heapsnapshot> <after.heapsnapshot> [--top N] [--match RE]
//       Cross-snapshot diff: Δcount per class, largest growth first. This is
//       the view that surfaces a leak — run a warmup snapshot, do work, take a
//       second snapshot, diff. (For the transcript-fs leak specifically the
//       second snapshot must be taken WHILE the fs burst is in flight — the
//       FSReqPromise are held by libuv's pending-request table and vanish once
//       the ops drain. See 5qh.)
//
//   Flags:
//     --top N      limit output rows (default 40)
//     --match RE   only rows whose "<type> / <name>" matches the JS regexp RE
//     --json       emit machine-readable JSON instead of a table
//
// The .heapsnapshot format is V8's: flat `nodes`/`edges` integer arrays
// described by `snapshot.meta.{node_fields,node_types,edge_fields,edge_types}`,
// plus a `strings` table. node[name] indexes `strings`; node[type] indexes the
// `node_types[0]` enum.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

// [LAW:one-source-of-truth] The single snapshot parser. heap-retainers.mjs
// imports this rather than re-deriving the field offsets — the two tools
// cannot disagree about how to read a snapshot.
//
// The file is read as bytes and never decoded whole: a snapshot past V8's
// string limit (~512 MiB — a jest worker's heap, or a daemon near its memory
// limit) cannot be one string, so `JSON.parse` of it fails before parsing
// starts. Only the `snapshot` header and each string of the table are decoded.
export function parseSnapshot(path) {
  const bytes = readWhole(path);
  const nodesAt = keyAt(bytes, "nodes", 0);
  // The header is every byte before `"nodes":`, a `{"snapshot":{…},` object
  // whose closing brace is the file's.
  const header = bytes.toString("utf8", 0, nodesAt).replace(/,\s*$/, "}");
  const { meta, node_count: nodeCount, edge_count: edgeCount } =
    JSON.parse(header).snapshot;
  const nodeFields = meta.node_fields;
  const edgeFields = meta.edge_fields;
  const nodes = readInts(bytes, nodesAt, nodeCount * nodeFields.length, SIZES);
  const edgesAt = keyAt(bytes, "edges", nodes.end);
  const edges = readInts(
    bytes,
    edgesAt,
    edgeCount * edgeFields.length,
    INDICES,
  );
  const s = {
    nodes: nodes.values,
    edges: edges.values,
    // Everything between the edges and the strings is numbers, so the first
    // `"strings":` after the edges is the key, never text inside a string.
    strings: readStrings(bytes, keyAt(bytes, "strings", edges.end)),
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
  s.nodeCount = nodeCount;
  return s;
}

// The offset of the top-level key `"<key>":`, searched from `from`.
function keyAt(bytes, key, from) {
  const at = bytes.indexOf(`"${key}":`, from);
  if (at < 0) throw new Error(`not a V8 heap snapshot: no "${key}" array`);
  return at;
}

// How wide an array's values run. A node's `self_size` is a size_t (a 4 GiB
// backing store is one node), so node fields are held as doubles, exact to
// 2^53; every edge field indexes a table or the nodes, so edges fit 32 bits
// at half the memory.
const SIZES = {
  make: (n) => new Float64Array(n),
  max: Number.MAX_SAFE_INTEGER,
};
const INDICES = { make: (n) => new Uint32Array(n), max: 0xffffffff };

// [LAW:single-enforcer] The one reader of a list's grammar: `[`, then items
// each followed by `,` or `]`, whitespace allowed around either. `item(i)`
// reads the item at byte i and returns the offset past it, or -1 when none
// starts there. Returns the offset past `]`.
// [LAW:no-silent-failure] A list cut short, an empty element, two items with
// no comma between them, or any byte the grammar does not admit is a
// truncated or foreign file, refused rather than read as a different heap.
function readList(bytes, from, what, item) {
  let i = skipSpace(bytes, bytes.indexOf(0x5b /* [ */, from) + 1);
  if (bytes[i] === 0x5d /* ] */) return i + 1;
  for (;;) {
    const next = item(i);
    if (next < 0) break;
    i = skipSpace(bytes, next);
    if (bytes[i] === 0x5d /* ] */) return i + 1;
    if (bytes[i] !== 0x2c /* , */) break;
    i = skipSpace(bytes, i + 1);
  }
  throw new Error(
    `heap snapshot list at byte ${from}: not a list of ${what} at byte ${i}`,
  );
}

// The `[n,n,…]` array starting at `from`, exactly `count` unsigned integers no
// larger than `width.max`, and the offset past its `]`. V8 ends each node's
// row with a newline straight after its last digit, so whitespace ends a
// number.
function readInts(bytes, from, count, width) {
  const values = width.make(count);
  let n = 0;
  const end = readList(
    bytes,
    from,
    `unsigned integers up to ${width.max}`,
    (i) => {
      const start = i;
      let value = 0;
      for (; bytes[i] >= 0x30 && bytes[i] <= 0x39; i++)
        value = value * 10 + (bytes[i] - 0x30);
      if (i === start || value > width.max) return -1;
      if (n < count) values[n] = value;
      n++;
      return i;
    },
  );
  // [LAW:no-silent-failure] An array the header does not count is a foreign
  // or mismatched file, never a smaller or larger heap.
  if (n !== count) {
    throw new Error(
      `heap snapshot array at byte ${from}: the header counts ${count} values, the array holds ${n}`,
    );
  }
  return { values, end };
}

// The `["…","…",…]` string table starting at `from`, each string decoded on
// its own.
function readStrings(bytes, from) {
  const strings = [];
  readList(bytes, from, "strings", (i) => {
    if (bytes[i] !== 0x22 /* " */) return -1;
    let end = i + 1;
    while (end < bytes.length && bytes[end] !== 0x22)
      end += bytes[end] === 0x5c /* \ */ ? 2 : 1;
    if (end >= bytes.length) return -1;
    strings.push(JSON.parse(bytes.toString("utf8", i, end + 1)));
    return end + 1;
  });
  return strings;
}

function skipSpace(bytes, i) {
  while (
    bytes[i] === 0x20 ||
    bytes[i] === 0x0a ||
    bytes[i] === 0x0d ||
    bytes[i] === 0x09
  )
    i++;
  return i;
}

// `readFileSync` reads in one call, which Node caps at 2 GiB; a Buffer holds
// far more, so the file is read into one a gigabyte at a time.
function readWhole(path) {
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.allocUnsafe(fstatSync(fd).size);
    for (let at = 0; at < bytes.length; ) {
      const n = readSync(
        fd,
        bytes,
        at,
        Math.min(bytes.length - at, 2 ** 30),
        at,
      );
      if (n === 0)
        throw new Error(`${path}: ended at byte ${at} of ${bytes.length}`);
      at += n;
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

// "<type> / <name>" label for node ordinal i — the unit a histogram counts.
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

// Total node count whose label matches a regexp — the scalar a regression
// gate asserts on (e.g. count of "FSReqPromise" classes).
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

// Run as CLI only when invoked directly (not when imported by heap-retainers
// or a test). `import.meta.url` vs argv[1] is the standard ESM main-guard.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
