import { ColorDepth } from "@promptctl/rich-js";
import { resolvePath, type SourceRegistry } from "../../src/var-system/sources";
import { parseSessionId } from "../../src/daemon/session-id";

// A fixed payload bound as a registry's input source, as `cc-candybar check`
// binds its constant payload: every input derives its path in it, and the
// drawn depth is `drawnAt`. Binding another payload is the next "request".
// Its session is the payload's `session_id` as the hook door checks it.
export function feedInputs(
  registry: SourceRegistry,
  payload: unknown,
  drawnAt: ColorDepth = ColorDepth.TRUECOLOR,
): void {
  const session = parseSessionId(
    (payload as { session_id?: unknown } | null)?.session_id,
  );
  registry.bindInputs({
    session: () => (session.ok ? session.id : null),
    read: (path) => resolvePath(payload, path),
    drawnAt: () => drawnAt,
  });
}
