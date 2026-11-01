// [LAW:verifiable-goals] brandon-themes-dzl's acceptance, measured where the
// feature actually lands: the daemon's own request handling, rendering a config
// whose `globals.palette` is a RULE rather than a name.
//
// Two facts, and the second is the one a test of drawDsl cannot reach. The bar
// is painted in the theme the rule chose for THIS render's data, and the label
// reading `.theme.effective` agrees with it — one producer, so a label cannot
// name a theme the bar is not wearing. And when the rule names a theme nothing
// installs, the bar STILL RENDERS (in the floor theme) with the reason on the
// bar's diagnostics: the daemon's own warning channel, which is the half
// `onRenderWarning` exists for and which no unit test of drawDsl can observe.
//
// The value is data-driven, so a throw would take the statusline away the moment
// live data reached a branch with a typo. That is why this is a warning over a
// rendered bar rather than an error instead of one.

import { textOf } from "../src/render/frame";
import { backgroundsOf } from "./helpers/frame";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { render } from "./helpers/daemon-e2e";
import { startDaemon } from "./helpers/in-worker-daemon";
import {
  prepareIsolatedDaemonEnv,
} from "./helpers/spawn-isolated-daemon";

import { indicatorOf, readDiagnostics } from "./helpers/diagnostics-viewer";

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

describe("brandon-themes-dzl: globals.palette as a rule, through the daemon", () => {
  test("the rule paints the bar and labels it; a result naming nothing renders the floor under a warning", async () => {
    const { env, removeTmpDirs } = prepareIsolatedDaemonEnv(
      "cc-candybar-theme-rule-e2e",
    );
    configFor(env);
    const projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-theme-rule-project-"),
    );

    const daemon = startDaemon(env);
    try {

      // ── the good branch ────────────────────────────────────────────────────
      const good = await render(daemon, "theme-rule-good", projectDir);
      const goodText = textOf(good);
      // The label is drawDsl's own publication of what the rule chose.
      expect(goodText).toContain("T=dracula");
      // dracula's `surface` — the bar is wearing the theme the label names.
      expect(backgroundsOf(good)).toContain("#2b2e3b");
      // Nothing to warn about, so no indicator at all.
      expect(goodText).not.toContain("⚠");

      // ── the branch whose result names nothing installed ────────────────────
      const bad = await render(daemon, BAD_SESSION, projectDir);
      const badText = textOf(bad);
      // The bar is still there — that is the whole point of not throwing.
      expect(badText).toContain("◆ mark");
      // In the floor theme (textual-dark's `surface`), and labelled as such.
      expect(badText).toContain("T=textual-dark");
      expect(backgroundsOf(bad)).toContain("#1e1e1e");
      // And the reason is the bar's message, from the frame after the one that
      // met it, naming the slot, the value the rule produced, and what was
      // rendered instead.
      const again = await render(daemon, BAD_SESSION, projectDir);
      expect(indicatorOf(again)).toBe("⚠ 1");
      const [page] = await readDiagnostics(daemon, BAD_SESSION, projectDir, again);
      expect(page!.text).toContain("globals.palette");
      expect(page!.text).toContain("no-such-theme");
      expect(page!.text).toContain("textual-dark");
    } finally {
      await daemon.stop();
      rmSync(projectDir, { recursive: true, force: true });
      removeTmpDirs();
    }
  });
});
