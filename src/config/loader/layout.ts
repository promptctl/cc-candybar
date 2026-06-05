// [LAW:one-source-of-truth] The two layout authoring surfaces — the flat `layout`
// row sugar and the `root` node grammar (with its own `cells` sugar) — both lower
// to ONE canonical `container | segment` tree here, so nothing downstream ever
// sees a row, a cells node, or the union. STRUCTURAL validation only; whether a
// name resolves is a cross-ref concern (it runs on the MERGED config). This file
// changes when the layout grammar or its sugar changes.

import {
  DIRECTIONS,
  type Direction,
  type LayoutNode,
  type LayoutRow,
  type LayoutRowInput,
} from "../dsl-types.js";
import { findKeyLine } from "./diagnostics.js";
import {
  describeType,
  describeValue,
  isPlainObject,
  optionalStringField,
  type ValidateCtx,
} from "./validate-core.js";

// [LAW:one-source-of-truth] `layout` rows are flat-vertical SUGAR: each row
// lowers to a horizontal container of segment refs (the row's `when` gates that
// whole row-container), and the row list lowers to one vertical container of
// those — the SAME `container | segment` tree the raw `root` grammar produces, so
// nothing downstream sees the row form. `rowToHorizontal` is the one place a list
// of segment names becomes a horizontal container, shared with `cells`-sugar
// lowering in the validator.
function rowToHorizontal(
  segments: readonly string[],
  when: string | undefined,
): LayoutNode {
  return {
    kind: "container",
    direction: "horizontal",
    children: segments.map((name) => ({ kind: "segment", name })),
    ...(when !== undefined && { when }),
  };
}

// [LAW:single-enforcer] The ONE boundary that normalizes the user-file row sugar
// (a bare `string[]` ≡ a predicate-less row) into the canonical node tree. The
// parser preserves whichever form the user wrote (so the JSON Schema can describe
// both); the sugar is collapsed here and never leaks past lowering.
export function layoutRowsToNode(rows: readonly LayoutRowInput[]): LayoutNode {
  return {
    kind: "container",
    direction: "vertical",
    children: rows.map((row) => {
      // A bare array is a predicate-less row; an object carries its own `when`.
      const norm: LayoutRow = "segments" in row ? row : { segments: row };
      return rowToHorizontal(norm.segments, norm.when);
    }),
  };
}

