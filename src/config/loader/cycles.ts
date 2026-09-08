// [LAW:types-are-the-program] One DFS, so a cycle spanning template, cache.key
// and depends_on edges is still caught.

import {
  hasCacheField,
  type DslConfig,
  type VariableDecl,
} from "../dsl-types.js";
import { findKeyLine } from "./diagnostics.js";
import { type ValidateCtx } from "./validate-core.js";
import { extractTemplateRefs } from "./refs.js";

interface NodeInfo {
  readonly declarationPath: string;
  readonly linePathParts: readonly string[];
}

export function validateNoCycles(ctx: ValidateCtx, cfg: DslConfig): void {
  const { graph, nodeInfo } = buildTemplateGraph(cfg);

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  for (const node of graph.keys()) color.set(node, WHITE);

  for (const start of graph.keys()) {
    if (color.get(start) !== WHITE) continue;
    if (dfs(start)) return;
  }

  function dfs(node: string): boolean {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
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

// A segment var's node is its namespaced form, so two "local"s cannot collide.
function buildTemplateGraph(cfg: DslConfig): {
  graph: Map<string, Set<string>>;
  nodeInfo: Map<string, NodeInfo>;
} {
  const allVarNames = new Set<string>(Object.keys(cfg.variables));
  const nodeInfo = new Map<string, NodeInfo>();

  for (const name of Object.keys(cfg.variables)) {
    nodeInfo.set(name, {
      declarationPath: `variables.${name}`,
      linePathParts: ["variables", name],
    });
  }
  for (const [segName, seg] of Object.entries(cfg.segments)) {
    if (!seg.vars) continue;
    for (const vName of Object.keys(seg.vars)) {
      const canonical = `${segName}.${vName}`;
      allVarNames.add(canonical);
      nodeInfo.set(canonical, {
        declarationPath: `segments.${segName}.vars.${vName}`,
        linePathParts: ["segments", segName, "vars", vName],
      });
    }
  }

  const graph = new Map<string, Set<string>>();
  for (const name of allVarNames) graph.set(name, new Set());

  // [LAW:one-source-of-truth] Refs resolve as the runtime scope proxy does, so a
  // bare own-segment ref is not aliased here either.
  const addTemplateEdges = (from: string, template: string): void => {
    for (const ref of extractTemplateRefs(template)) {
      if (allVarNames.has(ref)) {
        graph.get(from)!.add(ref);
        continue;
      }
      const head = ref.split(".")[0]!;
      if (head !== ref && allVarNames.has(head)) {
        graph.get(from)!.add(head);
      }
    }
  };

  const addVarEdges = (name: string, v: VariableDecl): void => {
    if (v.kind === "template") addTemplateEdges(name, v.template);
    if (hasCacheField(v)) {
      if (v.cache && "key" in v.cache) addTemplateEdges(name, v.cache.key);
      if (v.cache && "depends_on" in v.cache) {
        for (const dep of v.cache.depends_on) {
          if (allVarNames.has(dep)) graph.get(name)!.add(dep);
        }
      }
    }
  };

  for (const [name, v] of Object.entries(cfg.variables)) {
    addVarEdges(name, v);
  }
  for (const [segName, seg] of Object.entries(cfg.segments)) {
    if (!seg.vars) continue;
    for (const [vName, vDecl] of Object.entries(seg.vars)) {
      addVarEdges(`${segName}.${vName}`, vDecl);
    }
  }

  return { graph, nodeInfo };
}
