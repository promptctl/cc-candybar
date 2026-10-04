// Globals a Node program assumes: `process`, `Buffer`, and Node's timers.
import proc from "./process";
import { Buffer } from "buffer";
import { setTimeout, setInterval, clearTimeout, clearInterval, setImmediate, clearImmediate } from "./timers";
export { proc as process, Buffer, setTimeout, setInterval, clearTimeout, clearInterval, setImmediate, clearImmediate };
