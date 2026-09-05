// [LAW:verifiable-goals] brandon-doctor-b6a: the `☰ ▸ 🧰 tools ▸ 🩺 doctor`
// route, driven through the real loader, the real spine (registerDslConfig +
// renderDsl), and the real verb handlers — with a fake DoctorEdge whose tmux
// probe answers `RGB` and whose settings.json is a temp file. The recorded
// client hints are seeded the way server.ts records them, so the click reads
// the facts of the session's "last render" exactly as production does.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import {
  deriveActionValidators,
  registerStateValidator,
} from "../src/daemon/verbs/state-validators";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { SETTINGS_ANCHOR, SETTINGS_NS } from "../src/config/settings-menu";
import { EDIT_MODE_OPEN } from "../src/config/loader/edit-mode";
import { DISCLOSURE_CLOSED } from "../src/config/disclosure";
import { testVerbContext, effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import {
  parseEffects,
  VERB_DISPATCH,
  VERB_DOCTOR_FIX,
  VERB_DOCTOR_RUN,
} from "../src/click/wire";
import { VERBS, SESSION_CLIENT_HINTS_KEY, BadVerbArgs } from "../src/daemon/verbs";
import type { VerbContext } from "../src/daemon/verbs";
import { TMUX_TRUECOLOR_VAR } from "../src/doctor/checks";
import type { DoctorEdge } from "../src/doctor/edge";
import type { TmuxHint } from "../src/tmux-hint";

const ALLOWED = new Set(listResolvablePaletteNames());
const TOOLS_KEY = `${SETTINGS_NS}tools`;

const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

function extractUrls(rendered: string): string[] {
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\]8;;([^\x1b]+)\x1b\\/g;
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) urls.push(m[1]!);
  return urls;
}

const PAYLOAD = {
  session_id: "s1",
  project_dir: "/tmp/proj",
  workspace: { current_dir: "/tmp/proj" },
  model: { display_name: "Opus" },
};

const HINT: TmuxHint = { socket: "/s", pane: "%1", truecolor: null };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-doctor-menu-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function buildRuntime(tmux: TmuxHint | null) {
  const config = parseAndValidate(
    "<user>",
    `{ globals: {}, root: { h: ['directory', 'model'] } }`,
    ALLOWED,
    DEFAULT_DSL_CONFIG,
  );
  const sessionState = new SessionState();
  // What server.ts records on a render: the stamped hints, as JSON.
  sessionState.set("s1", SESSION_CLIENT_HINTS_KEY, JSON.stringify({ tmux }));
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { cwd: "/tmp/proj" });
  const basePalette = getThemePalette("textual-dark");
  const render = (): string =>
    stripAnsi(
      renderDsl(config, compiled, store, registry, PAYLOAD, basePalette, OPTS),
    );
  const renderRaw = (): string =>
    renderDsl(config, compiled, store, registry, PAYLOAD, basePalette, OPTS);
  const disposers = deriveActionValidators(config).map(({ key, spec }) =>
    registerStateValidator(key, spec),
  );
  const settingsPath = path.join(dir, "settings.json");
  let probes = 0;
  const doctor: DoctorEdge = {
    probeTmux: () => {
      probes += 1;
      return { kind: "ok", value: ["osc7", "RGB", "sixel"] };
    },
    claudeSettingsPath: settingsPath,
  };
  const ctx: VerbContext = { ...testVerbContext(sessionState), doctor };
  const click = (url: string): void => {
    const { verb, value } = parseHandlerUrl(url);
    const effects =
      verb === VERB_DISPATCH ? parseEffects(value) : [{ verb, value }];
    for (const e of effects) {
      const handler = VERBS.get(e.verb);
      if (!handler) throw new Error(`no handler for verb "${e.verb}"`);
      handler(e.value, ctx);
    }
  };
  const clickWriting = (key: string, value: string): void => {
    const url = extractUrls(renderRaw()).find((u) =>
      effectsOf(u).some((e) => e.args[1] === key && e.args[2] === value),
    );
    if (!url) throw new Error(`no affordance writing ${key}=${value} rendered`);
    click(url);
  };
  const urlOfVerb = (verb: string): string | undefined =>
    extractUrls(renderRaw()).find((u) =>
      effectsOf(u).some((e) => e.verb === verb),
    );
  const clickVerb = (verb: string): void => {
    const url = urlOfVerb(verb);
    if (!url) throw new Error(`no affordance with verb ${verb} rendered`);
    click(url);
  };
  const openTools = (): void => {
    clickWriting(SETTINGS_ANCHOR, EDIT_MODE_OPEN);
    clickWriting(TOOLS_KEY, EDIT_MODE_OPEN);
  };
  const dispose = (): void => disposers.forEach((d) => d());
  return {
    sessionState,
    settingsPath,
    render,
    click,
    clickVerb,
    urlOfVerb,
    openTools,
    probes: () => probes,
    dispose,
  };
}

