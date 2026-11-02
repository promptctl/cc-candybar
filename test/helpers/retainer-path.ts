import v8 from "node:v8";

// [LAW:verifiable-goals] Who holds an instance of `className` on the heap, as
// the path from the heap's roots to it, read off a snapshot. A WeakRef says
// that something holds an object and not who, so a leak test that fails on a
// WeakRef alone leaves the next person to guess; this names the holder.
// Weak edges are not followed: a WeakRef's own edge to its target holds
// nothing, and a path through it would name the observer as the holder.
// An empty result says no instance is reachable by a strong path.
export const retainerPathsTo = async (className: string, limit = 3): Promise<string[]> => {
  const chunks: Buffer[] = [];
  for await (const chunk of v8.getHeapSnapshot()) chunks.push(chunk as Buffer);
  const snap: Snapshot = JSON.parse(Buffer.concat(chunks).toString("utf8"));

  const { node_fields, edge_fields, node_types, edge_types } = snap.snapshot.meta;
  const nodeWidth = node_fields.length;
  const edgeWidth = edge_fields.length;
  const at = (fields: string[], name: string): number => fields.indexOf(name);
  const [typeAt, nameAt, countAt] = [at(node_fields, "type"), at(node_fields, "name"), at(node_fields, "edge_count")];
  const [edgeTypeAt, edgeNameAt, toAt] = [at(edge_fields, "type"), at(edge_fields, "name_or_index"), at(edge_fields, "to_node")];
  const nodeTypeNames = node_types[0] as string[];
  const edgeTypeNames = edge_types[0] as string[];
  const nodeCount = snap.nodes.length / nodeWidth;

  // Each node's edges are contiguous, in node order, so a node's first edge is
  // the running sum of the edge counts before it.
  const firstEdge = new Int32Array(nodeCount + 1);
  for (let n = 0; n < nodeCount; n++) firstEdge[n + 1] = firstEdge[n]! + snap.nodes[n * nodeWidth + countAt]!;

  const parent = new Int32Array(nodeCount).fill(-1);
  const viaEdge = new Int32Array(nodeCount).fill(-1);
  parent[0] = 0;
  const queue = [0];
  for (let head = 0; head < queue.length; head++) {
    const from = queue[head]!;
    for (let e = firstEdge[from]!; e < firstEdge[from + 1]!; e++) {
      const kind = edgeTypeNames[snap.edges[e * edgeWidth + edgeTypeAt]!];
      if (kind === "weak" || kind === "shortcut") continue;
      const to = snap.edges[e * edgeWidth + toAt]! / nodeWidth;
      if (parent[to] !== -1) continue;
      parent[to] = from;
      viaEdge[to] = e;
      queue.push(to);
    }
  }

  const nameOf = (n: number): string => snap.strings[snap.nodes[n * nodeWidth + nameAt]!]!;
  const edgeLabel = (e: number): string => {
    const kind = edgeTypeNames[snap.edges[e * edgeWidth + edgeTypeAt]!]!;
    const name = snap.edges[e * edgeWidth + edgeNameAt]!;
    // Element and hidden edges name an index; the others name a string.
    return kind === "element" || kind === "hidden" ? `[${name}]` : `${kind} ${snap.strings[name]}`;
  };

  const paths: string[] = [];
  for (let n = 0; n < nodeCount && paths.length < limit; n++) {
    const isInstance = nodeTypeNames[snap.nodes[n * nodeWidth + typeAt]!] === "object" && nameOf(n) === className;
    if (!isInstance || parent[n] === -1) continue;
    const steps: string[] = [];
    for (let step = n; step !== 0; step = parent[step]!) steps.push(`${edgeLabel(viaEdge[step]!)} → ${nameOf(step)}`);
    paths.push(steps.reverse().join("\n  "));
  }
  return paths;
};

interface Snapshot {
  snapshot: {
    meta: {
      node_fields: string[];
      node_types: Array<string[] | string>;
      edge_fields: string[];
      edge_types: Array<string[] | string>;
    };
  };
  nodes: number[];
  edges: number[];
  strings: string[];
}
