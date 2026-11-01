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

// An action a confirm fires, while `when` (a template expression) holds where
// the confirm is drawn — "true" for one it always fires.
export interface ConfirmFire {
  readonly action: string;
  readonly when: string;
}

// [LAW:dataflow-not-control-flow] A click carries one action, and an action
// fires unconditionally, so a fire offered only where its gate holds is
// chosen when the confirm is drawn: one confirm action per set of gates that
// hold, and the draw links the one whose gates hold here. A step with no gated
// fire is the one confirm, `key`.
function confirms(
  key: string,
  disarm: string,
  fires: readonly ConfirmFire[],
): { readonly link: string; readonly actions: Record<string, ActionDecl> } {
  const gates = [...new Set(fires.map((f) => f.when))].filter(
    (g) => g !== "true",
  );
  const nameOf = (held: number): string =>
    gates.length === 0 ? key : `${key}.${held}`;
  const actions: Record<string, ActionDecl> = {};
  for (let held = 0; held < 2 ** gates.length; held++)
    actions[nameOf(held)] = {
      do: [
        disarm,
        ...fires
          .filter(
            (f) => f.when === "true" || held & (1 << gates.indexOf(f.when)),
          )
          .map((f) => f.action),
      ],
    };
  const link = (i: number, held: number): string =>
    i === gates.length
      ? `"${nameOf(held)}"`
      : `(ternary ${link(i + 1, held | (1 << i))} ${link(i + 1, held)} (${gates[i]}))`;
  return { link: link(0, 0), actions };
}

export function confirmStep(
  key: string,
  labels: { readonly arm: string; readonly confirm: string },
  fires: readonly ConfirmFire[],
): ConfirmStep {
  const stateKey = `${key}${CONFIRM_KEY_SUFFIX}`;
  const arm = `${key}.arm`;
  const disarm = `${key}.disarm`;
  const armed = `(eq .${key} "${ARMED}")`;
  const confirm = confirms(key, disarm, fires);
  return {
    // [LAW:dataflow-not-control-flow] Which view the step shows is the key's
    // value, read back here.
    template:
      `{{ if ${armed} }}` +
      `{{ action ${confirm.link} "${labels.confirm}" }} {{ action "${disarm}" "✕" }}` +
      `{{ else }}{{ action "${arm}" "${labels.arm}" }}{{ end }}`,
    actions: {
      [arm]: { set: stateKey, to: ARMED },
      [disarm]: { set: stateKey, to: DISARMED },
      ...confirm.actions,
    },
    armed,
    variables: {
      [key]: { kind: "state", key: stateKey, default: DISARMED },
    },
    disarm,
  };
}
