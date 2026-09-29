// A control that takes two clicks: the first arms it, the second fires.
//
// [LAW:one-type-per-behavior] `⟲ reset all` and the command tray's `/clear`
// are two instances of this one step: a `state` key the arming click sets, a
// confirm that disarms and fires the listed actions in one click, and a ✕ that
// disarms without firing. What differs is data — the key, the two labels, the
// actions fired.

import type { ActionDecl } from "./action.js";
import type { VariableDecl } from "./dsl-types.js";

const ARMED = "armed";
const DISARMED = "disarmed";

export interface ConfirmStep {
  readonly template: string;
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
  const arm = `${key}.arm`;
  const disarm = `${key}.disarm`;
  return {
    // [LAW:dataflow-not-control-flow] Which view the step shows is the key's
    // value, read back here.
    template:
      `{{ if eq .${key} "${ARMED}" }}` +
      `{{ action "${key}" "${labels.confirm}" }} {{ action "${disarm}" "✕" }}` +
      `{{ else }}{{ action "${arm}" "${labels.arm}" }}{{ end }}`,
    actions: {
      [arm]: { set: key, to: ARMED },
      [disarm]: { set: key, to: DISARMED },
      [key]: { do: [disarm, ...fires] },
    },
    variables: { [key]: { kind: "state", key, default: DISARMED } },
    disarm,
  };
}
