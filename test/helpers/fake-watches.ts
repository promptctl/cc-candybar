import fs from "node:fs";
import { EventEmitter } from "node:events";

// fs.watch replaced by handles a test fires by hand: deterministic events,
// errors after open, and refusals.
export function fakeWatches(refuse: ReadonlySet<string> = new Set()) {
  const opened: Array<{
    path: string;
    listener: (event: string, filename: string | null) => void;
    emitter: EventEmitter;
  }> = [];
  jest.spyOn(fs, "watch").mockImplementation(((
    target: string,
    _opts: unknown,
    listener: (event: string, filename: string | null) => void,
  ) => {
    if (refuse.has(target)) {
      throw Object.assign(
        new Error(`EMFILE: too many open files, watch '${target}'`),
        {
          code: "EMFILE",
        },
      );
    }
    const emitter = Object.assign(new EventEmitter(), { close: () => {} });
    opened.push({ path: target, listener, emitter });
    return emitter;
  }) as unknown as typeof fs.watch);
  return opened;
}
