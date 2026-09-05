// [LAW:one-source-of-truth] The JSON Schema emitter — the SECOND interpreter over
// the declarative loader schemas. `validateConfig` composes the per-module
// `validate*` functions to validate at runtime; `emitConfigSchema` composes the
// per-module `*Json` functions to derive the editor-facing JSON Schema. Both read
// the SAME module-private schema declarations (GLOBALS_SCHEMA, VARIABLE_SCHEMA,
// SEGMENT_SCHEMA, CACHE_SCHEMA, SET_ARMS, the A-grammar layout grammar), so the
// published schema and the runtime validator can never describe a different grammar.
//
// What a JSON Schema still cannot express (by construction): cross-field
// refinements (min<max, by≠0, input default matches type), palette-name
// membership, duration FORMAT, and cross-references between segments/variables/
// cycles. Those stay SEMANTIC checks the loader carries — schema = shape, lint =
// meaning, the same complementary boundary `config-schema.test.ts` pins.

import { editGlobalsJson, globalsJson } from "./globals.js";
import { variablesMapJson } from "./variables.js";
import { segmentsJson } from "./segments.js";
import { actionsJson } from "./actions.js";
import { looksJson } from "./looks.js";
import { presetsJson } from "./presets.js";
import {
  layoutNodeJson,
  LAYOUT_NODE_DEF_NAME,
  rootFragmentJson,
  ROOT_FRAGMENT_DEF_NAME,
  ROOT_FRAGMENT_REF,
} from "./layout.js";
import type { JsonNode } from "./validate-core.js";

// [LAW:one-source-of-truth] The stable published identity. The committed artifact
// is self-identifying at this URL so an editor loading it via `$schema` resolves.
export const SCHEMA_ID =
  "https://raw.githubusercontent.com/promptctl/cc-candybar/main/schema/cc-candybar.schema.json";

// [LAW:dataflow-not-control-flow] The RawDslConfig schema: every top-level key is
// optional (a user file declares only what differs from the bundled default), so
// the object carries no `required`. Each property is one module's emitted shape —
// the same composition `validateConfig` performs over the validators. `root`
// references the RootFragment definition (a whole tree or a `{ rows }` map),
// whose tree arm is the LayoutNode definition that closes the node recursion
// via `$ref`.
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
      root: { $ref: ROOT_FRAGMENT_REF },
      actions: actionsJson(),
      looks: looksJson(),
      presets: presetsJson(),
      editGlobals: editGlobalsJson(),
      helpers: { type: "object", additionalProperties: { type: "string" } },
    },
    definitions: {
      [LAYOUT_NODE_DEF_NAME]: layoutNodeJson(),
      [ROOT_FRAGMENT_DEF_NAME]: rootFragmentJson(),
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
