// [LAW:one-source-of-truth] The two layout authoring surfaces — the flat `layout`
// row sugar and the `root` node grammar (with its own `cells` sugar) — both lower
// to ONE canonical `container | segment` tree here, so nothing downstream ever
// sees a row, a cells node, or the union. STRUCTURAL validation only; whether a
// name resolves is a cross-ref concern (it runs on the MERGED config). This file
// changes when the layout grammar or its sugar changes.
//
// [LAW:types-are-the-program] Both surfaces are DATA schemas interpreted by the
// generic `record` engine: each arm's shape is a FieldSpecMap, each bespoke
// message lives on its field spec as data. The two things the generic engine does
// NOT own stay local: the kind-dispatch (a node folds object-guard / missing-kind
// / unknown-kind into one bespoke message and pins its line to `root`, unlike the
// generic taggedUnion's per-failure messages), and the degenerate-node recovery
// (a node never drops to null; it recovers so traversal keeps collecting issues —
// parseDslConfig throws once any issue exists, so the fallback never renders). The
// recursion (a container's children are nodes) crosses through `lazy`, the engine's
// recursion seam, so the child-list field is data that points back at the node
// parser without a temporal-dead-zone crash at module load.

import {
  DIRECTIONS,
  type ContainerNode,
  type Direction,
  type LayoutNode,
  type LayoutRow,
  type LayoutRowInput,
  type SegmentNode,
} from "../dsl-types.js";
import { findKeyLine } from "./diagnostics.js";
import {
  describeType,
  describeValue,
  isPlainObject,
  lazy,
  optionalStringSpec,
  record,
  recordJson,
  type FieldSpec,
  type JsonNode,
  type RecordSchema,
  type ValidateCtx,
} from "./validate-core.js";

// [LAW:types-are-the-program] The recursion seam for EMIT: a container's children
// are LayoutNodes, so the node schema must reference itself. JSON Schema breaks
// the cycle with a named definition + `$ref` — the structural analogue of the
// `lazy` thunk that breaks the parse-time cycle. The emitter publishes the node
// schema at this path; `childrenSpec` and the top-level `root` both point here.
export const LAYOUT_NODE_REF = "#/definitions/LayoutNode";
export const LAYOUT_NODE_DEF_NAME = "LayoutNode";

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

// ─── Shared leaf: a list of segment-name strings ─────────────────────────────

// [LAW:locality-or-seam] `pathPrefix` is the caller's actual row path, so the
// error path reflects the form the user wrote: `layout[r][c]` for a bare-array
// row, `layout[r].segments[c]` for an object/cells row. The discriminator lives in
// the caller (which knows which form it received); threading the prefix keeps the
// error honest about the input rather than asserting a `.segments` key a sugar-form
// config never wrote.
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

// [LAW:dataflow-not-control-flow] The `segments` field of an object-form layout
// row: REQUIRED, so a missing/non-array value fails the record and the row drops
// (the old `if (!Array.isArray) { push; return null }`). The bespoke message and
// the `layout` line key are DATA on the spec.
function rowSegmentsSpec(): FieldSpec<readonly string[]> {
  return {
    required: true,
    json: { type: "array", items: { type: "string" } },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (!Array.isArray(v)) {
        ctx.issues.push({
          path: `${path}.${field}`,
          message: `a layout row object must have a "segments" array of segment names, got ${describeType(v)}`,
          line: findKeyLine(ctx.source, ["layout"]),
        });
        return undefined;
      }
      return validateLayoutSegments(ctx, `${path}.${field}`, v);
    },
  };
}

