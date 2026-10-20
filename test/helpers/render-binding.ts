import type { ActionRuntime, RenderBinding } from "../../src/render/action";

// The binding the latest render bound into `runtime`, kept after drawDsl drops
// it, so a test can read what that render published — its look, its layout
// rows. Nothing in the daemon keeps one: a compile is shared between entries
// and must hold nothing of a render once it returns.
export function lastBinding(runtime: ActionRuntime): () => RenderBinding {
  let live: RenderBinding | undefined;
  let drawn: RenderBinding | undefined;
  Object.defineProperty(runtime, "bound", {
    configurable: true,
    get: () => live,
    set: (b: RenderBinding | undefined) => {
      live = b;
      drawn = b ?? drawn;
    },
  });
  return () => {
    if (drawn === undefined) throw new Error("no render has bound this compile");
    return drawn;
  };
}