describe("☰ ▸ 🧰 tools ▸ 🩺 doctor", () => {
  test("the tools disclosure holds the doctor button and no report until it runs", () => {
    const rt = buildRuntime(HINT);
    expect(rt.render()).not.toContain("🩺 doctor");
    rt.openTools();
    const out = rt.render();
    expect(out).toContain("🧰 tools ▾");
    expect(out).toContain("🩺 doctor");
    expect(out).not.toMatch(/[✓✗] tmux truecolor/);
    expect(rt.urlOfVerb(VERB_DOCTOR_RUN)).toBeDefined();
    expect(rt.urlOfVerb(VERB_DOCTOR_FIX)).toBeUndefined();
    rt.dispose();
  });

  test("the doctor's report rows are the body's own rows under the tools trigger", () => {
    const rt = buildRuntime(HINT);
    rt.openTools();
    rt.clickVerb(VERB_DOCTOR_RUN);
    const lines = rt.render().split("\n");
    const toolsRow = lines.findIndex((l) => l.includes("🧰 tools ▾"));
    expect(toolsRow).toBeGreaterThanOrEqual(0);
    // A vertical body: the button on one row, the report on the next — a long
    // reason never widens the settings band it hangs from.
    expect(lines[toolsRow + 1]).toContain("🩺 doctor");
    expect(lines[toolsRow + 2]).toMatch(/^✗ tmux truecolor/);
    rt.dispose();
  });

  test("in tmux with RGB and the var unset: failed row with [fix]; the fix lands and the row says restart", () => {
    const rt = buildRuntime(HINT);
    fs.writeFileSync(
      rt.settingsPath,
      `{\n  "env": { "FORCE_COLOR": "3" },\n  "model": "opus"\n}\n`,
    );
    rt.openTools();
    rt.clickVerb(VERB_DOCTOR_RUN);
    const failed = rt.render();
    expect(failed).toContain(
      "✗ tmux truecolor — Claude Code renders the bar in 256 colours inside tmux [fix]",
    );

    rt.clickVerb(VERB_DOCTOR_FIX);
    // one probe for the run click, one for the fix click — the post-fix
    // report re-reads only the settings env the fix changed
    expect(rt.probes()).toBe(2);
    expect(JSON.parse(fs.readFileSync(rt.settingsPath, "utf8"))).toEqual({
      env: { FORCE_COLOR: "3", [TMUX_TRUECOLOR_VAR]: "1" },
      model: "opus",
    });
    const fixed = rt.render();
    expect(fixed).toContain(
      `✗ tmux truecolor — ${TMUX_TRUECOLOR_VAR} is set in ~/.claude/settings.json — restart Claude Code to apply`,
    );
    expect(fixed).not.toContain("[fix]");
    expect(rt.urlOfVerb(VERB_DOCTOR_FIX)).toBeUndefined();
    rt.dispose();
  });

  // [LAW:no-silent-failure] A stale `[fix]` URL (the world moved since the
  // render that drew it) is refused loudly, never a silent second write.
  test("a second fix click is refused: nothing left to fix", () => {
    const rt = buildRuntime(HINT);
    rt.openTools();
    rt.clickVerb(VERB_DOCTOR_RUN);
    const fixUrl = rt.urlOfVerb(VERB_DOCTOR_FIX)!;
    rt.clickVerb(VERB_DOCTOR_FIX);
    const before = fs.readFileSync(rt.settingsPath, "utf8");
    expect(() => rt.click(fixUrl)).toThrow(BadVerbArgs);
    expect(fs.readFileSync(rt.settingsPath, "utf8")).toBe(before);
    rt.dispose();
  });

  test("not in tmux: the check is ok", () => {
    const rt = buildRuntime(null);
    rt.openTools();
    rt.clickVerb(VERB_DOCTOR_RUN);
    expect(rt.render()).toContain("✓ tmux truecolor");
    expect(rt.urlOfVerb(VERB_DOCTOR_FIX)).toBeUndefined();
    rt.dispose();
  });

  test("closing ☰ hides the tools body even when it was left open", () => {
    const rt = buildRuntime(HINT);
    rt.openTools();
    rt.clickVerb(VERB_DOCTOR_RUN);
    expect(rt.render()).toContain("tmux truecolor");
    rt.sessionState.set("s1", SETTINGS_ANCHOR, DISCLOSURE_CLOSED);
    const closed = rt.render();
    expect(closed).not.toContain("🩺 doctor");
    expect(closed).not.toContain("tmux truecolor");
    rt.dispose();
  });
});