// [LAW:dataflow-not-control-flow] The `segments` field of a `cells` node: RECOVERS
// to `[]` on a missing/non-array value (the old `return rowToHorizontal([], when)`)
// rather than dropping the node, so traversal keeps collecting issues. Bespoke
// message + `root` line key as DATA; distinct from `rowSegmentsSpec` only in those
// data and in recover-vs-drop.
function cellsSegmentsSpec(): FieldSpec<readonly string[]> {
  return {
    // [LAW:types-are-the-program] `required` has two readers: `fields` (fail when
    // a required field's parse returns undefined) and `objectJson` (emit the field
    // in the schema `required`). This parse RECOVERS (never returns undefined), so
    // `required: true` is a no-op for `fields` — but it correctly tells the emitter
    // the field is mandatory, matching the loader's behavior (a missing `segments`
    // pushes an issue → parseDslConfig throws). `required: false` would lie to the
    // emitter, weakening the schema below what the validator enforces.
    required: true,
    json: { type: "array", items: { type: "string" } },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (!Array.isArray(v)) {
        ctx.issues.push({
          path: `${path}.${field}`,
          message: `a cells node must have a "segments" array of segment names, got ${describeType(v)}`,
          line: findKeyLine(ctx.source, ["root"]),
        });
        return [];
      }
      return validateLayoutSegments(ctx, `${path}.${field}`, v);
    },
  };
}

// ─── Layout row sugar (`layout`) ─────────────────────────────────────────────

// [LAW:types-are-the-program] An object-form row IS a record: `{ when?, segments }`
// with unknown-key rejection. The `segments` field is required (a row without it
// drops); `when` is preserved faithfully — an explicit `when: ""` is a present-if-
// degenerate predicate, distinct from an absent one, which `optionalStringSpec`'s
// present/absent split keeps (a truthiness check would silently drop "").
const ROW_SCHEMA: RecordSchema<LayoutRow> = {
  noun: "layout-row key",
  fields: {
    when: optionalStringSpec(),
    segments: rowSegmentsSpec(),
  },
};

// [LAW:locality-or-seam] One row → one validated row, IN THE FORM THE USER WROTE
// IT (bare `string[]` stays an array; `{ when?, segments }` stays an object).
// STRUCTURAL validation only — normalization to the node tree is `layoutRowsToNode`'s
// job, the single lowering boundary, so the parsed shape can faithfully describe
// the user-file domain the JSON Schema validates against. A bare string at the
// outer level is the legacy flat layout — rejected with a wrap hint, not silently
// shimmed [LAW:no-silent-fallbacks]. The array-vs-object-vs-string dispatch is a
// structural shape union — it fits no generic combinator, so it stays local.
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
    return record(ctx, ROW_SCHEMA, `layout[${r}]`, row);
  }
  ctx.issues.push({
    path: `layout[${r}]`,
    message: `a layout row must be an array of segment names or a { when?, segments } object, got ${describeType(row)}`,
    line: findKeyLine(ctx.source, ["layout"]),
  });
  return null;
}

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

// ─── Root node grammar (`root`) ──────────────────────────────────────────────

// [LAW:dataflow-not-control-flow] On a fundamental shape error (non-object node or
// unknown kind) the dispatch returns a degenerate node so traversal continues
// collecting issues — parseDslConfig throws once any issue exists, so the fallback
// never renders. This is the recovery shape the generic `record`/union engines do
// NOT own (they drop to null); it stays local as a separate pass over the engine.
const EMPTY_VERTICAL_NODE: LayoutNode = {
  kind: "container",
  direction: "vertical",
  children: [],
};

// [LAW:types-are-the-program] A node's `kind` is a literal the dispatch has already
// validated; as a record field it is included (so the unknown-key rejection allows
// it) and yields the literal back. It can never be absent or wrong here — the
// dispatch routes to this arm only on an exact kind match.
// `required: true` though parse never fails — it's mandatory in the emitted
// schema (the const discriminator), a no-op for `fields`. See `cellsSegmentsSpec`.
function literalSpec<V extends string>(value: V): FieldSpec<V> {
  return { required: true, json: { const: value }, parse: () => value };
}

