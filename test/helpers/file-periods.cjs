const { createHook } = require("node:async_hooks");
const { setImmediate: nextTurn } = require("node:timers/promises");
const { clearInterval } = require("node:timers");

// [LAW:effects-at-boundaries] Node exposes one async resource for a timer,
// regardless of which API created or disposed it. Its init resource carries
// the repeat period and callback; destroy is the authoritative end. Confine
// these Node-specific fields to this adapter and exercise them on real timers.
function trackFilePeriods(sandbox, file, filename) {
  const periods = new Map();
  const hook = createHook({
    init(id, type, _trigger, handle) {
      if (type !== "Timeout" || !("_repeat" in handle) ||
          typeof handle._repeat !== "number" || handle._repeat <= 0) return;
      const callback = "_onTimeout" in handle && typeof handle._onTimeout === "function"
        ? handle._onTimeout : undefined;
      const origin = new Error(
        `${callback?.name || "<anonymous>"} (${handle._repeat} ms)`,
      );
      // A file owns functions from its VM, including asynchronously armed
      // intervals. A Node helper may supply its own callback for a test.
      if (
        callback instanceof sandbox.Function ||
        origin.stack?.includes(filename)
      ) {
        periods.set(id, { handle, origin });
      }
    },
    destroy(id) {
      periods.delete(id);
    },
  }).enable();
  return async () => {
    // Node delivers destroy hooks on a later turn, including after dispose().
    await nextTurn();
    hook.disable();
    const leaked = [...periods.values()];
    for (const { handle } of leaked) clearInterval(handle);
    periods.clear();
    if (leaked.length) {
      throw new Error(
        `${file} left periods armed:\n${leaked.map(({ origin }) => origin.stack).join("\n")}`,
      );
    }
  };
}

module.exports = { trackFilePeriods };
