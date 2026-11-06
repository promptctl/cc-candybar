// The render origin a request records, and what reads it back. Session state
// sits at one unversioned path, so builds of either age read this record.

import type { RequestedOrigin } from "../src/config-hint";
import { BadVerbArgs } from "../src/daemon/verb-error";
import { parseRenderOrigin } from "../src/daemon/verbs/index";
import { encodeRenderOrigin } from "../src/daemon/foundations/render-origin";
import { storedRootAt } from "../src/daemon/paths";

const ROOT = storedRootAt("/home/u/renderer");
const AT = { projectDir: "/p", cwd: "/p/sub" };

const record = (fields: Record<string, unknown>): string =>
  JSON.stringify({ ...AT, ...fields });

describe("the render origin record", () => {
  test.each<RequestedOrigin["target"]>([
    { source: "search" },
    { source: "argument", path: "/x.json5" },
    { source: "environment", path: "/x.json5" },
    { source: "argument", path: `${ROOT.dir}/config/config.json5` },
  ])("%j round-trips", (target) => {
    const origin = { ...AT, target };
    expect(parseRenderOrigin(encodeRenderOrigin(origin, ROOT), ROOT)).toEqual(origin);
  });

  test("a file in the home is stored relative to its root, and one outside it absolute", () => {
    const at = (path: string) =>
      JSON.parse(encodeRenderOrigin({ ...AT, target: { source: "argument", path } }, ROOT))
        .configFile;
    expect(at(`${ROOT.dir}/config/config.json5`)).toEqual({ kind: "home", path: "config/config.json5" });
    expect(at("/x.json5")).toEqual({ kind: "world", path: "/x.json5" });
    expect(
      JSON.parse(encodeRenderOrigin({ ...AT, target: { source: "search" } }, ROOT)),
    ).toMatchObject({ ...AT, configFile: null });
  });

  test("a home's file read back under another root names that root's file", () => {
    const stored = encodeRenderOrigin(
      { ...AT, target: { source: "argument", path: `${ROOT.dir}/config/config.json5` } },
      ROOT,
    );
    expect(parseRenderOrigin(stored, storedRootAt("/elsewhere")).target).toEqual({
      source: "argument",
      path: "/elsewhere/config/config.json5",
    });
  });

  test("an older record with no file is a search", () => {
    expect(parseRenderOrigin(record({ configFile: null }), ROOT)).toEqual({
      ...AT,
      target: { source: "search" },
    });
  });

  test("an older record's file outside the home is a world path whose source is unknown", () => {
    expect(parseRenderOrigin(record({ configFile: "/x.json5" }), ROOT)).toEqual({
      ...AT,
      target: { source: "unknown", path: "/x.json5" },
    });
  });

  test("an older record's file under the home's root is the home's file", () => {
    expect(parseRenderOrigin(record({ configFile: `${ROOT.dir}/config/config.json5` }), ROOT)).toEqual({
      ...AT,
      target: { source: "unknown", path: `${ROOT.dir}/config/config.json5` },
    });
  });

  test("a world path under the home's root is refused, naming it", () => {
    expect(() =>
      parseRenderOrigin(
        record({ configFile: { kind: "world", path: `${ROOT.dir}/config/config.json5` } }),
        ROOT,
      ),
    ).toThrow(new BadVerbArgs(
      `render origin: stored world path ${ROOT.dir}/config/config.json5 lies under the home's root ${ROOT.dir}; a home's file is stored relative to it`,
    ));
  });

  test.each([
    ["a home path that climbs out", { kind: "home", path: "../other/config.json5" }],
    ["a world path stored relative", { kind: "world", path: "config.json5" }],
    ["no kind", { path: "/x.json5" }],
  ])("%s is refused", (_name, configFile) => {
    expect(() => parseRenderOrigin(record({ configFile }), ROOT)).toThrow(BadVerbArgs);
  });

  test.each([
    ["a newer build's source", "workspace"],
    ["an older build's load-config pick", "pick"],
    ["a search", "search"],
    ["no kind of source", 3],
  ])("%s beside a file leaves the file with its source unknown", (_name, source) => {
    expect(parseRenderOrigin(record({ configFile: "/x.json5", source }), ROOT)).toEqual({
      ...AT,
      target: { source: "unknown", path: "/x.json5" },
    });
  });

  test.each([["a newer build's source", "workspace"], ["an argument", "argument"]])(
    "%s with no file is a search",
    (_name, source) => {
      expect(parseRenderOrigin(record({ configFile: null, source }), ROOT)).toEqual({
        ...AT,
        target: { source: "search" },
      });
    },
  );

  test("a record with no configFile is refused", () => {
    expect(() => parseRenderOrigin(record({ source: "search" }), ROOT)).toThrow(BadVerbArgs);
  });
});
