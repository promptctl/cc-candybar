import { filesystemFake } from "../../src/disk/filesystem-fake";
import { heldClock } from "../helpers/held-clock";
import { filesystemContract } from "../contract/filesystem.contract";

for (const platform of ["darwin", "linux"] as const) {
  filesystemContract(`the ${platform} filesystem fake`, () => {
    const clock = heldClock(new Date(1_000_000));
    const fake = filesystemFake({ clock, platform });
    fake.mkdir("/root");
    return {
      filesystem: fake,
      world: fake,
      root: "/root",
      // One nudge must be enough: the fake delivers what a write caused on
      // the clock's next turn, every time.
      hear: async (nudge, heard) => {
        nudge();
        clock.advance(0);
        expect(heard()).toBe(true);
      },
    };
  });
}
