// [LAW:behavior-not-structure] What a config declares it reads of the
// built-ins: the facts its draws can reach, over every preset, through the one
// walk (src/config/payload-reads.ts) and the payload's rows
// (src/daemon/render-payload.ts). A built-in nothing reads is declared by
// nobody, so no session gathers it.

import { DEFAULT_DSL_CONFIG } from "../../src/config/default-dsl-config";
import { configPayloadPaths } from "../../src/config/payload-reads";
import { presetNames, presetRoot } from "../../src/config/presets";
import { walkNodes } from "../../src/config/dsl-types";
import { builtinsReadAt } from "../../src/daemon/render-payload";
import { listResolvablePaletteNames } from "../../src/themes/policy";
import { parseAndValidate } from "../helpers/parse-and-validate";

const ALLOWED = new Set(listResolvablePaletteNames());

const declaredOf = (source: string): readonly string[] => [
  ...builtinsReadAt(
    configPayloadPaths(parseAndValidate("<user>", source, ALLOWED)),
  ),
];

// What every config declares whatever it places: the synthesized settings
// menu and quick-action tray are placed segments too, and they read the
// repository (the tray's link), the context window and the auto-compact
// control.
const CHROME = declaredOf(
  `{ segments: { s: { template: "x" } }, root: { h: ["s"] } }`,
);

// What a config declares beyond the chrome every config has.
const declaredBy = (source: string): readonly string[] =>
  declaredOf(source).filter((name) => !CHROME.includes(name));

// Inputs over the built-ins' payload paths, for a config to place or not.
const INPUTS = `
  branch: { kind: "input", path: "git.branch", default: "" },
  prNumber: { kind: "input", path: "git.prNumber", type: "number", default: 0 },
  messages: { kind: "input", path: "metrics.messageCount", type: "number", default: 0 },
  burn: { kind: "input", path: "burn.costPerHour", type: "number", default: 0 },
  compact: { kind: "input", path: "autocompact.window", default: "" },
  host: { kind: "input", path: "host", default: "" },
  ssh: { kind: "input", path: "host.ssh", type: "boolean", default: false },
  pane: { kind: "input", path: "tmux.pane", default: "" },
  model: { kind: "input", path: "model.display_name", default: "" },
`;

describe("the built-ins a config declares", () => {
  test("beyond its chrome's, which reads the repository, the context window and the auto-compact control", () => {
    expect(CHROME).toEqual(["context", "autocompact", "git"]);
  });

  test("are only those its placed templates read", () => {
    expect(
      declaredBy(`{
        variables: { ${INPUTS} },
        segments: {
          b: { template: "{{ .branch }}" },
          m: { template: "{{ .messages }}" },
        },
        root: { h: ["b"] },
      }`),
    ).toEqual([]);
  });

  test("hold the PR only when a PR field is read", () => {
    expect(
      declaredBy(`{
        variables: { ${INPUTS} },
        segments: { p: { template: "{{ .prNumber }}" } },
        root: { h: ["p"] },
      }`),
    ).toEqual(["pr"]);
  });

  // A path at or above a row can see every part of the row's value, so a read
  // of all of git holds the PR too: an Undeclared could otherwise sit inside a
  // found object, which is the blank the declaration must never draw.
  test("hold the PR for a read of all of git", () => {
    expect(
      declaredBy(`{
        variables: { ${INPUTS} wholeGit: { kind: "input", path: "git", default: "" } },
        segments: { g: { template: "{{ .wholeGit }}" } },
        root: { h: ["g"] },
      }`),
    ).toEqual(["pr"]);
  });

  test("hold every fact a derived field is composed from", () => {
    expect(
      declaredBy(`{
        variables: { ${INPUTS} },
        segments: { b: { template: "{{ .burn }}" } },
        root: { h: ["b"] },
      }`),
    ).toEqual(["session", "metrics"]);
  });

  test("hold both host facts for a read of all of host, and none for its hint", () => {
    expect(
      declaredBy(`{
        variables: { ${INPUTS} },
        segments: { h: { template: "{{ .host }}" } },
        root: { h: ["h"] },
      }`),
    ).toEqual(["hostName", "hostUser"]);
    expect(
      declaredBy(`{
        variables: { ${INPUTS} },
        segments: {
          s: { template: "{{ .ssh }}{{ .pane }}{{ .model }}" },
        },
        root: { h: ["s"] },
      }`),
    ).toEqual([]);
  });

  test("hold a read reached only through a placement's when, a partial or a globals rule", () => {
    const placed = (body: string): readonly string[] =>
      declaredBy(`{ variables: { ${INPUTS} }, ${body} }`);
    expect(
      placed(`
        segments: { s: { template: "x" } },
        root: { h: [{ seg: "s", when: "{{ gt .messages 0 }}" }] },
      `),
    ).toEqual(["metrics"]);
    expect(
      placed(`
        segments: { s: { template: "x", partials: { p: "{{ .messages }}" } } },
        root: { h: ["s"] },
      `),
    ).toEqual(["metrics"]);
    expect(
      placed(`
        globals: { palette: "{{ if gt .messages 0 }}nord{{ else }}dracula{{ end }}" },
        segments: { s: { template: "x" } },
        root: { h: ["s"] },
      `),
    ).toEqual(["metrics"]);
  });

  // Every shell and file source is declared and its key evaluated whether or
  // not a template reads the source, so a key reading a built-in no placed
  // segment reads would otherwise fault the source on its first evaluation.
  test("hold what a shell or file source's cache key reads, placed or not", () => {
    expect(
      declaredBy(`{
        variables: {
          ${INPUTS}
          rate: { kind: "shell", command: "true", cache: { key: "{{ .burn }}" } },
          notes: { kind: "file", path: "/tmp/notes", cache: { depends_on: ["host"] } },
        },
        segments: { s: { template: "x" } },
        root: { h: ["s"] },
      }`),
    ).toEqual(["session", "metrics", "hostName", "hostUser"]);
  });

  test("hold what a preset no session has picked reads, so a pick moves nothing", () => {
    expect(
      declaredBy(`{
        variables: { ${INPUTS} },
        segments: {
          b: { template: "{{ .branch }}" },
          m: { template: "{{ .messages }}" },
        },
        root: { h: ["b"] },
        presets: { busy: { root: { h: ["m"] } } },
      }`),
    ).toEqual(["metrics"]);
  });

  test("of the bundled default, under every preset that places a today segment, include today", () => {
    const config = parseAndValidate(
      "<user>",
      "{}",
      ALLOWED,
      DEFAULT_DSL_CONFIG,
    );
    const declared = builtinsReadAt(configPayloadPaths(config));
    const placesToday = presetNames(config.presets).some((preset) =>
      [...walkNodes(presetRoot(config, preset).node)].some(
        (node) => node.kind === "segment" && /today/i.test(node.name),
      ),
    );
    expect(placesToday).toBe(true);
    expect(declared.has("today")).toBe(true);
  });
});
