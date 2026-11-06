// A stored path says whose it is: a file under the home's root is stored
// relative to it, anything else absolute, and reading one back refuses every
// spelling that would not move with the home's tree. An older build's bare
// absolute path is read as this build spells it.

import { resolveStoredPath, storedPathOf } from "../../src/daemon/foundations/stored-path";

const ROOT = "/r/home";

describe("a stored path", () => {
  test.each([
    [`${ROOT}/config/config.json5`, { kind: "home", path: "config/config.json5" }],
    [`${ROOT}/..dotted`, { kind: "home", path: "..dotted" }],
    ["/r/home-sibling/config.json5", { kind: "world", path: "/r/home-sibling/config.json5" }],
    ["/r/other.json5", { kind: "world", path: "/r/other.json5" }],
    [ROOT, { kind: "world", path: ROOT }],
  ])("%s is stored as %j and reads back as itself", (file, stored) => {
    expect(storedPathOf(ROOT, file)).toEqual(stored);
    expect(resolveStoredPath(ROOT, storedPathOf(ROOT, file))).toBe(file);
  });

  test("a home path reads back under whichever root it is read against", () => {
    expect(resolveStoredPath("/moved", { kind: "home", path: "config/config.json5" })).toBe(
      "/moved/config/config.json5",
    );
  });

  test.each([
    [`${ROOT}/config/config.json5`, "the home's"],
    ["/x.json5", "the world's"],
  ])("an older build's bare %s reads back as itself, as %s", (file) => {
    expect(resolveStoredPath(ROOT, file)).toBe(file);
  });

  test.each([
    ["an absolute world path under the root", { kind: "world", path: `${ROOT}/config/config.json5` }, /lies under the home's root/],
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
