// [LAW:verifiable-goals] brandon-themes-dzl's acceptance, measured where the
// feature actually lands: a REAL daemon over a REAL socket, rendering a config
// whose `globals.palette` is a RULE rather than a name.
//
// Two facts, and the second is the one an in-process test cannot reach. The bar
// is painted in the theme the rule chose for THIS render's data, and the label
// reading `.theme.effective` agrees with it — one producer, so a label cannot
// name a theme the bar is not wearing. And when the rule names a theme nothing
// installs, the bar STILL RENDERS (in the floor theme) with the reason on the
// diagnostic strip above it: the daemon's own warning channel, which is the half
// `onRenderWarning` exists for and which no unit test of renderDsl can observe.
//
// The value is data-driven, so a throw would take the statusline away the moment
// live data reached a branch with a typo. That is why this is a warning over a
// rendered bar rather than an error instead of one.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { killAndWait, render, stripAnsi } from "./helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

// The rule branches on the SESSION ID, which is real payload data the daemon
// carries per render — so both branches are reachable by asking the same daemon
// for two different sessions, and neither assertion can go vacuous on a fixture
// the test invented. `session.id` is declared by the bundled default this user
// config merges over.
const BAD_SESSION = "theme-rule-bad";
const RULE = `{{ if eq .session.id "${BAD_SESSION}" }}no-such-theme{{ else }}dracula{{ end }}`;

function configFor(env: NodeJS.ProcessEnv): string {
  const configDir = path.join(env.XDG_CONFIG_HOME!, "cc-candybar");
  mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "config.json5");
  writeFileSync(
    configPath,
    JSON.stringify({
      globals: { palette: RULE },
      variables: {
        "theme.effective": {
          kind: "input",
          path: "theme.effective",
          default: "",
        },
      },
      segments: {
        mark: { template: " ◆ mark ", bg: "surface", fg: "foreground" },
        label: {
          template: "T={{ .theme.effective }}",
          bg: "surface",
          fg: "foreground",
        },
      },
      root: { h: ["mark", "label"] },
    }),
  );
  return configPath;
}

describe("brandon-themes-dzl: globals.palette as a rule, through the real daemon", () => {
  test("the rule paints the bar and labels it; a result naming nothing renders the floor under a warning", async () => {
    const { env, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv(
      "cc-candybar-theme-rule-e2e",
    );
    configFor(env);
    const projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-theme-rule-project-"),
    );

    let daemon: RunningDaemon | undefined;
    try {
      daemon = await spawnDaemonWithEnv(env);

      // ── the good branch ────────────────────────────────────────────────────
      const good = await render(sockPath, "theme-rule-good", projectDir);
      const goodText = stripAnsi(good);
      // The label is renderDsl's own publication of what the rule chose.
      expect(goodText).toContain("T=dracula");
      // dracula's `surface` — the bar is wearing the theme the label names.
      expect(good).toContain("48;2;43;46;59");
      // Nothing to warn about, so no strip at all.
      expect(goodText).not.toContain("⚠");

      // ── the branch whose result names nothing installed ────────────────────
      const bad = await render(sockPath, BAD_SESSION, projectDir);
      const badText = stripAnsi(bad);
      // The bar is still there — that is the whole point of not throwing.
      expect(badText).toContain("◆ mark");
      // In the floor theme (textual-dark's `surface`), and labelled as such.
      expect(badText).toContain("T=textual-dark");
      expect(bad).toContain("48;2;30;30;30");
      // And the reason is on the strip above it, naming the slot, the value the
      // rule produced, and what was rendered instead.
      expect(badText).toContain("globals.palette");
      expect(badText).toContain("no-such-theme");
      expect(badText).toContain("textual-dark");
    } finally {
      if (daemon !== undefined) await killAndWait(daemon);
      rmSync(projectDir, { recursive: true, force: true });
      removeTmpDirs();
    }
  });
});
