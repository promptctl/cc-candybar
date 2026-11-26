import { asError } from "./atomic-write.js";

// [LAW:single-enforcer] Changes to files that stand or fall together: each
// change records, as it lands, how to put back what it replaced, and a
// failure puts them back newest first, so each undo finds the file as its
// own change left it. Every undo is tried, and each that fails is named.

export interface UndoFailure {
  readonly file: string;
  readonly error: Error;
}

export class UndoLog {
  private readonly undos: Array<{
    readonly file: string;
    readonly undo: () => void;
  }> = [];

  // A change to `file` landed; `undo` puts back what it replaced.
  landed(file: string, undo: () => void): void {
    this.undos.push({ file, undo });
  }

  // Every change put back, newest first: the undos that failed, in the order
  // they ran.
  undo(): UndoFailure[] {
    const failed: UndoFailure[] = [];
    for (const { file, undo } of this.undos.splice(0).reverse()) {
      try {
        undo();
      } catch (e) {
        failed.push({ file, error: asError(e) });
      }
    }
    return failed;
  }
}
