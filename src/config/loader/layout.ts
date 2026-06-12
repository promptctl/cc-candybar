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
  type RawDslConfig,
  type SegmentDecl,
  type SegmentNode,
  type VariableDecl,
} from "../dsl-types.js";
import type { ActionDecl } from "../action.js";
import { findKeyLine } from "./diagnostics.js";
import {
  describeType,
  describeValue,
  isPlainObject,
  lazy,
  optionalBooleanSpec,
  optionalEnumSpec,
  optionalStringSpec,
  record,
  recordJson,
  requireString,
  requireStringSpec,
  type FieldSpec,
  type JsonNode,
  type Mutable,
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
      message: `a layout node must be an object with "kind" of "container", "segment", "cells", or "group", got ${describeType(raw)}`,
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
  if (raw.kind === "group") {
    const group = record(ctx, GROUP_SCHEMA, path, raw);
    if (group === null) return EMPTY_VERTICAL_NODE;
    // Collected for the post-walk synthesis pass (state var + cycle action +
    // toggle segment); the node itself lowers to the canonical grammar here.
    ctx.groups.push({
      name: group.name,
      label: group.label,
      ...(group.open !== undefined && { open: group.open }),
      ...(group.direction !== undefined && { direction: group.direction }),
      ...(group.key !== undefined && { key: group.key }),
      ...(group.bg !== undefined && { bg: group.bg }),
      ...(group.fg !== undefined && { fg: group.fg }),
      ...(group.when !== undefined && { when: group.when }),
      path,
    });
    return lowerGroup(group);
  }
  ctx.issues.push({
    path: `${path}.kind`,
    message: `a layout node "kind" must be "container", "segment", "cells", or "group", got ${JSON.stringify(raw.kind)}`,
    line: findKeyLine(ctx.source, ["root"]),
  });
  return EMPTY_VERTICAL_NODE;
};

// ─── Group sugar (`kind: "group"`) ───────────────────────────────────────────

// [LAW:one-source-of-truth] The reserved namespace every synthesized artifact
// lives under, in all three sections (variables / actions / segments). One
// group declaration is the single source; the var, the action, and the toggle
// segment all derive their name from it. A user-authored name under this
// prefix is rejected so synthesis can never silently collide.
export const GROUP_NS = "groups.";

// The "no group open" sentinel a group's cycle starts from. Group names are
// forbidden from equaling it, so a cycle's two members are always distinct.
const GROUP_CLOSED = "closed";

// [LAW:types-are-the-program] A group name must be template-addressable — it is
// spliced into the synthesized `when` predicate and toggle template as
// `.groups.<name>`, and Go-template field syntax admits identifier characters
// only. The pattern IS that constraint; it also excludes quotes, slashes, and
// dots, so a name needs no escaping anywhere it is spliced.
const GROUP_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const GROUP_GLYPH_CLOSED = "▸";
const GROUP_GLYPH_OPEN = "▾";

function groupNameSpec(): FieldSpec<string> {
  return {
    required: true,
    json: { type: "string", pattern: GROUP_NAME_RE.source },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (
        typeof v !== "string" ||
        !GROUP_NAME_RE.test(v) ||
        v === GROUP_CLOSED
      ) {
        ctx.issues.push({
          path: `${path}.${field}`,
          message: `a group "name" must be an identifier (letters, digits, _; not starting with a digit) and not the reserved "${GROUP_CLOSED}", got ${describeValue(v)}`,
          line: findKeyLine(ctx.source, ["root"]),
        });
        return undefined;
      }
      return v;
    },
  };
}

// [LAW:single-enforcer] A group's optional shared `key` is a SessionState key —
// the same non-empty/slash-free wire shape the action loader's `set` key
// enforces, restated here because the group synthesizes that `set`.
function groupKeySpec(): FieldSpec<string> {
  return {
    required: false,
    json: { type: "string", minLength: 1 },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (v === undefined) return undefined;
      if (typeof v !== "string" || v === "" || v.includes("/")) {
        ctx.issues.push({
          path: `${path}.${field}`,
          message: `a group "key" must be a non-empty, slash-free SessionState key, got ${describeValue(v)}`,
          line: findKeyLine(ctx.source, ["root"]),
        });
        return undefined;
      }
      return v;
    },
  };
}

