// A control that takes two clicks: the first arms it, the second fires.
//
// [LAW:one-type-per-behavior] `⟲` (reset all) and the command tray's `/clear`
// are two instances of this one step: a `state` key the arming click sets, a
// confirm that disarms and fires the listed actions in one click, and a ✕ that
// disarms without firing. What differs is data — the key, the two labels, the
// actions fired.

import type { ActionDecl } from "./action.js";
import type { VariableDecl } from "./dsl-types.js";

const ARMED = "armed";
const DISARMED = "disarmed";

// [LAW:one-source-of-truth] Every confirm's SessionState key ends here, so the
// daemon can tell one from every other key without a list: an armed confirm
// is one click from firing, so going back (src/daemon/navigation-history.ts)
// must never restore one — it is armed only by its own click.
const CONFIRM_KEY_SUFFIX = ".armed";
export const isConfirmKey = (key: string): boolean =>
  key.endsWith(CONFIRM_KEY_SUFFIX);

export interface ConfirmStep {
  readonly template: string;
  // A template expression, true while the step is armed: whatever shows the
  // step must keep showing it while this holds, or its confirm could be
  // hidden armed and come back already one click from firing.
  readonly armed: string;
  readonly actions: Readonly<Record<string, ActionDecl>>;
  readonly variables: Readonly<Record<string, VariableDecl>>;
  // Fired by every click that can bring the step into view, so a confirm is
  // only ever clicked in the view that armed it.
  readonly disarm: string;
}

export function confirmStep(
  key: string,
  labels: { readonly arm: string; readonly confirm: string },
  fires: readonly string[],
): ConfirmStep {
  const stateKey = `${key}${CONFIRM_KEY_SUFFIX}`;
  const arm = `${key}.arm`;
  const disarm = `${key}.disarm`;
  const armed = `(eq .${key} "${ARMED}")`;
  return {
    // [LAW:dataflow-not-control-flow] Which view the step shows is the key's
    // value, read back here.
    template:
      `{{ if ${armed} }}` +
      `{{ action "${key}" "${labels.confirm}" }} {{ action "${disarm}" "✕" }}` +
      `{{ else }}{{ action "${arm}" "${labels.arm}" }}{{ end }}`,
    actions: {
      [arm]: { set: stateKey, to: ARMED },
      [disarm]: { set: stateKey, to: DISARMED },
      [key]: { do: [disarm, ...fires] },
    },
    armed,
    variables: {
      [key]: { kind: "state", key: stateKey, default: DISARMED },
    },
    disarm,
  };
}
