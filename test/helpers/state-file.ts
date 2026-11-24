// Fixture setup can publish a state document without a click. Use the
// host's actual plan and transaction so it has the same migration semantics.
import type { Planned } from "../../src/daemon/state-file";
import { writeRevisions } from "../../src/daemon/file-rewrites";
import { ok, type Asked } from "../../src/utils/outcome";

export function writeStatePlan<T>(planned: Asked<Planned<T>>): Asked<T> {
  if (planned.kind === "failed") return planned;
  const { setAside, rewrite, retire, value } = planned.value;
  const written = writeRevisions({
    setAside,
    rewrites: rewrite === null ? [] : [rewrite],
    retire,
  });
  if (written.kind !== "ok") throw written.error;
  return ok(value);
}