// [LAW:types-are-the-program] The `group` input record: one declaration carrying
// everything its synthesized artifacts derive from. `direction` arranges the
// BODY (the children container) — the toggle row always stacks above it;
// `key` opts sibling groups into one accordion (shared key ⇒ one open at a
// time); `open` picks the key's initial state; `bg`/`fg` paint the toggle
// segment; `when` gates the whole group (toggle included).
interface GroupNodeInput {
  readonly kind: "group";
  readonly name: string;
  readonly label: string;
  readonly open?: boolean;
  readonly direction?: Direction;
  readonly key?: string;
  readonly bg?: string;
  readonly fg?: string;
  readonly when?: string;
  readonly children: readonly LayoutNode[];
}

// [LAW:no-silent-failure] Reject newlines at the validator boundary — a label
// with \n or \r would reach escapeTemplateLiteral and produce a Go template
// string literal with an embedded newline, which go-template-js forbids. Fail
// loudly here so the loader surfaces the problem before synthesis runs.
function groupLabelSpec(): FieldSpec<string> {
  return {
    required: true,
    json: { type: "string", pattern: "^[^\\n\\r]*$" },
    parse: (ctx, path, field, raw) => {
      const s = requireString(ctx, path, raw, field);
      if (s === null) return undefined;
      if (/[\n\r]/.test(s)) {
        ctx.issues.push({
          path: `${path}.${field}`,
          message: `${path}.${field}: group label must not contain newlines`,
          line: findKeyLine(ctx.source, [...path.split("."), field]),
        });
        return undefined;
      }
      return s;
    },
  };
}

const GROUP_SCHEMA: RecordSchema<GroupNodeInput> = {
  noun: "layout-node key",
  fields: {
    kind: literalSpec("group"),
    name: groupNameSpec(),
    label: groupLabelSpec(),
    open: optionalBooleanSpec(),
    direction: optionalEnumSpec(DIRECTIONS),
    key: groupKeySpec(),
    bg: optionalStringSpec(),
    fg: optionalStringSpec(),
    when: optionalStringSpec(),
    children: childrenSpec(lazy(() => validateRoot)),
  },
};

// The state key a group toggles: the explicit shared `key` (accordion) or the
// group's own derived key (independent toggle). One value selects the behavior
// — no accordion mode [LAW:dataflow-not-control-flow].
function groupStateKey(g: { name: string; key?: string }): string {
  return g.key ?? GROUP_NS + g.name;
}

// [LAW:one-source-of-truth] Lower a group to the canonical grammar. The toggle
// segment ref and the body predicate both derive from the group's name — the
// same name the synthesis names the state var with, so the predicate reads
// exactly the var the toggle's cycle writes. The body is open exactly when the
// key holds THIS group's name (a sibling's name or "closed" hides it — the
// accordion falls out of one key holding one name).
function lowerGroup(g: GroupNodeInput): LayoutNode {
  const ref = GROUP_NS + g.name;
  return {
    kind: "container",
    direction: "vertical",
    children: [
      { kind: "segment", name: ref },
      {
        kind: "container",
        direction: g.direction ?? "vertical",
        children: g.children,
        when: `{{ eq .${ref} "${g.name}" }}`,
      },
    ],
    ...(g.when !== undefined && { when: g.when }),
  };
}

