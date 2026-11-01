// brandon-unfiled-3248.qum: a segment's text is whatever its data says — a
// ticket's description, a branch name, a JSON field — and the terminal reads
// some characters as instructions rather than text. A bidi override left
// unclosed reverses the rest of the line, bar chrome included; a C1 control is
// the start of an escape sequence. rich-js's Text strips them at the one place
// a string becomes drawn characters, and this pins that every segment's text
// takes that path on the production render.

import { drawPayload } from "./helpers/draw-payload";
import { textOf } from "../src/render/frame";
import type { Frame } from "../src/render/frame";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { SessionState } from "../src/daemon/session-state";
import { parseAndValidate } from "./helpers/parse-and-validate";

import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig } from "../src/dsl/render";
import { instantOf } from "../src/utils/instant";

const OPTS = {
  endcaps: "powerline" as const,
  colorCompatibility: "truecolor" as const, wrap: true, padding: 0,
  width: Number.POSITIVE_INFINITY,
};

const CONFIG = parseAndValidate(
  "<test>",
  `{
    variables: { s: { kind: "input", path: "s", type: "string", default: "" } },
    segments: { probe: { template: "[{{ .s }}]" } },
    root: "probe",
  }`,
  undefined,
  DEFAULT_DSL_CONFIG,
);

function render(s: string): Frame {
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", new SessionState());
  try {
    const compiled = registerDslConfig(CONFIG, registry, { signer: TEST_SIGNER, cwd: "/tmp" });
    return drawPayload(CONFIG, compiled, store, registry, { s }, instantOf(new Date()), OPTS).frame;
  } finally {
    registry.dispose();
  }
}

const RLO = String.fromCodePoint(0x202e);
const LRI = String.fromCodePoint(0x2066);
const CSI = String.fromCodePoint(0x9b);
const RLM = String.fromCodePoint(0x200f);

describe("a segment's text reaches the terminal without the controls it could issue", () => {
  test("a bidi override, an isolate and a C1 CSI in data are not drawn", () => {
    const out = render(`a${RLO}b${LRI}c${CSI}2Jd`);
    for (const control of [RLO, LRI, CSI]) expect(textOf(out)).not.toContain(control);
    expect(textOf(out)).toContain("[abc2Jd]");
  });

  test("a bidi mark, which holds no direction state, is drawn", () => {
    expect(textOf(render(`a${RLM}b`))).toContain(`a${RLM}b`);
  });
});
