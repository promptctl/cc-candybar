import { ColorDepth } from "@promptctl/rich-js";
import { resolvePath, type SourceRegistry } from "../../src/var-system/sources";

// A fixed payload bound as a registry's input source, as `cc-candybar check`
// binds its constant payload: every input derives its path in it, and the
// drawn depth is `drawnAt`. Binding another payload is the next "request".
export function feedInputs(
  registry: SourceRegistry,
  payload: unknown,
  drawnAt: ColorDepth = ColorDepth.TRUECOLOR,
): void {
  registry.bindInputs({
    read: (path) => resolvePath(payload, path),
    drawnAt: () => drawnAt,
  });
}
