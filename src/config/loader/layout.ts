// [LAW:one-source-of-truth] The ONE layout authoring surface is the A-grammar
// (a bare string = segment ref; { seg, when? } = segment ref with predicate;
// { h: [...], when? } = horizontal container; { v: [...], when? } = vertical
// container; { kind: "group", … } = collapsible group). ALL other shapes are
// migration errors [LAW:no-silent-failure]:
//
//   `layout:` top-level key (removed in 2de.19) → error with A-grammar rewrite
//   `kind: "cells"` node (removed in 2de.19)     → error with { h: […] } rewrite
//
// [LAW:types-are-the-program] The node grammar is DATA schemas interpreted by the
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
  type RawDslConfig,
  type Root,
  type RootFragment,
  type SegmentDecl,
  type SegmentNode,
  type VariableDecl,
} from "../dsl-types.js";
import { ROW_NAME_RE } from "../root.js";
import type { ActionDecl } from "../action.js";
import {
  DISCLOSURE_CLOSED,
  DISCLOSURE_GLYPH_CLOSED,
  DISCLOSURE_GLYPH_OPEN,
  disclosureCycleAction,
  disclosureGate,
  disclosureStateVar,
  disclosureTrigger,
} from "../disclosure.js";
import { findKeyLine } from "./diagnostics.js";
import { reservedNamespaceCollisions } from "./reserved-namespace.js";
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
// The definition a `root:` (top-level or a preset's) is validated against: a
// whole tree (the node definition above) or a `{ rows }` map of named nodes.
export const ROOT_FRAGMENT_REF = "#/definitions/RootFragment";
export const ROOT_FRAGMENT_DEF_NAME = "RootFragment";

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

// ─── Option A shape grammar (seg / h / v) ────────────────────────────────────

// [LAW:types-are-the-program] The terse bijective spellings of the canonical
// tree: a bare string names a segment; an object with exactly one of "seg",
// "h", or "v" spells a segment-ref-with-predicate, a horizontal container, or
// a vertical container respectively. Every legal canonical node is expressible;
// no illegal one is — bijectivity is the acceptance test. The key-count check
// (exactly one of seg/h/v) is the dispatch-level invariant that makes the wrong
// arm unrepresentable as a valid parse. [LAW:single-enforcer] — the loader is
// the sole enforcer; the JSON Schema emitter mirrors it, but the loader's exit
// code is the truth.

interface SegArmNode {
  readonly seg: string;
  readonly when?: string;
}

function segArmSpec(): FieldSpec<string> {
  return {
    required: true,
    json: { type: "string" },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (typeof v === "string" && v.length > 0) return v;
      ctx.issues.push({
        path: `${path}.${field}`,
        message: `a "seg" node must have a non-empty segment name, got ${describeValue(v)}`,
        line: findKeyLine(ctx.source, ["root"]),
      });
      return "";
    },
  };
}

const SEG_ARM_SCHEMA: RecordSchema<SegArmNode> = {
  noun: "layout-node key",
  fields: { seg: segArmSpec(), when: optionalStringSpec() },
};

interface HArmNode {
  readonly h: readonly LayoutNode[];
  readonly when?: string;
}

const H_ARM_SCHEMA: RecordSchema<HArmNode> = {
  noun: "layout-node key",
  fields: {
    h: childrenSpec(lazy(() => validateRoot)),
    when: optionalStringSpec(),
  },
};

interface VArmNode {
  readonly v: readonly LayoutNode[];
  readonly when?: string;
}

const V_ARM_SCHEMA: RecordSchema<VArmNode> = {
  noun: "layout-node key",
  fields: {
    v: childrenSpec(lazy(() => validateRoot)),
    when: optionalStringSpec(),
  },
};

