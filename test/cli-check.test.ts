// [LAW:verifiable-goals] These drive the same entry functions `cc-candybar check` runs,
// so the exit-code contract is verifiable without spawning a process or stubbing process.exit.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkConfig,
  checkPlan,
  runCheck,
  type CheckOutcome,
} from "../src/check";
import { detectConfigEnv } from "../src/config-hint";

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-check-"));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// Pin $XDG_CONFIG_HOME and $CC_CANDYBAR_CONFIG per test so the developer's real config can never leak into a verdict.
const SAVED_ENV = {
  CC_CANDYBAR_CONFIG: process.env.CC_CANDYBAR_CONFIG,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};
beforeEach(() => {
  delete process.env.CC_CANDYBAR_CONFIG;
  process.env.XDG_CONFIG_HOME = path.join(dir, "xdg-empty");
});
afterAll(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function write(name: string, contents: string): string {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
  return p;
}

function expectFatal(outcome: CheckOutcome): string {
  expect(outcome.kind).toBe("fatal");
  return outcome.kind === "fatal" ? outcome.message : "";
}

describe("checkConfig — explicit target", () => {
  it("reports a valid config clean, with the rendered line", async () => {
    const p = write(
      "ok.json5",
      `{ segments: { a: { template: 'a' } }, root: { h: ['a'] } }`,
    );
    const outcome = await checkConfig(p, dir);
    expect(outcome.kind).toBe("clean");
    if (outcome.kind === "clean") {
      expect(outcome.configPath).toBe(p);
      expect(outcome.rendered.length).toBeGreaterThan(0);
    }
  });

  it("a source still running at the settle deadline is a warning naming it, not a hang or a failure", async () => {
    const p = write(
      "slow.json5",
      `{
        variables: {
          slow: { kind: "shell", command: "sleep 6; echo late", parse: { text: true }, cache: { never: true }, default: "pending" },
        },
        segments: { a: { template: "{{ .slow }}" } },
        root: { h: ["a"] },
      }`,
    );
    const outcome = await checkConfig(p, dir);
    if (outcome.kind !== "clean") throw new Error(`expected clean, got ${outcome.kind}`);
    expect(outcome.warnings).toContain(
      "source still running after 5000 ms, rendered with fallback values: slow",
    );
    expect(checkPlan(outcome).code).toBe(0);
  }, 15000);

  it("a json document with no default still unscanned at the deadline is a fatal segment error naming it", async () => {
    const p = write(
      "slow-doc.json5",
      `{
        variables: {
          slow2: { kind: "shell", command: "sleep 6; echo {}", parse: { json: true }, cache: { never: true } },
        },
        segments: { a: { template: "{{ .slow2.x }}" } },
        root: { h: ["a"] },
      }`,
    );
    const message = expectFatal(await checkConfig(p, dir));
    expect(message).toContain('variable "slow2" has no value yet');
  }, 15000);

  it("reports a structurally invalid config with the loader's message", async () => {
    const p = write("bad.json5", `{ segments: { a: { template: 42 } } }`);
    const message = expectFatal(await checkConfig(p, dir));
    expect(message).toContain("Invalid config");
    expect(message).toContain("template");
  });

  it("reports a semantic (cross-ref) error — the daemon would surface the same", async () => {
    const p = write(
      "dangling.json5",
      `{ segments: { a: { template: 'a' } }, root: { h: ['a', 'nope'] } }`,
    );
    expect(expectFatal(await checkConfig(p, dir))).toContain("nope");
  });

  it("reports an unreadable file distinctly from an invalid one — never falls through to the bundled default", async () => {
    const outcome = await checkConfig(path.join(dir, "does-not-exist.json5"), dir);
    expect(outcome.kind).toBe("unreadable");
  });

  it("reports a directory target as unreadable (usage-shaped, exit 2), not invalid", async () => {
    const outcome = await checkConfig(dir, dir);
    expect(outcome.kind).toBe("unreadable");
    expect(checkPlan(outcome).code).toBe(2);
  });

  it("reports a JSON5 parse error naming the config path", async () => {
    const p = write("syntax.json5", `{ segments: { a: `);
    const message = expectFatal(await checkConfig(p, dir));
    expect(message).toContain("syntax.json5");
  });

  it("reports a template referencing an undeclared action", async () => {
    const p = write(
      "undeclared-action.json5",
      `{
        segments: { a: { template: '{{ action "nope" "x" }}' } },
        root: { h: ['a'] },
      }`,
    );
    expect(expectFatal(await checkConfig(p, dir))).toContain('"nope"');
  });

  it("reports a user action squatting the reserved menus. namespace", async () => {
    const p = write(
      "squat-menus.json5",
      `{
        actions: { "menus.mine": { set: "x", to: "1" } },
        segments: { a: { template: 'a' } },
        root: { h: ['a'] },
      }`,
    );
    const message = expectFatal(await checkConfig(p, dir));
    expect(message).toContain('reserved "menus."');
  });

  it("reports a user action squatting the reserved groups. namespace", async () => {
    const p = write(
      "squat-groups.json5",
      `{
        actions: { "groups.mine": { set: "x", to: "1" } },
        segments: { a: { template: 'a' } },
        root: { h: ['a'] },
      }`,
    );
    const message = expectFatal(await checkConfig(p, dir));
    expect(message).toContain('reserved "groups."');
  });

  it("reports a {{ menu }} with no trigger display with the migration pointer", async () => {
    const p = write(
      "menu-nodisplay.json5",
      `{
        actions: { applyX: { set: "theme", from: "themes" } },
        segments: { a: { template: '{{ menu "applyX" }}' } },
        root: { h: ['a'] },
      }`,
    );
    expect(expectFatal(await checkConfig(p, dir))).toContain("needs a display");
  });

  it("reports an unknown {{ menu }} dict option with the legal shape", async () => {
    const p = write(
      "menu-badopt.json5",
      `{
        actions: { applyX: { set: "theme", from: "themes" } },
        segments: { a: { template: '{{ menu "applyX" "▸" "▾" (dict "closeOnPik" true) }}' } },
        root: { h: ['a'] },
      }`,
    );
    const message = expectFatal(await checkConfig(p, dir));
    expect(message).toContain('unknown {{ menu }} option "closeOnPik"');
  });

  it("does not flag the standalone {{ picker }} form", async () => {
    const p = write(
      "standalone-picker.json5",
      `{
        variables: {
          "session.id": { kind: "input", path: "session_id", default: "" },
          themePageCursor: { kind: "state", key: "theme-page", default: "-1" },
        },
        actions: {
          applyTheme: { set: "theme", from: "themes" },
          themePage: { set: "theme-page", int: true },
        },
        segments: {
          picker: { template: '{{ picker "applyTheme" "themePage" false true }}' },
        },
        root: { v: [
          { seg: "picker", when: "{{ ge (int .themePageCursor) 0 }}" },
        ] },
      }`,
    );
    expect((await checkConfig(p, dir)).kind).toBe("clean");
  });

  // A mistyped payload field path parses and validates fine, then throws at render.
  it("reports a render-stage failure (mistyped payload field path)", async () => {
    const p = write(
      "render-fail.json5",
      `{
        variables: {
          bogus: { kind: "input", path: "git.nonexistent" },
        },
        segments: { a: { template: '{{ .bogus }}x{{ .bogus.deeper }}' } },
        root: { h: ['a'] },
      }`,
    );
    expect((await checkConfig(p, dir)).kind).toBe("fatal");
  });

  // [LAW:no-silent-failure] The blind authoring agent is not looking at the bar, so a
  // visible ⚠ error cell must still fold into the text verdict: exit 1, never a blessed 0.
  it("reports a segment whose template throws at evaluation (⚠ error cell) as fatal", async () => {
    const p = write(
      "render-error-cell.json5",
      `{
        actions: { cycleMode: { set: "work-mode", cycle: ["focus", "review", "debug"] } },
        segments: { chip: { template: '{{ action "cycleMode" "🎯 focus" "🔍 review" }}' } },
        root: { h: ['chip'] },
      }`,
    );
    const message = expectFatal(await checkConfig(p, dir));
    expect(message).toContain('segment "chip"');
    expect(message).toContain(
      "cycles 3 members; bind one display per member (3) or one static display, got 2",
    );
  });

  // `.preset.customized` is the one field the static fixture cannot drive true, so this reaches the SECOND render pass.
  it("reports a segment error reachable only behind .preset.customized as fatal", async () => {
    const p = write(
      "customized-gate-error.json5",
      `{
        actions: { cycleMode: { set: "work-mode", cycle: ["focus", "review", "debug"] } },
        segments: {
          a: { template: 'ok' },
          layoutStatus: {
            template: '{{ action "cycleMode" "🎯 focus" "🔍 review" }}',
            when: '{{ .preset.customized }}',
          },
        },
        root: { h: ['a', 'layoutStatus'] },
      }`,
    );
    const message = expectFatal(await checkConfig(p, dir));
    expect(message).toContain('segment "layoutStatus"');
    expect(message).toContain("(under .preset.customized = true)");
  });

  // The same error in both render passes must be reported exactly once, not double-counted.
  it("does not double-report an unconditional segment error across both render passes", async () => {
    const p = write(
      "unconditional-error-dedup.json5",
      `{
        actions: { cycleMode: { set: "work-mode", cycle: ["focus", "review", "debug"] } },
        segments: { chip: { template: '{{ action "cycleMode" "🎯 focus" "🔍 review" }}' } },
        root: { h: ['chip'] },
      }`,
    );
    const message = expectFatal(await checkConfig(p, dir));
    expect(message).toContain("config renders with 1 segment error");
    expect(message).not.toContain("(under .preset.customized = true)");
    expect(message.split('segment "chip"').length - 1).toBe(1);
  });

  it("reports a template parse error in a segment override (register stage)", async () => {
    const p = write(
      "template-parse.json5",
      `{
        segments: { a: { template: '{{ if }}' } },
        root: { h: ['a'] },
      }`,
    );
    expect((await checkConfig(p, dir)).kind).toBe("fatal");
  });
});

describe("checkConfig — default resolution (the daemon's own chain)", () => {
  it("checks the bundled default when no config file exists anywhere", async () => {
    const emptyCwd = path.join(dir, "empty-cwd");
    fs.mkdirSync(emptyCwd, { recursive: true });
    const outcome = await checkConfig(undefined, emptyCwd);
    expect(outcome.kind).toBe("clean");
    if (outcome.kind === "clean") {
      expect(outcome.configPath).toBeNull();
      expect(outcome.rendered.length).toBeGreaterThan(0);
    }
  });

  it("resolves the cwd config file exactly as the daemon would", async () => {
    const cwd = path.join(dir, "proj");
    const p = write(
      "proj/.cc-candybar.json5",
      `{ segments: { a: { template: 'a' } }, root: { h: ['a'] } }`,
    );
    const outcome = await checkConfig(undefined, cwd);
    expect(outcome.kind).toBe("clean");
    if (outcome.kind === "clean") expect(outcome.configPath).toBe(p);
  });

  // $CC_CANDYBAR_CONFIG is read at the CLI edge and passed as the explicit target, so an absent file is `unreadable`.
  it("takes $CC_CANDYBAR_CONFIG as the explicit target, not as a resolver input", async () => {
    const p = write(
      "env-config.json5",
      `{ segments: { a: { template: 'env' } }, root: { h: ['a'] } }`,
    );
    const cwd = path.join(dir, "empty-cwd");
    process.env.CC_CANDYBAR_CONFIG = p;
    const blind = await checkConfig(undefined, cwd);
    expect(blind.kind).toBe("clean");
    if (blind.kind === "clean") expect(blind.configPath).toBeNull();
    const viaEnv = await checkConfig(detectConfigEnv(process.env), cwd);
    expect(viaEnv.kind).toBe("clean");
    if (viaEnv.kind === "clean") expect(viaEnv.configPath).toBe(p);
    process.env.CC_CANDYBAR_CONFIG = path.join(dir, "absent.json5");
    const absent = await checkConfig(detectConfigEnv(process.env), cwd);
    expect(absent.kind).toBe("unreadable");
  });

  it("surfaces the .json5/.json collision as a warning on a CLEAN exit", async () => {
    const cwd = path.join(dir, "collide");
    write(
      "collide/.cc-candybar.json5",
      `{ segments: { a: { template: 'a' } }, root: { h: ['a'] } }`,
    );
    write(
      "collide/.cc-candybar.json",
      `{ "segments": { "a": { "template": "a" } }, "root": { "h": ["a"] } }`,
    );
    const outcome = await checkConfig(undefined, cwd);
    expect(outcome.kind).toBe("clean");
    if (outcome.kind === "clean") {
      expect(outcome.warnings.join("\n")).toContain("collision");
      expect(checkPlan(outcome).code).toBe(0);
      expect(checkPlan(outcome).stderr).toContain("collision");
    }
  });
});

describe("checkPlan — the text/exit-code contract", () => {
  it("maps clean → exit 0 with the verdict on stdout", async () => {
    const plan = checkPlan({
      kind: "clean",
      configPath: "/tmp/x.json5",
      warnings: [],
      rendered: "line",
    });
    expect(plan.code).toBe(0);
    expect(plan.stdout).toContain("/tmp/x.json5");
    expect(plan.stderr).toBe("");
  });

  it("maps clean-with-warnings → exit 0 with warnings visible on stderr", async () => {
    const plan = checkPlan({
      kind: "clean",
      configPath: null,
      warnings: ["something advisory"],
      rendered: "line",
    });
    expect(plan.code).toBe(0);
    expect(plan.stdout).toContain("bundled default");
    expect(plan.stderr).toContain("warning: something advisory");
  });

  it("maps fatal → exit 1 with the diagnostic on stderr", async () => {
    const plan = checkPlan({
      kind: "fatal",
      configPath: "/tmp/x.json5",
      message: "broken here",
      warnings: [],
    });
    expect(plan.code).toBe(1);
    expect(plan.stdout).toBe("");
    expect(plan.stderr).toContain("/tmp/x.json5");
    expect(plan.stderr).toContain("broken here");
  });

  it("maps unreadable → exit 2", async () => {
    const plan = checkPlan({
      kind: "unreadable",
      path: "gone.json5",
      message: "ENOENT",
    });
    expect(plan.code).toBe(2);
    expect(plan.stderr).toContain("gone.json5");
  });
});

// `runCheck` owns process.exit and the streams; the spies turn its exit into a thrown code.
describe("runCheck — the argv edge", () => {
  class Exit {
    constructor(readonly code: number) {}
  }
  async function run(args: string[]): Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }> {
    let stdout = "";
    let stderr = "";
    const out = jest
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => ((stdout += String(chunk)), true));
    const err = jest
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => ((stderr += String(chunk)), true));
    const exit = jest.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Exit(code ?? 0);
    }) as never);
    try {
      await runCheck(args);
    } catch (e) {
      if (e instanceof Exit) return { code: e.code, stdout, stderr };
      throw e;
    } finally {
      out.mockRestore();
      err.mockRestore();
      exit.mockRestore();
    }
    throw new Error("runCheck returned instead of exiting");
  }

  it("an explicit argument outranks $CC_CANDYBAR_CONFIG; without one the variable is the target", async () => {
    const ok = write(
      "edge-ok.json5",
      `{ segments: { a: { template: 'ok' } }, root: { h: ['a'] } }`,
    );
    const bad = write("edge-bad.json5", `{ theme: "dracula" }`);
    process.env.CC_CANDYBAR_CONFIG = bad;

    const viaArg = await run([ok]);
    expect(viaArg.code).toBe(0);
    expect(viaArg.stdout).toContain(`✓ ${ok}: config OK`);

    const viaEnv = await run([]);
    expect(viaEnv.code).toBe(1);
    expect(viaEnv.stderr).toContain(`✗ ${bad}`);
    expect(viaEnv.stderr).toContain('Unknown top-level key "theme"');
  });
});
