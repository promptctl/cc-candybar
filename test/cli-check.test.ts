// [LAW:verifiable-goals] check's contract is its OUTCOME, discriminated by kind
// — clean / fatal / unreadable. `checkConfig` is the pure decision (a function
// of the target file's contents on the daemon's own pipeline); `checkPlan`
// projects it onto the streams + exit-code contract. We drive the same entry
// functions `cc-candybar check` runs (the ticket's "drives the same entry
// function" form), so the exit-code contract is verifiable without spawning a
// process or stubbing process.exit.
//
// The fixture vocabulary below is the bn5.6 load-error surface the command
// exists to expose to a blind authoring agent: JSON5 parse errors, undeclared
// action refs, reserved-namespace squatting, the removed {{ menu }} positional
// tail, mistyped menu dict options — plus the render-stage failures the old
// shallow `lint` could never see (template parse errors, missing payload
// fields).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkConfig, checkPlan } from "../src/check";

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-check-"));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// Default-path resolution reads $CC_CANDYBAR_CONFIG and $XDG_CONFIG_HOME
// (dslConfigCandidatePaths); pin both per test so the developer's real config
// can never leak into a verdict.
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

function expectFatal(outcome: ReturnType<typeof checkConfig>): string {
  expect(outcome.kind).toBe("fatal");
  return outcome.kind === "fatal" ? outcome.message : "";
}

describe("checkConfig — explicit target", () => {
  it("reports a valid config clean, with the rendered line", () => {
    const p = write(
      "ok.json5",
      `{ segments: { a: { template: 'a' } }, root: { h: ['a'] } }`,
    );
    const outcome = checkConfig(p, dir);
    expect(outcome.kind).toBe("clean");
    if (outcome.kind === "clean") {
      expect(outcome.configPath).toBe(p);
      expect(outcome.rendered.length).toBeGreaterThan(0);
    }
  });

  it("reports a structurally invalid config with the loader's message", () => {
    const p = write("bad.json5", `{ segments: { a: { template: 42 } } }`);
    const message = expectFatal(checkConfig(p, dir));
    expect(message).toContain("Invalid config");
    expect(message).toContain("template");
  });

  it("reports a semantic (cross-ref) error — the daemon would surface the same", () => {
    const p = write(
      "dangling.json5",
      `{ segments: { a: { template: 'a' } }, root: { h: ['a', 'nope'] } }`,
    );
    expect(expectFatal(checkConfig(p, dir))).toContain("nope");
  });

  it("reports an unreadable file distinctly from an invalid one — never falls through to the bundled default", () => {
    const outcome = checkConfig(path.join(dir, "does-not-exist.json5"), dir);
    expect(outcome.kind).toBe("unreadable");
  });

  it("reports a directory target as unreadable (usage-shaped, exit 2), not invalid", () => {
    const outcome = checkConfig(dir, dir);
    expect(outcome.kind).toBe("unreadable");
    expect(checkPlan(outcome).code).toBe(2);
  });

  // Acceptance (a): a JSON5 syntax error is fatal and names the file.
  it("reports a JSON5 parse error naming the config path", () => {
    const p = write("syntax.json5", `{ segments: { a: `);
    const message = expectFatal(checkConfig(p, dir));
    expect(message).toContain("syntax.json5");
  });

  // Acceptance (b): a template referencing an undeclared action is fatal.
  it("reports a template referencing an undeclared action", () => {
    const p = write(
      "undeclared-action.json5",
      `{
        segments: { a: { template: '{{ action "nope" "x" }}' } },
        root: { h: ['a'] },
      }`,
    );
    expect(expectFatal(checkConfig(p, dir))).toContain('"nope"');
  });

  // Acceptance (c): a user name squatting the reserved namespaces is fatal.
  it("reports a user action squatting the reserved menus. namespace", () => {
    const p = write(
      "squat-menus.json5",
      `{
        actions: { "menus.mine": { set: "x", to: "1" } },
        segments: { a: { template: 'a' } },
        root: { h: ['a'] },
      }`,
    );
    const message = expectFatal(checkConfig(p, dir));
    expect(message).toContain('reserved "menus."');
  });

  it("reports a user action squatting the reserved groups. namespace", () => {
    const p = write(
      "squat-groups.json5",
      `{
        actions: { "groups.mine": { set: "x", to: "1" } },
        segments: { a: { template: 'a' } },
        root: { h: ['a'] },
      }`,
    );
    const message = expectFatal(checkConfig(p, dir));
    expect(message).toContain('reserved "groups."');
  });

  // bn5.6 vocabulary: the removed {{ menu }} positional tail is a
  // migration-pointing load error, not a silent reinterpretation.
  it("reports the removed {{ menu }} positional tail with the migration pointer", () => {
    const p = write(
      "menu-positional.json5",
      `{
        actions: { applyX: { set: "theme", from: "themes" } },
        segments: { a: { template: '{{ menu "applyX" "pageX" }}' } },
        root: { h: ['a'] },
      }`,
    );
    expect(expectFatal(checkConfig(p, dir))).toContain("options (dict");
  });

  it("reports an unknown {{ menu }} dict option with the legal shape", () => {
    const p = write(
      "menu-badopt.json5",
      `{
        actions: { applyX: { set: "theme", from: "themes" } },
        segments: { a: { template: '{{ menu "applyX" (dict "closeOnPik" true) }}' } },
        root: { h: ['a'] },
      }`,
    );
    const message = expectFatal(checkConfig(p, dir));
    expect(message).toContain('unknown {{ menu }} option "closeOnPik"');
  });

  // The standalone {{ picker }} form (explicit page action + page=-1 close —
  // {{ menu }}'s documented desugaring, live in examples/demo-actions.json5)
  // is valid and must NOT be flagged.
  it("does not flag the standalone {{ picker }} form", () => {
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
    expect(checkConfig(p, dir).kind).toBe("clean");
  });

  // The stage the old `lint` could not reach: register + render. A mistyped
  // payload field path parses and validates fine but throws MissingFieldError
  // against the rich representative payload.
  it("reports a render-stage failure (mistyped payload field path)", () => {
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
    expect(checkConfig(p, dir).kind).toBe("fatal");
  });

  it("reports a template parse error in a segment override (register stage)", () => {
    const p = write(
      "template-parse.json5",
      `{
        segments: { a: { template: '{{ if }}' } },
        root: { h: ['a'] },
      }`,
    );
    expect(checkConfig(p, dir).kind).toBe("fatal");
  });
});

