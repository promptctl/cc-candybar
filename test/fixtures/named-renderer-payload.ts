import { composePayload as compose } from "../../src/renderer/render-payload.js";

export const WORKTREE_MODEL = "Worktree renderer";

// [LAW:behavior-not-structure] A worktree renderer can interpret the same
// hook differently. Keep the entire production payload except its model label.
export function composePayload(
  ...[facts, inputs, draw]: Parameters<typeof compose>
): ReturnType<typeof compose> {
  return compose(
    facts,
    {
      ...inputs,
      hookData: {
        ...inputs.hookData,
        model: { ...inputs.hookData.model, display_name: WORKTREE_MODEL },
      },
    },
    draw,
  );
}
