import { ColorDepth } from "@promptctl/rich-js";
import { resolvePath, type SourceRegistry } from "../../src/var-system/sources";
import { NOTHING_READ, type HostReadings } from "../../src/dsl/view-source";
import { sessionOfPayload } from "../../scripts/lib/draw-fixtures/payload-session";

// A fixed payload bound as a registry's input source, as `cc-candybar check`
// binds its constant payload: every input derives its path in it, and the
// drawn depth is `drawnAt`. Binding another payload is the next "request".
// Its session is the payload's (`sessionOfPayload`). What the host read for
// it is `readings`: a case whose sources run holds them (`heldRuns`).
export function feedInputs(
  registry: SourceRegistry,
  payload: unknown,
  drawnAt: ColorDepth = ColorDepth.TRUECOLOR,
  readings: HostReadings = NOTHING_READ,
): void {
  const session = sessionOfPayload(payload);
  registry.bindInputs({
    session: () => session,
    read: (path) => resolvePath(payload, path),
    ...readings,
    drawnAt: () => drawnAt,
  });
}
