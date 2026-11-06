// The render origin a request records, and what reads it back. Session state
// sits at one unversioned path, so builds of either age read this record.

import type { RequestedOrigin } from "../src/config-hint";
import { BadVerbArgs } from "../src/daemon/verb-error";
import { parseRenderOrigin } from "../src/daemon/verbs/index";
import { encodeRenderOrigin } from "../src/daemon/foundations/render-origin";

const AT = { projectDir: "/p", cwd: "/p/sub" };

const record = (fields: Record<string, unknown>): string =>
  JSON.stringify({ ...AT, ...fields });

describe("the render origin record", () => {
  test.each<RequestedOrigin["target"]>([
    { source: "search" },
    { source: "argument", path: "/x.json5" },
    { source: "environment", path: "/x.json5" },
  ])("%j round-trips", (target) => {
    const origin = { ...AT, target };
    expect(parseRenderOrigin(encodeRenderOrigin(origin))).toEqual(origin);
  });

  test("a record keeps the configFile an older build requires", () => {
    const named = { ...AT, target: { source: "argument", path: "/x.json5" } };
    expect(JSON.parse(encodeRenderOrigin(named as RequestedOrigin))).toMatchObject({
      ...AT,
      configFile: "/x.json5",
    });
    expect(
      JSON.parse(encodeRenderOrigin({ ...AT, target: { source: "search" } })),
    ).toMatchObject({ ...AT, configFile: null });
  });

  test("an older record with no file is a search", () => {
    expect(parseRenderOrigin(record({ configFile: null }))).toEqual({
      ...AT,
      target: { source: "search" },
    });
  });

  test("an older record with a file says its source is unknown", () => {
    expect(parseRenderOrigin(record({ configFile: "/x.json5" }))).toEqual({
      ...AT,
      target: { source: "unknown", path: "/x.json5" },
    });
  });

  test.each([
    ["a newer build's source", "workspace"],
    ["an older build's load-config pick", "pick"],
    ["a search", "search"],
    ["no kind of source", 3],
  ])("%s beside a file leaves the file with its source unknown", (_name, source) => {
    expect(parseRenderOrigin(record({ configFile: "/x.json5", source }))).toEqual({
      ...AT,
      target: { source: "unknown", path: "/x.json5" },
    });
  });

  test.each([["a newer build's source", "workspace"], ["an argument", "argument"]])(
    "%s with no file is a search",
    (_name, source) => {
      expect(parseRenderOrigin(record({ configFile: null, source }))).toEqual({
        ...AT,
        target: { source: "search" },
      });
    },
  );

  test("a record with no configFile is refused", () => {
    expect(() => parseRenderOrigin(record({ source: "search" }))).toThrow(BadVerbArgs);
  });
});