// Go-template string-literal escaping for the synthesized toggle template — the
// label is a plain display string (dynamic labels are raw-grammar territory),
// so backslashes and quotes are the only characters that could break the splice.
function escapeTemplateLiteral(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function groupIssue(ctx: ValidateCtx, path: string, message: string): void {
  ctx.issues.push({
    path,
    message,
    line: findKeyLine(ctx.source, ["root"]),
  });
}

// [LAW:one-source-of-truth] The synthesis pass: every artifact a group implies,
// derived from its one declaration and merged into the raw sections, AFTER the
// user's own sections parsed — so a user name under the reserved namespace is a
// loud rejection, never a silent overwrite. Runs once per parse, after the root
// walk collected every group with its tree position.
//
// Invariants enforced here (each a load error, never a silent fixup):
//   • group names are unique (they name the synthesized artifacts);
//   • no user-authored variable/action/segment under the reserved namespace;
//   • an ancestor and a descendant group never share a key (one key holds ONE
//     open name, so a same-key chain could not represent "both open" — sibling
//     accordions share keys, nested disclosure nests distinct keys);
//   • at most one group per shared key declares `open: true` (the key's single
//     initial value [LAW:one-source-of-truth]).
export function synthesizeGroupDecls(
  ctx: ValidateCtx,
  out: Mutable<RawDslConfig>,
): void {
  const groups = ctx.groups;
  if (groups.length === 0) return;

  for (const section of ["variables", "actions", "segments"] as const) {
    for (const name of Object.keys(out[section] ?? {})) {
      if (name.startsWith(GROUP_NS)) {
        groupIssue(
          ctx,
          `${section}.${name}`,
          `"${name}" is in the reserved "${GROUP_NS}" namespace (synthesized by group nodes) — rename it`,
        );
      }
    }
  }

  const seen = new Set<string>();
  for (const g of groups) {
    if (seen.has(g.name)) {
      groupIssue(
        ctx,
        g.path,
        `duplicate group name "${g.name}" — group names must be unique (they name the synthesized state var, action, and toggle segment)`,
      );
    }
    seen.add(g.name);
  }

  for (const inner of groups) {
    for (const outer of groups) {
      if (
        inner !== outer &&
        inner.path.startsWith(`${outer.path}.`) &&
        groupStateKey(inner) === groupStateKey(outer)
      ) {
        groupIssue(
          ctx,
          inner.path,
          `group "${inner.name}" shares key "${groupStateKey(inner)}" with its ancestor group "${outer.name}" — a shared key holds ONE open group, so an ancestor and a descendant cannot share one. Sibling accordions share a key; nested groups use distinct keys.`,
        );
      }
    }
  }

  // [LAW:one-source-of-truth] One initial value per key: the single open
  // group's name, else closed. Every var synthesized on a key carries the SAME
  // default, so two vars reading one key cannot disagree.
  const defaultByKey = new Map<string, string>();
  for (const g of groups) {
    const key = groupStateKey(g);
    if (!defaultByKey.has(key)) defaultByKey.set(key, GROUP_CLOSED);
    if (g.open === true) {
      const prior = defaultByKey.get(key)!;
      if (prior !== GROUP_CLOSED) {
        groupIssue(
          ctx,
          g.path,
          `groups "${prior}" and "${g.name}" share key "${key}" and both declare open: true — a shared key holds one open group; pick one`,
        );
      }
      defaultByKey.set(key, g.name);
    }
  }

  const variables: Record<string, VariableDecl> = {};
  const actions: Record<string, ActionDecl> = {};
  const segments: Record<string, SegmentDecl> = {};
  for (const g of groups) {
    const name = GROUP_NS + g.name;
    const key = groupStateKey(g);
    const label = escapeTemplateLiteral(g.label);
    variables[name] = {
      kind: "state",
      key,
      default: defaultByKey.get(key)!,
    };
    // Members are ordered default-state-first ("closed" first): an unset or
    // sibling-held key counts as the first member, so the toggle renders ▸ and
    // clicks to its own name — expand, auto-closing the sibling on a shared key.
    actions[name] = { set: key, cycle: [GROUP_CLOSED, g.name] };
    segments[name] = {
      template: `{{ action "${name}" "${GROUP_GLYPH_CLOSED} ${label}" "${GROUP_GLYPH_OPEN} ${label}" }}`,
      ...(g.bg !== undefined && { bg: g.bg }),
      ...(g.fg !== undefined && { fg: g.fg }),
    };
  }
  out.variables = { ...(out.variables ?? {}), ...variables };
  out.actions = { ...(out.actions ?? {}), ...actions };
  out.segments = { ...(out.segments ?? {}), ...segments };
}

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
      recordJson(GROUP_SCHEMA),
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
