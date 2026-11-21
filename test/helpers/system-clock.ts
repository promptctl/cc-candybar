import { clockOver, rethrowing, systemTimers } from "../../src/time";

// The machine's clock for a case that runs on real time: built as the
// process's is, over the machine's timers, and what its tasks throw ends the
// case as it would end a command.
export const systemTimekeeper = clockOver(systemTimers, rethrowing);