describe("checkConfig — default resolution (the daemon's own chain)", () => {
  it("checks the bundled default when no config file exists anywhere", () => {
    const emptyCwd = path.join(dir, "empty-cwd");
    fs.mkdirSync(emptyCwd, { recursive: true });
    const outcome = checkConfig(undefined, emptyCwd);
    expect(outcome.kind).toBe("clean");
    if (outcome.kind === "clean") {
      expect(outcome.configPath).toBeNull();
      expect(outcome.rendered.length).toBeGreaterThan(0);
    }
  });

  it("resolves the cwd config file exactly as the daemon would", () => {
    const cwd = path.join(dir, "proj");
    const p = write(
      "proj/.cc-candybar.json5",
      `{ segments: { a: { template: 'a' } }, root: { h: ['a'] } }`,
    );
    const outcome = checkConfig(undefined, cwd);
    expect(outcome.kind).toBe("clean");
    if (outcome.kind === "clean") expect(outcome.configPath).toBe(p);
  });

  it("honors $CC_CANDYBAR_CONFIG like the daemon's resolver", () => {
    const p = write(
      "env-config.json5",
      `{ segments: { a: { template: 'env' } }, root: { h: ['a'] } }`,
    );
    process.env.CC_CANDYBAR_CONFIG = p;
    const outcome = checkConfig(undefined, path.join(dir, "empty-cwd"));
    expect(outcome.kind).toBe("clean");
    if (outcome.kind === "clean") expect(outcome.configPath).toBe(p);
  });

  it("surfaces the .json5/.json collision as a warning on a CLEAN exit", () => {
    const cwd = path.join(dir, "collide");
    write(
      "collide/.cc-candybar.json5",
      `{ segments: { a: { template: 'a' } }, root: { h: ['a'] } }`,
    );
    write(
      "collide/.cc-candybar.json",
      `{ "segments": { "a": { "template": "a" } }, "root": { "h": ["a"] } }`,
    );
    const outcome = checkConfig(undefined, cwd);
    expect(outcome.kind).toBe("clean");
    if (outcome.kind === "clean") {
      expect(outcome.warnings.join("\n")).toContain("collision");
      expect(checkPlan(outcome).code).toBe(0);
      expect(checkPlan(outcome).stderr).toContain("collision");
    }
  });
});

describe("checkPlan — the text/exit-code contract", () => {
  it("maps clean → exit 0 with the verdict on stdout", () => {
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

  it("maps clean-with-warnings → exit 0 with warnings visible on stderr", () => {
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

  it("maps fatal → exit 1 with the diagnostic on stderr", () => {
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

  it("maps unreadable → exit 2", () => {
    const plan = checkPlan({
      kind: "unreadable",
      path: "gone.json5",
      message: "ENOENT",
    });
    expect(plan.code).toBe(2);
    expect(plan.stderr).toContain("gone.json5");
  });
});