// ─── validateRoot ────────────────────────────────────────────────────────────

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
  // [LAW:types-are-the-program] A bare string is the terse segment-ref spelling.
  // Checked before the object guard so the "not an object" error does not fire
  // on a valid input.
  if (typeof raw === "string") {
    if (raw.length === 0) {
      ctx.issues.push({
        path,
        message: `a bare-string layout node must be a non-empty segment name`,
        line: findKeyLine(ctx.source, ["root"]),
      });
      return EMPTY_VERTICAL_NODE;
    }
    return { kind: "segment", name: raw };
  }
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path,
      message: `a layout node must be a string (segment name) or an object with "kind" / "seg" / "h" / "v", got ${describeType(raw)}`,
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
    // [LAW:no-silent-failure] `kind: "cells"` removed in 2de.19. Reject loudly
    // with the A-grammar equivalent so the author knows exactly how to migrate.
    ctx.issues.push({
      path,
      message: `kind: "cells" is no longer supported — use the h-arm spelling instead:\n  Old: { kind: "cells", segments: ["seg1", "seg2"] }\n  New: { h: ["seg1", "seg2"] }`,
      line: findKeyLine(ctx.source, ["root"]),
    });
    return EMPTY_VERTICAL_NODE;
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
  // [LAW:types-are-the-program] Option A terse arms: exactly one of "seg" / "h"
  // / "v". Two or more present is an illegal state; zero means the object has
  // neither a valid "kind" nor a valid terse arm — both are loud rejections.
  const hasH = "h" in raw;
  const hasV = "v" in raw;
  const hasSeg = "seg" in raw;
  const armCount = (hasH ? 1 : 0) + (hasV ? 1 : 0) + (hasSeg ? 1 : 0);
  if (armCount > 1) {
    const present = (["seg", "h", "v"] as const).filter((k) => k in raw);
    ctx.issues.push({
      path,
      message: `a layout node may have exactly one of "seg", "h", or "v" — got ${present.map((k) => `"${k}"`).join(" and ")} together`,
      line: findKeyLine(ctx.source, ["root"]),
    });
    return EMPTY_VERTICAL_NODE;
  }
  if (hasSeg) {
    const arm = record(ctx, SEG_ARM_SCHEMA, path, raw);
    if (arm === null) return EMPTY_VERTICAL_NODE;
    return {
      kind: "segment",
      name: arm.seg,
      ...(arm.when !== undefined && { when: arm.when }),
    };
  }
  if (hasH) {
    const arm = record(ctx, H_ARM_SCHEMA, path, raw);
    if (arm === null) return EMPTY_VERTICAL_NODE;
    return {
      kind: "container",
      direction: "horizontal",
      children: arm.h,
      ...(arm.when !== undefined && { when: arm.when }),
    };
  }
  if (hasV) {
    const arm = record(ctx, V_ARM_SCHEMA, path, raw);
    if (arm === null) return EMPTY_VERTICAL_NODE;
    return {
      kind: "container",
      direction: "vertical",
      children: arm.v,
      ...(arm.when !== undefined && { when: arm.when }),
    };
  }
  ctx.issues.push({
    path: `${path}.kind`,
    message: `a layout node "kind" must be "container", "segment", or "group", or use the terse A-grammar: a bare string, or an object with "seg", "h", or "v" (got ${JSON.stringify(raw.kind)})`,
    line: findKeyLine(ctx.source, ["root"]),
  });
  return EMPTY_VERTICAL_NODE;
};

// ─── Root fragment (`root:` — a whole tree or a `{ rows }` map) ──────────────

// [LAW:types-are-the-program] The rows map: name → node, each name an
// identifier (ROW_NAME_RE — never integer-like, so authoring order survives the
// by-name spread) and each value any layout node. A bad name is a loud issue
// and the row is dropped from the recovery value; parseDslConfig throws once
// any issue exists, so the recovery never renders.
function rowsSpec(): FieldSpec<Root["rows"]> {
  return {
    required: true,
    json: {
      type: "object",
      propertyNames: { pattern: ROW_NAME_RE.source },
      additionalProperties: { $ref: LAYOUT_NODE_REF },
    },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (!isPlainObject(v)) {
        ctx.issues.push({
          path: `${path}.${field}`,
          message: `"rows" must be an object of row name → layout node, got ${describeType(v)}`,
          line: findKeyLine(ctx.source, ["root"]),
        });
        return {};
      }
      const rows: Record<string, LayoutNode> = {};
      for (const [name, node] of Object.entries(v)) {
        if (!ROW_NAME_RE.test(name)) {
          ctx.issues.push({
            path: `${path}.${field}.${name}`,
            message: `row name "${name}" must be an identifier (letters, digits, _; not starting with a digit) — it names the row in the config file and merges by name over the bundled default's rows`,
            line: findKeyLine(ctx.source, ["root"]),
          });
          continue;
        }
        rows[name] = validateRoot(ctx, `${path}.${field}.${name}`, node);
      }
      return rows;
    },
  };
}

const ROWS_SCHEMA: RecordSchema<Root> = {
  noun: "root key",
  fields: { rows: rowsSpec(), when: optionalStringSpec() },
};

// [LAW:types-are-the-program] The two intents a `root:` can spell, dispatched
// on the shape the author wrote: a `{ rows }` object is the by-name fragment,
// anything else is a whole tree through the node grammar above. A `rows`
// object nested INSIDE a node is not a fragment and falls to validateRoot's
// own rejection — rows merge at a root, never at a container.
export function validateRootFragment(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): RootFragment {
  if (isPlainObject(raw) && "rows" in raw) {
    return record(ctx, ROWS_SCHEMA, path, raw) ?? { rows: {} };
  }
  return validateRoot(ctx, path, raw);
}

// [LAW:one-source-of-truth] The RootFragment definition: the anyOf of exactly
// the two arms `validateRootFragment` dispatches over, each derived from the
// schema the validator interprets.
export function rootFragmentJson(): JsonNode {
  return { anyOf: [{ $ref: LAYOUT_NODE_REF }, recordJson(ROWS_SCHEMA)] };
}

// ─── Group sugar (`kind: "group"`) ───────────────────────────────────────────

// [LAW:one-source-of-truth] The reserved namespace every synthesized artifact
// lives under, in all three sections (variables / actions / segments). One
// group declaration is the single source; the var, the action, and the toggle
// segment all derive their name from it. A user-authored name under this
// prefix is rejected so synthesis can never silently collide.
export const GROUP_NS = "groups.";

