// [LAW:verifiable-goals] brandon-doctor-v62x.e91: what a config file declares
// that nothing uses — a variable nothing reads, an action nothing clicks, a
// helper nothing calls, a segment no preset places — over the two shapes one
// load produces (the raw file and the merged config).
// [LAW:behavior-not-structure] Every case is a config file's text through the
// real loader; the expectation is the names an author would have to remove.

import { loadConfigSource, validateConfig } from "../src/config/dsl-loader";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { unusedDeclarations } from "../src/config/unused";

function unusedIn(source: string): string[] {
  const loaded = loadConfigSource("/cfg.json5", source, DEFAULT_DSL_CONFIG);
  // The file must be one the bar would load: an unused name is an advisory
  // about a config that works, never a second spelling of a load error.
  validateConfig(loaded, "/cfg.json5");
  return unusedDeclarations(loaded.raw, loaded.config).map(
    (u) => `${u.kind} ${u.name}`,
  );
}

describe("unusedDeclarations", () => {
  test("no file, and an empty file, declare nothing unused", () => {
    expect(unusedDeclarations({}, DEFAULT_DSL_CONFIG)).toEqual([]);
    expect(unusedIn("{}")).toEqual([]);
  });

  test("each kind of declaration nothing uses is named, in file order", () => {
    expect(
      unusedIn(`{
        variables: {
          orphan: { kind: "literal", value: "x" },
          shown: { kind: "literal", value: "y" },
        },
        actions: { never: { copy: "text" } },
        helpers: { lonely: "{{ . }}" },
        segments: {
          placed: { template: "{{ .shown }}" },
          spare: { template: "spare" },
        },
        root: { h: ["placed"] },
      }`),
    ).toEqual([
      "variable orphan",
      "action never",
      "helper lonely",
      "segment spare",
    ]);
  });

  test("a variable read through a helper, a namespace, or a document field is used", () => {
    expect(
      unusedIn(`{
        variables: {
          viaHelper: { kind: "literal", value: "a" },
          "ns.leaf": { kind: "literal", value: "b" },
          doc: { kind: "shell", command: "echo {}", parse: { json: true }, default: {}, cache: { never: true } },
        },
        helpers: { show: "{{ .viaHelper }}" },
        segments: {
          s: { template: '{{ template "show" . }}{{ toJson .ns }}{{ .doc.field }}' },
        },
        root: { h: ["s"] },
      }`),
    ).toEqual([]);
  });

  test("a variable read only by another variable's template or depends_on is used", () => {
    expect(
      unusedIn(`{
        variables: {
          base: { kind: "literal", value: "a" },
          trigger: { kind: "literal", value: "b" },
          derived: { kind: "template", template: "{{ .base }}" },
          polled: { kind: "shell", command: "true", cache: { depends_on: ["trigger"] } },
        },
        segments: { s: { template: "{{ .derived }}{{ .polled }}" } },
        root: { h: ["s"] },
      }`),
    ).toEqual([]);
  });

  test("a segment's own variable is named as the store holds it", () => {
    expect(
      unusedIn(`{
        segments: {
          s: {
            template: "{{ .s.used }}",
            vars: {
              used: { kind: "literal", value: "a" },
              idle: { kind: "literal", value: "b" },
            },
          },
        },
        root: { h: ["s"] },
      }`),
    ).toEqual(["variable s.idle"]);
  });

  test("a state variable is read by the clicked action that sets its key", () => {
    expect(
      unusedIn(`{
        variables: {
          mode: { kind: "state", key: "mode", default: "a" },
          stale: { kind: "state", key: "stale", default: "a" },
        },
        actions: {
          flip: { set: "mode", cycle: ["a", "b"] },
          unbound: { set: "stale", cycle: ["a", "b"] },
        },
        segments: { s: { template: '{{ action "flip" "A" "B" }}' } },
        root: { h: ["s"] },
      }`),
    ).toEqual(["variable stale", "action unbound"]);
  });

  test("the action a carousel's centre fires is clicked; a literal after a bare carousel is not", () => {
    const config = (template: string): string => `{
      variables: {
        pick: { kind: "state", key: "pick", default: "a" },
        opened: { kind: "state", key: "opened", default: "closed" },
      },
      actions: {
        pick: { set: "pick", from: ["a", "b"] },
        openIt: { set: "opened", cycle: ["closed", "open"] },
      },
      segments: { s: { template: '${template}' } },
      root: { h: ["s"] },
    }`;
    expect(unusedIn(config('{{ carousel "pick" 0 "openIt" }}'))).toEqual([]);
    expect(
      unusedIn(config('{{ printf "%s%s" (carousel "pick" 0) "openIt" }}')),
    ).toEqual(["variable opened", "action openIt"]);
  });

  test("the members of a clicked `do` are clicked; a `when` on a node is a read", () => {
    expect(
      unusedIn(`{
        variables: {
          a: { kind: "state", key: "a", default: "0" },
          gate: { kind: "literal", value: "true" },
        },
        actions: {
          one: { set: "a", to: "1" },
          both: { do: ["one", "copyDir"] },
        },
        segments: { s: { template: '{{ action "both" "go" }}' } },
        root: { h: [{ seg: "s", when: "{{ .gate }}" }] },
      }`),
    ).toEqual([]);
  });

  test("a segment placed only by one preset, or only inside a group, is placed", () => {
    expect(
      unusedIn(`{
        segments: {
          inPreset: { template: "p" },
          inGroup: { template: "g" },
        },
        presets: { alt: { root: { h: ["inPreset"] } } },
        root: { h: [{ kind: "group", name: "more", label: "more", children: ["inGroup"] }] },
      }`),
    ).toEqual([]);
  });

  test("a delta over a bundled segment the bar places is used; over one it does not, unused", () => {
    expect(unusedIn(`{ segments: { directory: { fg: "primary" } } }`)).toEqual(
      [],
    );
    expect(unusedIn(`{ segments: { commands: { fg: "primary" } } }`)).toEqual([
      "segment commands",
    ]);
  });
});
