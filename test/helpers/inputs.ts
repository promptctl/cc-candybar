import { ColorDepth } from "@promptctl/rich-js";
import { resolvePath, type SourceRegistry } from "../../src/var-system/sources";
import { UNREAD_RUN, type RunFact } from "../../src/facts/world-state";
import { sessionOfPayload } from "./payload-session";

// A fixed payload bound as a registry's input source, as `cc-candybar check`
// binds its constant payload: every input derives its path in it, and the
// drawn depth is `drawnAt`. Binding another payload is the next "request".
// Its session is the payload's (`sessionOfPayload`). Its runs are `run`'s:
// a case whose sources run holds them (`heldRuns`).
export function feedInputs(
  registry: SourceRegistry,
  payload: unknown,
  drawnAt: ColorDepth = ColorDepth.TRUECOLOR,
  run: (digest: string) => RunFact = () => UNREAD_RUN,
): void {
  const session = sessionOfPayload(payload);
  registry.bindInputs({
    session: () => session,
    read: (path) => resolvePath(payload, path),
    run,
    drawnAt: () => drawnAt,
  });
}
