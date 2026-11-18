import { KeyedSource } from "../src/utils/keyed-source";

// [LAW:no-silent-failure] A test file ends with nothing it declared still
// held. A held entry's refresh period re-arms for the life of the worker, so a
// file that leaves one open passes itself and fails whichever later file
// counts what is running, naming the wrong file. Each source a file declares
// into is noted with the stack that first declared it, and one still holding
// an entry when the file ends fails the file, at that stack.
const declared = new Map<KeyedSource<unknown, unknown>, string>();
const declare = KeyedSource.prototype.declare;
KeyedSource.prototype.declare = function (this: KeyedSource<unknown, unknown>, holds, input) {
  if (!declared.has(this)) declared.set(this, new Error("declared here").stack ?? "");
  return declare.call(this, holds, input);
};

afterAll(() => {
  const held = [...declared].filter(([source]) => source.isHeld(() => true));
  if (held.length > 0)
    throw new Error(
      `${held.length} source(s) still held when the file ended; the first was\n${held[0]![1]}`,
    );
});
