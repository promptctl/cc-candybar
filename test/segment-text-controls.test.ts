// brandon-unfiled-3248.qum: a segment's text is whatever its data says — a
// ticket's description, a branch name, a JSON field — and the terminal reads
// some characters as instructions rather than text. A bidi override left
// unclosed reverses the rest of the line, bar chrome included; a C1 control is
// the start of an escape sequence. rich-js's Text strips them at the one place
// a string becomes drawn characters, and this pins that every segment's text
// takes that path on the production render.

import { SessionState } from "../src/daemon/session-state";
import { stripAnsi } from "./helpers/ansi";

import {
  parseDslConfig,
  mergeWithDefault,
  validateConfig,
} from "../src/config/dsl-loader";
import type { ValidatedConfig } from "../src/config/dsl-types";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { instantOf } from "../src/utils/instant";

const OPTS = {
  endcaps: "powerline" as const,
  colorCompatibility: "truecolor" as const, wrap: true, padding: 0,
  width: Number.POSITIVE_INFINITY,
};

function render(s: string): string {
  const source = `{
    variables: { s: { kind: "input", path: "s", type: "string", default: "" } },
    segments: { probe: { template: "[{{ .s }}]" } },
    root: "probe",
  }`;
  const raw = parseDslConfig("<test>", source);
  const config = validateConfig(
    { config: mergeWithDefault(raw, DEFAULT_DSL_CONFIG), raw, source },
    "<test>",
  ) as ValidatedConfig;
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, new SessionState());
  const compiled = registerDslConfig(config, registry, { cwd: "/tmp" });
  return renderDsl(config, compiled, store, registry, { s }, instantOf(new Date()), OPTS);
}

const RLO = String.fromCodePoint(0x202e);
const LRI = String.fromCodePoint(0x2066);
const CSI = String.fromCodePoint(0x9b);
const RLM = String.fromCodePoint(0x200f);

describe("a segment's text reaches the terminal without the controls it could issue", () => {
  test("a bidi override, an isolate and a C1 CSI in data are not drawn", () => {
    const out = render(`a${RLO}b${LRI}c${CSI}2Jd`);
    for (const control of [RLO, LRI, CSI]) expect(out).not.toContain(control);
    expect(stripAnsi(out)).toContain("[abc2Jd]");
  });

  test("a bidi mark, which holds no direction state, is drawn", () => {
    expect(render(`a${RLM}b`)).toContain(`a${RLM}b`);
  });
});