// [LAW:locality-or-seam] The single boundary that turns the user's layout into
// the canonical `LayoutRow[]`. Two user-file forms collapse to one shape here
// so no downstream consumer ever sees the union:
//   • a bare `string[]` row   → `{ segments: [...] }`  (predicate-less sugar)
//   • a `{ when?, segments }`  → itself                (explicit predicate form)
// Whether each name resolves to a declared segment is a cross-ref concern
// (validateCrossReferences), which runs on the MERGED config so a user's layout
// can reference default-provided segments.
//
// [LAW:types-are-the-program] Single-line is the degenerate `[[a, b, c]]` case.
// A flat `string[]` (the pre-multiline shape) is rejected with a migration-
// pointing message — no auto-wrap shim, because the shim would silently convert
// "I forgot to wrap" into a working config and hide the breaking change.
export function validateLayout(
  ctx: ValidateCtx,
  raw: unknown,
): readonly LayoutRowInput[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    ctx.issues.push({
      path: "layout",
      message: `layout must be an array of rows (each row an array of segment names, or a { when?, segments } object), got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, ["layout"]),
    });
    return [];
  }

  const out: LayoutRowInput[] = [];
  for (let r = 0; r < raw.length; r++) {
    const row = validateLayoutRow(ctx, r, raw[r]);
    if (row !== null) out.push(row);
  }
  return out;
}

// [LAW:dataflow-not-control-flow] One row → one validated row, IN THE FORM THE
// USER WROTE IT (bare `string[]` stays an array; `{ when?, segments }` stays an
// object). Structural validation only — normalization to the node tree is
// `layoutRowsToNode`'s job, the single lowering boundary, so the parsed shape can
// faithfully describe the user-file domain the JSON Schema validates against. A
// bare string at the outer level is the legacy flat layout — rejected with a wrap
// hint, not silently shimmed [LAW:no-silent-fallbacks].
function validateLayoutRow(
  ctx: ValidateCtx,
  r: number,
  row: unknown,
): LayoutRowInput | null {
  if (typeof row === "string") {
    ctx.issues.push({
      path: `layout[${r}]`,
      message: `layout is now an array of rows; wrap your segment list in an outer [] (e.g. [["${row}", ...]]). Single-line layouts use one row.`,
      line: findKeyLine(ctx.source, ["layout"]),
    });
    return null;
  }
  if (Array.isArray(row)) {
    return validateLayoutSegments(ctx, `layout[${r}]`, row);
  }
  if (isPlainObject(row)) {
    const allowed = new Set(["when", "segments"]);
    for (const key of Object.keys(row)) {
      if (!allowed.has(key)) {
        ctx.issues.push({
          path: `layout[${r}].${key}`,
          message: `Unknown layout-row key "${key}". Expected one of: ${[...allowed].join(", ")}`,
          line: findKeyLine(ctx.source, ["layout"]),
        });
      }
    }
    if (!Array.isArray(row.segments)) {
      ctx.issues.push({
        path: `layout[${r}].segments`,
        message: `a layout row object must have a "segments" array of segment names, got ${describeType(row.segments)}`,
        line: findKeyLine(ctx.source, ["layout"]),
      });
      return null;
    }
    const segments = validateLayoutSegments(
      ctx,
      `layout[${r}].segments`,
      row.segments,
    );
    // Preserve the predicate faithfully — an explicit `when: ""` is a present
    // (if degenerate) predicate, distinct from an absent one; only `undefined`
    // (absent or non-string) means "no predicate". A truthiness check would
    // silently drop "".
    const when = optionalStringField(ctx, `layout[${r}]`, row, "when");
    return when !== undefined ? { when, segments } : { segments };
  }
  ctx.issues.push({
    path: `layout[${r}]`,
    message: `a layout row must be an array of segment names or a { when?, segments } object, got ${describeType(row)}`,
    line: findKeyLine(ctx.source, ["layout"]),
  });
  return null;
}

// [LAW:locality-or-seam] `pathPrefix` is the caller's actual row path, so the
// error path reflects the form the user wrote: `layout[r][c]` for a bare-array
// row, `layout[r].segments[c]` for an object row. The discriminator lives in
// validateLayoutRow (which knows which form it received); threading the prefix
// keeps the error honest about the input rather than asserting a `.segments`
// key a sugar-form config never wrote.
function validateLayoutSegments(
  ctx: ValidateCtx,
  pathPrefix: string,
  row: readonly unknown[],
): readonly string[] {
  const rowOut: string[] = [];
  for (let c = 0; c < row.length; c++) {
    const entry = row[c];
    if (typeof entry !== "string") {
      ctx.issues.push({
        path: `${pathPrefix}[${c}]`,
        message: `layout entries must be strings (segment names), got ${describeType(entry)}`,
        line: findKeyLine(ctx.source, ["layout"]),
      });
      continue;
    }
    rowOut.push(entry);
  }
  return rowOut;
}

// ─── Root node grammar ───────────────────────────────────────────────────────

// [LAW:locality-or-seam] The boundary that turns the raw `root` grammar into a
// validated LayoutNode tree. STRUCTURAL only — whether a segment name resolves
// and whether a `when` ref exists are cross-ref concerns (validateCrossReferences
// runs on the MERGED config, so a node can name default-provided segments).
// Mirrors validateLayout's discipline: loud, no silent shimming.
//
// [LAW:dataflow-not-control-flow] The `kind` discriminator selects the arm; an
// unknown kind is rejected, never coerced. On a fundamental shape error the
// validator returns a degenerate node so traversal continues collecting issues
// — parseDslConfig throws once any issue exists, so the fallback never renders.
const EMPTY_VERTICAL_NODE: LayoutNode = {
  kind: "container",
  direction: "vertical",
  children: [],
};

export function validateRoot(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): LayoutNode {
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path,
      message: `a layout node must be an object with "kind" of "container", "segment", or "cells", got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, ["root"]),
    });
    return EMPTY_VERTICAL_NODE;
  }
  if (raw.kind === "container") return validateContainerNode(ctx, path, raw);
  if (raw.kind === "segment") return validateSegmentNode(ctx, path, raw);
  // [LAW:one-source-of-truth] `cells` is SUGAR — a horizontal run of segments —
  // lowered immediately to `container(horizontal, [segment…])` so no `cells` value
  // ever reaches a downstream consumer; the canonical tree is `container | segment`.
  if (raw.kind === "cells") return validateCellsNode(ctx, path, raw);
  ctx.issues.push({
    path: `${path}.kind`,
    message: `a layout node "kind" must be "container", "segment", or "cells", got ${JSON.stringify(raw.kind)}`,
    line: findKeyLine(ctx.source, ["root"]),
  });
  return EMPTY_VERTICAL_NODE;
}

