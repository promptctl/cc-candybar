// One of two processes writing one file: it says it is ready, waits for the
// go file, then writes the file through writeAtomic as many times as argv
// names, each body naming this child and the write. test/atomic-write.test.ts
// spawns two at once, as a daemon and a CLI share a state directory.
import fs from "node:fs";
import { writeAtomic } from "../../src/utils/atomic-write";

const [file, ready, go, name, writes, padBytes] = process.argv.slice(2) as [
  string, string, string, string, string, string,
];

fs.writeFileSync(ready, "");
const nap = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(go)) Atomics.wait(nap, 0, 0, 1);

const pad = "x".repeat(Number(padBytes));
for (let i = 0; i < Number(writes); i++) {
  writeAtomic(file, JSON.stringify({ child: name, i, pad }));
}
