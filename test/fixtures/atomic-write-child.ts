// One of two processes writing one file: it says it is ready on stdout, waits
// for the test's go on stdin, then writes the file through writeAtomic as many
// times as argv names, each body naming this child and the write. The go comes
// down a pipe the test holds, so the test's teardown, or the worker's death,
// ends a child still waiting. test/atomic-write.test.ts spawns two at once, as
// a daemon and a CLI share a state directory.
import { writeAtomic } from "../../src/utils/atomic-write";

const [file, name, writes, padBytes] = process.argv.slice(2) as [
  string, string, string, string,
];

const pad = "x".repeat(Number(padBytes));
process.stdin.once("data", () => {
  for (let i = 0; i < Number(writes); i++) {
    writeAtomic(file, JSON.stringify({ child: name, i, pad }));
  }
  process.exit(0);
});
// The test ended before its go.
process.stdin.once("end", () => process.exit(1));
process.stdout.write("ready\n");
