import { ColorDepth } from "@promptctl/rich-js";
import { resolvePath, type SourceRegistry } from "../../src/var-system/sources";
import { sessionOfPayload } from "./payload-session";

// A fixed payload bound as a registry's input source, as `cc-candybar check`
// binds its constant payload: every input derives its path in it, and the
// drawn depth is `drawnAt`. Binding another payload is the next "request".
// Its session is the payload's (`sessionOfPayload`).
export function feedInputs(
  registry: SourceRegistry,
  payload: unknown,
  drawnAt: ColorDepth = ColorDepth.TRUECOLOR,
): void {
  const session = sessionOfPayload(payload);
  registry.bindInputs({
    session: () => session,
    read: (path) => resolvePath(payload, path),
    drawnAt: () => drawnAt,
  });
}
