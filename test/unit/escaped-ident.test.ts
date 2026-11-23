import { escapedIdent, unescapedIdent } from "../../src/config/ident";

// The escape is what keeps edit chrome's names apart, so it is held here as
// the properties every name built from it relies on.
describe("escapedIdent", () => {
  // Pairs a lossy or careless escape would merge: punctuation a collapse
  // folds together, and a literal escape marker beside an escaped character.
  const NAMES = [
    "git-2",
    "git_2",
    "git.2",
    "git 2",
    "gitZ00002d2",
    "a-",
    "aZ00002d",
    "Z",
    "z",
    "é",
    "😀",
    "directory",
  ];

  test("distinct names spell distinct identifiers", () => {
    expect(new Set(NAMES.map(escapedIdent)).size).toBe(NAMES.length);
  });

  test("the spelling is letters and digits alone, and reads back as the name", () => {
    for (const name of NAMES) {
      const spelled = escapedIdent(name);
      expect(spelled).toMatch(/^[A-Za-z0-9]+$/);
      expect(unescapedIdent(spelled)).toBe(name);
    }
  });

  test("a spelling no name escapes to reads back as nothing", () => {
    // `Zffffff` is past the last code point: read, not thrown on.
    for (const spelled of ["Z", "gitZ2d", "a.b", "Z00005A", "Zffffff"])
      expect(unescapedIdent(spelled)).toBeUndefined();
  });

  test("a name of plain letters and digits other than the marker reads as written", () => {
    expect(escapedIdent("directory2")).toBe("directory2");
    expect(escapedIdent("git-2")).toBe("gitZ00002d2");
  });
});
