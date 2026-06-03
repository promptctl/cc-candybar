export { createCcCandybarEngine } from "./engine.js";
export { buildScope } from "./scope.js";
export { ccCandybarFuncs } from "./funcs.js";
export { fragmentsToCells } from "./cells.js";
export { evaluateWhen, applySegmentLayout, collapseToCell } from "./layout.js";
export type {
  SegmentLayoutOptions,
  JustifyMode,
  TruncateMode,
} from "./layout.js";
export { resolveSegmentColors, ColorSpecError } from "./colors.js";
