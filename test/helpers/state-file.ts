// Fixture setup can publish a state document without a click. Use the
// host's actual plan and transaction so it has the same migration semantics.
import type { Planned } from "../../src/daemon/state-file";
import { writeRevisions } from "../../src/daemon/file-rewrites";
import { ok, type Asked } from "../../src/utils/outcome";

export function writeStatePlan<T>(planned: Asked<Planned<T>>): Asked<T> {
  if (planned.kind === "failed") return planned;
  const { rewrite, retire, value } = planned.value;
  writeRevisions(rewrite === null ? [] : [rewrite], retire);
  return ok(value);
}