function rejectUnknownNodeKeys(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      ctx.issues.push({
        path: `${path}.${key}`,
        message: `Unknown layout-node key "${key}". Expected one of: ${[...allowed].join(", ")}`,
        line: findKeyLine(ctx.source, ["root"]),
      });
    }
  }
}

// [LAW:one-source-of-truth] `cells` is authoring SUGAR for a horizontal run of
// segments. It is validated then LOWERED here to `container(horizontal,
// [segment…])` — the canonical form — so no `cells` value escapes the loader. The
// `when` (if any) gates the whole row-container, the same as a `LayoutRow`'s.
function validateCellsNode(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
): LayoutNode {
  rejectUnknownNodeKeys(ctx, path, raw, new Set(["kind", "segments", "when"]));
  const when = optionalStringField(ctx, path, raw, "when");
  if (!Array.isArray(raw.segments)) {
    ctx.issues.push({
      path: `${path}.segments`,
      message: `a cells node must have a "segments" array of segment names, got ${describeType(raw.segments)}`,
      line: findKeyLine(ctx.source, ["root"]),
    });
    return rowToHorizontal([], when);
  }
  const segments = validateLayoutSegments(
    ctx,
    `${path}.segments`,
    raw.segments,
  );
  return rowToHorizontal(segments, when);
}

// [LAW:locality-or-seam] STRUCTURAL validation of a segment node: a `name` (a ref
// into the segments block) plus optional `when`. Whether the name resolves is a
// cross-ref concern (validateCrossReferences, on the MERGED config).
function validateSegmentNode(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
): LayoutNode {
  rejectUnknownNodeKeys(ctx, path, raw, new Set(["kind", "name", "when"]));
  const when = optionalStringField(ctx, path, raw, "when");
  const name = typeof raw.name === "string" ? raw.name : "";
  if (typeof raw.name !== "string" || raw.name.length === 0) {
    ctx.issues.push({
      path: `${path}.name`,
      message: `a segment node must have a non-empty "name" (a segment name), got ${describeValue(raw.name)}`,
      line: findKeyLine(ctx.source, ["root"]),
    });
  }
  return when !== undefined
    ? { kind: "segment", name, when }
    : { kind: "segment", name };
}

function validateContainerNode(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
): LayoutNode {
  rejectUnknownNodeKeys(
    ctx,
    path,
    raw,
    new Set(["kind", "direction", "children", "when"]),
  );
  const when = optionalStringField(ctx, path, raw, "when");

  // [LAW:one-source-of-truth] Valid directions come from the DIRECTIONS list —
  // the same set the renderer projects. Today only `vertical` is implemented;
  // an unimplemented direction is a hard error, not a silent downgrade.
  const direction = raw.direction;
  const directionOk =
    typeof direction === "string" &&
    (DIRECTIONS as readonly string[]).includes(direction);
  if (!directionOk) {
    ctx.issues.push({
      path: `${path}.direction`,
      message: `a container "direction" must be one of: ${DIRECTIONS.join(", ")} (got ${JSON.stringify(direction)})`,
      line: findKeyLine(ctx.source, ["root"]),
    });
  }
  const dir: Direction = directionOk ? (direction as Direction) : "vertical";

  let children: LayoutNode[] = [];
  if (!Array.isArray(raw.children)) {
    ctx.issues.push({
      path: `${path}.children`,
      message: `a container must have a "children" array of layout nodes, got ${describeType(raw.children)}`,
      line: findKeyLine(ctx.source, ["root"]),
    });
  } else {
    children = raw.children.map((child, i) =>
      validateRoot(ctx, `${path}.children[${i}]`, child),
    );
  }

  return when !== undefined
    ? { kind: "container", direction: dir, children, when }
    : { kind: "container", direction: dir, children };
}