// [LAW:dataflow-not-control-flow] A segment node's `name`: present-non-empty-string
// → the name; anything else → the bespoke issue plus a `""` fallback (NOT a drop),
// so the node recovers and traversal continues. The fallback IS the value (never
// undefined), so the record always keeps the field.
function segmentNameSpec(): FieldSpec<string> {
  return {
    // Mandatory in the schema (a missing/empty name pushes an issue → throw); the
    // parse recovers to "" so it's a no-op for `fields`. See `cellsSegmentsSpec`.
    required: true,
    json: { type: "string" },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (typeof v === "string" && v.length > 0) return v;
      ctx.issues.push({
        path: `${path}.${field}`,
        message: `a segment node must have a non-empty "name" (a segment name), got ${describeValue(v)}`,
        line: findKeyLine(ctx.source, ["root"]),
      });
      return "";
    },
  };
}

// [LAW:one-source-of-truth] Valid directions come from the DIRECTIONS list — the
// same set the renderer projects. An invalid/absent direction recovers to
// `vertical` (the node is never dropped) plus the bespoke issue. Distinct from the
// generic `optionalEnumSpec`, which OMITS on invalid; a container's `direction` is
// required, so it must recover to a value, not vanish.
function directionSpec(): FieldSpec<Direction> {
  return {
    // Mandatory in the schema (a missing/invalid direction pushes an issue →
    // throw); the parse recovers to "vertical", a no-op for `fields`. See
    // `cellsSegmentsSpec`.
    required: true,
    json: { enum: [...DIRECTIONS] },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (
        typeof v === "string" &&
        (DIRECTIONS as readonly string[]).includes(v)
      ) {
        return v as Direction;
      }
      ctx.issues.push({
        path: `${path}.${field}`,
        message: `a container "direction" must be one of: ${DIRECTIONS.join(", ")} (got ${JSON.stringify(v)})`,
        line: findKeyLine(ctx.source, ["root"]),
      });
      return "vertical";
    },
  };
}

// [LAW:decomposition] A container's `children` are themselves nodes — the one
// recursive field. It recovers to `[]` on a non-array value (the node is kept),
// and otherwise maps each child through the node parser. The parser is referenced
// through `lazy` so this spec can live inside CONTAINER_SCHEMA as data that points
// back at `validateRoot` without a temporal-dead-zone read at module load.
function childrenSpec(
  node: (ctx: ValidateCtx, path: string, raw: unknown) => LayoutNode,
): FieldSpec<readonly LayoutNode[]> {
  return {
    // Mandatory in the schema (a missing/non-array `children` pushes an issue →
    // throw); the parse recovers to [], a no-op for `fields`. See `cellsSegmentsSpec`.
    required: true,
    // [LAW:one-source-of-truth] The recursive field points at the node definition
    // via `$ref` — emit's analogue of the `lazy` thunk that defers the parse-time
    // self-reference. The runtime recursion and the schema recursion break the
    // same cycle, declared in one place.
    json: { type: "array", items: { $ref: LAYOUT_NODE_REF } },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (!Array.isArray(v)) {
        ctx.issues.push({
          path: `${path}.${field}`,
          message: `a container must have a "children" array of layout nodes, got ${describeType(v)}`,
          line: findKeyLine(ctx.source, ["root"]),
        });
        return [];
      }
      return v.map((child, i) => node(ctx, `${path}.${field}[${i}]`, child));
    },
  };
}

const SEGMENT_NODE_SCHEMA: RecordSchema<SegmentNode> = {
  noun: "layout-node key",
  fields: {
    kind: literalSpec("segment"),
    name: segmentNameSpec(),
    when: optionalStringSpec(),
  },
};

const CONTAINER_SCHEMA: RecordSchema<ContainerNode> = {
  noun: "layout-node key",
  fields: {
    kind: literalSpec("container"),
    direction: directionSpec(),
    children: childrenSpec(lazy(() => validateRoot)),
    when: optionalStringSpec(),
  },
};

