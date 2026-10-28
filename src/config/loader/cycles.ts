// [LAW:types-are-the-program] Dependency-cycle detection over the variable graph.
// Its edges are the one fold of what a value reads (value-reads.ts): a single
// DFS catches mixed cycles spanning edge kinds, and a new edge kind is the
// fold's to add, never this file's.

import { type DslConfig, type VariableDecl } from "../dsl-types.js";
import { findKeyLine } from "./diagnostics.js";
import { type ValidateCtx } from "./validate-core.js";
import { valueReadsOf } from "./value-reads.js";

// Carries declaration metadata for each graph node so cycle errors report the
// correct config path (variables.X vs segments.S.vars.X) and correct line.
interface NodeInfo {
  readonly declarationPath: string;
  readonly linePathParts: readonly string[];
}

// `within` names the nodes a reported cycle may run through. A plugin joining a
// layer that held nothing under its name adds variables nothing beneath can
// read, so any cycle through them lies wholly among them: its check walks them
// alone and never reports a cycle the layer already held, even one its own
// variables read into.
export function validateNoCycles(
  ctx: ValidateCtx,
  cfg: DslConfig,
  within: (name: string) => boolean = () => true,
): void {
  const { graph, nodeInfo } = buildTemplateGraph(cfg);

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  for (const node of graph.keys()) color.set(node, WHITE);

  for (const start of graph.keys()) {
    if (!within(start) || color.get(start) !== WHITE) continue;
    if (dfs(start)) return; // first cycle is enough — report and stop walking
  }

  function dfs(node: string): boolean {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (!within(next)) continue;
      const c = color.get(next);
      if (c === GRAY) {
        const cycleStart = stack.indexOf(next);
        const cycle = [...stack.slice(cycleStart), next];
        const firstNode = cycle[0]!;
        const info = nodeInfo.get(firstNode);
        ctx.issues.push({
          path: info?.declarationPath ?? `variables.${firstNode}`,
          message: `Dependency cycle: ${cycle.join(" → ")}`,
          line: findKeyLine(
            ctx.source,
            info?.linePathParts ?? ["variables", firstNode],
          ),
        });
        return true;
      }
      if (c === WHITE && dfs(next)) return true;
    }
    color.set(node, BLACK);
    stack.pop();
    return false;
  }
}

// [LAW:types-are-the-program] The variable dependency graph: X → Y for every
// declaration Y that X reads (value-reads.ts) — through its template, its
// cache.key or its cache.depends_on, each of which loops forever at runtime
// when it closes. Nodes are the store's own keys: segment vars under
// `segName.varName`, globals bare.
function buildTemplateGraph(cfg: DslConfig): {
  graph: Map<string, Set<string>>;
  nodeInfo: Map<string, NodeInfo>;
} {
  const nodeInfo = new Map<string, NodeInfo>();
  const graph = new Map<string, Set<string>>();
  const reads = valueReadsOf(cfg);
  const addNode = (
    name: string,
    v: VariableDecl,
    linePathParts: readonly string[],
  ): void => {
    nodeInfo.set(name, {
      declarationPath: linePathParts.join("."),
      linePathParts,
    });
    graph.set(
      name,
      new Set(reads.ofVariable(v).flatMap(({ reaches }) => reaches)),
    );
  };
  for (const [name, v] of Object.entries(cfg.variables)) {
    addNode(name, v, ["variables", name]);
  }
  for (const [segName, seg] of Object.entries(cfg.segments)) {
    for (const [vName, v] of Object.entries(seg.vars ?? {})) {
      addNode(`${segName}.${vName}`, v, ["segments", segName, "vars", vName]);
    }
  }
  return { graph, nodeInfo };
}
