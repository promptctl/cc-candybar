// A stored path says whose it is: a file under the home's root is stored
// relative to it, anything else absolute, and reading one back refuses every
// spelling that would not move with the home's tree. A world path, or an
// older build's bare absolute path, is read as this build spells it. Whose a
// file is follows the directories on its path, not its spelling: a root named
// through a link is still the root. The disk's spelling is a map of links here.

import {
  homeSpelling,
  oneReading,
  resolveStoredPath,
  storedPathOf,
  type StoredRoot,
} from "../../src/daemon/foundations/stored-path";

// A directory's spelling with `links` resolved, longest first, as the disk
// would spell it.
const rootAt = (dir: string, links: Record<string, string> = {}): StoredRoot => ({
  dir,
  onDisk: (d) => {
    const from = Object.keys(links)
      .sort((a, b) => b.length - a.length)
      .find((l) => d === l || d.startsWith(`${l}/`));
    return from === undefined ? d : links[from] + d.slice(from.length);
  },
});

const ROOT = rootAt("/r/home");

describe("a stored path", () => {
  test.each([
    [`${ROOT.dir}/config/config.json5`, { kind: "home", path: "config/config.json5" }],
    [`${ROOT.dir}/..dotted`, { kind: "home", path: "..dotted" }],
    ["/r/home-sibling/config.json5", { kind: "world", path: "/r/home-sibling/config.json5" }],
    ["/r/other.json5", { kind: "world", path: "/r/other.json5" }],
    [ROOT.dir, { kind: "world", path: ROOT.dir }],
  ])("%s is stored as %j and reads back as itself", (file, stored) => {
    expect(storedPathOf(ROOT, file)).toEqual(stored);
    expect(resolveStoredPath(ROOT, storedPathOf(ROOT, file))).toBe(file);
  });

  test("a home path reads back under whichever root it is read against", () => {
    expect(resolveStoredPath(rootAt("/moved"), { kind: "home", path: "config/config.json5" })).toBe(
      "/moved/config/config.json5",
    );
  });

  test.each([
    [`${ROOT.dir}/config/config.json5`, "the home's"],
    ["/x.json5", "the world's"],
  ])("an older build's bare %s reads back as itself, as %s", (file) => {
    expect(resolveStoredPath(ROOT, file)).toBe(file);
  });

  test.each([
    ["an absolute world path under the root", { kind: "world", path: `${ROOT.dir}/config/config.json5` }, /lies under the home's root/],
    ["a relative world path", { kind: "world", path: "config.json5" }, /is not absolute/],
    ["a home path that climbs out", { kind: "home", path: "../x.json5" }, /not a plain path inside/],
    ["a home path that is absolute", { kind: "home", path: "/x.json5" }, /not a plain path inside/],
    ["a home path not in its plain spelling", { kind: "home", path: "config/../config.json5" }, /not a plain path inside/],
    ["the root itself as a home path", { kind: "home", path: "" }, /not a plain path inside/],
    ["no kind", { path: "/x.json5" }, /no kind of home or world/],
    ["no path", { kind: "home" }, /has no path/],
    ["an older build's bare string that is relative", "config.json5", /is not absolute/],
    ["a number", 3, /is not an object/],
  ])("%s is refused", (_name, raw, message) => {
    expect(() => resolveStoredPath(ROOT, raw)).toThrow(message);
  });
});

describe("a stored path under a root named through a link", () => {
  // The root is named `/l/home`; `/l` is a link to `/real`, as macOS names
  // /private/tmp as /tmp.
  const root = rootAt("/l/home", { "/l": "/real" });
  const onDisk = "/real/home/config/config.json5";
  const asHome = "/l/home/config/config.json5";

  test("a file named through the directory the link points at is the home's, and reads back in the root's spelling", () => {
    expect(storedPathOf(root, onDisk)).toEqual({ kind: "home", path: "config/config.json5" });
    expect(resolveStoredPath(root, storedPathOf(root, onDisk))).toBe(asHome);
    expect(homeSpelling(root, onDisk)).toBe(asHome);
  });

  test("a file's home spelling is what the store reads back for it", () => {
    for (const file of [onDisk, asHome, "/real/other.json5"]) {
      expect(homeSpelling(root, file)).toBe(resolveStoredPath(root, storedPathOf(root, file)));
    }
  });

  test("a file named under the root as the home names it asks the disk nothing", () => {
    const asked: StoredRoot = {
      dir: "/l/home",
      onDisk: (d) => {
        throw new Error(`asked the disk for ${d}`);
      },
    };
    expect(storedPathOf(asked, asHome)).toEqual({ kind: "home", path: "config/config.json5" });
  });

  test("a file in another letter case is the home's where the disk folds case", () => {
    const folded: StoredRoot = { dir: "/l/home", onDisk: (d) => d.toLowerCase() };
    expect(storedPathOf(folded, "/L/HOME/config.json5")).toEqual({ kind: "home", path: "config.json5" });
  });

  test("a file reached through a link inside the home is the home's", () => {
    const linkedConfig = rootAt("/home", { "/home/config": "/elsewhere" });
    expect(storedPathOf(linkedConfig, "/home/config/config.json5")).toEqual({
      kind: "home",
      path: "config/config.json5",
    });
  });

  test("a file reached through a link from outside into the home's tree is the home's", () => {
    const linkedIn = rootAt("/home", { "/presets-link": "/home/presets" });
    expect(storedPathOf(linkedIn, "/presets-link/x.json5")).toEqual({
      kind: "home",
      path: "presets/x.json5",
    });
    expect(homeSpelling(linkedIn, "/presets-link/x.json5")).toBe("/home/presets/x.json5");
  });

  test("a file beside the home is the world's, as given", () => {
    expect(storedPathOf(root, "/real/other.json5")).toEqual({ kind: "world", path: "/real/other.json5" });
    expect(homeSpelling(root, "/real/other.json5")).toBe("/real/other.json5");
  });

  test("a world path naming the home's file through the link's target reads back as the home's", () => {
    expect(resolveStoredPath(root, { kind: "world", path: onDisk })).toBe(asHome);
  });

  test("an older build's bare path through the link's target reads back as the home's", () => {
    expect(resolveStoredPath(root, onDisk)).toBe(asHome);
  });
});

describe("one reading of the disk", () => {
  test("asks each directory once however many decisions stand on it", () => {
    const asked: string[] = [];
    const root = oneReading({
      dir: "/l/home",
      onDisk: (d) => {
        asked.push(d);
        return d.replace(/^\/l(?=\/|$)/, "/real");
      },
    });
    for (const file of ["/real/other.json5", "/real/other.json5", "/real/home/config.json5"]) {
      storedPathOf(root, file);
    }
    expect(asked).toEqual(["/l/home", "/real", "/", "/real/home"]);
  });
});
