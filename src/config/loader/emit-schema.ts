// [LAW:one-source-of-truth] A second interpreter over the same schema declarations
// the runtime validators read. Shape only — cross-field and cross-reference
// refinements stay semantic checks the loader carries.

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

export const SCHEMA_ID =
  "https://raw.githubusercontent.com/promptctl/cc-candybar/main/schema/cc-candybar.schema.json";

// [LAW:dataflow-not-control-flow] Every top-level key is optional, so no `required`.
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

// [LAW:single-enforcer] One serialization, shared by `gen:schema` and `check:schema`.
export function serializeConfigSchema(): string {
  return JSON.stringify(emitConfigSchema(), null, 2) + "\n";
}
