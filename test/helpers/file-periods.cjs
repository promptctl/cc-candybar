// [LAW:effects-at-boundaries] Only periods created via this Jest sandbox's
// globals belong to its file. Jest's runner and neighboring files have their
// own globals even when they share the same Node worker.
function trackFilePeriods(sandbox, file) {
  const periods = new Map();
  const { setInterval, clearInterval, clearTimeout } = sandbox;
  sandbox.setInterval = (callback, ms, ...args) => {
    const handle = setInterval(callback, ms, ...args);
    periods.set(handle, new Error(`${callback.name || "<anonymous>"} (${ms} ms)`));
    return handle;
  };
  // Node accepts either clear function for an interval.
  sandbox.clearInterval = (handle) => {
    periods.delete(handle);
    clearInterval(handle);
  };
  sandbox.clearTimeout = (handle) => {
    periods.delete(handle);
    clearTimeout(handle);
  };
  return () => {
    const leaked = [...periods.values()];
    for (const handle of periods.keys()) clearInterval(handle);
    periods.clear();
    if (leaked.length) {
      throw new Error(`${file} left periods armed:
${leaked.map((error) => error.stack).join("\n")}`);
    }
  };
}

module.exports = { trackFilePeriods };