// [LAW:one-source-of-truth] The closed sentinel and ▸/▾ glyphs are the shared
// disclosure primitive (src/config/disclosure.ts) — a group is one of its two
// body-kinds, so it reuses DISCLOSURE_CLOSED / DISCLOSURE_GLYPH_* rather than
// keeping a second copy that could drift from the menu's. Group names are
// forbidden from equaling the sentinel, so a cycle's two members are distinct.

// [LAW:types-are-the-program] A group name must be template-addressable — it is
// spliced into the synthesized `when` predicate and toggle template as
// `.groups.<name>`, and Go-template field syntax admits identifier characters
// only. The pattern IS that constraint; it also excludes quotes, slashes, and
// dots, so a name needs no escaping anywhere it is spliced.
const GROUP_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function groupNameSpec(): FieldSpec<string> {
  return {
    required: true,
    json: { type: "string", pattern: GROUP_NAME_RE.source },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (
        typeof v !== "string" ||
        !GROUP_NAME_RE.test(v) ||
        v === DISCLOSURE_CLOSED
      ) {
        ctx.issues.push({
          path: `${path}.${field}`,
          message: `a group "name" must be an identifier (letters, digits, _; not starting with a digit) and not the reserved "${DISCLOSURE_CLOSED}", got ${describeValue(v)}`,
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
        when: disclosureGate({ variable: ref, member: g.name }),
      },
    ],
    ...(g.when !== undefined && { when: g.when }),
  };
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
  // [LAW:single-enforcer] The disclosure primitive's shared reserved-namespace
  // enforcer (mirroring {{ menu }}'s `menus.`) — a user name under `groups.`
  // would silently shadow a synthesized artifact. Reserved UNCONDITIONALLY,
  // before the no-groups early return, so the reservation is a stable contract
  // ("you never author groups.*"), not a rule that only switches on when a
  // group node happens to be declared this load — same placement as the menus
  // pass (synthesizeMenuDecls).
  reservedNamespaceCollisions(ctx, out, GROUP_NS, "group nodes");

  const groups = ctx.groups;
  if (groups.length === 0) return;

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
    if (!defaultByKey.has(key)) defaultByKey.set(key, DISCLOSURE_CLOSED);
    if (g.open === true) {
      const prior = defaultByKey.get(key)!;
      if (prior !== DISCLOSURE_CLOSED) {
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
    // [LAW:dataflow-not-control-flow] Depth is a value derivable from the paths
    // already in ctx.groups — no extra threading. Strict-prefix count gives
    // nesting depth; the indent embeds as a string constant in the template.
    const depth = groups.filter(
      (other) => other !== g && g.path.startsWith(other.path + "."),
    ).length;
    const indent = "  ".repeat(depth);
    // [LAW:one-source-of-truth] The shared disclosure toggle: one state var + one
    // binary cycle action, both from the primitive. Members are ordered default-
    // state-first (closed first): an unset or sibling-held key counts as the first
    // member, so the toggle renders ▸ and clicks to its own name — expand, auto-
    // closing the sibling on a shared key.
    variables[name] = disclosureStateVar(key, defaultByKey.get(key)!);
    actions[name] = disclosureCycleAction(key, g.name);
    // [LAW:representation] The disclosure glyph trails the label it gates, so an
    // arrow reads as belonging to the text on its LEFT — adjacent toggles
    // ("details ▸" "links ▸") stay unambiguous even when abutted. `indent` is a
    // structural left-margin (nesting depth) and stays leading; the glyph is a
    // trailing affordance on the label, never a prefix.
    segments[name] = {
      template: disclosureTrigger(
        name,
        `${indent}${g.label} ${DISCLOSURE_GLYPH_CLOSED}`,
        `${indent}${g.label} ${DISCLOSURE_GLYPH_OPEN}`,
      ),
      ...(g.bg !== undefined && { bg: g.bg }),
      ...(g.fg !== undefined && { fg: g.fg }),
    };
  }
  out.variables = { ...(out.variables ?? {}), ...variables };
  out.actions = { ...(out.actions ?? {}), ...actions };
  out.segments = { ...(out.segments ?? {}), ...segments };
}

// ─── Schema emit ─────────────────────────────────────────────────────────────

// [LAW:one-source-of-truth] The LayoutNode definition: the anyOf of ALL arms
// `validateRoot` dispatches over — kind-based (container / segment / group) and
// terse A-grammar (bare string, seg-arm, h-arm, v-arm) — each derived from the
// SAME schema the validator interprets. The `kind` const and the unique required
// key keep arms disjoint; the container/h/v children `$ref` back here, closing
// the recursion. `{ type: "string" }` covers the bare-string segment-ref form.
export function layoutNodeJson(): JsonNode {
  return {
    anyOf: [
      { type: "string" },
      recordJson(CONTAINER_SCHEMA),
      recordJson(SEGMENT_NODE_SCHEMA),
      recordJson(GROUP_SCHEMA),
      recordJson(SEG_ARM_SCHEMA),
      recordJson(H_ARM_SCHEMA),
      recordJson(V_ARM_SCHEMA),
    ],
  };
}
