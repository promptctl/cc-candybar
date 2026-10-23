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

import { readFileSync } from "node:fs";

// [LAW:one-source-of-truth] The single snapshot parser. heap-retainers.mjs
// imports this rather than re-deriving the field offsets — the two tools
// cannot disagree about how to read a snapshot.
//
// The file is read as bytes and never decoded whole: a snapshot past V8's
// string limit (~512 MiB — a jest worker's heap, or a daemon near its memory
// limit) cannot be one string, so `JSON.parse` of it fails before parsing
// starts. Only the `snapshot` header and each string of the table are decoded.
export function parseSnapshot(path) {
  const bytes = readFileSync(path);
  const nodesAt = keyAt(bytes, "nodes", 0);
  // The header is every byte before `"nodes":`, a `{"snapshot":{…},` object
  // whose closing brace is the file's.
  const header = bytes.toString("utf8", 0, nodesAt).replace(/,\s*$/, "}");
  const { meta, node_count: nodeCount, edge_count: edgeCount } =
    JSON.parse(header).snapshot;
  const nodeFields = meta.node_fields;
  const edgeFields = meta.edge_fields;
  const nodes = readInts(bytes, nodesAt, nodeCount * nodeFields.length);
  const edgesAt = keyAt(bytes, "edges", nodes.end);
  const edges = readInts(bytes, edgesAt, edgeCount * edgeFields.length);
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
  s.nodeCount = s.nodes.length / s.nodeStride;
  return s;
}

// The offset of the top-level key `"<key>":`, searched from `from`.
function keyAt(bytes, key, from) {
  const at = bytes.indexOf(`"${key}":`, from);
  if (at < 0) throw new Error(`not a V8 heap snapshot: no "${key}" array`);
  return at;
}

// The `[n,n,…]` array starting at `from`, exactly `count` unsigned 32-bit
// integers (every node and edge field is one), and the offset past its `]`.
// V8 ends each node's row with a newline straight after its last digit, so
// whitespace ends a number; a digit after it would join two.
// [LAW:no-silent-failure] Anything else — a count other than the header's, a
// value past 2^32, a byte no integer list holds — is a truncated or foreign
// file, refused rather than read as a different heap.
function readInts(bytes, from, count) {
  const values = new Uint32Array(count);
  let i = bytes.indexOf(0x5b /* [ */, from) + 1;
  let n = 0;
  let value = 0;
  let digits = false;
  let spaced = false;
  for (; i < bytes.length; i++) {
    const b = bytes[i];
    if (b >= 0x30 && b <= 0x39) {
      if (spaced) break;
      value = value * 10 + (b - 0x30);
      digits = true;
    } else if (b === 0x2c /* , */ || b === 0x5d /* ] */) {
      if (digits) {
        if (n === count || value > 0xffffffff) break;
        values[n++] = value;
      }
      value = 0;
      digits = false;
      spaced = false;
      if (b === 0x5d) break;
    } else if (isSpace(b)) {
      spaced = digits;
    } else break;
  }
  if (n !== count || bytes[i] !== 0x5d) {
    throw new Error(
      `heap snapshot array at byte ${from}: expected ${count} unsigned 32-bit integers, read ${n} before byte ${i}`,
    );
  }
  return { values, end: i + 1 };
}

// The `["…","…",…]` string table starting at `from`, each string decoded on
// its own.
// [LAW:no-silent-failure] A string cut off, a byte no string list holds
// between its strings, or no closing `]` is a truncated file, refused rather
// than read as a shorter table that names every later node `undefined`.
function readStrings(bytes, from) {
  const strings = [];
  let i = bytes.indexOf(0x5b /* [ */, from) + 1;
  for (; i < bytes.length && bytes[i] !== 0x5d /* ] */; i++) {
    if (bytes[i] === 0x2c /* , */ || isSpace(bytes[i])) continue;
    if (bytes[i] !== 0x22 /* " */) break;
    let end = i + 1;
    while (end < bytes.length && bytes[end] !== 0x22)
      end += bytes[end] === 0x5c /* \ */ ? 2 : 1;
    if (end >= bytes.length) break;
    strings.push(JSON.parse(bytes.toString("utf8", i, end + 1)));
    i = end;
  }
  if (bytes[i] !== 0x5d) {
    throw new Error(
      `heap snapshot string table at byte ${from}: no closing ] after ${strings.length} strings, at byte ${i}`,
    );
  }
  return strings;
}

function isSpace(b) {
  return b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;
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
