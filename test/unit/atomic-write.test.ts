import { filesystemFake } from "../../src/disk/filesystem-fake";
import type { Filesystem } from "../../src/disk/filesystem";
import { writeAtomicOn } from "../../src/utils/atomic-write";
import { heldClock } from "../helpers/held-clock";

// A write that fails, and whose cleanup of the staged file fails too (the
// directory stopped being searchable mid-write): the caller hears why the
// write failed, with its errno intact, and the message it logs and shows
// names the staged file left behind and why it could not be removed.
test("a failed write whose cleanup also fails throws the write's error, naming the leftover tmp in its message", () => {
  const disk = filesystemFake({ clock: heldClock(new Date(0)), platform: "darwin" });
  disk.mkdir("/home");
  // The staged file lands, then every later call naming it is refused: the
  // rename that publishes it, and the removal that cleans it up.
  const refusing: Filesystem = {
    ...disk,
    writeFileSync: (at, text, options) => {
      disk.writeFileSync(at, text, options);
      disk.fault(at, "EACCES");
    },
  };

  let thrown: unknown;
  try {
    writeAtomicOn(refusing, "/home/config.json5", "{}", 0o644);
  } catch (e) {
    thrown = e;
  }

  expect(thrown).toMatchObject({
    code: "EACCES",
    message: expect.stringMatching(
      /^EACCES: .*, rename '(\/home\/config\.json5\..*\.tmp)'; staged file \1 was left behind: EACCES: .*, rm '\1'$/,
    ),
  });
});
