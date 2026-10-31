// The render origin a request records, and what reads it back. Session state
// sits at one unversioned path, so builds of either age read this record.

import type { RequestedOrigin } from "../src/config-hint";
import { BadVerbArgs } from "../src/daemon/verb-error";
import {
  encodeRenderOrigin,
  parseRenderOrigin,
  sessionRenderOrigin,
  SESSION_CONFIG_OVERRIDE_KEY,
} from "../src/daemon/verbs/index";

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
      target: { source: "unrecorded", path: "/x.json5" },
    });
  });

  test.each([
    ["a persisted pick", { configFile: "/x.json5", source: "pick" }],
    ["a persisted unrecorded", { configFile: "/x.json5", source: "unrecorded" }],
    ["a search with a file", { configFile: "/x.json5", source: "search" }],
    ["an argument with no file", { configFile: null, source: "argument" }],
    ["an environment with no file", { configFile: null, source: "environment" }],
    ["a source of no kind", { configFile: null, source: 3 }],
    ["no configFile at all", { source: "search" }],
  ])("%s is refused", (_name, fields) => {
    expect(() => parseRenderOrigin(record(fields))).toThrow(BadVerbArgs);
  });
});

describe("sessionRenderOrigin", () => {
  const requested = {
    ...AT,
    target: { source: "environment", path: "/env.json5" },
  } as const;
  const state = (held: Record<string, string>) => ({
    get: (_sid: string, key: string) => held[key] ?? null,
    revision: () => 0,
  });

  test("with no pick, the request's target stands", () => {
    expect(sessionRenderOrigin(requested, state({}), "s1")).toEqual(requested);
  });

  test("a pick replaces the target, and is what names the file", () => {
    expect(
      sessionRenderOrigin(
        requested,
        state({ [SESSION_CONFIG_OVERRIDE_KEY]: "/pick.json5" }),
        "s1",
      ),
    ).toEqual({ ...AT, target: { source: "pick", path: "/pick.json5" } });
  });
});
