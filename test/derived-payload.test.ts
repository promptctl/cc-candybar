// brandon-unfiled-3248.8ro6, step 4e (the data half): a view's payload is
// derived and a draw writes no input. So a cache policy over the payload — a
// selection slot's `.effective`, a key over the drawn depth — re-runs its
// source in the turn the fact it reads moves, never inside a draw; and a
// policy over a fact of the draw's own instant, or a rule reading a slot's
// `.effective`, is refused at load.
//
// [LAW:behavior-not-structure] Each run of a shell appends a line to a file,
// so "spawns once" is a count of lines, and "in the turn the fact moved" is
// the run in flight before any draw.

import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { observable, runInAction } from "mobx";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { shellGate } from "./helpers/shell-gate";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { resolveEffectiveGlobals } from "../src/config/effective-globals";
import type { ValidatedConfig } from "../src/config/dsl-types";
import { bindView } from "../src/dsl/parts";
import { drawDsl, registerDslConfig } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { SourceRegistry, VariableStore } from "../src/var-system";
import { instantOf } from "../src/utils/instant";

const AT = instantOf(new Date(2026, 9, 25, 12, 0, 0));
const RUN_WITHIN_MS = 5_000;

const OPTS = {
  endcaps: "plain" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 1,
  width: 160,
};

// A view of `config` whose source answers the payload a test moves, and the
// count of the runs its `probe` shell made.
function viewOver(
  config: ValidatedConfig,
  payload: Record<string, unknown>,
  runs: string,
) {
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", new SessionState());
  const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: os.tmpdir() });
  const answer = observable.box(payload, { deep: false });
  const selections = resolveEffectiveGlobals(
    config,
    () => null,
    () => false,
  );
  bindView(compiled, store, registry, {
    payload: () => answer.get(),
    selections: () => selections,
  });
  return {
    registry,
    // A request's arrival: the payload moves, in one turn.
    arrive: (next: Record<string, unknown>) =>
      runInAction(() => answer.set(next)),
    draw: () =>
      drawDsl(config, compiled, store, registry, {}, AT, OPTS, undefined, {
        ...selections,
      }),
    runs: (): number =>
      fs.existsSync(runs)
        ? fs.readFileSync(runs, "utf8").split("\n").filter(Boolean).length
        : 0,
    dispose: () => registry.dispose(),
  };
}

describe("a cache policy over the view's payload", () => {
  let dir: string;
  let runs: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-derived-"));
    runs = path.join(dir, "runs");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("a key over a style rule's .effective runs in the turn its data moves, never in a draw", async () => {
    const gate = shellGate(path.join(dir, "gate"));
    const config = parseAndValidate(
      "<test>",
      `{
        globals: { style: '{{ if .hot }}vivid{{ else }}none{{ end }}' },
        styles: { vivid: { chromaScale: 1.4 } },
        variables: {
          hot: { kind: "input", path: "hot", type: "boolean", default: false },
          'style.effective': { kind: "input", path: "style.effective", default: "" },
          probe: {
            kind: "shell",
            command: "echo run >> ${runs}; ${gate.hold}; echo ran",
            cache: { key: "{{ .style.effective }}" },
          },
        },
        segments: { s: { template: "{{ .probe }}" } },
        root: { h: ["s"] },
      }`,
    );
    const view = viewOver(config, { hot: false }, runs);
    try {
      expect(await view.registry.settled(RUN_WITHIN_MS)).toEqual([]);
      expect(view.runs()).toBe(1);
      view.draw();
      view.draw();
      expect(await view.registry.settled(RUN_WITHIN_MS)).toEqual([]);
      expect(view.runs()).toBe(1);
      // The data the rule reads moves: the rule settles on another name, and
      // the key's run starts in that turn, before any draw.
      gate.close();
      view.arrive({ hot: true });
      expect(await view.registry.settled(0)).toEqual(["probe"]);
      gate.open();
      expect(await view.registry.settled(RUN_WITHIN_MS)).toEqual([]);
      expect(view.runs()).toBe(2);
      view.draw();
      view.draw();
      expect(await view.registry.settled(RUN_WITHIN_MS)).toEqual([]);
      expect(view.runs()).toBe(2);
    } finally {
      view.dispose();
    }
  });

  test("a key over readableOn at colour depth 256 runs once, whatever draws", async () => {
    const config = parseAndValidate(
      "<test>",
      `{
        variables: {
          probe: {
            kind: "shell",
            command: "echo run >> ${runs}; echo ran",
            cache: { key: '{{ readableOn "#e72abb" "#2e082f" 4.5 }}' },
          },
        },
        segments: { s: { template: "{{ .probe }}" } },
        root: { h: ["s"] },
      }`,
    );
    const view = viewOver(
      config,
      { colorCompatibility: { effective: "256" } },
      runs,
    );
    try {
      expect(await view.registry.settled(RUN_WITHIN_MS)).toEqual([]);
      for (let frame = 0; frame < 3; frame++) view.draw();
      expect(await view.registry.settled(RUN_WITHIN_MS)).toEqual([]);
      expect(view.runs()).toBe(1);
    } finally {
      view.dispose();
    }
  });
});