// [LAW:one-source-of-truth] `cells` is authoring SUGAR for a horizontal run of
// segments. The schema validates the raw `cells` shape; the dispatch LOWERS it to
// `container(horizontal, [segment…])` — the canonical form — so no `cells` value
// escapes the loader. The `when` (if any) gates the whole row-container, the same
// as a `LayoutRow`'s.
interface CellsNode {
  readonly kind: "cells";
  readonly segments: readonly string[];
  readonly when?: string;
}

const CELLS_SCHEMA: RecordSchema<CellsNode> = {
  noun: "layout-node key",
  fields: {
    kind: literalSpec("cells"),
    segments: cellsSegmentsSpec(),
    when: optionalStringSpec(),
  },
};

// [LAW:locality-or-seam] The boundary that turns the raw `root` grammar into a
// validated LayoutNode tree. STRUCTURAL only — whether a segment name resolves and
// whether a `when` ref exists are cross-ref concerns (validateCrossReferences runs
// on the MERGED config, so a node can name default-provided segments).
//
// [LAW:dataflow-not-control-flow] The `kind` discriminator selects the arm; an
// unknown kind is rejected, never coerced. Object-guard and unknown-kind fold into
// one bespoke message each (pinned to the `root` line) — the local dispatch the
// generic taggedUnion does not express. A `const` (not a hoisted function) so the
// `lazy` thunk inside CONTAINER_SCHEMA defers reading it; reading it eagerly there
// would be a temporal-dead-zone crash.
export const validateRoot = (
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): LayoutNode => {
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path,
      message: `a layout node must be an object with "kind" of "container", "segment", or "cells", got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, ["root"]),
    });
    return EMPTY_VERTICAL_NODE;
  }
  if (raw.kind === "container") {
    return record(ctx, CONTAINER_SCHEMA, path, raw) ?? EMPTY_VERTICAL_NODE;
  }
  if (raw.kind === "segment") {
    return record(ctx, SEGMENT_NODE_SCHEMA, path, raw) ?? EMPTY_VERTICAL_NODE;
  }
  if (raw.kind === "cells") {
    const cells = record(ctx, CELLS_SCHEMA, path, raw);
    return cells === null
      ? EMPTY_VERTICAL_NODE
      : rowToHorizontal(cells.segments, cells.when);
  }
  ctx.issues.push({
    path: `${path}.kind`,
    message: `a layout node "kind" must be "container", "segment", or "cells", got ${JSON.stringify(raw.kind)}`,
    line: findKeyLine(ctx.source, ["root"]),
  });
  return EMPTY_VERTICAL_NODE;
};

// ─── Schema emit ─────────────────────────────────────────────────────────────

// [LAW:one-source-of-truth] The LayoutNode definition: the anyOf of the three
// kind-arms `validateRoot` dispatches over (container / segment / cells), each
// derived from the SAME record schema the validator interprets. The `kind`
// `const` on each arm keeps them disjoint; the container arm's `children` field
// `$ref`s back here, closing the recursion. The emitter publishes this at
// `LAYOUT_NODE_REF`, so a config writing `root` is validated by the same grammar
// the loader enforces — `cells` sugar included (the old type-derived schema
// omitted it; deriving from the loader declaration restores parity).
export function layoutNodeJson(): JsonNode {
  return {
    anyOf: [
      recordJson(CONTAINER_SCHEMA),
      recordJson(SEGMENT_NODE_SCHEMA),
      recordJson(CELLS_SCHEMA),
    ],
  };
}

// [LAW:one-source-of-truth] The `layout` row-sugar surface: an array of rows,
// each a bare `string[]` (a predicate-less row) OR a `{ when?, segments }`
// object — the two forms `validateLayoutRow` dispatches over, derived from the
// SAME ROW_SCHEMA. A bare string at the row level (the legacy flat layout) matches
// neither and is rejected, the same boundary the validator draws.
export function layoutRowsJson(): JsonNode {
  return {
    type: "array",
    items: {
      anyOf: [
        { type: "array", items: { type: "string" } },
        recordJson(ROW_SCHEMA),
      ],
    },
  };
}
