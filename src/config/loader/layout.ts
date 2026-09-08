// [LAW:one-source-of-truth][LAW:no-silent-failure] The A-grammar is the ONE authoring surface; every other shape is a migration error.
// [LAW:types-are-the-program] DATA schemas over the generic `record` engine; only the kind-dispatch and the degenerate-node recovery stay local.

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
  DISTRIBUTION_NAMES,
  type DistributionName,
} from "../../themes/decor.js";
import {
  DISCLOSURE_CLOSED,
  DISCLOSURE_GLYPH_CLOSED,
  DISCLOSURE_GLYPH_OPEN,
  disclosureCycleAction,
  disclosureNode,
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

// [LAW:types-are-the-program] `$ref` is emit's analogue of the `lazy` thunk that breaks the parse-time cycle.
export const LAYOUT_NODE_REF = "#/definitions/LayoutNode";
export const LAYOUT_NODE_DEF_NAME = "LayoutNode";
export const ROOT_FRAGMENT_REF = "#/definitions/RootFragment";
export const ROOT_FRAGMENT_DEF_NAME = "RootFragment";

// [LAW:dataflow-not-control-flow] A shape error recovers here so traversal keeps collecting issues; parseDslConfig then throws.
const EMPTY_VERTICAL_NODE: LayoutNode = {
  kind: "container",
  direction: "vertical",
  children: [],
};

// [LAW:types-are-the-program] The dispatch already matched `kind`; `required` is for the emitted schema alone.
function literalSpec<V extends string>(value: V): FieldSpec<V> {
  return { required: true, json: { const: value }, parse: () => value };
}

// [LAW:dataflow-not-control-flow] A bad `name` recovers to "" rather than dropping, so traversal continues.
function segmentNameSpec(): FieldSpec<string> {
  return {
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

// [LAW:one-source-of-truth] Unlike `optionalEnumSpec`, an invalid direction recovers to a value rather than vanishing.
function directionSpec(): FieldSpec<Direction> {
  return {
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

// [LAW:decomposition] The one recursive field: `lazy` lets it point back at `validateRoot` with no dead-zone read.
function childrenSpec(
  node: (ctx: ValidateCtx, path: string, raw: unknown) => LayoutNode,
): FieldSpec<readonly LayoutNode[]> {
  return {
    required: true,
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

// [LAW:types-are-the-program] `opens` is deliberately unauthorable, so `disclosureNode` stays the only producer of a body.
const SEGMENT_NODE_SCHEMA: RecordSchema<Omit<SegmentNode, "opens">> = {
  noun: "layout-node key",
  fields: {
    kind: literalSpec("segment"),
    name: segmentNameSpec(),
    when: optionalStringSpec(),
  },
};

const distributionSpec = (): FieldSpec<DistributionName> =>
  optionalEnumSpec(DISTRIBUTION_NAMES);

const CONTAINER_SCHEMA: RecordSchema<ContainerNode> = {
  noun: "layout-node key",
  fields: {
    kind: literalSpec("container"),
    direction: directionSpec(),
    children: childrenSpec(lazy(() => validateRoot)),
    when: optionalStringSpec(),
    distribution: distributionSpec(),
  },
};

// [LAW:types-are-the-program] Terse spellings, bijective by construction: exactly one of seg/h/v
// makes the wrong arm unrepresentable. [LAW:single-enforcer] The loader's exit code is truth.

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
  readonly distribution?: DistributionName;
}

const H_ARM_SCHEMA: RecordSchema<HArmNode> = {
  noun: "layout-node key",
  fields: {
    h: childrenSpec(lazy(() => validateRoot)),
    when: optionalStringSpec(),
    distribution: distributionSpec(),
  },
};

interface VArmNode {
  readonly v: readonly LayoutNode[];
  readonly when?: string;
  readonly distribution?: DistributionName;
}

const V_ARM_SCHEMA: RecordSchema<VArmNode> = {
  noun: "layout-node key",
  fields: {
    v: childrenSpec(lazy(() => validateRoot)),
    when: optionalStringSpec(),
    distribution: distributionSpec(),
  },
};

// [LAW:locality-or-seam] STRUCTURAL only: name resolution is a cross-ref concern over the MERGED config.
// A `const`, not a hoisted function, so CONTAINER_SCHEMA's `lazy` thunk can defer reading it.
export const validateRoot = (
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): LayoutNode => {
  // Checked before the object guard so "not an object" cannot fire on a valid input.
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
    // [LAW:no-silent-failure] Reject loudly, naming the A-grammar equivalent.
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
      ...(arm.distribution !== undefined && { distribution: arm.distribution }),
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
      ...(arm.distribution !== undefined && { distribution: arm.distribution }),
    };
  }
  ctx.issues.push({
    path: `${path}.kind`,
    message: `a layout node "kind" must be "container", "segment", or "group", or use the terse A-grammar: a bare string, or an object with "seg", "h", or "v" (got ${JSON.stringify(raw.kind)})`,
    line: findKeyLine(ctx.source, ["root"]),
  });
  return EMPTY_VERTICAL_NODE;
};

// [LAW:types-are-the-program] A row name is never integer-like, so authoring order survives the spread.
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
          line: findKeyLine(ctx.source, [...path.split("."), field]),
        });
        return {};
      }
      const rows: Record<string, LayoutNode> = {};
      for (const [name, node] of Object.entries(v)) {
        if (!ROW_NAME_RE.test(name)) {
          ctx.issues.push({
            path: `${path}.${field}.${name}`,
            message: `row name "${name}" must be an identifier (letters, digits, _; not starting with a digit) — it names the row in the config file and merges by name over the bundled default's rows`,
            line: findKeyLine(ctx.source, [...path.split("."), field, name]),
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
  fields: {
    rows: rowsSpec(),
    when: optionalStringSpec(),
    distribution: distributionSpec(),
  },
};

// [LAW:types-are-the-program] `{ rows }` is the by-name fragment: rows merge at a root, never at a container.
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

export function rootFragmentJson(): JsonNode {
  return { anyOf: [{ $ref: LAYOUT_NODE_REF }, recordJson(ROWS_SCHEMA)] };
}

// [LAW:one-source-of-truth] The reserved namespace: a user name here is rejected, never silently overwritten.
export const GROUP_NS = "groups.";

// [LAW:one-source-of-truth] A group name splices into `.groups.<name>` and may not equal the closed sentinel.
function groupNameSpec(): FieldSpec<string> {
  return {
    required: true,
    json: { type: "string", pattern: ROW_NAME_RE.source },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (
        typeof v !== "string" ||
        !ROW_NAME_RE.test(v) ||
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

// [LAW:single-enforcer] The same wire shape the `set` key enforces, since the group synthesizes it.
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

// [LAW:types-are-the-program] One declaration everything else derives from: `direction`/`distribution`
// arrange the BODY, `key` opts siblings into one accordion, `when` gates the whole group.
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
  readonly distribution?: DistributionName;
  readonly children: readonly LayoutNode[];
}

// [LAW:no-silent-failure] A newline in a label would produce a template literal go-template-js forbids.
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
    distribution: distributionSpec(),
    children: childrenSpec(lazy(() => validateRoot)),
  },
};

// [LAW:dataflow-not-control-flow] One value selects accordion vs independent — no mode.
function groupStateKey(g: { name: string; key?: string }): string {
  return g.key ?? GROUP_NS + g.name;
}

// [LAW:one-source-of-truth] Trigger and body both derive from the group's name, so the gate reads the
// var the cycle writes; the accordion falls out of one key holding one name.
function lowerGroup(g: GroupNodeInput): LayoutNode {
  const ref = GROUP_NS + g.name;
  return disclosureNode(
    ref,
    { variable: ref, member: g.name },
    {
      kind: "container",
      direction: g.direction ?? "vertical",
      children: g.children,
      ...(g.distribution !== undefined && { distribution: g.distribution }),
    },
    g.when,
  );
}

function groupIssue(ctx: ValidateCtx, path: string, message: string): void {
  ctx.issues.push({
    path,
    message,
    line: findKeyLine(ctx.source, ["root"]),
  });
}

// [LAW:one-source-of-truth] Runs AFTER the user's sections parsed, so a reserved name is a loud rejection.
// Load errors: duplicate names; an ancestor and descendant sharing a key; two `open: true` on one key.
export function synthesizeGroupDecls(
  ctx: ValidateCtx,
  out: Mutable<RawDslConfig>,
): void {
  // [LAW:single-enforcer] Reserved UNCONDITIONALLY, so "you never author groups.*" is a stable contract.
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

  // [LAW:one-source-of-truth] One initial value per key, so two vars on it cannot disagree.
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
    // [LAW:dataflow-not-control-flow] Depth derives from the paths already in ctx.groups.
    const depth = groups.filter(
      (other) => other !== g && g.path.startsWith(other.path + "."),
    ).length;
    const indent = "  ".repeat(depth);
    // [LAW:one-source-of-truth] Closed-first, so an unset or sibling-held key expands this group.
    variables[name] = disclosureStateVar(key, defaultByKey.get(key)!);
    actions[name] = disclosureCycleAction(key, g.name);
    // [LAW:representation] The glyph TRAILS its label so abutted toggles stay unambiguous.
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

// [LAW:one-source-of-truth] The anyOf of ALL arms `validateRoot` dispatches over, from the same schemas.
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
