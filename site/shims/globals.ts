// Globals a Node program assumes: `process`, `Buffer`, and Node's timers.
import proc from "./process";
import { Buffer } from "buffer";
import { setTimeout, setInterval, clearTimeout, clearInterval, setImmediate, clearImmediate } from "./timers";
export { proc as process, Buffer, setTimeout, setInterval, clearTimeout, clearInterval, setImmediate, clearImmediate };

// Safari has no Symbol.dispose. esbuild lowers `using` to look the symbol up as Symbol.for("Symbol.dispose")
// when it is absent, while the source's `[Symbol.dispose]` keys read the global, so every held object
// fails as "Object not disposable". Defining the global as that same symbol makes both sides agree.
const symbols = Symbol as unknown as Record<"dispose" | "asyncDispose", symbol | undefined>;
symbols.dispose ??= Symbol.for("Symbol.dispose");
symbols.asyncDispose ??= Symbol.for("Symbol.asyncDispose");
