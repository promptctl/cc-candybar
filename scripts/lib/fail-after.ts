import { throwAll } from "../../src/utils/run-each";

// [LAW:no-silent-failure] `cleanup`, after the work failed with `error`. A
// cleanup that throws too is thrown beside `error` (`throwAll`), never in its
// place, because `error` is what says why the work failed.
export function failAfter(error: unknown, cleanup: () => void): never {
  try {
    cleanup();
  } catch (cleanupError) {
    throwAll([error, cleanupError]);
  }
  throw error;
}
