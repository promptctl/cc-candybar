// [LAW:verifiable-goals] brandon-settings-menu-92b: a `do` action fires several
// declared actions from one click. Driven through the real loader, the real
// spine (registerDslConfig + renderDsl), and the real set-state gate derived
// from the config, so "the gate admits it" is measured, not assumed.

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
import { ConfigError } from "../src/config/dsl-loader";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { effectsOf, clickUrl, testVerbContext } from "./helpers/click";
import { linkUrls, stripAnsi } from "./helpers/ansi";

const ALLOWED = new Set(listResolvablePaletteNames());
const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};
const PAYLOAD = { session_id: "s1", workspace: { current_dir: "/tmp/proj" } };

// A config of one segment, `bar`, over the given actions and template.
function config(actions: string, template: string): string {
  return `{
    variables: {
      panel: { kind: 'state', key: 'panel', default: 'open' },
      focus: { kind: 'state', key: 'focus', default: 'off' },
      theme: { kind: 'state', key: 'theme', default: 'nord' },
    },
    actions: { ${actions} },
    segments: { bar: { template: '${template}', fg: 'foreground' } },
    root: 'bar',
  }`;
}

function runtime(src: string) {
  const cfg = parseAndValidate("<user>", src, ALLOWED, DEFAULT_DSL_CONFIG);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(cfg, registry, { cwd: "/tmp/proj" });
  const disposers = deriveActionValidators(cfg).map(({ key, spec }) =>
    registerStateValidator(key, spec),
  );
  return {
    sessionState,
    render: () => renderDsl(cfg, compiled, store, registry, PAYLOAD, OPTS),
    click: (url: string) => clickUrl(url, testVerbContext(sessionState)),
    dispose: () => disposers.forEach((d) => d()),
  };
}

const FOCUS_AND_CLOSE = `
  toggleFocus: { set: 'focus', cycle: ['off', 'on'] },
  closePanel: { set: 'panel', to: 'closed' },
  focusAndClose: { do: ['toggleFocus', 'closePanel'] },`;

describe("do: several declared actions, one click", () => {
  test("the head is the face; every member's write lands, through the derived gate", () => {
    const rt = runtime(
      config(FOCUS_AND_CLOSE, '{{ action "focusAndClose" "◎ focus" "◉ unfocus" }}'),
    );
    const out = rt.render();
    // The head is a two-member cycle, so the `do` shows its per-member display.
    expect(stripAnsi(out)).toContain("◎ focus");
    const [url] = linkUrls(out).filter((u) => u.includes("focus"));
    // Members' effects, head first; the daemon joins the adjacent session
    // writes into one batch (test/click-wire.test.ts pins that).
    expect(effectsOf(url!)).toEqual([
      { verb: "set-state", args: ["s1", "focus", "on"] },
      { verb: "set-state", args: ["s1", "panel", "closed"] },
    ]);
    rt.click(url!);
    expect(rt.sessionState.get("s1", "focus")).toBe("on");
    expect(rt.sessionState.get("s1", "panel")).toBe("closed");
    // The head's current state drives the next display and the next write.
    const next = rt.render();
    expect(stripAnsi(next)).toContain("◉ unfocus");
    rt.dispose();
  });

  test("a {{ menu }} over a do headed by an option action: each pick also fires the rest", () => {
    const rt = runtime(
      config(
        `pickTheme: { set: 'theme', from: 'themes' },
         closePanel: { set: 'panel', to: 'closed' },
         pickAndClose: { do: ['pickTheme', 'closePanel'] },`,
        '{{ menu "pickAndClose" "▸" "▾" }}',
      ),
    );
    const trigger = linkUrls(rt.render()).find((u) => u.includes("menus."));
    rt.click(trigger!);
    const dracula = linkUrls(rt.render()).find((u) =>
      effectsOf(u).some((e) => e.args[2] === "dracula"),
    );
    expect(effectsOf(dracula!)).toEqual([
      { verb: "set-state", args: ["s1", "theme", "dracula"] },
      { verb: "set-state", args: ["s1", "panel", "closed"] },
    ]);
    rt.click(dracula!);
    expect(rt.sessionState.get("s1", "theme")).toBe("dracula");
    expect(rt.sessionState.get("s1", "panel")).toBe("closed");
    rt.dispose();
  });
});

describe("do: load errors", () => {
  const loadError = (actions: string): string => {
    try {
      parseAndValidate(
        "<user>",
        config(actions, "x"),
        ALLOWED,
        DEFAULT_DSL_CONFIG,
      );
    } catch (e) {
      if (e instanceof ConfigError) return e.message;
      throw e;
    }
    throw new Error("expected a load error");
  };

  test.each([
    ["one member", `a: { set: 'panel', to: 'closed' }, d: { do: ['a'] },`, "do must list at least two action names"],
    ["an unknown member", `a: { set: 'panel', to: 'closed' }, d: { do: ['a', 'nope'] },`, 'actions.d do: references unknown action "nope"'],
    ["a nested do", `a: { set: 'panel', to: 'closed' }, b: { set: 'focus', to: 'on' }, ab: { do: ['a', 'b'] }, d: { do: ['ab', 'a'] },`, '"ab" is itself a do action'],
    ["a member listed twice", `a: { set: 'panel', to: 'closed' }, b: { set: 'focus', to: 'on' }, d: { do: ['a', 'b', 'a'] },`, '"a" is listed twice'],
    ["a template-bound follower", `a: { set: 'panel', to: 'closed' }, t: { set: 'theme', from: 'themes' }, d: { do: ['a', 't'] },`, '"t" takes its value from the template'],
    ["a sibling key", `a: { set: 'panel', to: 'closed' }, b: { set: 'focus', to: 'on' }, d: { do: ['a', 'b'], to: 'x' },`, 'Unknown key "to" on a do action'],
  ])("%s", (_label, actions, message) => {
    expect(loadError(actions)).toContain(message);
  });

  test("a do that fires edit.toggle is demand enough for edit mode", () => {
    // No template names edit.toggle, so only the `do` can mint it.
    expect(() =>
      parseAndValidate(
        "<user>",
        config(
          `closePanel: { set: 'panel', to: 'closed' },
           editAndClose: { do: ['edit.toggle', 'closePanel'] },`,
          '{{ action "editAndClose" "✎" }}',
        ),
        ALLOWED,
        DEFAULT_DSL_CONFIG,
      ),
    ).not.toThrow();
  });
});
