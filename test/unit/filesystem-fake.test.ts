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

// What the disk does that its contract cannot stage, because the contract's
// world has no rename: the fake answers as the kernel does.
describe("the filesystem fake moves and removes as the kernel does", () => {
  const make = (platform: "darwin" | "linux") => {
    const clock = heldClock(new Date(1_000_000));
    return { clock, fake: filesystemFake({ clock, platform }) };
  };
  const codeOf = (run: () => void) => {
    try {
      run();
    } catch (e) {
      return (e as { code: string }).code;
    }
    return undefined;
  };

  it("refuses a rename over a folder that is not empty, or of the other kind", () => {
    const { fake } = make("linux");
    fake.mkdir("/d/x");
    fake.mkdir("/e/y");
    fake.write("/f", "");
    expect(codeOf(() => fake.renameSync("/d", "/e"))).toBe("ENOTEMPTY");
    expect(codeOf(() => fake.renameSync("/d", "/f"))).toBe("ENOTDIR");
    expect(codeOf(() => fake.renameSync("/f", "/e"))).toBe("EISDIR");
    fake.mkdir("/g");
    fake.renameSync("/d", "/g");
    expect(fake.statSync("/g/x").kind).toBe("directory");
  });

  for (const platform of ["darwin", "linux"] as const)
    it(`tells a ${platform} watch deep in a removed tree that its folder went`, () => {
      const { clock, fake } = make(platform);
      fake.mkdir("/a/b/c");
      const names: string[] = [];
      fake.watch("/a/b/c", { recursive: false }, (_e, n) => names.push(n!));
      fake.remove("/a");
      clock.advance(0);
      expect(names).toEqual(["c"]);
    });

  it("moves a linux watch with its folder, and tells a darwin one its path is gone", () => {
    for (const [platform, heard] of [
      ["linux", []],
      ["darwin", ["b"]],
    ] as const) {
      const { clock, fake } = make(platform);
      fake.mkdir("/a/b");
      const names: string[] = [];
      fake.watch("/a/b", { recursive: false }, (_e, n) => names.push(n!));
      fake.renameSync("/a", "/z");
      clock.advance(0);
      expect(names).toEqual(heard);
    }
  });

  it("refuses to move a folder into its own subtree", () => {
    const { fake } = make("linux");
    fake.mkdir("/a/b");
    expect(codeOf(() => fake.renameSync("/a", "/a/b/a"))).toBe("EINVAL");
    expect(fake.statSync("/a/b").kind).toBe("directory");
  });

  it("no longer lists a watch that failed", () => {
    const { clock, fake } = make("darwin");
    fake.mkdir("/w");
    fake.watch("/w", { recursive: false }, () => {});
    fake.failWatch("/w", "gone deaf");
    clock.advance(0);
    expect(fake.watching()).toEqual([]);
  });
});
