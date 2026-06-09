// [LAW:one-source-of-truth] The JSON Schema emitter — the SECOND interpreter over
// the declarative loader schemas. `validateConfig` composes the per-module
// `validate*` functions to validate at runtime; `emitConfigSchema` composes the
// per-module `*Json` functions to derive the editor-facing JSON Schema. Both read
// the SAME module-private schema declarations (GLOBALS_SCHEMA, VARIABLE_SCHEMA,
// SEGMENT_SCHEMA, CACHE_SCHEMA, SET_ARMS, the layout grammar), so the published
// schema and the runtime validator can never describe a different grammar — the
// drift this resolves was real: the old schema derived from `dsl-types.ts` (it
// knew structure and enums, but not exactly-one-present for cache/actions, and it
// omitted the `cells` sugar). Deriving from the declarations closes those gaps.
//
// What a JSON Schema still cannot express (by construction): cross-field
// refinements (min<max, by≠0, input default matches type), palette-name
// membership, duration FORMAT, and cross-references between segments/variables/
// cycles. Those stay SEMANTIC checks the loader carries — schema = shape, lint =
// meaning, the same complementary boundary `config-schema.test.ts` pins.

import { globalsJson } from "./globals.js";
import { variablesMapJson } from "./variables.js";
import { segmentsJson } from "./segments.js";
import { actionsJson } from "./actions.js";
import {
  layoutNodeJson,
  layoutRowsJson,
  LAYOUT_NODE_DEF_NAME,
  LAYOUT_NODE_REF,
} from "./layout.js";
import type { JsonNode } from "./validate-core.js";

// [LAW:one-source-of-truth] The stable published identity. The committed artifact
// is self-identifying at this URL so an editor loading it via `$schema` resolves.
export const SCHEMA_ID =
  "https://raw.githubusercontent.com/promptctl/cc-candybar/main/schema/cc-candybar.schema.json";

// [LAW:dataflow-not-control-flow] The RawDslConfig schema: every top-level key is
// optional (a user file declares only what differs from the bundled default), so
// the object carries no `required`. Each property is one module's emitted shape —
// the same composition `validateConfig` performs over the validators. The two
// layout authoring surfaces (`layout` row sugar, `root` recursive node grammar)
// emit independently; `root` references the LayoutNode definition that closes the
// node recursion via `$ref`.
export function emitConfigSchema(): JsonNode {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: SCHEMA_ID,
    title: "cc-candybar config (.cc-candybar.json5)",
    type: "object",
    additionalProperties: false,
    properties: {
      globals: globalsJson(),
      variables: variablesMapJson(),
      segments: segmentsJson(),
      layout: layoutRowsJson(),
      root: { $ref: LAYOUT_NODE_REF },
      actions: actionsJson(),
      helpers: { type: "object", additionalProperties: { type: "string" } },
    },
    definitions: {
      [LAYOUT_NODE_DEF_NAME]: layoutNodeJson(),
    },
  };
}

// [LAW:single-enforcer] One serialization, shared by `gen:schema` (writes the
// committed artifact) and `check:schema` (byte-diffs against it) so the two can
// never disagree on how the schema is produced. Trailing newline + 2-space indent
// match the committed file's format.
export function serializeConfigSchema(): string {
  return JSON.stringify(emitConfigSchema(), null, 2) + "\n";
}
