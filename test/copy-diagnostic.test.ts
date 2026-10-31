// [LAW:verifiable-goals] A diagnostic's copy click names its message by key,
// and the copy-diagnostic verb copies what the session's last draw listed
// under that key: the full prompt reaches the clipboard while the link stays
// short, and a key that draw does not list is refused loudly.

import { processLauncher, type LaunchOpts } from "../src/proc/launch";
import { collectDiagnostics, copyKeys } from "../src/render/diagnostics";
import { SessionState } from "../src/daemon/session-state";
import { DroppedFileError } from "../src/config/loader/diagnostics";
import { clickUrl, testVerbContext } from "./helpers/click";

const launched: LaunchOpts[] = [];
const recording = {
  ...processLauncher,
  launchSync: (opts: LaunchOpts) => {
    launched.push(opts);
    return { ok: true as const, exitCode: 0, stdout: "", stderr: "" };
  },
};

const SID = "sid-copy";
const PROMPT = `Fix my config.\n\n${"a placement that names nothing; ".repeat(200)}`;

const drawn = () => {
  const list = collectDiagnostics(
    SID,
    "request",
    [{ about: "dropped\0/x.json5", text: "first line\nsecond", copy: PROMPT }],
    [],
    [],
  );
  const keys = copyKeys(list);
  const copies = new Map(list.map((m, i) => [keys[i]!, m.copy]));
  return { list, copies };
};

beforeEach(() => {
  launched.length = 0;
});

test("the first line's click copies the full prompt, though its link carries only a key", () => {
  const { list, copies } = drawn();
  const link = list[0]!.lines[0]![0].link!;
  expect(link.length).toBeLessThan(200);
  expect(link).not.toContain("placement");
  clickUrl(link, {
    ...testVerbContext(new SessionState()),
    launcher: recording,
    diagnosticCopy: (sid, by, key) =>
      sid === SID && by === "request" ? copies.get(key) : undefined,
  });
  expect(launched).toHaveLength(1);
  expect(launched[0]!.bin).toBe("/usr/bin/pbcopy");
  expect(launched[0]!.stdinInput).toBe(PROMPT);
});

test("a key the session's last draw no longer lists is refused, and nothing is copied", () => {
  const { list } = drawn();
  const link = list[0]!.lines[0]![0].link!;
  expect(() =>
    clickUrl(link, {
      ...testVerbContext(new SessionState()),
    launcher: recording,
      diagnosticCopy: () => undefined,
    }),
  ).toThrow(/no longer listed/);
  expect(launched).toHaveLength(0);
});

test("a dropped placement's prompt names the file to edit and carries the error whole", () => {
  const e = new DroppedFileError("/home/me/config.json5", [
    {
      path: "root",
      message: 'root entry "x" does not match any declared segment',
    },
  ]);
  expect(e.prompt).toMatch(
    /^Fix my cc-candybar statusline config\.[\s\S]*Config file to edit: \/home\/me\/config\.json5\n\nInvalid config in \/home\/me\/config\.json5[\s\S]*root entry "x"[\s\S]*Edit only the config file/,
  );
});
