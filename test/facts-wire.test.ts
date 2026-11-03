import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFact, restamp } from "../src/facts/fact";
import { parseGithubPr } from "../src/segments/git";
import { readAutoCompactWindow } from "../src/segments/autocompact";
import { instantOf, type Instant } from "../src/utils/instant";
import { jsonParser } from "../src/var-system/parse";

const at = (seconds: number): Instant => instantOf(new Date(seconds * 1000));

// Each producer here is the owner's own function over a real input, so a shape
// JSON would corrupt (an `undefined` the type forgot, a class instance) shows
// up here and not in a hand-written fixture.
describe("an owner's answer crosses as JSON without loss", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-facts-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const settings = (text: string): string => {
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, text);
    return file;
  };
  const crosses = (reading: Parameters<typeof restamp>[1]) => {
    const fact = restamp(undefined, reading, at(7));
    expect(parseFact(JSON.parse(JSON.stringify(fact)), "owner")).toEqual(fact);
    return fact;
  };

  it("autocompact: a window, and the two phases it fails in", () => {
    expect(crosses(readAutoCompactWindow(settings(`{}`)))).toMatchObject({
      kind: "ok",
      value: "auto",
    });
    expect(
      crosses(
        readAutoCompactWindow(settings(`{ "autoCompactWindow": 400000 }`)),
      ),
    ).toMatchObject({ kind: "ok", value: 400000 });
    expect(
      crosses(readAutoCompactWindow(settings("{ not json"))),
    ).toMatchObject({ kind: "failed", failedAt: "parse" });
    const asDirectory = path.join(dir, "settings-dir");
    fs.mkdirSync(asDirectory);
    expect(crosses(readAutoCompactWindow(asDirectory))).toMatchObject({
      kind: "failed",
      failedAt: "read",
    });
  });

  it("the PR: a pull request, and the forge answering something that is not one", () => {
    expect(
      crosses(
        parseGithubPr(
          JSON.stringify({
            number: 76,
            state: "OPEN",
            url: "https://github.com/x/y/pull/76",
            headRefOid: "c0ffee",
          }),
        ),
      ),
    ).toMatchObject({ kind: "ok", value: { number: 76, state: "open" } });
    expect(crosses(parseGithubPr("not json"))).toMatchObject({
      kind: "failed",
      failedAt: "parse",
    });
  });

  it("a declared source: its document, and a document that does not parse", () => {
    expect(
      crosses(jsonParser(`{"spent": 3, "kind": "pending"}`)),
    ).toMatchObject({ kind: "ok", value: { spent: 3, kind: "pending" } });
    expect(crosses(jsonParser("{"))).toMatchObject({
      kind: "failed",
      failedAt: "parse",
    });
  });
});
