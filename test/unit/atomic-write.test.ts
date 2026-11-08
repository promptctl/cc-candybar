import { filesystemFake } from "../../src/disk/filesystem-fake";
import type { Filesystem } from "../../src/disk/filesystem";
import { writeAtomicOn } from "../../src/utils/atomic-write";
import { heldClock } from "../helpers/held-clock";

// A write that fails, and whose cleanup of the staged file fails too (the
// directory stopped being searchable mid-write): the caller hears why the
// write failed, and the cleanup's failure rides along on it rather than
// replacing it.
test("a failed write whose cleanup also fails throws the write's error, the cleanup's as its cause", () => {
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
    message: expect.stringMatching(/, rename '\/home\/config\.json5\..*\.tmp'$/),
    cause: expect.objectContaining({
      code: "EACCES",
      message: expect.stringMatching(/, rm '\/home\/config\.json5\..*\.tmp'$/),
    }),
  });
});
