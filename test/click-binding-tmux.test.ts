// [LAW:behavior-not-structure] The user's own MouseDown1Status survives a real
// tmux server's whole round trip under the click binding: read back out of the
// listing, bound under this build's binding, wrapped again by an older
// build's, read back as the same list and restored, so the listing that comes
// back is the one the user had (src/tmux-status/click-binding.ts).

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  boundOf,
  clickBinding,
  restoreBinding,
} from "../src/tmux-status/click-binding";

const HAS_TMUX = spawnSync("tmux", ["-V"]).status === 0;

(HAS_TMUX ? describe : describe.skip)(
  "the user's binding on a real tmux server",
  () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ccb-binding-"));
    const socket = path.join(dir, "tmux.sock");
    const tmux = (args: readonly string[], input?: string): string => {
      const run = spawnSync("tmux", ["-S", socket, ...args], {
        encoding: "utf8",
        input,
      });
      if (run.status !== 0) throw new Error(`tmux ${args[0]}: ${run.stderr}`);
      return run.stdout;
    };
    const line = (): string =>
      tmux(["list-keys", "-T", "root"])
        .split("\n")
        .find((l) => / MouseDown1Status /.test(l)) ?? "";

    beforeAll(() => {
      tmux(["-f", "/dev/null", "new-session", "-d", "-s", "binding"]);
    });
    afterAll(() => {
      spawnSync("tmux", ["-S", socket, "kill-session", "-t", "binding"]);
      rmSync(dir, { recursive: true, force: true });
    });

    test.each([
      ["a command list", `select-pane \\; display-message "hi there"`],
      [
        "a ; inside a quoted word",
        `display-message "semi;colon \\; not a separator"`,
      ],
      ["the server's own", "switch-client -t ="],
      ["one that mentions cc-candybar", `run-shell "cc-candybar doctor"`],
      [
        "an if-shell over blocks",
        "if-shell -F '#{==:1,1}' { select-window -t = ; display-message hi } { display-message no }",
      ],
      [
        "a list ending in a nested block",
        `select-window -t = \\; if-shell -F 1 { display-message "a }b" ; display-message 'c;d' }`,
      ],
      [
        "a string beside a block",
        `if-shell -F 1 "display-message \\"{ x }\\"" { display-message '{' }`,
      ],
    ])("is %s, and comes back as it was", (_what, command) => {
      tmux(
        ["source-file", "-"],
        `bind-key -T root MouseDown1Status ${command}\n`,
      );
      const before = line();
      tmux(clickBinding(boundOf(before).user));
      expect(boundOf(line()).ours).toBe(true);
      // An older build binds over this one, with what it read as its prior.
      tmux([
        "bind-key",
        "-T",
        "root",
        "MouseDown1Status",
        "if-shell",
        "-F",
        "#{m:ccb*,#{mouse_status_range}}",
        'run-shell -b "old url-handle cc-candybar://to/main/tmux-status-click/x"',
        line().replace(/^bind-key\s+-T root MouseDown1Status\s+/, ""),
      ]);
      const nested = boundOf(line());
      expect(nested).toEqual({ ours: true, user: boundOf(before).user });
      // No session names a renderer, so the guard puts the user's back.
      expect(tmux(restoreBinding(nested.user))).toContain("ccb:restored");
      expect(line()).toBe(before);
    });

    test("a restore is held while any session names a renderer", () => {
      tmux(
        ["source-file", "-"],
        "bind-key -T root MouseDown1Status switch-client -t =\n",
      );
      tmux(clickBinding(boundOf(line()).user));
      const bound = line();
      tmux(["set-option", "-t", "binding", "@cc-candybar-renderer", "dev"]);
      expect(tmux(restoreBinding(boundOf(bound).user))).toContain("ccb:held");
      expect(line()).toBe(bound);
      tmux(["set-option", "-u", "-t", "binding", "@cc-candybar-renderer"]);
    });
  },
);
