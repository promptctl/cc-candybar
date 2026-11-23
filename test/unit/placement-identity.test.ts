// A placement's scope is exactly three dot-separated parts that parse back to
// its identity (src/config/placement-identity.ts), and no two identities meet
// in one spelling.

import {
  placementOfScope,
  placementScope,
} from "../../src/config/placement-identity";

const IDENTITIES = [
  { preset: "default", id: "clock", segment: "clock" },
  // A digit-led preset is legal, and no part may lead a field name with it.
  { preset: "2col", id: "seg-2", segment: "git" },
  { preset: "2col", id: "seg_2", segment: "git" },
  { preset: "a.b", id: "x", segment: "y" },
  { preset: "😀", id: "Z", segment: "z" },
];

test("a scope is three parts, each led by a letter", () => {
  for (const identity of IDENTITIES)
    expect(placementScope(identity)).toMatch(
      /^p[A-Za-z0-9]*\.d[A-Za-z0-9]*\.s[A-Za-z0-9]*$/,
    );
});

test("a scope reads back as the identity, and identities never share one", () => {
  const scopes = IDENTITIES.map(placementScope);
  expect(new Set(scopes).size).toBe(IDENTITIES.length);
  scopes.forEach((scope, at) =>
    expect(placementOfScope(scope)).toEqual(IDENTITIES[at]),
  );
});

test.each([
  "",
  "pdefault",
  "pdefault.dclock",
  "pdefault.dclock.sclock.extra",
  "xdefault.dclock.sclock",
  "pdefault.xclock.sclock",
  "pdefault.dclock.xclock",
  "pdefault.dclock.sZffffff",
  "pdefault.dclock.sa.b",
])("%j is a spelling no identity makes", (spelled) => {
  expect(placementOfScope(spelled)).toBeUndefined();
});