describe("a policy or rule over what the draw answers is refused at load", () => {
  const load = (source: string) => () =>
    parseAndValidate("<test>", source, undefined, DEFAULT_DSL_CONFIG);
  const TTL = /re-run it on a period instead: cache: \{ ttl: "<duration>" \}/;

  test("a key over a lane's feeds", () => {
    expect(
      load(`{ variables: { p: { kind: "shell", command: "true",
        cache: { key: "{{ .feeds.pane.fps }}" } } } }`),
    ).toThrow(/cache\.key reads "feeds\.pane\.fps", which reads the draw's "feeds"/);
    expect(
      load(`{ variables: { p: { kind: "shell", command: "true",
        cache: { key: "{{ .feeds.pane.fps }}" } } } }`),
    ).toThrow(TTL);
  });

  test("a depends_on over who the draw is for", () => {
    expect(
      load(`{ variables: { p: { kind: "shell", command: "true",
        cache: { depends_on: ["drawing.fps"] } } } }`),
    ).toThrow(
      /cache\.depends_on names "drawing\.fps", which reads the draw's "drawing"/,
    );
  });

  test("a key over a slot whose rule calls the clock", () => {
    expect(
      load(`{
        globals: { style: '{{ if eq (mod (unixEpoch now) 2) 0 }}vivid{{ else }}none{{ end }}' },
        variables: { p: { kind: "shell", command: "true",
          cache: { key: "{{ .style.effective }}" } } },
      }`),
    ).toThrow(
      /cache\.key reads "style\.effective", which reads the style rule, which calls "now"/,
    );
  });

  test("a rule reading a source whose cache policy reads a slot's .effective", () => {
    expect(
      load(`{
        globals: { palette: '{{ if eq .probe "x" }}nord{{ else }}dracula{{ end }}' },
        variables: { probe: { kind: "shell", command: "echo x",
          cache: { key: "{{ .theme.effective }}" } } },
      }`),
    ).toThrow(
      /globals\.palette reads "probe", whose cache\.key reads "theme\.effective", the palette's own name/,
    );
    expect(
      load(`{
        globals: { style: '{{ if eq .probe "x" }}vivid{{ else }}none{{ end }}' },
        variables: {
          picked: { kind: "template", template: "{{ .style.effective }}" },
          probe: { kind: "shell", command: "echo x",
            cache: { depends_on: ["picked"] } },
        },
      }`),
    ).toThrow(
      /globals\.style reads "probe", whose cache\.depends_on reads "picked", which reads "style\.effective", the style's own name/,
    );
  });

  test("a rule reading a slot's .effective, its own or another's", () => {
    expect(
      load(`{ globals: { effect: '{{ if eq .theme.effective "nord" }}pulse{{ else }}none{{ end }}' } }`),
    ).toThrow(
      /globals\.effect reads "theme\.effective", the palette's own name: a rule decides that name, so it cannot read it/,
    );
  });
});
